/**
 * executor.js — Browser automation task executor for the Visual Perception Agent.
 *
 * Receives a tasks.json array and executes each step sequentially in the DOM.
 * Supports: click, type, select, scroll, wait, navigate, hover, screenshot.
 *
 * Runs as a content script with direct DOM access.
 */

/* ============================================================
   Utility helpers
   ============================================================ */

/**
 * Resolve an element from a task target object.
 * Tries elementId index → CSS selector → centre-of-rect click.
 */
function resolveElement(target) {
  if (!target) return null;

  // elementId format: "element_N" — look it up in the DOM index built by content.js
  if (target.elementId) {
    const index = parseInt(target.elementId.replace("element_", ""), 10) - 1;
    if (!isNaN(index) && index >= 0) {
      const allInteractive = document.querySelectorAll(
        "button, input, textarea, select, a[href], [contenteditable='true'], " +
        "[role='button'], [role='link'], [role='textbox'], [role='checkbox'], " +
        "[role='radio'], [role='tab'], [role='menuitem'], h1, h2, h3, h4, h5, h6"
      );
      if (allInteractive[index]) return allInteractive[index];
    }
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
 * Simulate a realistic click: focus → mousedown → mouseup → click.
 */
function simulateClick(element) {
  element.focus({ preventScroll: true });
  ["mousedown", "mouseup", "click"].forEach((eventType) => {
    element.dispatchEvent(
      new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window })
    );
  });
}

/**
 * Simulate typing character-by-character with input/change events.
 */
async function simulateTyping(element, text) {
  element.focus({ preventScroll: true });

  // Clear existing value first
  if ("value" in element) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, "");
    } else {
      element.value = "";
    }
  }

  for (const char of String(text)) {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: char, bubbles: true })
    );
    element.dispatchEvent(
      new KeyboardEvent("keypress", { key: char, bubbles: true })
    );

    if ("value" in element) {
      element.value += char;
    } else if (element.isContentEditable) {
      element.textContent += char;
    }

    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: char }));
    element.dispatchEvent(
      new KeyboardEvent("keyup", { key: char, bubbles: true })
    );

    await delay(30 + Math.random() * 40); // human-like timing
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/* ============================================================
   Action executors
   ============================================================ */

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
    console.warn(`[Executor] Selector '${task.selector}' not found within ${timeoutMs}ms`);
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

async function executeScreenshot(_task) {
  // Signal background.js to re-capture and re-analyse
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "START_ON_DEMAND_CAPTURE" },
      () => {
        if (chrome.runtime.lastError) {
          console.warn("[Executor] Re-capture signal failed:", chrome.runtime.lastError.message);
        }
        resolve();
      }
    );
  });
}

/* ============================================================
   Main task runner
   ============================================================ */

const ACTION_MAP = {
  click:      executeClick,
  type:       executeType,
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
    const { action, description } = step;
    console.log(
      `[Executor] Step ${step.step}/${total}: ${action} — ${description}`
    );

    if (typeof onProgress === "function") {
      onProgress(step.step, total, "running");
    }

    const executor = ACTION_MAP[action];
    if (!executor) {
      const error = `Unknown action '${action}' at step ${step.step}`;
      console.error("[Executor]", error);
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
      console.error(`[Executor] Step ${step.step} failed:`, errorMsg);
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
