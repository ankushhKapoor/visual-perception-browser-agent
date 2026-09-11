/* global chrome */
const HISTORY_KEY = "vpba_browser_history_v1";
const historyElement = document.getElementById("history");
const intentElement = document.getElementById("intent");
const sendButton = document.getElementById("send");
const privacyScanButton = document.getElementById("privacy-scan");
const privacyStatusElement = document.getElementById("privacy-status");
const agentStatusElement = document.getElementById("agent-status");
const agentStatusTextElement = document.getElementById("agent-status-text");
const refreshAgentButton = document.getElementById("refresh-agent");
const stopAgentButton = document.getElementById("stop-agent");
const vlmEndpointElement = document.getElementById("vlm-endpoint");
const saveVlmButton = document.getElementById("save-vlm");
const vlmStatusElement = document.getElementById("vlm-status");
const VLM_AGENT_URL_STORAGE_KEY = "vpba_vlm_agent_url";
const DEFAULT_VLM_AGENT_URL = "http://127.0.0.1:9001/v1/agent";
let agentBusy = false;

function setAgentStatus(text, active = false) {
  agentBusy = active;
  agentStatusTextElement.textContent = text || (active ? "Working" : "Ready");
  agentStatusElement.classList.toggle("active", active);
  stopAgentButton.classList.toggle("visible", active);
  sendButton.disabled = active;
  intentElement.disabled = active;
  refreshAgentButton.disabled = active;
}

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
chrome.storage.local.get(VLM_AGENT_URL_STORAGE_KEY, result => {
  vlmEndpointElement.value = result[VLM_AGENT_URL_STORAGE_KEY] || DEFAULT_VLM_AGENT_URL;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[HISTORY_KEY]) render(changes[HISTORY_KEY].newValue);
});

async function sendTask() {
  const text = intentElement.value.trim();
  if (!text || agentBusy) return;
  setAgentStatus("Starting agent", true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "VPBA_START_SIDE_PANEL_TASK", text });
    if (!response?.success) throw new Error(response?.error || "Agent task could not start.");
    intentElement.value = "";
  } catch (error) {
    appendAgentMessage(`Could not start task: ${error?.message || error}. Refresh the active webpage and try again.`);
    setAgentStatus("Agent could not start", false);
  } finally {
    // The page runtime emits a real busy/idle state. Keep the UI locked until
    // that state arrives after a successfully dispatched task.
    if (!agentBusy) intentElement.focus();
  }
}

sendButton.addEventListener("click", sendTask);
stopAgentButton.addEventListener("click", async () => {
  stopAgentButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "VPBA_STOP_SIDE_PANEL_TASK" });
    setAgentStatus("Stopping task", true);
  } finally {
    stopAgentButton.disabled = false;
  }
});
refreshAgentButton.addEventListener("click", async () => {
  if (agentBusy) return;
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  setAgentStatus("Ready", false);
  intentElement.focus();
});
saveVlmButton.addEventListener("click", async () => {
  const endpoint = vlmEndpointElement.value.trim();
  try {
    const url = new URL(endpoint);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Use an HTTP or HTTPS URL.");
    await chrome.storage.local.set({ [VLM_AGENT_URL_STORAGE_KEY]: url.toString() });
    vlmStatusElement.textContent = `Saved VLM endpoint: ${url.origin}${url.pathname}`;
  } catch (error) {
    vlmStatusElement.textContent = `Invalid VLM endpoint: ${error.message || error}`;
  }
});
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
      + "The raw capture remains local; no screenshots were downloaded."
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
  if (message.type === "VPBA_AGENT_STATUS") {
    setAgentStatus(message.text || "Working", Boolean(message.active));
    return;
  }
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
