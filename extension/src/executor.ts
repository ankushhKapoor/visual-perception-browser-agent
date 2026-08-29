/**
 * executor.ts
 *
 * Member 3 (Ankush) — Browser Executor
 *
 * Two execution modes:
 *
 *   scripted — steps are pre-defined (CSS selectors, direct actions).
 *              No backend call. Used for testing before VLM integration.
 *
 *   agent    — each step calls POST /agent/step and executes the returned
 *              action. Ready to receive VLM output.
 *
 * Navigation rules:
 *   - If the current tab is already on the task's domain, do not reload.
 *   - If openInNewTab is true, always open a new tab for the task.
 *   - Otherwise navigate the current working tab only when the domain differs.
 *
 * Supported scripted actions: CLICK, TYPE, PRESS_KEY, SCROLL, WAIT
 * Supported agent actions: CLICK, TYPE, SCROLL, SELECT, PRESS_KEY, WAIT,
 *                          DONE, ASK_USER_CONFIRMATION
 */

import type {
  AgentStepResponse,
  AgentTask,
  BrowserState,
  ScriptedTask,
  TaskDefinition,
  TaskResult,
  TaskStepLog,
  TaskStatus,
} from "./types";

import TASKS from "./tasks.json";

const API_BASE = "http://localhost:8000";

const INTER_STEP_DELAY_MS      = 700;
const INTER_TASK_DELAY_MS      = 1000;
const PAGE_LOAD_TIMEOUT_MS     = 12_000;
const POST_CLICK_LOAD_MS       = 1_500;
const POST_INJECT_SETTLE_MS    = 350;
const POST_NAV_SETTLE_MS       = 800;

const DESTRUCTIVE_VALUES = new Set([
  "send", "delete", "pay", "transfer", "submit", "purchase", "confirm payment",
]);

let _stopRequested = false;

export function requestStop(): void  { _stopRequested = true; }
export function resetStop(): void    { _stopRequested = false; }

// Shared helpers

function sameDomain(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

function waitForTabLoad(tabId: number, timeoutMs = PAGE_LOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(id: number, info: chrome.tabs.TabChangeInfo): void {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, POST_NAV_SETTLE_MS);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
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

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToContent<unknown>(tabId, { type: "__PING__" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise((r) => setTimeout(r, POST_INJECT_SETTLE_MS));
  }
}

async function captureScreenshot(windowId: number): Promise<string | undefined> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return dataUrl.split(",")[1];
  } catch {
    return undefined;
  }
}

/**
 * Navigate the tab to a URL only if the tab is not already on that domain.
 * If the tab is already on the same domain, do nothing and return false.
 * Returns true if navigation actually happened.
 */
async function navigateIfNeeded(
  tabId: number,
  targetUrl: string,
  currentTabUrl: string
): Promise<boolean> {
  if (sameDomain(currentTabUrl, targetUrl)) {
    return false;
  }
  await chrome.tabs.update(tabId, { url: targetUrl });
  await waitForTabLoad(tabId);
  return true;
}

function broadcastProgress(payload: {
  taskId: string;
  taskIndex: number;
  totalTasks: number;
  status: TaskStatus;
  step: number;
  maxSteps: number;
  actionType?: string;
  detail?: string;
  error?: string;
  stepLatencyMs?: number;
  totalLatencyMs?: number;
}): void {
  chrome.runtime.sendMessage({ type: "TASK_PROGRESS", payload }).catch(() => {});
}

// Scripted task runner

async function runScriptedTask(
  task: ScriptedTask,
  taskIndex: number,
  totalTasks: number,
  tabId: number,
  windowId: number,
  currentTabUrl: string
): Promise<{ result: TaskResult; finalTabId: number }> {
  const result: TaskResult = {
    taskId: task.id,
    status: "running",
    stepsRun: 0,
    logs: [],
  };

  const taskStartTime = Date.now();

  broadcastProgress({
    taskId: task.id, taskIndex, totalTasks,
    status: "running", step: 0, maxSteps: task.steps.length,
  });

  let workingTabId = tabId;

  if (task.openInNewTab) {
    const newTab = await chrome.tabs.create({ url: task.url });
    workingTabId = newTab.id!;
    void windowId;
    await waitForTabLoad(workingTabId);
  } else {
    const navigated = await navigateIfNeeded(workingTabId, task.url, currentTabUrl);
    if (!navigated) {
      broadcastProgress({
        taskId: task.id, taskIndex, totalTasks,
        status: "running", step: 0, maxSteps: task.steps.length,
        detail: `Already on ${new URL(task.url).hostname} — skipping navigation.`,
      });
    }
  }

  await ensureContentScript(workingTabId);

  for (let i = 0; i < task.steps.length; i++) {
    if (_stopRequested) {
      result.status = "failed";
      result.error = "Stopped by user.";
      broadcastProgress({
        taskId: task.id, taskIndex, totalTasks,
        status: "failed", step: i + 1, maxSteps: task.steps.length,
        error: result.error,
      });
      return { result, finalTabId: workingTabId };
    }

    const step = task.steps[i];
    const stepNum = i + 1;
    const stepStart = Date.now();

    let execResult: { success: boolean; message: string };

    try {
      const response = await sendToContent<{ type: string; payload: { success: boolean; message: string } }>(
        workingTabId,
        { type: "EXECUTE_SCRIPTED_STEP", payload: step }
      );
      execResult = response.payload;
    } catch (e) {
      try {
        await ensureContentScript(workingTabId);
        const retry = await sendToContent<{ type: string; payload: { success: boolean; message: string } }>(
          workingTabId,
          { type: "EXECUTE_SCRIPTED_STEP", payload: step }
        );
        execResult = retry.payload;
      } catch (e2) {
        execResult = { success: false, message: String(e2) };
      }
    }

    const latencyMs = Date.now() - stepStart;
    const totalLatencyMs = Date.now() - taskStartTime;

    const log: TaskStepLog = {
      step: stepNum,
      actionType: step.action,
      detail: step.note ?? step.cssSelector ?? step.value ?? "",
      success: execResult.success,
      message: execResult.message,
      latencyMs,
    };
    result.logs.push(log);
    result.stepsRun = stepNum;

    broadcastProgress({
      taskId: task.id, taskIndex, totalTasks,
      status: "running", step: stepNum, maxSteps: task.steps.length,
      actionType: step.action,
      detail: execResult.message,
      stepLatencyMs: latencyMs,
      totalLatencyMs,
    });

    await new Promise((r) => setTimeout(r, INTER_STEP_DELAY_MS));

    if (step.action === "CLICK" || step.action === "PRESS_KEY") {
      await waitForTabLoad(workingTabId, POST_CLICK_LOAD_MS);
      await ensureContentScript(workingTabId);
    }
  }

  result.status = "done";

  broadcastProgress({
    taskId: task.id, taskIndex, totalTasks,
    status: "done", step: task.steps.length, maxSteps: task.steps.length,
    totalLatencyMs: Date.now() - taskStartTime,
  });

  return { result, finalTabId: workingTabId };
}

// Agent task runner (calls backend for each step)

async function callAgentStep(state: BrowserState): Promise<AgentStepResponse> {
  const body = {
    session_id: state.sessionId,
    task: state.task,
    url: state.url,
    page_title: state.pageTitle,
    visible_text: state.visibleText,
    ui_elements: state.uiElements,
    sanitized_screenshot_b64: state.sanitizedScreenshotB64 ?? null,
  };

  const res = await fetch(`${API_BASE}/agent/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<AgentStepResponse>;
}

async function requestUserConfirmation(
  action: AgentStepResponse["action"],
  reasoning: string
): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: "CONFIRMATION_REQUIRED",
      payload: { action, reasoning },
    }).catch(() => {});

    const listener = (msg: { type: string; payload: { confirmed: boolean } }) => {
      if (msg.type === "CONFIRMATION_RESPONSE") {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.payload.confirmed);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    setTimeout(() => { chrome.runtime.onMessage.removeListener(listener); resolve(false); }, 60_000);
  });
}

async function runAgentTask(
  task: AgentTask,
  taskIndex: number,
  totalTasks: number,
  tabId: number,
  windowId: number,
  sessionId: string,
  currentTabUrl: string
): Promise<{ result: TaskResult; finalTabId: number }> {
  const result: TaskResult = {
    taskId: task.id,
    status: "running",
    stepsRun: 0,
    logs: [],
  };

  const taskStartTime = Date.now();

  broadcastProgress({
    taskId: task.id, taskIndex, totalTasks,
    status: "running", step: 0, maxSteps: task.maxSteps,
  });

  let workingTabId = tabId;

  if (task.openInNewTab) {
    const newTab = await chrome.tabs.create({ url: task.url });
    workingTabId = newTab.id!;
    void windowId;
    await waitForTabLoad(workingTabId);
  } else {
    await navigateIfNeeded(workingTabId, task.url, currentTabUrl);
  }

  await ensureContentScript(workingTabId);

  for (let step = 1; step <= task.maxSteps; step++) {
    if (_stopRequested) {
      result.status = "failed";
      result.error = "Stopped by user.";
      broadcastProgress({
        taskId: task.id, taskIndex, totalTasks,
        status: "failed", step, maxSteps: task.maxSteps, error: result.error,
      });
      return { result, finalTabId: workingTabId };
    }

    const stepStart = Date.now();

    let state: BrowserState;
    try {
      const msg = await sendToContent<{ type: string; payload: BrowserState }>(
        workingTabId,
        { type: "COLLECT_STATE", payload: { task: task.task, sessionId } }
      );
      state = msg.payload;
    } catch {
      try {
        await ensureContentScript(workingTabId);
        const retry = await sendToContent<{ type: string; payload: BrowserState }>(
          workingTabId,
          { type: "COLLECT_STATE", payload: { task: task.task, sessionId } }
        );
        state = retry.payload;
      } catch (e2) {
        result.status = "failed";
        result.error = `DOM collection failed: ${String(e2)}`;
        broadcastProgress({
          taskId: task.id, taskIndex, totalTasks,
          status: "failed", step, maxSteps: task.maxSteps, error: result.error,
        });
        return { result, finalTabId: workingTabId };
      }
    }

    state.sanitizedScreenshotB64 = await captureScreenshot(
      (await chrome.tabs.get(workingTabId)).windowId
    );

    let agentResp: AgentStepResponse;
    try {
      agentResp = await callAgentStep(state);
    } catch (e) {
      result.status = "failed";
      result.error = `Backend error: ${String(e)}`;
      broadcastProgress({
        taskId: task.id, taskIndex, totalTasks,
        status: "failed", step, maxSteps: task.maxSteps, error: result.error,
      });
      return { result, finalTabId: workingTabId };
    }

    const { action, reasoning, done } = agentResp;

    const isDestructive =
      DESTRUCTIVE_VALUES.has((action.value ?? "").toLowerCase().trim()) ||
      action.type === "ASK_USER_CONFIRMATION";

    if (isDestructive) {
      const confirmed = await requestUserConfirmation(action, reasoning);
      if (!confirmed) {
        result.status = "failed";
        result.error = "User declined confirmation.";
        broadcastProgress({
          taskId: task.id, taskIndex, totalTasks,
          status: "failed", step, maxSteps: task.maxSteps, error: result.error,
        });
        return { result, finalTabId: workingTabId };
      }
    }

    let execSuccess = true;
    let execMessage = "";

    try {
      const execResult = await sendToContent<{
        type: string; payload: { success: boolean; message: string };
      }>(workingTabId, { type: "EXECUTE_ACTION", payload: action });
      execSuccess = execResult.payload.success;
      execMessage = execResult.payload.message;
    } catch (e) {
      execSuccess = false;
      execMessage = String(e);
    }

    const latencyMs = Date.now() - stepStart;
    const totalLatencyMs = Date.now() - taskStartTime;

    result.logs.push({
      step,
      actionType: action.type,
      detail: reasoning,
      success: execSuccess,
      message: execMessage,
      latencyMs,
    });
    result.stepsRun = step;

    broadcastProgress({
      taskId: task.id, taskIndex, totalTasks,
      status: done ? "done" : "running",
      step, maxSteps: task.maxSteps,
      actionType: action.type,
      detail: reasoning,
      stepLatencyMs: latencyMs,
      totalLatencyMs,
    });

    if (done) {
      result.status = "done";
      return { result, finalTabId: workingTabId };
    }

    await new Promise((r) => setTimeout(r, INTER_STEP_DELAY_MS));

    if (action.type === "CLICK" && step < task.maxSteps) {
      await waitForTabLoad(workingTabId, POST_CLICK_LOAD_MS);
      await ensureContentScript(workingTabId);
    }
  }

  result.status = "failed";
  result.error = `Max steps (${task.maxSteps}) reached without completion.`;
  broadcastProgress({
    taskId: task.id, taskIndex, totalTasks,
    status: "failed", step: task.maxSteps, maxSteps: task.maxSteps,
    error: result.error,
  });
  return { result, finalTabId: workingTabId };
}

// Public: run ALL tasks sequentially

export async function runAllTasks(sessionId: string): Promise<TaskResult[]> {
  resetStop();

  const tasks = TASKS as TaskDefinition[];
  const results: TaskResult[] = [];

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let workingTabId: number;
  let workingTabUrl: string;

  if (activeTab?.id) {
    workingTabId = activeTab.id;
    workingTabUrl = activeTab.url ?? "";
  } else {
    const newTab = await chrome.tabs.create({ url: "about:blank" });
    workingTabId = newTab.id!;
    workingTabUrl = "about:blank";
  }

  const workingWindowId = (await chrome.tabs.get(workingTabId)).windowId;

  for (let i = 0; i < tasks.length; i++) {
    if (_stopRequested) break;

    const task = tasks[i];
    let outcome: { result: TaskResult; finalTabId: number };

    if (task.mode === "scripted") {
      outcome = await runScriptedTask(
        task, i, tasks.length, workingTabId, workingWindowId, workingTabUrl
      );
    } else {
      outcome = await runAgentTask(
        task, i, tasks.length, workingTabId, workingWindowId, sessionId, workingTabUrl
      );
    }

    results.push(outcome.result);

    workingTabId  = outcome.finalTabId;
    workingTabUrl = (await chrome.tabs.get(workingTabId)).url ?? "";

    if (i < tasks.length - 1 && !_stopRequested) {
      await new Promise((r) => setTimeout(r, INTER_TASK_DELAY_MS));
    }
  }

  const succeeded = results.filter((r) => r.status === "done").length;
  const failed    = results.filter((r) => r.status === "failed").length;

  chrome.runtime.sendMessage({
    type: "ALL_TASKS_DONE",
    payload: { results, totalTasks: tasks.length, succeeded, failed },
  }).catch(() => {});

  return results;
}
