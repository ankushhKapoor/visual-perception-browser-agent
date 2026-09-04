console.log(
  "Visual Perception Browser Agent: background service worker started",
  chrome.runtime.id
);

const ANALYSIS_API_URL = "http://127.0.0.1:8000/analyze";
const PERCEPTION_API_URL = "http://127.0.0.1:8000/perception";
const captureInProgressTabs = new Set();

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    return;
  }

  console.log("On-demand capture clicked", { tabId: tab.id });

  chrome.tabs.sendMessage(
    tab.id,
    { type: "START_ON_DEMAND_CAPTURE" },
    () => {
      if (chrome.runtime.lastError) {
        console.error(
          "On-demand capture could not start:",
          chrome.runtime.lastError.message
        );
      }
    }
  );
});

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
  }
);