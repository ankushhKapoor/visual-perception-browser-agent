/**
 * background.ts — Service Worker (Manifest V3).
 *
 * Message handlers:
 *   RUN_AGENT_STEP        — single step from popup (original flow)
 *   RUN_ALL_TASKS         — full executor loop over tasks.json
 *   STOP_EXECUTOR         — graceful abort
 *   CONFIRMATION_RESPONSE — user confirmation reply forwarded to executor
 */

import type {
  AgentStepResponse,
  BrowserState,
  RunAgentStepMessage,
} from "./types";

import { runAllTasks, requestStop } from "./executor";

const API_BASE = "http://localhost:8000";

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

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

async function runAgentStep(
  task: string,
  sessionId: string,
  senderId: number
): Promise<void> {
  const tab = await getActiveTab();
  const tabId = tab.id!;

  const stateMsg = await sendToContent<{ type: string; payload: BrowserState }>(
    tabId,
    { type: "COLLECT_STATE", payload: { task, sessionId } }
  );
  const state = stateMsg.payload;

  const agentResponse = await callAgentStep(state);

  const actionResult = await sendToContent<{
    type: string;
    payload: { success: boolean; message: string };
  }>(tabId, { type: "EXECUTE_ACTION", payload: agentResponse.action });

  void actionResult;

  chrome.tabs
    .sendMessage(senderId, {
      type: "AGENT_STEP_RESULT",
      payload: agentResponse,
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RUN_AGENT_STEP") {
    const { task, sessionId } = (message as RunAgentStepMessage).payload;
    const senderId = sender.tab?.id ?? -1;

    runAgentStep(task, sessionId, senderId)
      .then(() => sendResponse({ type: "OK" }))
      .catch((err) => {
        sendResponse({ type: "ERROR", payload: { message: String(err) } });
      });

    return true;
  }

  if (message.type === "RUN_ALL_TASKS") {
    const { sessionId } = message.payload as { sessionId: string };

    runAllTasks(sessionId)
      .then(() => sendResponse({ type: "OK" }))
      .catch((err) => {
        sendResponse({ type: "ERROR", payload: { message: String(err) } });
      });

    return true;
  }

  if (message.type === "STOP_EXECUTOR") {
    requestStop();
    sendResponse({ type: "OK" });
    return false;
  }

  if (message.type === "CONFIRMATION_RESPONSE") {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ type: "OK" });
    return false;
  }
});
