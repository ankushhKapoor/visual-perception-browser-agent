/**
 * executor.js — Browser automation task executor for the Visual Perception Agent.
 *
 * Receives a tasks.json array and executes each step sequentially in the DOM.
 * Supports: click, type, select, scroll, wait, navigate, hover, screenshot.
 *
 * Runs as a content script with direct DOM access.
 */

/**
 * Live element map — populated by chatbot.js during getPageContext().
 * Keyed by "element_N" strings, values are the live DOM nodes.
 * When this map is populated, resolveElement() uses it for reliable resolution.
 */
window._vpbaElMap = window._vpbaElMap || new Map();

/**
 * Resolve an element from a task target object.
 * Priority: _vpbaElMap (live references) → CSS selector.
 */
function resolveElement(target) {
  if (!target) return null;

  // Primary: live element map (populated by chatbot.js during capture)
  if (target.elementId) {
    const cached = window._vpbaElMap.get(target.elementId);
    if (cached && document.contains(cached)) return cached;
  }

  // Fallback: CSS selector
  if (target.selector) {
    try {
      const el = document.querySelector(target.selector);
      if (el) return el;
    } catch (_) { /* invalid selector */ }
  }

  return null;
}

/**
 * Scroll the page to make an element visible, then return it.
 */
async function ensureVisible(element) {
  if (!element) return element;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  await delay(300);
  return element;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulate a realistic click: full pointer + mouse event chain.
 * Works for React/SPA frameworks that require the complete sequence.
 */
function simulateClick(element) {
  const rect = element.getBoundingClientRect();
  const cx   = rect.left + rect.width  / 2;
  const cy   = rect.top  + rect.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, detail: 1, clientX: cx, clientY: cy };

  element.dispatchEvent(new PointerEvent("pointerover",  { ...base, isPrimary: true }));
  element.dispatchEvent(new PointerEvent("pointerenter", { ...base, isPrimary: true, bubbles: false }));
  element.dispatchEvent(new MouseEvent("mouseover",  base));
  element.dispatchEvent(new PointerEvent("pointermove", { ...base, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousemove",  base));
  element.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true, button: 0, buttons: 1 }));
  element.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }));
  element.focus({ preventScroll: true });
  element.dispatchEvent(new PointerEvent("pointerup",  { ...base, isPrimary: true, button: 0 }));
  element.dispatchEvent(new MouseEvent("mouseup",  { ...base, button: 0 }));
  element.dispatchEvent(new MouseEvent("click",    { ...base, button: 0 }));
  try { element.click(); } catch (_) {}
}

/**
 * Simulate typing character-by-character with React-compatible native value setter.
 */
async function simulateTyping(element, text) {
  // Click to focus first so React/Vue registers the interaction
  simulateClick(element);
  await delay(100);
  element.focus({ preventScroll: true });
  await delay(50);

  // Clear using native setter so React state updates
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set;
  const nativeTextaSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  if (element instanceof HTMLInputElement && nativeInputSetter) {
    nativeInputSetter.call(element, "");
  } else if (element instanceof HTMLTextAreaElement && nativeTextaSetter) {
    nativeTextaSetter.call(element, "");
  } else if ("value" in element) {
    element.value = "";
  }
  element.dispatchEvent(new Event("input",  { bubbles: true }));

  for (const char of String(text)) {
    element.dispatchEvent(new KeyboardEvent("keydown",  { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));

    // Append using native setter for React incremental state update
    if (element instanceof HTMLInputElement && nativeInputSetter) {
      nativeInputSetter.call(element, element.value + char);
    } else if (element instanceof HTMLTextAreaElement && nativeTextaSetter) {
      nativeTextaSetter.call(element, element.value + char);
    } else if ("value" in element) {
      element.value += char;
    } else if (element.isContentEditable) {
      element.textContent += char;
    }

    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
    element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));

    await delay(30 + Math.random() * 40); // human-like timing
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function executeClick(task) {
  const element = resolveElement(task.target);
  if (!element) {
    throw new Error(
      `click: could not resolve element for target ${JSON.stringify(task.target)}`
    );
  }
  await ensureVisible(element);
  simulateClick(element);
  await delay(200);
}

async function executeType(task) {
  const element = resolveElement(task.target);
  if (!element) {
    throw new Error(
      `type: could not resolve element for target ${JSON.stringify(task.target)}`
    );
  }
  await ensureVisible(element);
  simulateClick(element);
  await delay(150);
  await simulateTyping(element, task.value || "");
}

async function executeSelect(task) {
  const element = resolveElement(task.target);
  if (!element || element.tagName.toLowerCase() !== "select") {
    throw new Error(
      `select: target is not a <select> element: ${JSON.stringify(task.target)}`
    );
  }
  await ensureVisible(element);

  const value = String(task.value || "");
  // Try matching by option value first, then by visible text
  let matched = false;
  for (const option of element.options) {
    if (
      option.value === value ||
      option.text.trim().toLowerCase() === value.toLowerCase()
    ) {
      element.value = option.value;
      matched = true;
      break;
    }
  }

  if (!matched) {
    throw new Error(
      `select: no option matching '${value}' in <select>`
    );
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
  await delay(150);
}

async function executeScroll(task) {
  const direction = task.direction || "down";
  const pixels = task.pixels || 300;

  if (task.target) {
    const element = resolveElement(task.target);
    if (element) {
      await ensureVisible(element);
      return;
    }
  }

  const scrollMap = {
    down:  { top: pixels,    left: 0 },
    up:    { top: -pixels,   left: 0 },
    right: { top: 0,         left: pixels },
    left:  { top: 0,         left: -pixels },
  };

  window.scrollBy({ ...scrollMap[direction], behavior: "smooth" });
  await delay(400);
}

async function executeWait(task) {
  const timeoutMs = task.timeout_ms || 2000;
  const condition = task.condition || "timeout";

  if (condition === "timeout") {
    await delay(timeoutMs);
    return;
  }

  if (condition === "navigation") {
    // Wait up to timeoutMs for document ready state to become 'complete'
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.readyState === "complete") return;
      await delay(100);
    }
    return; // don't throw — page might still be interactive
  }

  if (condition === "selector" && task.selector) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelector(task.selector)) return;
      await delay(100);
    }
    return;
  }

  await delay(timeoutMs);
}

async function executeNavigate(task) {
  if (!task.url) throw new Error("navigate: 'url' is required");
  window.location.href = task.url;
  await delay(500);
}

async function executeHover(task) {
  const element = resolveElement(task.target);
  if (!element) {
    throw new Error(
      `hover: could not resolve element for target ${JSON.stringify(task.target)}`
    );
  }
  await ensureVisible(element);
  element.dispatchEvent(
    new MouseEvent("mouseover", { bubbles: true, cancelable: true })
  );
  element.dispatchEvent(
    new MouseEvent("mouseenter", { bubbles: true, cancelable: true })
  );
  await delay(200);
}

async function executeKey(task) {
  const key    = task.key || task.value || "Enter";
  const el     = task.target ? resolveElement(task.target) : document.activeElement;
  const target = el || document.body;
  const opts   = { key, bubbles: true, cancelable: true, view: window };

  target.dispatchEvent(new KeyboardEvent("keydown",  opts));
  await delay(60);
  target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup",    opts));

  if (key === "Enter" && el && el.form) {
    el.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
  await delay(200);
}

async function executeScreenshot(_task) {
  // Signal background.js to re-capture and re-analyse
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "START_ON_DEMAND_CAPTURE" },
      () => {
        resolve();
      }
    );
  });
}

const ACTION_MAP = {
  click:      executeClick,
  type:       executeType,
  key:        executeKey,
  select:     executeSelect,
  scroll:     executeScroll,
  wait:       executeWait,
  navigate:   executeNavigate,
  hover:      executeHover,
  screenshot: executeScreenshot,
};

/**
 * Execute a full tasks.json plan.
 *
 * @param {Object} tasksJson - The validated tasks.json object from the VLM.
 * @param {Function} onProgress - Callback(stepIndex, total, status, error?) called per step.
 * @returns {Promise<{success: boolean, completedSteps: number, error?: string}>}
 */
async function executeTasks(tasksJson, onProgress) {
  const steps = tasksJson?.tasks;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { success: false, completedSteps: 0, error: "No tasks to execute" };
  }

  const total = steps.length;
  let completedSteps = 0;

  for (const step of steps) {
    const { action } = step;
    if (typeof onProgress === "function") {
      onProgress(step.step, total, "running");
    }

    const executor = ACTION_MAP[action];
    if (!executor) {
      const error = `Unknown action '${action}' at step ${step.step}`;
      if (typeof onProgress === "function") onProgress(step.step, total, "error", error);
      return { success: false, completedSteps, error };
    }

    try {
      await executor(step);
      completedSteps++;
      if (typeof onProgress === "function") {
        onProgress(step.step, total, "done");
      }
    } catch (err) {
      const errorMsg = err?.message || String(err);
      if (typeof onProgress === "function") {
        onProgress(step.step, total, "error", errorMsg);
      }
      return { success: false, completedSteps, error: errorMsg };
    }

    // Small pause between steps for page stability
    await delay(150);
  }

  return { success: true, completedSteps };
}
