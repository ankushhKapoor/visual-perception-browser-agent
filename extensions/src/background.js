console.log(
  "Visual Perception Browser Agent: background service worker started",
  chrome.runtime.id
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(
    "Background received message:",
    message,
    "Extension ID:",
    chrome.runtime.id
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

        console.log("Background captured screenshot successfully");

        sendResponse({
          success: true,
          screenshot: dataUrl
        });
      }
    );

    return true;
  }
});