/**
 * popup.ts — Popup UI logic.
 *
 * Two modes:
 *   A. Single Step tab — original single-action flow
 *   B. Task Executor tab — drives runAllTasks via background, shows live progress
 */

import type {
  AgentStepResponse,
  RunAgentStepMessage,
  TaskDefinition,
  TaskResult,
  TaskStatus,
} from "./types";

import TASKS from "./tasks.json";

// Session ID

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

// Tab switching

const tabSingle   = document.getElementById("tabSingle")   as HTMLButtonElement;
const tabExecutor = document.getElementById("tabExecutor") as HTMLButtonElement;
const panelSingle   = document.getElementById("panelSingle")   as HTMLDivElement;
const panelExecutor = document.getElementById("panelExecutor") as HTMLDivElement;

tabSingle.addEventListener("click", () => {
  tabSingle.classList.add("active");
  tabExecutor.classList.remove("active");
  panelSingle.classList.add("active");
  panelExecutor.classList.remove("active");
});

tabExecutor.addEventListener("click", () => {
  tabExecutor.classList.add("active");
  tabSingle.classList.remove("active");
  panelExecutor.classList.add("active");
  panelSingle.classList.remove("active");
});

// Single Step tab

const taskInput    = document.getElementById("taskInput")    as HTMLTextAreaElement;
const runBtn       = document.getElementById("runBtn")       as HTMLButtonElement;
const statusEl     = document.getElementById("status")       as HTMLDivElement;
const actionEl     = document.getElementById("actionOutput") as HTMLPreElement;
const reasoningEl  = document.getElementById("reasoningOutput") as HTMLParagraphElement;
const resultSection = document.getElementById("resultSection")  as HTMLDivElement;
const spinner      = document.getElementById("spinner")      as HTMLDivElement;

function setSingleLoading(loading: boolean): void {
  runBtn.disabled = loading;
  spinner.style.display = loading ? "flex" : "none";
  if (loading) {
    statusEl.textContent = "Running agent step…";
    statusEl.className = "status info";
  }
}

function showSingleResult(response: AgentStepResponse): void {
  resultSection.style.display = "block";
  actionEl.textContent = JSON.stringify(response.action, null, 2);
  reasoningEl.textContent = response.reasoning || "—";
  statusEl.textContent = response.done
    ? "✅ Task complete!"
    : `✅ Action executed: ${response.action.type}`;
  statusEl.className = "status success";
}

function showSingleError(message: string): void {
  statusEl.textContent = `❌ ${message}`;
  statusEl.className = "status error";
}

runBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) { showSingleError("Please enter a task description."); return; }

  setSingleLoading(true);
  resultSection.style.display = "none";

  try {
    const sessionId = await getSessionId();
    const message: RunAgentStepMessage = {
      type: "RUN_AGENT_STEP",
      payload: { task, sessionId },
    };

    chrome.runtime.sendMessage(message, (response) => {
      setSingleLoading(false);
      if (chrome.runtime.lastError) {
        showSingleError(chrome.runtime.lastError.message ?? "Unknown error");
        return;
      }
      if (response?.type === "ERROR") {
        showSingleError(response.payload?.message ?? "Unknown error from background.");
      }
    });

    chrome.runtime.onMessage.addListener(function handler(msg) {
      if (msg.type === "AGENT_STEP_RESULT") {
        setSingleLoading(false);
        showSingleResult(msg.payload as AgentStepResponse);
        chrome.runtime.onMessage.removeListener(handler);
      }
    });
  } catch (err) {
    setSingleLoading(false);
    showSingleError(String(err));
  }
});

document.getElementById("newSessionBtn")?.addEventListener("click", () => {
  const id = generateSessionId();
  chrome.storage.local.set({ sessionId: id });
  statusEl.textContent = `New session: ${id}`;
  statusEl.className = "status info";
  resultSection.style.display = "none";
});

chrome.storage.local.get(["lastTask"], (result) => {
  if (result.lastTask) taskInput.value = result.lastTask as string;
});

taskInput.addEventListener("input", () => {
  chrome.storage.local.set({ lastTask: taskInput.value });
});

// Executor tab

const tasks = TASKS as TaskDefinition[];

const execRunBtn     = document.getElementById("execRunBtn")      as HTMLButtonElement;
const execStopBtn    = document.getElementById("execStopBtn")     as HTMLButtonElement;
const execTaskCount  = document.getElementById("execTaskCount")   as HTMLSpanElement;
const execProgressBar = document.getElementById("execProgressBar") as HTMLDivElement;
const taskListEl     = document.getElementById("taskList")        as HTMLDivElement;
const execResultEl   = document.getElementById("execResult")      as HTMLDivElement;

// Build initial task cards

execTaskCount.textContent = `${tasks.length} task${tasks.length !== 1 ? "s" : ""} loaded`;

function renderTaskCards(statuses: Map<string, {
  status: TaskStatus;
  step: number;
  maxSteps: number;
  detail?: string;
  error?: string;
}>): void {
  taskListEl.innerHTML = "";

  for (const task of tasks) {
    const maxSteps = task.mode === "scripted" ? task.steps.length : task.maxSteps;
    const s = statuses.get(task.id) ?? { status: "pending" as TaskStatus, step: 0, maxSteps };
    const stepPct = s.maxSteps > 0 ? (s.step / s.maxSteps) * 100 : 0;
    const modeBadge = task.mode === "scripted" ? "scripted" : "agent";

    const card = document.createElement("div");
    card.className = `task-card ${s.status}`;
    card.id = `card-${task.id}`;

    card.innerHTML = `
      <div class="task-card-header">
        <span class="task-card-id">${task.id} <span style="opacity:0.5;font-size:9px">[${modeBadge}]</span></span>
        <span class="task-badge ${s.status}">${s.status}</span>
      </div>
      <div class="task-card-task">${task.description}</div>
      <div class="task-card-url">${task.url}</div>
      <div class="task-card-step">
        <span>Step ${s.step}/${s.maxSteps}</span>
        <div class="task-step-bar">
          <div class="task-step-fill" style="width:${stepPct}%"></div>
        </div>
      </div>
      ${s.detail ? `<div class="task-card-reasoning">${s.detail}</div>` : ""}
      ${s.error  ? `<div class="task-card-error">⚠ ${s.error}</div>` : ""}
    `;

    taskListEl.appendChild(card);
  }
}

const execStatuses = new Map<string, {
  status: TaskStatus; step: number; maxSteps: number; detail?: string; error?: string;
}>();

for (const t of tasks) {
  const maxSteps = t.mode === "scripted" ? t.steps.length : t.maxSteps;
  execStatuses.set(t.id, { status: "pending", step: 0, maxSteps });
}
renderTaskCards(execStatuses);

// Progress updates from background

let execRunning = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TASK_PROGRESS") {
    const p = msg.payload as {
      taskId: string; taskIndex: number; totalTasks: number;
      status: TaskStatus; step: number; maxSteps: number;
      actionType?: string; detail?: string; error?: string;
    };

    execStatuses.set(p.taskId, {
      status: p.status,
      step: p.step,
      maxSteps: p.maxSteps,
      detail: p.detail,
      error: p.error,
    });

    const doneCount = [...execStatuses.values()].filter(
      (s) => s.status === "done" || s.status === "failed"
    ).length;
    execProgressBar.style.width = `${(doneCount / tasks.length) * 100}%`;

    renderTaskCards(execStatuses);

    const card = document.getElementById(`card-${p.taskId}`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  if (msg.type === "ALL_TASKS_DONE") {
    execRunning = false;
    execRunBtn.disabled = false;
    execStopBtn.disabled = true;
    execProgressBar.style.width = "100%";

    const p = msg.payload as {
      totalTasks: number; succeeded: number; failed: number; results: TaskResult[];
    };

    execResultEl.style.display = "block";
    const cls = p.failed === 0 ? "success" : p.succeeded === 0 ? "failed" : "partial";
    execResultEl.className = cls;
    execResultEl.innerHTML = `
      ✅ Done &nbsp;·&nbsp; <strong>${p.succeeded}</strong> succeeded &nbsp;·&nbsp; <strong>${p.failed}</strong> failed
      &nbsp;·&nbsp; ${p.totalTasks} total
    `;
  }
});

// Run / Stop buttons

execRunBtn.addEventListener("click", async () => {
  if (execRunning) return;
  execRunning = true;

  for (const t of tasks) {
    const maxSteps = t.mode === "scripted" ? t.steps.length : t.maxSteps;
    execStatuses.set(t.id, { status: "pending", step: 0, maxSteps });
  }
  renderTaskCards(execStatuses);
  execProgressBar.style.width = "0%";
  execResultEl.style.display = "none";

  execRunBtn.disabled = true;
  execStopBtn.disabled = false;

  const sessionId = await getSessionId();

  chrome.runtime.sendMessage(
    { type: "RUN_ALL_TASKS", payload: { sessionId } },
    (response) => {
      if (chrome.runtime.lastError || response?.type === "ERROR") {
        execRunning = false;
        execRunBtn.disabled = false;
        execStopBtn.disabled = true;
        execResultEl.style.display = "block";
        execResultEl.className = "failed";
        execResultEl.textContent = `❌ Error: ${
          chrome.runtime.lastError?.message ?? response?.payload?.message ?? "Unknown"
        }`;
      }
    }
  );
});

execStopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_EXECUTOR" });
  execStopBtn.disabled = true;
  execResultEl.style.display = "block";
  execResultEl.className = "";
  execResultEl.textContent = "⏹ Stop requested — finishing current step…";
});

// Confirmation dialog

const confirmDialog  = document.getElementById("confirmDialog")  as HTMLDivElement;
const confirmText    = document.getElementById("confirmText")    as HTMLParagraphElement;
const confirmYesBtn  = document.getElementById("confirmYesBtn")  as HTMLButtonElement;
const confirmNoBtn   = document.getElementById("confirmNoBtn")   as HTMLButtonElement;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CONFIRMATION_REQUIRED") {
    const { action, reasoning } = msg.payload as {
      action: { type: string; target_id?: string; value?: string };
      reasoning: string;
    };

    confirmText.textContent = `${reasoning} (Action: ${action.type}${
      action.value ? ` "${action.value}"` : ""
    })`;
    confirmDialog.style.display = "block";

    const cleanup = () => {
      confirmDialog.style.display = "none";
      confirmYesBtn.replaceWith(confirmYesBtn.cloneNode(true));
      confirmNoBtn.replaceWith(confirmNoBtn.cloneNode(true));
    };

    document.getElementById("confirmYesBtn")!.addEventListener("click", () => {
      cleanup();
      chrome.runtime.sendMessage({ type: "CONFIRMATION_RESPONSE", payload: { confirmed: true } });
    }, { once: true });

    document.getElementById("confirmNoBtn")!.addEventListener("click", () => {
      cleanup();
      chrome.runtime.sendMessage({ type: "CONFIRMATION_RESPONSE", payload: { confirmed: false } });
    }, { once: true });
  }
});
