/* global chrome */
const HISTORY_KEY = "vpba_browser_history_v1";
const historyElement = document.getElementById("history");
const intentElement = document.getElementById("intent");
const sendButton = document.getElementById("send");
const privacyScanButton = document.getElementById("privacy-scan");
const privacyStatusElement = document.getElementById("privacy-status");

function setPrivacyStatus(text) {
  privacyStatusElement.textContent = text;
  privacyStatusElement.classList.toggle("visible", Boolean(text));
}

function appendAgentMessage(text) {
  const item = document.createElement("div");
  item.className = "message agent";
  item.textContent = text;
  historyElement.appendChild(item);
}

function render(history) {
  historyElement.textContent = "";
  if (!Array.isArray(history) || history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No browser-wide agent messages yet.";
    historyElement.appendChild(empty);
    return;
  }
  history.forEach(message => {
    const bubble = document.createElement("div");
    bubble.className = `message ${message.role === "user" ? "user" : "agent"}`;
    if (message.role === "user") bubble.textContent = message.text || "";
    else bubble.innerHTML = message.html || "";
    historyElement.appendChild(bubble);
  });
}

chrome.storage.local.get(HISTORY_KEY, result => render(result[HISTORY_KEY]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[HISTORY_KEY]) render(changes[HISTORY_KEY].newValue);
});

async function sendTask() {
  const text = intentElement.value.trim();
  if (!text) return;
  sendButton.disabled = true;
  intentElement.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active webpage is available.");
    await chrome.tabs.sendMessage(tab.id, { type: "VPBA_SIDEPANEL_TASK", text });
    intentElement.value = "";
  } catch (error) {
    appendAgentMessage(`Could not start task: ${error?.message || error}. Refresh the active webpage and try again.`);
  } finally {
    sendButton.disabled = false;
    intentElement.disabled = false;
    intentElement.focus();
  }
}

sendButton.addEventListener("click", sendTask);
privacyScanButton.addEventListener("click", async () => {
  privacyScanButton.disabled = true;
  setPrivacyStatus("Capturing the visible tab and preparing local models…");
  appendAgentMessage("Running local privacy scan. The first run may download and cache model assets in Chrome…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active webpage is available.");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "RUN_LOCAL_PRIVACY_SCAN" });
    if (!response?.success) throw new Error(response?.error || "Privacy scan failed");
    const { redactedRegions, facesDetected, objectsDetected, provider } = response.summary;
    appendAgentMessage(
      `Local privacy scan complete. ${redactedRegions} region(s) redacted; `
      + `${facesDetected} face(s) and ${objectsDetected} object(s) detected.\n`
      + `Runtime: ${provider}\n`
      + "Original and sanitized screenshots were saved in Downloads/VPBA Privacy Debug/."
    );
    setPrivacyStatus("Local scan complete. Page-change monitoring is active for this tab.");
  } catch (error) {
    appendAgentMessage(`Local privacy scan failed: ${error?.message || error}`);
    setPrivacyStatus(`Local scan failed: ${error?.message || error}`);
  } finally {
    privacyScanButton.disabled = false;
  }
});
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "VPBA_PRIVACY_SCAN_PROGRESS") {
    setPrivacyStatus(message.text || "Preparing local privacy scan…");
  }
});
intentElement.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTask();
  }
});
