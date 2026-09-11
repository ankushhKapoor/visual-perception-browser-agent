// The browser now talks directly to server-vlm. The old :8000 backend is not
// needed for agent chat, privacy redaction, or task execution.
const DEFAULT_AGENT_TASK_API_URL = "http://127.0.0.1:9001/v1/agent";
const VLM_AGENT_URL_STORAGE_KEY = "vpba_vlm_agent_url";
const captureInProgressTabs = new Set();

async function getAgentTaskApiUrl() {
  const stored = await chrome.storage.local.get(VLM_AGENT_URL_STORAGE_KEY);
  const candidate = String(stored[VLM_AGENT_URL_STORAGE_KEY] || DEFAULT_AGENT_TASK_API_URL).trim();
  try {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    return DEFAULT_AGENT_TASK_API_URL;
  }
}

function isInjectablePageUrl(url) {
  return /^(https?|file):\/\//i.test(String(url || ""));
}

async function dispatchSidePanelTask(text) {
  // Prefer the active tab in the focused window. If that tab is a Chrome
  // internal / extension page (e.g. the new-tab override or chrome://extensions),
  // fall back to the most recently accessed injectable tab across all windows so
  // the user doesn't have to manually switch away before sending a task.
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!tab?.id || !isInjectablePageUrl(tab.url)) {
    // Try: any active tab in any window that is injectable.
    const activeTabs = await chrome.tabs.query({ active: true });
    tab = activeTabs.find(t => isInjectablePageUrl(t.url));
  }

  if (!tab?.id || !isInjectablePageUrl(tab.url)) {
    // Last resort: most recently accessed injectable tab across all tabs.
    const allTabs = await chrome.tabs.query({});
    tab = allTabs
      .filter(t => isInjectablePageUrl(t.url))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }

  if (!tab?.id) {
    throw new Error("No active webpage is available. Open a website first, then send the task.");
  }
  if (!isInjectablePageUrl(tab.url)) {
    throw new Error("The agent cannot run on Chrome internal, extension, or store pages. Navigate to a website first.");
  }

  const send = () => chrome.tabs.sendMessage(tab.id, {
    type: "VPBA_SIDEPANEL_TASK",
    text: String(text || ""),
  });

  try {
    return await send();
  } catch (error) {
    // A tab opened before the extension was reloaded does not contain its
    // content scripts. Inject the same bundled runtime declared in the
    // manifest, then retry once. Both scripts are idempotent on a live page.
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) {
      throw error;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extensions/src/content.js", "extensions/src/chatbot.js"],
    });
    return await send();
  }
}

async function dispatchSidePanelControl(type) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !isInjectablePageUrl(tab.url)) {
    throw new Error("No controllable active webpage is available.");
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(error?.message || "")) {
      throw error;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["extensions/src/content.js", "extensions/src/chatbot.js"],
    });
    return await chrome.tabs.sendMessage(tab.id, { type });
  }
}

// Navigation continuations are intentionally stored in chrome.storage.session
// so they disappear when the browser session ends. Content scripts run in an
// untrusted context and cannot read this area by default, which otherwise
// causes a search or new-tab task to stop after its first phase.
if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(() => {});
}

// The debugger transport is used only as a local, trusted input device. It
// never returns DOM text, screenshots, cookies, network data, or page JS to
// the VLM; the existing sanitized perception path remains the sole model input.
function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function sendCdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

async function dispatchTrustedInput(tabId, request) {
  const point = request?.point || {};
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("Trusted input requires a visible element coordinate");
  }

  await attachDebugger(tabId);
  try {
    // Resolve the coordinate through DevTools before injecting input.  This is
    // intentionally local-only: we return only a boolean node check, never
    // DOM text, attributes, cookies, console output, or network data.
    const hit = await sendCdp(tabId, "DOM.getNodeForLocation", {
      x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true,
    });
    if (!hit?.backendNodeId) {
      throw new Error("No actual page element exists at the requested coordinate");
    }
    await sendCdp(tabId, "DOM.describeNode", { backendNodeId: hit.backendNodeId, depth: 0 });
    const click = async () => {
      await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sendCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    };
    const key = async (keyName) => {
      const keyCode = keyName === "Enter" ? 13 : keyName === "Tab" ? 9 : keyName === "Escape" ? 27 : 0;
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code: keyName, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code: keyName, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    };

    if (request.action === "click") {
      await click();
    } else if (request.action === "type") {
      await click();
      // Select and replace the focused field using trusted keyboard input.
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 });
      await key("Backspace");
      await sendCdp(tabId, "Input.insertText", { text: String(request.value || "") });
    } else if (request.action === "key") {
      await key(String(request.key || "Enter"));
    } else {
      throw new Error(`Unsupported trusted action '${request.action}'`);
    }
    return { actualElementVerified: true };
  } finally {
    await detachDebugger(tabId);
  }
}

// Unlike an injected page panel, Chrome's native side panel survives document
// replacement and tab navigation. It is the persistent browser-wide chat UI.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

// Track which tabs have the side panel open so the FAB can toggle it.
const sidePanelOpenTabs = new Set();
if (chrome.sidePanel?.onShown) {
  chrome.sidePanel.onShown.addListener(({ tabId }) => sidePanelOpenTabs.add(tabId));
}
if (chrome.sidePanel?.onHidden) {
  chrome.sidePanel.onHidden.addListener(({ tabId }) => sidePanelOpenTabs.delete(tabId));
}

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message.type === "VPBA_TOGGLE_SIDE_PANEL") {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId || !chrome.sidePanel) return sendResponse({ success: false });
          await chrome.sidePanel.open({ tabId });
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false, error: e?.message });
        }
      })();
      return true;
    }

    if (message.type === "VPBA_START_SIDE_PANEL_TASK") {
      (async () => {
        try {
          const response = await dispatchSidePanelTask(message.text);
          sendResponse(response?.success
            ? response
            : { success: false, error: response?.error || "Agent task could not start." });
        } catch (error) {
          sendResponse({ success: false, error: error?.message || String(error) });
        }
      })();
      return true;
    }

    if (message.type === "VPBA_STOP_SIDE_PANEL_TASK") {
      (async () => {
        try {
          const response = await dispatchSidePanelControl("VPBA_STOP_SIDE_PANEL_TASK");
          sendResponse(response?.success ? response : { success: false, error: "No running agent task was found." });
        } catch (error) {
          sendResponse({ success: false, error: error?.message || String(error) });
        }
      })();
      return true;
    }

    if (message.type === "VPBA_RUN_LOCAL_PRIVACY_SCAN") {
      (async () => {
        try {
          const response = await dispatchSidePanelControl("RUN_LOCAL_PRIVACY_SCAN");
          sendResponse(response?.success
            ? response
            : { success: false, error: response?.error || "Local privacy scan failed." });
        } catch (error) {
          sendResponse({ success: false, error: error?.message || String(error) });
        }
      })();
      return true;
    }

    if (message.type === "VPBA_AGENT_STATUS" && !message.forwarded) {
      // Forward the page runtime's real lifecycle state to the native panel.
      chrome.runtime.sendMessage({
        type: "VPBA_AGENT_STATUS",
        phase: message.phase,
        text: message.text,
        active: Boolean(message.active),
        forwarded: true,
      }).catch(() => {});
      return false;
    }

    if (message.type === "VPBA_SANITIZED_PREVIEW" && !message.forwarded) {
      // Forward to an open native side panel only. The service worker does not
      // retain preview data, so it disappears when the panel discards it or
      // the extension context is torn down.
      chrome.runtime.sendMessage({
        type: "VPBA_SANITIZED_PREVIEW",
        preview: message.preview,
        forwarded: true,
      }).catch(() => {});
      return false;
    }

    if (message.type === "CAPTURE_SCREENSHOT") {
      if (!sender.tab?.id) {
        sendResponse({ success: false, error: "Capture requires an active tab" });
        return false;
      }

      if (captureInProgressTabs.has(sender.tab.id)) {
        sendResponse({ success: false, error: "Capture already in progress" });
        return false;
      }

      captureInProgressTabs.add(sender.tab.id);
      const windowId = sender.tab?.windowId;

      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            captureInProgressTabs.delete(sender.tab.id);
            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message
            });

            return;
          }

          sendResponse({
            success: true,
            screenshot: dataUrl
          });
          captureInProgressTabs.delete(sender.tab.id);
        }
      );

      return true;
    }

    if (message.type === "CAPTURE_AND_ANALYZE") {
      sendResponse({
        success: false,
        error: "Raw screenshot analysis is disabled; use sanitized analysis"
      });
      return false;
    }

    if (message.type === "GET_TAB_ID") {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return false;
    }

    if (message.type === "PERFORM_TRUSTED_ACTION") {
      if (!sender.tab?.id) {
        sendResponse({ success: false, error: "Trusted action requires a tab" });
        return false;
      }
      (async () => {
        try {
          const result = await dispatchTrustedInput(sender.tab.id, message.request);
          sendResponse({ success: true, ...result });
        } catch (err) {
          sendResponse({ success: false, error: err?.message || String(err) });
        }
      })();
      return true;
    }

    if (message.type === "SEND_AGENT_TASK") {
      if (
        !sender.tab?.id ||
        !message.agentPayload?.privacy_proof?.sanitized ||
        message.agentPayload?.privacy_proof?.rawScreenshotIncluded
      ) {
        sendResponse({ success: false, error: "Privacy gate blocked agent task" });
        return false;
      }

      (async () => {
        try {
          const agentUrl = await getAgentTaskApiUrl();
          const apiResponse = await fetch(agentUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message.agentPayload)
          });

          if (!apiResponse.ok) {
            const errText = await apiResponse.text();
            throw new Error(`VLM server error: ${apiResponse.status} ${errText}`);
          }

          const result = await apiResponse.json();
          sendResponse({
            success: true,
            tasks: result.tasks,
            model: result.model,
            latency_ms: result.latency_ms,
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();

      return true;
    }

    if (message.type === "VPBA_PRIVACY_SCAN_PROGRESS") {
      // Forward browser-only model download/inference status to the side panel.
      chrome.runtime.sendMessage({
        type: "VPBA_PRIVACY_SCAN_PROGRESS",
        text: String(message.text || "Preparing local privacy scan…"),
      }).catch(() => {});
      return false;
    }

    if (message.type === "OPEN_NEW_TAB") {
      const url = message.url || "about:blank";
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          const continuation = message.continuation;
          if (!continuation?.replan || tab.id == null) {
            sendResponse({ success: true, tabId: tab.id });
            return;
          }
          chrome.storage.session.set({
            [`vpba_navigation_resume_${tab.id}`]: {
              tasks: [], intent: String(continuation.intent || ""), replan: true,
              createdAt: Date.now(), fromUrl: url,
            },
          }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ success: true, tabId: tab.id });
            }
          });
        }
      });
      return true;
    }

    if (message.type === "CLOSE_TABS") {
      const keepTab = sender.tab;
      if (keepTab?.id == null || keepTab.windowId == null) {
        sendResponse({ success: false, error: "Cannot determine the current tab" });
        return false;
      }
      const scope = message.scope || "all_except_current";
      const requestedNumbers = Array.isArray(message.tabNumbers)
        ? message.tabNumbers.map(Number).filter(Number.isInteger)
        : [];
      const range = message.tabRange && typeof message.tabRange === "object"
        ? { start: Number(message.tabRange.start), end: Number(message.tabRange.end) }
        : null;
      chrome.tabs.query({ windowId: keepTab.windowId }, tabs => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        // Tab selection is generic and stays in Chrome. The page and model
        // never receive tab titles or URLs. New scopes can be added here
        // without changing how content scripts access page data.
        const removeIds = tabs.filter(tab => {
          if (scope === "all_except_current") return tab.id !== keepTab.id;
          if (scope === "all_unpinned_except_current") return tab.id !== keepTab.id && !tab.pinned;
          // User-facing tab numbers are 1-based and count from the left in
          // this window. Chrome's tab.index is 0-based, so add one here.
          if (scope === "tab_numbers") return requestedNumbers.includes(tab.index + 1);
          if (scope === "tab_range" && range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
            const start = Math.min(range.start, range.end);
            const end = Math.max(range.start, range.end);
            return tab.index + 1 >= start && tab.index + 1 <= end;
          }
          return false;
        }).map(tab => tab.id).filter(id => id != null);
        if (!removeIds.length) {
          sendResponse({ success: true, closed: 0 });
          return;
        }
        chrome.tabs.remove(removeIds, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ success: true, closed: removeIds.length });
          }
        });
      });
      return true;
    }
  }
);
