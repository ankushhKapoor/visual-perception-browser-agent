/* global chrome */
const HISTORY_KEY = "vpba_browser_history_v1";
const historyElement = document.getElementById("history");

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
