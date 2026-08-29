/**
 * types.ts — Shared type definitions across the extension.
 *
 * These mirror the FastAPI Pydantic schemas so the extension and backend
 * stay in sync. Update both when the API contract changes.
 */

// ---------------------------------------------------------------------------
// UI Element — collected from the DOM
// ---------------------------------------------------------------------------

export interface UIElement {
  id: string;           // data-agent-id assigned by the extension
  role: string;         // ARIA role or inferred role
  tag: string;          // lowercase HTML tag name
  text: string;         // visible text / placeholder
  attributes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Browser State — sent to the server
// ---------------------------------------------------------------------------

export interface BrowserState {
  sessionId: string;
  task: string;
  url: string;
  pageTitle: string;
  visibleText: string;
  uiElements: UIElement[];
  sanitizedScreenshotB64?: string;   // reserved for future VLM integration
}

// ---------------------------------------------------------------------------
// Agent Actions
// ---------------------------------------------------------------------------

export type ActionType = "CLICK" | "TYPE" | "SCROLL" | "WAIT" | "DONE";

export interface AgentAction {
  type: ActionType;
  target_id?: string;   // data-agent-id
  value?: string;       // text to type
  scroll_x?: number;
  scroll_y?: number;
  wait_ms?: number;
}

// ---------------------------------------------------------------------------
// API Response
// ---------------------------------------------------------------------------

export interface AgentStepResponse {
  session_id: string;
  action: AgentAction;
  reasoning: string;
  done: boolean;
}

// ---------------------------------------------------------------------------
// Internal Messages (Extension ↔ Background ↔ Content)
// ---------------------------------------------------------------------------

export type MessageType =
  | "COLLECT_STATE"
  | "STATE_COLLECTED"
  | "EXECUTE_ACTION"
  | "ACTION_RESULT"
  | "RUN_AGENT_STEP"
  | "AGENT_STEP_RESULT"
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
