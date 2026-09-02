console.log(
  "Visual Perception Browser Agent: background service worker started",
  chrome.runtime.id
);

const ANALYSIS_API_URL = "http://127.0.0.1:8000/analyze";
const PERCEPTION_API_URL = "http://127.0.0.1:8000/perception";
const CAPTURE_DATABASE_NAME = "visual-perception-browser-agent";
const CAPTURE_STORE_NAME = "sanitized-captures";

function openCaptureDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CAPTURE_DATABASE_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(CAPTURE_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeSanitizedCapture(capture) {
  const database = await openCaptureDatabase();
  const id = `capture_${Date.now()}_${crypto.randomUUID()}`;
  const record = {
    id,
    capturedAt: new Date().toISOString(),
    ...capture
  };

  await new Promise((resolve, reject) => {
    const transaction = database.transaction(CAPTURE_STORE_NAME, "readwrite");
    transaction.objectStore(CAPTURE_STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });

  database.close();
  return id;
}

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab?.id !== "number") {
    console.error("Cannot start privacy capture without an active tab.");
    return;
  }

  chrome.tabs.sendMessage(
    tab.id,
    { type: "RUN_PRIVACY_CAPTURE_AND_ANALYZE" },
    () => {
      if (chrome.runtime.lastError) {
        console.error(
          "Could not start privacy-first analysis:",
          chrome.runtime.lastError.message
        );
      }
    }
  );
});

async function sendImageForAnalysis(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const formData = new FormData();

  formData.append(
    "image",
    blob,
    "sanitized_screenshot.png"
  );

  formData.append("sanitized", "true");

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
      {
        type: message?.type ?? "unknown",
        tabId: sender?.tab?.id ?? null,
        extensionId: chrome.runtime.id
      }
    );

    if (message.type === "CAPTURE_SCREENSHOT") {
      const windowId = sender.tab?.windowId;

      if (typeof sender.tab?.id !== "number") {
        sendResponse({
          success: false,
          error: "Screenshot capture requires a valid sender tab."
        });
        return false;
      }

      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
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
        }
      );

      return true;
    }

    if (message.type === "CAPTURE_AND_ANALYZE") {
      if (typeof sender.tab?.id !== "number") {
        sendResponse({
          success: false,
          error: "Analysis requires a valid sender tab."
        });
        return false;
      }

      chrome.tabs.sendMessage(
        sender.tab.id,
        { type: "RUN_PRIVACY_CAPTURE_AND_ANALYZE" },
        (result) => {
          if (chrome.runtime.lastError) {
            console.error(
              "Could not start privacy-first analysis:",
              chrome.runtime.lastError.message
            );

            sendResponse({
              success: false,
              error: chrome.runtime.lastError.message
            });
            return;
          }

          sendResponse(result || {
            success: false,
            error: "Privacy analysis returned no response."
          });
        }
      );

      return true;
    }

    if (
      message.type ===
      "SEND_SANITIZED_FOR_ANALYSIS"
    ) {
      if (message.sanitized !== true) {
        sendResponse({
          success: false,
          error: "Only privacy-sanitized screenshots may be analyzed."
        });
        return false;
      }

      (async () => {
        try {
          console.log(
            "Sending sanitized screenshot to FastAPI..."
          );

          const analysis =
            await sendImageForAnalysis(
              message.screenshot
            );

          console.log(
            "Sanitized screenshot analysis completed:",
            analysis
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

    if (message.type === "STORE_SANITIZED_CAPTURE") {
      (async () => {
        try {
          const id = await storeSanitizedCapture({
            tabId: sender.tab?.id ?? null,
            url: message.url || "",
            title: message.title || "",
            reason: message.reason || "unknown",
            screenshot: message.screenshot,
            payload: message.payload
          });
          console.log("Sanitized screenshot stored locally:", {
            id,
            storage: "IndexedDB",
            database: CAPTURE_DATABASE_NAME,
            store: CAPTURE_STORE_NAME
          });
          sendResponse({ success: true, id });
        } catch (error) {
          console.error("Could not store sanitized screenshot locally:", error);
          sendResponse({ success: false, error: error.message });
        }
      })();

      return true;
    }

    if (
      message.type ===
      "SEND_BROWSER_PERCEPTION"
    ) {
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