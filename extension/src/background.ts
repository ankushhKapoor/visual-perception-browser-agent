/**
 * background.ts — Service Worker (Manifest V3 background script).
 *
 * Orchestrates one full agent step:
 *   1. Receive RUN_AGENT_STEP from popup (task + sessionId)
 *   2. Ask content script to COLLECT_STATE from the active tab
 *   3. POST the state to the FastAPI /agent/step endpoint
 *   4. Ask content script to EXECUTE_ACTION with the returned action
 *   5. Send AGENT_STEP_RESULT back to popup
 */

import type {
  AgentStepResponse,
  BrowserState,
  RunAgentStepMessage,
} from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = "http://localhost:8000";

// ---------------------------------------------------------------------------
// Helper: get the active tab
// ---------------------------------------------------------------------------

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

// ---------------------------------------------------------------------------
// Helper: send message to content script and await response
// ---------------------------------------------------------------------------

function sendToContent<T>(tabId: number, message: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as T);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helper: POST to /agent/step
// ---------------------------------------------------------------------------

async function callAgentStep(state: BrowserState): Promise<AgentStepResponse> {
  const body = {
    session_id: state.sessionId,
    task: state.task,
    url: state.url,
    page_title: state.pageTitle,
    visible_text: state.visibleText,
    ui_elements: state.uiElements.map((el) => ({
      id: el.id,
      role: el.role,
      tag: el.tag,
      text: el.text,
      attributes: el.attributes,
    })),
  };

  const response = await fetch(`${API_BASE}/agent/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<AgentStepResponse>;
}

// ---------------------------------------------------------------------------
// Main agent step orchestration
// ---------------------------------------------------------------------------

async function runAgentStep(
  task: string,
  sessionId: string,
  senderId: number
): Promise<void> {
  const tab = await getActiveTab();
  const tabId = tab.id!;

  // 1. Collect browser state from content script
  console.log("[BG] Collecting state...");
  const stateMsg = await sendToContent<{ type: string; payload: BrowserState }>(
    tabId,
    { type: "COLLECT_STATE", payload: { task, sessionId } }
  );
  const state = stateMsg.payload;
  console.log("[BG] State collected:", state.uiElements.length, "elements");

  // 2. Call FastAPI backend
  console.log("[BG] Calling /agent/step...");
  const agentResponse = await callAgentStep(state);
  console.log("[BG] Action received:", agentResponse.action);

  // 3. Execute the action in the content script
  console.log("[BG] Executing action...");
  const actionResult = await sendToContent<{ type: string; payload: { success: boolean; message: string } }>(
    tabId,
    { type: "EXECUTE_ACTION", payload: agentResponse.action }
  );
  console.log("[BG] Action result:", actionResult.payload);

  // 4. Notify popup
  chrome.tabs.sendMessage(senderId, {
    type: "AGENT_STEP_RESULT",
    payload: agentResponse,
  }).catch(() => {
    // Popup may have closed — that's OK
  });
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: RunAgentStepMessage, sender, sendResponse) => {
  if (message.type === "RUN_AGENT_STEP") {
    const { task, sessionId } = message.payload;
    const senderId = sender.tab?.id ?? -1;

    runAgentStep(task, sessionId, senderId)
      .then(() => sendResponse({ type: "OK" }))
      .catch((err) => {
        console.error("[BG] Error:", err);
        sendResponse({ type: "ERROR", payload: { message: String(err) } });
      });

    return true; // Keep message channel open for async
  }
});

console.log("[VisionAgent] Background service worker started.");
