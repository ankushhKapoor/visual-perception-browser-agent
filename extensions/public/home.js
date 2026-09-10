/* global chrome */
const HISTORY_KEY = "vpba_browser_history_v1";
const historyElement = document.getElementById("history");
const intentElement = document.getElementById("intent");
const sendButton = document.getElementById("send");

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
    const item = document.createElement("div");
    item.className = "message agent";
    item.textContent = `Could not start task: ${error?.message || error}. Refresh the active webpage and try again.`;
    historyElement.appendChild(item);
  } finally {
    sendButton.disabled = false;
    intentElement.disabled = false;
    intentElement.focus();
  }
}

sendButton.addEventListener("click", sendTask);
intentElement.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTask();
  }
});
