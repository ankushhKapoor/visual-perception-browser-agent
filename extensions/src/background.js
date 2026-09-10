console.log(
  "Visual Perception Browser Agent: background service worker started",
  chrome.runtime.id
);

const ANALYSIS_API_URL   = "http://127.0.0.1:8000/analyze";
const PERCEPTION_API_URL = "http://127.0.0.1:8000/perception";
const AGENT_TASK_API_URL = "http://127.0.0.1:8000/agent/task";
const captureInProgressTabs = new Set();

// Navigation continuations are intentionally stored in chrome.storage.session
// so they disappear when the browser session ends. Content scripts run in an
// untrusted context and cannot read this area by default, which otherwise
// causes a search or new-tab task to stop after its first phase.
if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(error => console.warn("Could not enable session continuation storage:", error));
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
    .catch(error => console.warn("Could not enable native side panel:", error));
}

async function sendImageForAnalysis(dataUrl, redactionRegions, privacyProof) {
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:image/") ||
    !privacyProof?.sanitized ||
    privacyProof.rawScreenshotIncluded ||
    !Array.isArray(privacyProof.redactionMap)
  ) {
    throw new Error("Privacy gate blocked screenshot transmission");
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const formData = new FormData();

  formData.append(
    "image",
    blob,
    "sanitized_screenshot.png"
  );
  formData.append(
    "redaction_regions",
    JSON.stringify(redactionRegions || [])
  );
  formData.append(
    "privacy_proof",
    JSON.stringify(privacyProof)
  );

  const apiResponse = await fetch(
    ANALYSIS_API_URL,
    {
      method: "POST",
      body: formData
    }
  );

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();

    throw new Error(
      `API analysis failed: ${apiResponse.status} ${errorText}`
    );
  }

  return await apiResponse.json();
}

async function sendBrowserPerceptionState(perceptionState) {
  const apiResponse = await fetch(
    PERCEPTION_API_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(perceptionState)
    }
  );

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();

    throw new Error(
      `Perception API failed: ${apiResponse.status} ${errorText}`
    );
  }

  return await apiResponse.json();
}

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    console.log(
      "Background received message:",
      message.type
    );

    if (message.type === "CAPTURE_SCREENSHOT") {
      console.log("Capturing one screenshot", { tabId: sender.tab?.id });
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
            console.error(
              "Screenshot capture failed:",
              chrome.runtime.lastError.message
            );

            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message
            });

            return;
          }

          console.log(
            "Background captured screenshot successfully"
          );

          sendResponse({
            success: true,
            screenshot: dataUrl
          });
          console.log("One screenshot captured", { tabId: sender.tab.id });
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

    if (
      message.type ===
      "SEND_SANITIZED_FOR_ANALYSIS"
    ) {
      if (!sender.tab?.id) {
        sendResponse({ success: false, error: "Privacy gate blocked unknown sender" });
        return false;
      }
      (async () => {
        try {
          console.log(
            "Sending sanitized screenshot to FastAPI..."
          );

          const analysis =
            await sendImageForAnalysis(
              message.screenshot,
              message.redactionRegions,
              message.privacyProof
            );

          console.log(
            "Sanitized screenshot analysis completed",
            analysis?.detection_summary || {}
          );

          sendResponse({
            success: true,
            analysis: analysis
          });
        } catch (error) {
          console.error(
            "Sanitized screenshot analysis failed:",
            error
          );

          sendResponse({
            success: false,
            error: error.message
          });
        }
      })();

      return true;
    }

    if (
      message.type ===
      "SEND_BROWSER_PERCEPTION"
    ) {
      if (!sender.tab?.id || !message.perceptionState?.privacy?.sanitized) {
        sendResponse({ success: false, error: "Privacy gate blocked unsanitized perception" });
        return false;
      }
      (async () => {
        try {
          console.log(
            "Background sending browser perception state to server..."
          );

          const serverResponse =
            await sendBrowserPerceptionState(
              message.perceptionState
            );

          console.log(
            "Browser perception state sent successfully:",
            serverResponse
          );

          sendResponse({
            success: true,
            serverResponse: serverResponse
          });
        } catch (error) {
          console.error(
            "Browser perception state sending failed:",
            error
          );

          sendResponse({
            success: false,
            error: error.message
          });
        }
      })();

      return true;
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
          // A tab can already be attached to DevTools, or enterprise policy can
          // block debugger access. The content script uses its normal local
          // interaction fallback in either case.
          console.warn("Trusted action unavailable:", err?.message || err);
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
          console.log("Sending agent task to local backend...");
          const apiResponse = await fetch(AGENT_TASK_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message.agentPayload)
          });

          if (!apiResponse.ok) {
            const errText = await apiResponse.text();
            throw new Error(`Agent API error: ${apiResponse.status} ${errText}`);
          }

          const result = await apiResponse.json();
          console.log("Agent task result:", result);
          sendResponse({
            success: true,
            tasks: result.tasks,
            model: result.model,
            latency_ms: result.latency_ms,
          });
        } catch (err) {
          console.error("Agent task failed:", err);
          sendResponse({ success: false, error: err.message });
        }
      })();

      return true;
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
