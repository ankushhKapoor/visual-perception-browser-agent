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

// Constants

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

// Helpers

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

function setInputValue(input: HTMLInputElement, value: string): void {
  // Use the native setter so frameworks such as YouTube observe the edit.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
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

// State Collection

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

// Action Execution

async function executeAction(action: AgentAction): Promise<{ success: boolean; message: string }> {
  const { type } = action;

  if (type === "DONE" || type === "ASK_USER_CONFIRMATION") {
    return { success: true, message: `${type} acknowledged.` };
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

  if (type === "PRESS_KEY") {
    const key = action.key_to_press ?? action.value ?? "Enter";
    const targetId = action.target_id;
    const target = targetId
      ? (document.querySelector<HTMLElement>(`[${AGENT_ID_ATTR}="${targetId}"]`) ?? document.body)
      : (document.activeElement as HTMLElement) ?? document.body;

    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
    if (key === "Enter") {
      const input = target as HTMLInputElement;
      if (input.form) {
        try { input.form.requestSubmit(); } catch { input.form.submit(); }
      } else {
        const submitButton = target.closest("form")?.querySelector<HTMLElement>(
          "button[type='submit'], input[type='submit']"
        );
        submitButton?.click();
      }
    }
    return { success: true, message: `Pressed key "${key}".` };
  }

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
    setInputValue(input, "");

    const value = action.value ?? "";
    for (const char of value) {
      setInputValue(input, input.value + char);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await new Promise((res) => setTimeout(res, 20));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, message: `Typed "${value}" into element "${targetId}".` };
  }

  if (type === "SELECT") {
    const select = el as HTMLSelectElement;
    const value = action.value ?? "";
    const option = Array.from(select.options).find(
      (o) => o.value === value || o.text.toLowerCase() === value.toLowerCase()
    );
    if (!option) {
      return { success: false, message: `Option "${value}" not found in select "${targetId}".` };
    }
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, message: `Selected "${option.text}" in "${targetId}".` };
  }

  return { success: false, message: `Unknown action type: ${type}` };
}

// Scripted Step Execution — uses CSS selectors, no data-agent-id needed

async function executeScriptedStep(step: {
  action: string;
  cssSelector?: string;
  value?: string;
  key_to_press?: string;
  scroll_x?: number;
  scroll_y?: number;
  wait_ms?: number;
}): Promise<{ success: boolean; message: string }> {
  const { action } = step;

  if (action === "WAIT") {
    const ms = step.wait_ms ?? 1000;
    await new Promise((r) => setTimeout(r, ms));
    return { success: true, message: `Waited ${ms}ms.` };
  }

  if (action === "SCROLL") {
    const x = step.scroll_x ?? 0;
    const y = step.scroll_y ?? 500;
    window.scrollBy({ left: x, top: y, behavior: "smooth" });
    return { success: true, message: `Scrolled (${x}, ${y}).` };
  }

  if (action === "PRESS_KEY") {
    const key = step.key_to_press ?? "Enter";
    const keyCodeMap: Record<string, number> = {
      Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Space: 32,
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    };
    const keyCode = keyCodeMap[key] ?? key.charCodeAt(0);
    const eventInit = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true };

    const target = (document.activeElement as HTMLElement) ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown",  eventInit));
    target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    target.dispatchEvent(new KeyboardEvent("keyup",    eventInit));

    if (key === "Enter") {
      const input = target as HTMLInputElement;
      if (input.form) {
        try { input.form.requestSubmit(); } catch { input.form.submit(); }
      } else {
        const submitButton = target.closest("form")?.querySelector<HTMLElement>(
          "button[type='submit'], input[type='submit']"
        );
        submitButton?.click();
      }
    }

    return { success: true, message: `Pressed key "${key}".` };
  }

  // CLICK / TYPE — need a CSS selector
  if (!step.cssSelector) {
    return { success: false, message: `${action} requires cssSelector.` };
  }

  // Try each comma-separated selector until one resolves to a visible element
  const selectors = step.cssSelector.split(",").map((s) => s.trim());
  let el: HTMLElement | null = null;

  for (const sel of selectors) {
    try {
      const found = document.querySelector<HTMLElement>(sel);
      if (found) {
        const rect = found.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el = found;
          break;
        }
      }
    } catch {
      // Invalid selector — skip
    }
  }

  if (!el) {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>("a, button, [role='button']")
    );
    el = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const label = (candidate.getAttribute("aria-label") || candidate.textContent || "")
        .trim()
        .toLowerCase();
      return rect.width > 0 && rect.height > 0 && /^(go|start)(\s|$)/.test(label);
    }) ?? null;
  }

  if (!el) {
    return {
      success: false,
      message: `No visible element found for selectors: "${step.cssSelector}".`,
    };
  }

  el.scrollIntoView({ block: "center", behavior: "smooth" });
  await new Promise((r) => setTimeout(r, 150));

  if (action === "CLICK") {
    el.focus();
    const clickable = el.matches("a, button, [role='button']")
      ? el
      : el.querySelector<HTMLElement>("a, button, [role='button']") ?? el;
    clickable.click();
    return { success: true, message: `Clicked "${step.cssSelector}".` };
  }

  if (action === "TYPE") {
    const input = el as HTMLInputElement;
    el.focus();
    setInputValue(input, "");
    const value = step.value ?? "";
    for (const char of value) {
      setInputValue(input, input.value + char);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await new Promise((r) => setTimeout(r, 25));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { success: true, message: `Typed "${value}" into "${step.cssSelector}".` };
  }

  return { success: false, message: `Unknown scripted action: ${action}` };
}

// Message Listener

chrome.runtime.onMessage.addListener((message: CollectStateMessage | ExecuteActionMessage, _sender, sendResponse) => {
  // Liveness probe used by the executor before collecting state
  if ((message as { type: string }).type === "__PING__") {
    sendResponse({ type: "__PONG__" });
    return false;
  }

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
    return true;
  }

  if ((message as { type: string }).type === "EXECUTE_SCRIPTED_STEP") {
    const step = (message as { type: string; payload: unknown }).payload as Parameters<typeof executeScriptedStep>[0];
    executeScriptedStep(step).then((result) => {
      sendResponse({ type: "ACTION_RESULT", payload: result });
    });
    return true;
  }
});
