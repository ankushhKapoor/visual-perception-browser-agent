/**
 * content.ts — Content script injected into every page.
 *
 * Responsibilities:
 *   1. COLLECT_STATE  — Scan the DOM, tag interactive elements with
 *                       unique data-agent-ids, return a BrowserState.
 *   2. EXECUTE_ACTION — Execute a CLICK / TYPE / SCROLL / WAIT / DONE
 *                       action using data-agent-ids to locate elements.
 */

import type {
  AgentAction,
  BrowserState,
  CollectStateMessage,
  ExecuteActionMessage,
  UIElement,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ID_ATTR = "data-agent-id";
const AGENT_ID_PREFIX = "ag";

// Selectors for interactive elements
const INTERACTIVE_SELECTOR = [
  "input:not([type='hidden'])",
  "textarea",
  "button",
  "select",
  "a[href]",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='option']",
].join(", ");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function assignAgentId(el: Element): string {
  if (!el.hasAttribute(AGENT_ID_ATTR)) {
    el.setAttribute(AGENT_ID_ATTR, `${AGENT_ID_PREFIX}-${++_idCounter}`);
  }
  return el.getAttribute(AGENT_ID_ATTR)!;
}

function inferRole(el: Element): string {
  const ariaRole = el.getAttribute("role");
  if (ariaRole) return ariaRole;

  const tag = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type?.toLowerCase() ?? "";

  const roleMap: Record<string, string> = {
    button: "button",
    a: "link",
    select: "combobox",
    textarea: "textbox",
  };
  if (roleMap[tag]) return roleMap[tag];

  if (tag === "input") {
    const inputRoleMap: Record<string, string> = {
      checkbox: "checkbox",
      radio: "radio",
      range: "slider",
      number: "spinbutton",
      search: "searchbox",
      email: "textbox",
      password: "textbox",
      text: "textbox",
      tel: "textbox",
      url: "textbox",
    };
    return inputRoleMap[type] ?? "textbox";
  }

  return tag;
}

function getElementText(el: Element): string {
  const input = el as HTMLInputElement;
  return (
    input.value ||
    input.placeholder ||
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.textContent?.trim().slice(0, 120) ||
    ""
  );
}

function getAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  const keep = ["type", "name", "id", "aria-label", "placeholder", "href", "title"];
  for (const attr of keep) {
    const val = el.getAttribute(attr);
    if (val) attrs[attr] = val;
  }
  return attrs;
}

function getVisibleText(): string {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        const ignored = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
        if (ignored.includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const texts: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 0) texts.push(text);
  }
  // Limit to 4000 chars to avoid huge payloads
  return texts.join(" ").slice(0, 4000);
}

// ---------------------------------------------------------------------------
// State Collection
// ---------------------------------------------------------------------------

function collectState(task: string, sessionId: string): BrowserState {
  _idCounter = 0; // Reset IDs on each collection pass

  const elements = Array.from(
    document.querySelectorAll<Element>(INTERACTIVE_SELECTOR)
  );

  const uiElements: UIElement[] = elements
    .filter((el) => {
      // Skip hidden elements
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .slice(0, 100) // Cap at 100 elements to avoid huge payloads
    .map((el) => ({
      id: assignAgentId(el),
      role: inferRole(el),
      tag: el.tagName.toLowerCase(),
      text: getElementText(el),
      attributes: getAttributes(el),
    }));

  return {
    sessionId,
    task,
    url: window.location.href,
    pageTitle: document.title,
    visibleText: getVisibleText(),
    uiElements,
  };
}

// ---------------------------------------------------------------------------
// Action Execution
// ---------------------------------------------------------------------------

async function executeAction(action: AgentAction): Promise<{ success: boolean; message: string }> {
  const { type } = action;

  if (type === "DONE") {
    return { success: true, message: "Task marked as DONE. No action performed." };
  }

  if (type === "WAIT") {
    const ms = action.wait_ms ?? 1000;
    await new Promise((res) => setTimeout(res, ms));
    return { success: true, message: `Waited ${ms}ms.` };
  }

  if (type === "SCROLL") {
    const x = action.scroll_x ?? 0;
    const y = action.scroll_y ?? 500;
    window.scrollBy({ left: x, top: y, behavior: "smooth" });
    return { success: true, message: `Scrolled by (${x}, ${y}).` };
  }

  // CLICK / TYPE — need a target element
  const targetId = action.target_id;
  if (!targetId) {
    return { success: false, message: `Action ${type} requires target_id but none was provided.` };
  }

  const el = document.querySelector<HTMLElement>(`[${AGENT_ID_ATTR}="${targetId}"]`);
  if (!el) {
    return {
      success: false,
      message: `Element with ${AGENT_ID_ATTR}="${targetId}" not found in DOM.`,
    };
  }

  // Scroll element into view
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  await new Promise((res) => setTimeout(res, 150));

  if (type === "CLICK") {
    el.focus();
    el.click();
    return { success: true, message: `Clicked element "${targetId}".` };
  }

  if (type === "TYPE") {
    const input = el as HTMLInputElement;
    el.focus();
    // Clear existing value
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const value = action.value ?? "";
    for (const char of value) {
      input.value += char;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await new Promise((res) => setTimeout(res, 20)); // Human-like delay
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, message: `Typed "${value}" into element "${targetId}".` };
  }

  return { success: false, message: `Unknown action type: ${type}` };
}

// ---------------------------------------------------------------------------
// Message Listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: CollectStateMessage | ExecuteActionMessage, _sender, sendResponse) => {
  if (message.type === "COLLECT_STATE") {
    const { task, sessionId } = message.payload;
    const state = collectState(task, sessionId);
    sendResponse({ type: "STATE_COLLECTED", payload: state });
    return true;
  }

  if (message.type === "EXECUTE_ACTION") {
    const action = message.payload as AgentAction;
    executeAction(action).then((result) => {
      sendResponse({ type: "ACTION_RESULT", payload: result });
    });
    return true; // Keep channel open for async response
  }
});

console.log("[VisionAgent] Content script loaded.");
