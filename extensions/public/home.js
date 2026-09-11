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
const themeToggleButton = document.getElementById("theme-toggle");
const sanitizedInspectorElement = document.getElementById("sanitized-inspector");
const inspectorLabelElement = document.getElementById("inspector-label");
const previewTextElement = document.getElementById("preview-text");
const previewImageElement = document.getElementById("preview-image");
const showPreviewTextButton = document.getElementById("show-preview-text");
const showPreviewImageButton = document.getElementById("show-preview-image");
const discardPreviewButton = document.getElementById("discard-preview");
const THEME_KEY = "vpba_panel_theme";
let agentBusy = false;
let ephemeralPreview = null;
let previewCollapsed = false;

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  const label = nextTheme === "dark" ? "Use light theme" : "Use dark theme";
  themeToggleButton.title = label;
  themeToggleButton.setAttribute("aria-label", label);
}

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

function renderPreview(mode = "text") {
  if (!ephemeralPreview) return;
  const hasImage = Boolean(ephemeralPreview.sanitizedImage);
  inspectorLabelElement.textContent = ephemeralPreview.label || "Sanitized context available";
  previewTextElement.textContent = ephemeralPreview.sanitizedText || "No sanitised text was included.";
  previewImageElement.src = hasImage ? ephemeralPreview.sanitizedImage : "";
  showPreviewImageButton.disabled = !hasImage;
  const showImage = mode === "image" && hasImage;
  previewTextElement.classList.toggle("visible", !showImage && !previewCollapsed);
  previewImageElement.classList.toggle("visible", showImage && !previewCollapsed);
  showPreviewTextButton.classList.toggle("active", !showImage);
  showPreviewImageButton.classList.toggle("active", showImage);
  sanitizedInspectorElement.classList.add("visible");
  updateToggleButton();
}

function updateToggleButton() {
  const btn = document.getElementById("toggle-preview");
  if (btn) btn.textContent = previewCollapsed ? "▼" : "▲";
}

/** Hide the preview panel without releasing data. */
function collapsePreview() {
  previewCollapsed = true;
  previewTextElement.classList.remove("visible");
  previewImageElement.classList.remove("visible");
  updateToggleButton();
}

/** Show the preview panel (re-expand after collapse). */
function expandPreview() {
  previewCollapsed = false;
  renderPreview(previewImageElement.classList.contains("visible") || showPreviewImageButton.classList.contains("active") ? "image" : "text");
}

/**
 * Permanently release the ephemeral preview.
 * The data URL and sanitised text were never written to storage or disk;
 * clearing these JS references is the only cleanup needed.
 */
function discardPreview() {
  ephemeralPreview = null;
  previewCollapsed = false;
  previewImageElement.removeAttribute("src");
  previewTextElement.textContent = "";
  sanitizedInspectorElement.classList.remove("visible");
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
    return; // show nothing when no messages yet
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
chrome.storage.local.get(THEME_KEY, result => applyTheme(result[THEME_KEY]));
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
themeToggleButton.addEventListener("click", async () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  await chrome.storage.local.set({ [THEME_KEY]: nextTheme });
});
showPreviewTextButton.addEventListener("click", () => renderPreview("text"));
showPreviewImageButton.addEventListener("click", () => renderPreview("image"));
discardPreviewButton.addEventListener("click", discardPreview);
// Toggle collapse/expand — the ▲/▼ button.
document.getElementById("toggle-preview")?.addEventListener("click", () => {
  if (!ephemeralPreview) return;
  previewCollapsed ? expandPreview() : collapsePreview();
});
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
  discardPreview(); // clear any previous sanitized context immediately
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  setAgentStatus("Ready", false);
  intentElement.focus();
});
privacyScanButton.addEventListener("click", async () => {
  if (agentBusy) return;
  privacyScanButton.disabled = true;
  setPrivacyStatus("Capturing the visible tab and preparing local models…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "VPBA_RUN_LOCAL_PRIVACY_SCAN" });
    if (!response?.success) throw new Error(response?.error || "Privacy scan failed");
    const { redactedRegions, facesDetected, objectsDetected, provider } = response.summary;
    setPrivacyStatus(`Local scan complete: ${redactedRegions} protected region(s), ${facesDetected} face(s), and ${objectsDetected} object(s) detected (${provider}).`);
  } catch (error) {
    setPrivacyStatus(`Local scan failed: ${error?.message || error}`);
  } finally {
    privacyScanButton.disabled = false;
  }
});
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "VPBA_SANITIZED_PREVIEW" && message.preview) {
    discardPreview();
    ephemeralPreview = {
      label: String(message.preview.label || "Sanitized context available"),
      sanitizedText: String(message.preview.sanitizedText || ""),
      sanitizedImage: typeof message.preview.sanitizedImage === "string"
        && message.preview.sanitizedImage.startsWith("data:image/")
        ? message.preview.sanitizedImage
        : null,
    };
    renderPreview("text");
    return;
  }
  if (message.type === "VPBA_AGENT_STATUS") {
    setAgentStatus(message.text || "Working", Boolean(message.active));
    return;
  }
  // Privacy pipeline progress (local OCR / face detection / sanitisation) is
  // shown in the main agent-status bar so the timeline reads as one coherent
  // flow: "Sanitising page data locally…" → "Waiting for VLM response…"
  // Nothing in these messages is stored; they are display-only.
  if (message.type === "VPBA_PRIVACY_SCAN_PROGRESS") {
    // Only show if the agent is already busy (i.e. this is part of a task, not
    // a standalone privacy scan button). Standalone scans use privacy-status.
    if (agentBusy) {
      setAgentStatus(message.text || "Sanitising page data locally…", true);
    } else {
      setPrivacyStatus(message.text || "Preparing local privacy scan…");
    }
  }
});
intentElement.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTask();
  }
});
