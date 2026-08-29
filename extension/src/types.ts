/**
 * types.ts — Shared type definitions across the extension.
 *
 * These mirror the FastAPI Pydantic schemas so the extension and backend
 * stay in sync. Update both when the API contract changes.
 */

// UI Element — collected from the DOM

export interface UIElement {
  id: string;           // data-agent-id assigned by the extension
  role: string;         // ARIA role or inferred role
  tag: string;          // lowercase HTML tag name
  text: string;         // visible text / placeholder
  attributes: Record<string, string>;
}

// Browser State — sent to the server

export interface BrowserState {
  sessionId: string;
  task: string;
  url: string;
  pageTitle: string;
  visibleText: string;
  uiElements: UIElement[];
  sanitizedScreenshotB64?: string;   // reserved for future VLM integration
}

// Agent Actions

export type ActionType =
  | "CLICK"
  | "TYPE"
  | "SCROLL"
  | "SELECT"
  | "PRESS_KEY"
  | "WAIT"
  | "DONE"
  | "ASK_USER_CONFIRMATION";

export interface AgentAction {
  type: ActionType;
  target_id?: string;    // data-agent-id of the target element
  value?: string;        // text to type or option value to select
  key_to_press?: string; // key name for PRESS_KEY (e.g. "Enter", "Tab")
  scroll_x?: number;
  scroll_y?: number;
  wait_ms?: number;
  confidence?: number;   // model confidence in this action [0–1]
}

// API Response

export interface AgentStepResponse {
  session_id: string;
  action: AgentAction;
  reasoning: string;
  done: boolean;
}

// Internal Messages (Extension ↔ Background ↔ Content)

export type MessageType =
  | "COLLECT_STATE"
  | "STATE_COLLECTED"
  | "EXECUTE_ACTION"
  | "EXECUTE_SCRIPTED_STEP"
  | "ACTION_RESULT"
  | "RUN_AGENT_STEP"
  | "AGENT_STEP_RESULT"
  | "RUN_ALL_TASKS"
  | "TASK_PROGRESS"
  | "ALL_TASKS_DONE"
  | "STOP_EXECUTOR"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_RESPONSE"
  | "ERROR";

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface CollectStateMessage extends ExtensionMessage {
  type: "COLLECT_STATE";
  payload: { task: string; sessionId: string };
}

export interface StateCollectedMessage extends ExtensionMessage {
  type: "STATE_COLLECTED";
  payload: BrowserState;
}

export interface ExecuteActionMessage extends ExtensionMessage {
  type: "EXECUTE_ACTION";
  payload: AgentAction;
}

export interface ActionResultMessage extends ExtensionMessage {
  type: "ACTION_RESULT";
  payload: { success: boolean; message: string };
}

export interface RunAgentStepMessage extends ExtensionMessage {
  type: "RUN_AGENT_STEP";
  payload: { task: string; sessionId: string };
}

export interface AgentStepResultMessage extends ExtensionMessage {
  type: "AGENT_STEP_RESULT";
  payload: AgentStepResponse;
}

export interface ErrorMessage extends ExtensionMessage {
  type: "ERROR";
  payload: { message: string };
}

// Executor — Task definitions (mirrors tasks.json)

export interface ScriptedStep {
  action: "CLICK" | "TYPE" | "PRESS_KEY" | "SCROLL" | "WAIT" | "NAVIGATE" | "CLICK_TEXT";
  cssSelector?: string;
  value?: string;         // text to type, text to match (CLICK_TEXT), or option value
  url?: string;           // destination URL for NAVIGATE
  key_to_press?: string;
  scroll_x?: number;
  scroll_y?: number;
  wait_ms?: number;
  note?: string;
}

export interface ScriptedTask {
  id: string;
  description: string;
  mode: "scripted";
  url: string;
  openInNewTab: boolean;
  steps: ScriptedStep[];
}

export interface AgentTask {
  id: string;
  description: string;
  mode: "agent";
  url: string;
  task: string;
  openInNewTab: boolean;
  maxSteps: number;
}

export type TaskDefinition = ScriptedTask | AgentTask;

export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface TaskStepLog {
  step: number;
  actionType: string;
  detail: string;
  success: boolean;
  message: string;
  latencyMs: number;
}

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  stepsRun: number;
  logs: TaskStepLog[];
  error?: string;
}

export interface ExecutorState {
  running: boolean;
  tasks: TaskDefinition[];
  results: TaskResult[];
  currentTaskIndex: number;
}

// Executor Messages

export interface RunAllTasksMessage extends ExtensionMessage {
  type: "RUN_ALL_TASKS";
  payload: { sessionId: string };
}

export interface TaskProgressMessage extends ExtensionMessage {
  type: "TASK_PROGRESS";
  payload: {
    taskId: string;
    taskIndex: number;
    totalTasks: number;
    status: TaskStatus;
    step: number;
    maxSteps: number;
    action?: AgentAction;
    reasoning?: string;
    error?: string;
    stepLatencyMs?: number;
    totalLatencyMs?: number;
  };
}

export interface ConfirmationRequiredMessage extends ExtensionMessage {
  type: "CONFIRMATION_REQUIRED";
  payload: { action: AgentAction; reasoning: string };
}

export interface ConfirmationResponseMessage extends ExtensionMessage {
  type: "CONFIRMATION_RESPONSE";
  payload: { confirmed: boolean };
}

export interface AllTasksDoneMessage extends ExtensionMessage {
  type: "ALL_TASKS_DONE";
  payload: {
    results: TaskResult[];
    totalTasks: number;
    succeeded: number;
    failed: number;
  };
}

export interface StopExecutorMessage extends ExtensionMessage {
  type: "STOP_EXECUTOR";
}
