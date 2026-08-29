console.log(
  "Visual Perception Browser Agent: background service worker started",
  chrome.runtime.id
);

const ANALYSIS_API_URL = "http://127.0.0.1:8000/analyze";
const PERCEPTION_API_URL = "http://127.0.0.1:8000/perception";

async function sendScreenshotForAnalysis(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const formData = new FormData();

  formData.append(
    "image",
    blob,
    "screenshot.png"
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

async function sendImageForAnalysis(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();

  const formData = new FormData();

  formData.append(
    "image",
    blob,
    "sanitized_screenshot.png"
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
      const windowId = sender.tab?.windowId;

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
      const windowId = sender.tab?.windowId;

      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        async (dataUrl) => {
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

          try {
            console.log(
              "Screenshot captured. Sending to FastAPI..."
            );

            const analysis =
              await sendScreenshotForAnalysis(dataUrl);

            console.log(
              "Analysis completed successfully:",
              analysis
            );

            sendResponse({
              success: true,
              analysis: analysis
            });
          } catch (error) {
            console.error(
              "Screenshot analysis failed:",
              error
            );

            sendResponse({
              success: false,
              error: error.message
            });
          }
        }
      );

      return true;
    }

    if (
      message.type ===
      "SEND_SANITIZED_FOR_ANALYSIS"
    ) {
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