/**
 * popup.js — Logic for the extension popup.
 *
 * Flow:
 *  1. User types intent → clicks "Run Agent"
 *  2. Popup sends AGENT_TASK_REQUEST to the active tab's content script
 *  3. content.js captures perception state + screenshot → posts /agent/task
 *  4. Backend calls VLM → returns tasks.json
 *  5. If requires_confirmation → show confirm panel
 *  6. On proceed → send EXECUTE_TASKS to content.js
 *  7. Show per-step progress
 */

const BACKEND_AGENT_URL = "http://127.0.0.1:8000/agent/task";

/* ─── DOM refs ─── */
const intentInput    = document.getElementById("intentInput");
const runBtn         = document.getElementById("runBtn");
const headerBadge    = document.getElementById("headerBadge");
const statusBox      = document.getElementById("statusBox");
const statusDot      = document.getElementById("statusDot");
const statusLabel    = document.getElementById("statusLabel");
const progressBar    = document.getElementById("progressBar");
const stepList       = document.getElementById("stepList");
const confirmBox     = document.getElementById("confirmBox");
const confirmReason  = document.getElementById("confirmReason");
const confirmProceed = document.getElementById("confirmProceed");
const confirmCancel  = document.getElementById("confirmCancel");
const errorMsg       = document.getElementById("errorMsg");
const footerStatus   = document.getElementById("footerStatus");
const modelChip      = document.getElementById("modelChip");

/* ─── State ─── */
let pendingTasks = null;
let activeTabId  = null;

/* ─── UI helpers ─── */

function setLoading(loading) {
  runBtn.disabled = loading;
  runBtn.classList.toggle("loading", loading);
  intentInput.disabled = loading;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add("visible");
}

function hideError() {
  errorMsg.classList.remove("visible");
}

function setStatus(label, dotState) {
  statusBox.classList.add("visible");
  statusLabel.textContent = label;
  statusDot.className = `status-dot ${dotState}`;
  headerBadge.textContent = label;
}

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
}

function addStep(stepNum, total, description, state = "active") {
  const icons = { active: "⟳", done: "✓", error: "✗", pending: "·" };
  const existing = document.getElementById(`step-${stepNum}`);

  if (existing) {
    existing.querySelector(".step-icon").textContent = icons[state] || "·";
    const txt = existing.querySelector(".step-text");
    txt.className = `step-text ${state}`;
    return;
  }

  const item = document.createElement("div");
  item.className = "step-item";
  item.id = `step-${stepNum}`;
  item.innerHTML = `
    <span class="step-icon">${icons[state]}</span>
    <span class="step-text ${state}">${stepNum}/${total}: ${description}</span>
  `;
  stepList.appendChild(item);
  stepList.scrollTop = stepList.scrollHeight;
}

function clearSteps() {
  stepList.innerHTML = "";
  progressBar.style.width = "0%";
}

function showConfirm(reasoning) {
  confirmReason.textContent = reasoning || "The agent needs additional context to proceed.";
  confirmBox.classList.add("visible");
}

function hideConfirm() {
  confirmBox.classList.remove("visible");
}

/* ─── Main flow ─── */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Ask content.js to capture the current state and call /agent/task.
 */
async function requestAgentTask(tabId, intent) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "AGENT_TASK_REQUEST", taskIntent: intent },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response?.success) {
          return reject(new Error(response?.error || "Agent task failed"));
        }
        resolve(response.tasks);
      }
    );
  });
}

/**
 * Ask content.js to execute the tasks.json plan.
 */
async function requestTaskExecution(tabId, tasks) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "EXECUTE_TASKS", tasks },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
      }
    );
  });
}

runBtn.addEventListener("click", async () => {
  const intent = intentInput.value.trim();
  if (!intent) {
    intentInput.focus();
    return;
  }

  hideError();
  hideConfirm();
  clearSteps();
  pendingTasks = null;

  setLoading(true);
  setStatus("Capturing page…", "running");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("No active tab found");
    activeTabId = tab.id;

    setStatus("Analysing with VLM…", "running");

    const tasks = await requestAgentTask(activeTabId, intent);
    pendingTasks = tasks;

    if (tasks?.model) {
      modelChip.textContent = tasks.model.split("/").pop() || tasks.model;
    }

    // Show task steps as pending
    (tasks?.tasks || []).forEach((step) => {
      addStep(step.step, tasks.tasks.length, step.description, "pending");
    });

    if (tasks?.requires_confirmation) {
      setLoading(false);
      setStatus("Awaiting confirmation", "running");
      showConfirm(tasks.reasoning);
      return;
    }

    await executeAndTrack(activeTabId, tasks);
  } catch (err) {
    setLoading(false);
    setStatus("Error", "error");
    showError(err.message || String(err));
    footerStatus.textContent = "Failed";
  }
});

async function executeAndTrack(tabId, tasks) {
  setStatus("Executing…", "running");

  const stepItems = tasks?.tasks || [];
  const total = stepItems.length;

  // Listen for progress updates from content.js
  const progressListener = (message) => {
    if (message.type !== "TASK_PROGRESS") return;
    const { step, totalSteps, status, error, description } = message;
    addStep(step, totalSteps || total, description || "", status);
    setProgress(step, totalSteps || total);
  };
  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const result = await requestTaskExecution(tabId, tasks);

    chrome.runtime.onMessage.removeListener(progressListener);

    if (result?.success) {
      setProgress(total, total);
      setStatus("Done ✓", "success");
      setLoading(false);
      footerStatus.textContent = `${result.completedSteps || total} steps completed`;
    } else {
      setStatus("Partial failure", "error");
      setLoading(false);
      showError(result?.error || "Execution stopped");
    }
  } catch (err) {
    chrome.runtime.onMessage.removeListener(progressListener);
    setLoading(false);
    setStatus("Execution error", "error");
    showError(err.message || String(err));
  }
}

confirmProceed.addEventListener("click", async () => {
  if (!pendingTasks || !activeTabId) return;
  hideConfirm();
  setLoading(true);
  await executeAndTrack(activeTabId, pendingTasks);
});

confirmCancel.addEventListener("click", () => {
  hideConfirm();
  setLoading(false);
  setStatus("Cancelled", "error");
  pendingTasks = null;
});

/* Restore intent from session storage */
intentInput.addEventListener("input", () => {
  sessionStorage.setItem("agentIntent", intentInput.value);
});

const saved = sessionStorage.getItem("agentIntent");
if (saved) intentInput.value = saved;
intentInput.focus();
