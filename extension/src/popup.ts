/**
 * popup.ts — Popup UI logic.
 *
 * Sends RUN_AGENT_STEP to the background service worker when the user
 * clicks "Run Step". Displays the returned action and reasoning.
 */

import type { AgentStepResponse, RunAgentStepMessage } from "./types";

// ---------------------------------------------------------------------------
// DOM References (typed)
// ---------------------------------------------------------------------------

const taskInput = document.getElementById("taskInput") as HTMLTextAreaElement;
const runBtn = document.getElementById("runBtn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const actionEl = document.getElementById("actionOutput") as HTMLPreElement;
const reasoningEl = document.getElementById("reasoningOutput") as HTMLParagraphElement;
const resultSection = document.getElementById("resultSection") as HTMLDivElement;
const spinner = document.getElementById("spinner") as HTMLDivElement;

// ---------------------------------------------------------------------------
// Session ID (persisted via chrome.storage)
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getSessionId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(["sessionId"], (result) => {
      if (result.sessionId) {
        resolve(result.sessionId as string);
      } else {
        const id = generateSessionId();
        chrome.storage.local.set({ sessionId: id });
        resolve(id);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

function setLoading(loading: boolean): void {
  runBtn.disabled = loading;
  spinner.style.display = loading ? "flex" : "none";
  if (loading) {
    statusEl.textContent = "Running agent step…";
    statusEl.className = "status info";
  }
}

function showResult(response: AgentStepResponse): void {
  resultSection.style.display = "block";
  actionEl.textContent = JSON.stringify(response.action, null, 2);
  reasoningEl.textContent = response.reasoning || "—";
  statusEl.textContent = response.done
    ? "✅ Task complete!"
    : `✅ Action executed: ${response.action.type}`;
  statusEl.className = response.done ? "status success done" : "status success";
}

function showError(message: string): void {
  statusEl.textContent = `❌ ${message}`;
  statusEl.className = "status error";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) {
    showError("Please enter a task description.");
    return;
  }

  setLoading(true);
  resultSection.style.display = "none";

  try {
    const sessionId = await getSessionId();

    const message: RunAgentStepMessage = {
      type: "RUN_AGENT_STEP",
      payload: { task, sessionId },
    };

    chrome.runtime.sendMessage(message, (response) => {
      setLoading(false);

      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message ?? "Unknown error");
        return;
      }

      if (response?.type === "ERROR") {
        showError(response.payload?.message ?? "Unknown error from background.");
        return;
      }
    });

    // Listen for the full result pushed by background
    chrome.runtime.onMessage.addListener(function handler(msg) {
      if (msg.type === "AGENT_STEP_RESULT") {
        setLoading(false);
        showResult(msg.payload as AgentStepResponse);
        chrome.runtime.onMessage.removeListener(handler);
      }
    });
  } catch (err) {
    setLoading(false);
    showError(String(err));
  }
});

// New session button
document.getElementById("newSessionBtn")?.addEventListener("click", () => {
  const id = generateSessionId();
  chrome.storage.local.set({ sessionId: id });
  statusEl.textContent = `New session: ${id}`;
  statusEl.className = "status info";
  resultSection.style.display = "none";
});

// Restore last task
chrome.storage.local.get(["lastTask"], (result) => {
  if (result.lastTask) taskInput.value = result.lastTask as string;
});

taskInput.addEventListener("input", () => {
  chrome.storage.local.set({ lastTask: taskInput.value });
});
