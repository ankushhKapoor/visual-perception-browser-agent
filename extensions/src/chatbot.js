/**
 * chatbot.js v2 — page-local Visual Perception Agent runtime
 *
 * Improvements over v1:
 *  1. Browser-wide history persists across tabs, reloads, and restarts (chrome.storage.local)
 *  2. Smart image sending — questions use text-only first; image only if model signals it needs one
 *  3. Source transparency — collapsible "📎 Source" pill shows what was fed to the VLM
 *  4. Reliable element resolution — _elMap stores live DOM refs during capture (fixes silent no-ops)
 *  5. React/SPA-compatible click & type using native value setters + full pointer events
 *  6. New "key" action to press Enter/Tab/Escape
 */

/* global chrome */

(function vpbaChatbot() {
  "use strict";

  // ── Guard: don't inject twice ──────────────────────────────────────────────
  if (document.getElementById("vpba-root")) return;

  // ── Config ─────────────────────────────────────────────────────────────────
  const PANEL_W = 390;
  const MAX_ELEMS = 60;
  const MAX_TEXT = 3000;
  const MAX_HIST = 60;
  // A task may need a fresh plan after several navigation or SPA transitions.
  // Keep the budget explicit so a stalled site cannot create unbounded calls.
  const MAX_AGENT_CALLS_PER_TASK = 7;
  const BROWSER_HISTORY_KEY = "vpba_browser_history_v1";
  // Both the conversation and panel visibility are browser-wide. A tab-scoped
  // panel flag was unreliable during document replacement because a content
  // script can be destroyed before its session write is observed.
  const BROWSER_PANEL_OPEN_KEY = "vpba_browser_panel_open_v1";
  const NAVIGATION_STATE_PREFIX = "vpba_navigation_resume_";

  const PII_RE = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
    /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen = false;
  let processing = false;
  let pendingTasks = null;   // eslint-disable-line no-unused-vars
  let chatHistory = [];     // [{ role:"user"|"agent", text?:"", html?:"" }]
  let myTabId = null;
  let taskCancelled = false;

  /**
   * Live element reference map — populated during each getPageContext() call.
   * Maps "element_N" → the actual DOM node captured at that index.
   *
   * This is critical: without it, resolveEl() falls back to a raw
   * querySelectorAll that doesn't apply the same visibility filter used
   * during capture, causing index mismatches and silent no-ops.
   */
  const _elMap = new Map();
  // A framework may replace a node after a previous action (for example a
  // disabled Send button becoming enabled after typing). Keep local-only
  // fingerprints so the executor can bind the replacement safely.
  const _elDescriptors = new Map();

  // ── CSS ────────────────────────────────────────────────────────────────────
  const css = `
  #vpba-root { all: initial; }
  #vpba-root *, #vpba-root *::before, #vpba-root *::after {
    box-sizing: border-box; margin: 0; padding: 0;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
  }

  /* ── Toggle tab ── */
  #vpba-tab {
    position: fixed; top: 50%; right: 0;
    transform: translateY(-50%) translateX(0);
    z-index: 2147483646;
    width: 32px; height: 96px;
    background: linear-gradient(180deg, #7c3aed, #2563eb);
    border: none; border-radius: 8px 0 0 8px;
    color: #fff; cursor: pointer;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 2px;
    box-shadow: -3px 0 16px rgba(124,58,237,0.45);
    transition: width 0.18s, transform 0.28s cubic-bezier(.4,0,.2,1), background 0.15s;
    padding: 6px 0;
  }
  #vpba-tab:hover { width: 38px; background: linear-gradient(180deg,#6d28d9,#1d4ed8); }
  #vpba-tab.shifted { transform: translateY(-50%) translateX(-${PANEL_W}px); }
  #vpba-tab-letter {
    writing-mode: vertical-rl; text-orientation: mixed;
    font-size: 10px; font-weight: 700; letter-spacing: 0.12em;
    color: rgba(255,255,255,0.9);
  }
  #vpba-tab-icon { font-size: 15px; }

  /* ── Panel ── */
  #vpba-panel {
    position: fixed; top: 0; right: 0;
    width: ${PANEL_W}px; height: 100dvh;
    z-index: 2147483647;
    background: rgba(9, 13, 19, 0.97);
    backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
    border-left: 1px solid rgba(48,54,61,0.7);
    box-shadow: -10px 0 40px rgba(0,0,0,0.7);
    display: flex; flex-direction: column;
    transform: translateX(${PANEL_W}px);
    transition: transform 0.28s cubic-bezier(.4,0,.2,1);
  }
  #vpba-panel.open { transform: translateX(0); }

  /* ── Header ── */
  #vpba-hdr {
    display: flex; align-items: center; gap: 9px;
    padding: 13px 15px 11px;
    border-bottom: 1px solid rgba(48,54,61,0.6);
    flex-shrink: 0;
  }
  #vpba-hdr-logo {
    width: 27px; height: 27px; border-radius: 7px; flex-shrink: 0;
    background: linear-gradient(135deg,#7c3aed,#2563eb);
    display: flex; align-items: center; justify-content: center; font-size: 14px;
  }
  #vpba-hdr-title {
    font-size: 13px; font-weight: 700; color: #e6edf3; letter-spacing: -0.01em;
  }
  #vpba-hdr-subtitle {
    font-size: 10.5px; color: #8b949e; margin-left: auto; white-space: nowrap;
  }
  #vpba-hdr-status {
    width: 7px; height: 7px; border-radius: 50%; background: #374151; flex-shrink: 0;
    transition: background 0.3s;
  }
  #vpba-hdr-status.ok  { background: #22c55e; }
  #vpba-hdr-status.run { background: #fbbf24; animation: vpba-pulse 1s ease-in-out infinite; }
  #vpba-hdr-status.err { background: #f87171; }
  @keyframes vpba-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  #vpba-close {
    background: none; border: none; color: #8b949e; cursor: pointer;
    font-size: 16px; line-height: 1; padding: 3px 5px; border-radius: 5px;
    transition: color .15s, background .15s; flex-shrink: 0;
  }
  #vpba-close:hover { color: #e6edf3; background: rgba(255,255,255,.06); }

  /* ── Messages ── */
  #vpba-msgs {
    flex: 1; overflow-y: auto; padding: 10px 10px;
    display: flex; flex-direction: column; gap: 6px;
  }
  #vpba-msgs::-webkit-scrollbar { width: 3px; }
  #vpba-msgs::-webkit-scrollbar-thumb { background: rgba(255,255,255,.08); border-radius: 2px; }

  .vm { display: flex; flex-direction: column; max-width: 93%; }
  .vm.u { align-self: flex-end; align-items: flex-end; }
  .vm.a { align-self: flex-start; align-items: flex-start; }

  .vb {
    padding: 9px 12px; border-radius: 13px;
    font-size: 13px; line-height: 1.55; word-break: break-word; white-space: pre-wrap;
  }
  .vm.u .vb {
    background: linear-gradient(135deg,#7c3aed,#2563eb);
    color: #fff; border-bottom-right-radius: 5px;
  }
  .vm.a .vb {
    background: rgba(22,27,34,.85);
    border: 1px solid rgba(48,54,61,.55);
    color: #e6edf3; border-bottom-left-radius: 5px;
  }
  .vts { font-size: 10px; color: #6e7681; margin-top: 3px; padding: 0 2px; }

  /* thinking dots */
  .vdots { display: flex; gap: 4px; align-items: center; padding: 3px 0; }
  .vdots span {
    width: 6px; height: 6px; border-radius: 50%; background: #7c3aed;
    animation: vpba-bounce 1.2s ease-in-out infinite;
  }
  .vdots span:nth-child(2){animation-delay:.2s}
  .vdots span:nth-child(3){animation-delay:.4s}
  @keyframes vpba-bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-5px)} }

  /* tasks card */
  .vtasks {
    margin-top: 8px;
    background: rgba(10,14,20,.7);
    border: 1px solid rgba(48,54,61,.5);
    border-radius: 10px; overflow: hidden; font-size: 12.5px;
  }
  .vtasks-hdr {
    padding: 8px 12px;
    background: rgba(124,58,237,.1);
    border-bottom: 1px solid rgba(48,54,61,.4);
    font-weight: 700; color: #a78bfa;
    font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
  }
  .vprog { height: 3px; background: rgba(48,54,61,.4); margin: 0 12px; }
  .vprog-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg,#7c3aed,#a78bfa);
    border-radius: 2px; transition: width .3s ease;
  }
  .vstep {
    display: flex; align-items: flex-start; gap: 9px;
    padding: 8px 12px; border-bottom: 1px solid rgba(48,54,61,.25);
    color: #6e7681; transition: color .2s; line-height: 1.45;
  }
  .vstep:last-child { border-bottom: none; }
  .vstep.running { color: #fbbf24; }
  .vstep.done    { color: #22c55e; }
  .vstep.fail    { color: #f87171; }
  .vstep-ic { flex-shrink: 0; width: 14px; text-align: center; margin-top: 1px; }
  .vstep-tx { flex: 1; line-height: 1.5; font-size: 12px; }

  /* answer plain text */
  .vans { color: #e6edf3; line-height: 1.65; font-size: 13px; }

  /* error */
  .verr {
    background: rgba(248,113,113,.07); border: 1px solid rgba(248,113,113,.22);
    border-radius: 8px; padding: 9px 12px; font-size: 12px; color: #f87171;
  }
  .verr-help { margin-top: 7px; font-size: 11px; color: #ef9a9a; }
  .verr-help code {
    background: rgba(0,0,0,.35); padding: 1px 5px; border-radius: 3px;
    font-family: monospace; font-size: 10.5px;
  }

  /* confirm */
  .vconf {
    margin-top: 8px;
    background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.22);
    border-radius: 10px; padding: 11px 13px;
  }
  .vconf-title { font-size: 12px; font-weight: 700; color: #fbbf24; }
  .vconf-reason { font-size: 11.5px; color: #8b949e; margin-top: 4px; line-height: 1.5; }
  .vconf-actions { display: flex; gap: 8px; margin-top: 10px; }
  .vbtn {
    flex: 1; padding: 8px 0; border-radius: 8px; border: 1.5px solid transparent;
    font-size: 12px; font-weight: 700; cursor: pointer;
    transition: opacity .15s, transform .1s, box-shadow .15s;
    box-shadow: 0 1px 4px rgba(0,0,0,.35);
  }
  .vbtn:hover { opacity: .9; transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0,0,0,.4); }
  .vbtn:active { transform: scale(.96); box-shadow: none; }
  .vbtn-go { background: #22c55e; color: #000; border-color: #16a34a; }
  .vbtn-no { background: rgba(48,54,61,.9); color: #e6edf3; border-color: rgba(75,85,99,.6); }

  /* context pill */
  .vctx {
    font-size: 10.5px; color: #8b949e;
    background: rgba(22,27,34,.7);
    border: 1px solid rgba(48,54,61,.4);
    border-radius: 6px; padding: 4px 8px; margin-top: 6px;
    display: inline-flex; align-items: center; gap: 5px;
  }

  /* ── Source transparency pill ── */
  .vsrc { margin-top: 5px; font-size: 10.5px; }
  .vsrc-lat { display:inline-block; margin-top:5px; font-size:10.5px; color:var(--quiet,#6b6964); letter-spacing:.01em; }
  .vsrc > summary {
    cursor: pointer; color: #6e7681; list-style: none;
    background: rgba(22,27,34,.6); border: 1px solid rgba(48,54,61,.35);
    border-radius: 6px; padding: 3px 8px;
    display: inline-flex; align-items: center; gap: 5px;
    user-select: none; transition: color .15s, background .15s;
    font-size: 10px;
  }
  .vsrc > summary::-webkit-details-marker { display: none; }
  .vsrc > summary:hover { color: #c9d1d9; background: rgba(22,27,34,.95); }
  .vsrc[open] > summary { border-radius: 6px 6px 0 0; border-bottom-color: transparent; }
  /* nested collapsible sections for text / image inside the pill */
  .vsrc-sub { margin-top: 5px; }
  .vsrc-sub > summary {
    cursor: pointer; list-style: none; color: #8b949e; font-size: 10px;
    padding: 2px 0; user-select: none; display: inline-flex; align-items: center; gap: 4px;
  }
  .vsrc-sub > summary::-webkit-details-marker { display: none; }
  .vsrc-sub > summary:hover { color: #c9d1d9; }
  .vsrc-body {
    background: rgba(10,14,20,.55); border: 1px solid rgba(48,54,61,.35);
    border-top: none; border-radius: 0 0 6px 6px;
    padding: 8px 10px; display: flex; flex-direction: column; gap: 5px;
    color: #8b949e; line-height: 1.55;
  }
  .vsrc-row { display: flex; justify-content: space-between; align-items: center; }
  .vsrc-val { color: #c9d1d9; font-weight: 500; }
  .vsrc-badge {
    font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 99px;
    background: rgba(34,197,94,.12); color: #22c55e; border: 1px solid rgba(34,197,94,.28);
  }
  .vsrc-badge.img {
    background: rgba(124,58,237,.12); color: #a78bfa; border-color: rgba(124,58,237,.28);
  }
  .vsrc-code {
    background: rgba(0,0,0,.3); padding: 1px 5px; border-radius: 3px;
    font-family: monospace; font-size: 10px; color: #a78bfa;
  }
  .vsrc-copy {
    margin-top: 4px; max-height: 150px; overflow: auto; white-space: pre-wrap;
    word-break: break-word; color: #c9d1d9; font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: rgba(0,0,0,.23); border-radius: 4px; padding: 7px;
  }
  .vsrc-preview { margin-top: 7px; }
  .vsrc-preview img { width: 100%; max-height: 190px; object-fit: contain; border: 1px solid rgba(48,54,61,.55); border-radius: 5px; background: #000; }
  .vsrc-note { margin-top: 4px; font-size: 10px; color: #8b949e; }

  /* retry notice */
  .vretry {
    font-size: 11px; color: #8b949e; padding: 3px 0;
    display: flex; align-items: center; gap: 5px;
  }

  /* ── Input bar ── */
  #vpba-bar {
    display: flex; gap: 8px; padding: 10px 12px;
    border-top: 1px solid rgba(48,54,61,.55);
    background: rgba(9,13,19,.85); flex-shrink: 0;
  }
  #vpba-in {
    flex: 1; background: rgba(22,27,34,.9);
    border: 1.5px solid rgba(48,54,61,.6);
    border-radius: 8px; color: #e6edf3;
    font-size: 12.5px; font-family: inherit;
    padding: 8px 11px; outline: none; resize: none;
    min-height: 38px; max-height: 110px; overflow-y: auto;
    transition: border-color .15s; line-height: 1.4;
  }
  #vpba-in:focus { border-color: #7c3aed; }
  #vpba-in::placeholder { color: #8b949e; }
  #vpba-in:disabled { opacity: .4; }
  #vpba-send {
    background: linear-gradient(135deg,#7c3aed,#2563eb);
    border: none; border-radius: 8px; color: #fff;
    width: 38px; height: 38px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; flex-shrink: 0;
    transition: opacity .15s, transform .1s;
  }
  #vpba-send:hover:not(:disabled){opacity:.85}
  #vpba-send:active:not(:disabled){transform:scale(.93)}
  #vpba-send:disabled{opacity:.3;cursor:not-allowed}
  #vpba-send.stop { background: linear-gradient(135deg,#dc2626,#991b1b); font-size: 13px; }
  `;

  // ── HTML ────────────────────────────────────────────────────────────────────
  const html = `
  <button id="vpba-tab" title="Open Privacy Preserving Visual Browser Agent">
    <span id="vpba-tab-icon">👁</span>
    <span id="vpba-tab-letter">AGENT</span>
  </button>
  <div id="vpba-panel">
    <div id="vpba-hdr">
      <div id="vpba-hdr-logo">👁</div>
      <span id="vpba-hdr-title">Privacy Preserving Visual Browser Agent</span>
      <span id="vpba-hdr-subtitle">Qwen2.5-VL-3B</span>
      <div id="vpba-hdr-status"></div>
      <button id="vpba-close">✕</button>
    </div>
    <div id="vpba-msgs"></div>
    <div id="vpba-bar">
      <textarea id="vpba-in" rows="1"
        placeholder="Ask anything or describe a task…"></textarea>
      <button id="vpba-send">▶</button>
    </div>
  </div>
  `;

  // ── Create a headless runtime surface ──────────────────────────────────────
  // The native Chrome side panel is the only visible chat UI. It reduces the
  // webpage viewport itself, unlike a fixed DOM overlay. This page-local
  // runtime deliberately remains hidden because it owns the live DOM element
  // map and execution code required to carry out approved agent tasks.
  //
  // Keep its existing message and task machinery intact: the native panel
  // delegates VPBA_SIDEPANEL_TASK here, and this runtime persists responses to
  // chrome.storage.local for the native panel to render.
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  const rootEl = document.createElement("div");
  rootEl.id = "vpba-root";
  rootEl.setAttribute("aria-hidden", "true");
  rootEl.style.setProperty("display", "none", "important");
  rootEl.innerHTML = html;
  document.body.appendChild(rootEl);



  // Refs
  const tab = document.getElementById("vpba-tab");
  const panel = document.getElementById("vpba-panel");
  const closeB = document.getElementById("vpba-close");
  const msgs = document.getElementById("vpba-msgs");
  const inp = document.getElementById("vpba-in");
  const sendB = document.getElementById("vpba-send");
  const statusD = document.getElementById("vpba-hdr-status");

  // ── Panel toggle ────────────────────────────────────────────────────────────
  function savePanelState(open) {
    chrome.storage.local.set({ [BROWSER_PANEL_OPEN_KEY]: Boolean(open) });
  }
  function openPanel() { panelOpen = true; panel.classList.add("open"); tab.classList.add("shifted"); savePanelState(true); inp.focus(); }
  function closePanel() { panelOpen = false; panel.classList.remove("open"); tab.classList.remove("shifted"); savePanelState(false); }
  tab.addEventListener("click", () => panelOpen ? closePanel() : openPanel());
  closeB.addEventListener("click", closePanel);

  // ── Status dot ──────────────────────────────────────────────────────────────
  function setStatus(s) { statusD.className = s ? s : ""; }
  setStatus("ok");

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function esc(t) {
    return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function now() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function scrollBot() { msgs.scrollTop = msgs.scrollHeight; }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function extensionContextAvailable() {
    // Chrome removes runtime.id from content scripts that belonged to an older
    // extension build. This occurs only after Reload in chrome://extensions;
    // an already injected script cannot be revived and the tab must refresh.
    return Boolean(chrome?.runtime?.id);
  }
  function extensionReloadError() {
    return new Error("Extension was reloaded. Refresh this tab once, then run the task again.");
  }

  function getMyTabId() {
    return new Promise(resolve => {
      try {
        if (!extensionContextAvailable()) return resolve(null);
        chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, response => {
          resolve(chrome.runtime.lastError ? null : response?.tabId ?? null);
        });
      } catch (_) { resolve(null); }
    });
  }
  function sessionGet(key) {
    if (!extensionContextAvailable()) return Promise.resolve(undefined);
    return new Promise(resolve => chrome.storage.session.get(key, value => {
      if (chrome.runtime.lastError) {
        return resolve(undefined);
      }
      resolve(value?.[key]);
    }));
  }
  function sessionSet(key, value) {
    if (!extensionContextAvailable()) return Promise.reject(extensionReloadError());
    return new Promise((resolve, reject) => chrome.storage.session.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    }));
  }
  function sessionRemove(key) {
    if (!extensionContextAvailable()) return Promise.resolve();
    return new Promise(resolve => chrome.storage.session.remove(key, () => resolve()));
  }

  // ── History storage ──────────────────────────────────────────────────────────
  async function loadHistory() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(BROWSER_HISTORY_KEY, result => {
          if (chrome.runtime.lastError) return resolve(false);
          const hist = result[BROWSER_HISTORY_KEY];
          if (!hist || !hist.length) return resolve(false);
          chatHistory = hist;
          hist.forEach(m => {
            if (m.role === "user") _renderUserBubble(m.text);
            else if (m.role === "agent") _renderAgentBubble(m.html);
          });
          resolve(true);
        });
      } catch { resolve(false); }
    });
  }

  function persistHistory() {
    try {
      const trimmed = chatHistory.slice(-MAX_HIST);
      chrome.storage.local.set({ [BROWSER_HISTORY_KEY]: trimmed });
    } catch (_) { }
  }

  function renderHistory() {
    msgs.innerHTML = "";
    chatHistory.forEach(m => {
      if (m.role === "user") _renderUserBubble(m.text);
      else if (m.role === "agent") _renderAgentBubble(m.html);
    });
  }

  // A completed conversation message saved in one tab appears in all pages.
  // Keep a live request untouched in its owning tab until it completes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[BROWSER_HISTORY_KEY] || processing) return;
    const next = changes[BROWSER_HISTORY_KEY].newValue;
    if (!Array.isArray(next)) return;
    chatHistory = next;
    renderHistory();
  });

  // ── Low-level bubble renderers (no history side effects) ────────────────────
  function _renderUserBubble(text) {
    const el = document.createElement("div");
    el.className = "vm u";
    el.innerHTML = `<div class="vb">${esc(text)}</div><div class="vts">${now()}</div>`;
    msgs.appendChild(el);
    scrollBot();
  }

  function _renderAgentBubble(innerHtml) {
    const el = document.createElement("div");
    el.className = "vm a";
    const bubble = document.createElement("div");
    bubble.className = "vb";
    bubble.innerHTML = innerHtml;
    const ts = document.createElement("div");
    ts.className = "vts";
    ts.textContent = now();
    el.appendChild(bubble);
    el.appendChild(ts);
    msgs.appendChild(el);
    scrollBot();
  }

  // ── Public message renderers ─────────────────────────────────────────────────

  function addUser(text) {
    _renderUserBubble(text);
    chatHistory.push({ role: "user", text });
    persistHistory();
  }

  function addAgent(initialHtml = null) {
    const el = document.createElement("div");
    el.className = "vm a";
    const bubble = document.createElement("div");
    bubble.className = "vb";
    bubble.innerHTML = initialHtml ?? `<div class="vdots"><span></span><span></span><span></span></div>`;
    const ts = document.createElement("div");
    ts.className = "vts";
    ts.textContent = now();
    el.appendChild(bubble);
    el.appendChild(ts);
    msgs.appendChild(el);
    scrollBot();
    let savedIndex = null;
    return {
      el, bubble, ts,
      set(html) { bubble.innerHTML = html; ts.textContent = now(); scrollBot(); },
      append(html) { bubble.insertAdjacentHTML("beforeend", html); scrollBot(); },
      save() {
        const saved = bubble.cloneNode(true);
        saved.querySelectorAll(".vsrc-preview").forEach(node => node.remove());
        const entry = { role: "agent", html: saved.innerHTML };
        if (savedIndex == null) {
          savedIndex = chatHistory.length;
          chatHistory.push(entry);
        } else {
          chatHistory[savedIndex] = entry;
        }
        persistHistory();
      },
    };
  }

  function setProcessing(v) {
    processing = v;
    // Keep the single action button usable while work is running: it becomes
    // a Stop button rather than a disabled Send button.
    sendB.disabled = false;
    sendB.classList.toggle("stop", v);
    sendB.textContent = v ? "■" : "▶";
    sendB.title = v ? "Stop agent" : "Send task";
    inp.disabled = v;
    setStatus(v ? "run" : "ok");
    if (!v) reportAgentStatus("idle", "Ready", false);
  }

  // The native side panel is the visible UI. Emit only concrete lifecycle
  // transitions from this page-local runtime so its progress text describes
  // what the agent is actually doing.
  function reportAgentStatus(phase, text, active) {
    try {
      chrome.runtime.sendMessage({
        type: "VPBA_AGENT_STATUS",
        phase,
        text,
        active: Boolean(active),
      }).catch(() => { });
    } catch (_) { }
  }

  function stopActiveTask() {
    if (!processing) return;
    taskCancelled = true;
    // Signal the local ML pipeline loops to abort between tiles.
    window.vpbaCancelCapture = true;
    // A navigation continuation must not resurrect a task that the user
    // cancelled while its page was loading.
    if (myTabId != null) sessionRemove(`${NAVIGATION_STATE_PREFIX}${myTabId}`);
    setProcessing(false);
    reportAgentStatus("stopped", "Task stopped", false);
  }

  function ensureNotCancelled() {
    if (taskCancelled) throw new Error("Stopped by user");
  }

  // ── PII sanitizer ────────────────────────────────────────────────────────────
  function sanitize(t) {
    if (!t) return "";
    let s = String(t);
    // Use the fuller local PII classifier from content.js when it is loaded;
    // it covers credentials, OTPs, tokens and IDs in addition to this
    // panel's lightweight fallback patterns.
    if (typeof window.sanitizeVisibleText === "function") return window.sanitizeVisibleText(s);
    if (typeof window.sanitizeText === "function") return window.sanitizeText(s);
    PII_RE.forEach(p => { s = s.replace(p, "<REDACTED>"); });
    return s;
  }

  // ── Question vs task detection ────────────────────────────────────────────────
  // Only classify as a question if the intent STARTS with a question word.
  // Avoids false positives like "please ask chatgpt what is X" where
  // "what" is buried inside an action sentence.
  const QUESTION_START_RE = /^(what|how many|how much|is there|are there|show me|find|list|tell me|describe|count|which|where|when|who|why|does|did|can you see|do you see|any|how)\b/i;
  const QUESTION_FULL_RE = /^(what|how|which|is|are|does|did|can|who|where|when|why)\b[^.!]*\?\s*$/i;

  function isQuestion(intent) {
    const t = intent.trim();
    return QUESTION_START_RE.test(t) || QUESTION_FULL_RE.test(t);
  }

  // ── Page context extraction ────────────────────────────────────────────────
  function getPageContext() {
    _elMap.clear(); // reset for this capture session
    _elDescriptors.clear();

    const allInteractive = Array.from(
      document.querySelectorAll(
        "button,input,textarea,select,a[href],[contenteditable='true']," +
        "[contenteditable]," +
        "[role='button'],[role='link'],[role='textbox'],[role='checkbox'],[role='tab']"
      )
    ).filter(el => {
      // ── Never capture elements that belong to the VPBA panel itself ──
      // Without this guard, the chatbot's own textarea gets assigned an
      // elementId and the VLM types into it instead of the real page input.
      if (el.closest("#vpba-root")) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    }).slice(0, MAX_ELEMS);

    const interactiveEl = allInteractive.map((el, i) => {
      const id = `element_${i + 1}`;
      _elMap.set(id, el); // ←← store live DOM reference
      // This attribute is a local, ephemeral handle to the exact live node.
      // It contains no page text and is never used as an identifier outside
      // the current document.  It gives the model a selector that resolves to
      // the same real element it was shown, rather than a guessed CSS path.
      el.setAttribute("data-vpba-element", id);
      const r = el.getBoundingClientRect();
      const text = sanitize((el.innerText || el.value || el.textContent || "").trim().slice(0, 120));
      const placeholder = sanitize(el.getAttribute("placeholder") || "");
      const label = sanitize(el.getAttribute("aria-label") || el.getAttribute("title") || "");
      const role = el.getAttribute("role") || null;
      const testId = el.getAttribute("data-testid") || "";
      const name = el.getAttribute("name") || "";
      let safeHref = null;
      if (el instanceof HTMLAnchorElement && el.href) {
        try {
          const href = new URL(el.href);
          href.username = ""; href.password = ""; href.search = ""; href.hash = "";
          safeHref = href.toString();
        } catch (_) { /* omit malformed hrefs */ }
      }
      _elDescriptors.set(id, { tag: el.tagName.toLowerCase(), role, text, placeholder, label, testId, name });
      return {
        elementId: id,
        selector: `[data-vpba-element="${id}"]`,
        tag: el.tagName.toLowerCase(),
        category: {
          BUTTON: "button", INPUT: "input", TEXTAREA: "textarea",
          SELECT: "select", A: "link"
        }[el.tagName] || el.tagName.toLowerCase(),
        role,
        editable: Boolean(el.isContentEditable),
        type: el.getAttribute("type") || null,
        text,
        placeholder,
        label,
        href: safeHref,
        disabled: Boolean(el.disabled),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      };
    });

    // Prefer the richer sanitizer from content.js (sanitizeVisibleText) which
    // also redacts person-query names and form-based person names. Fall back to
    // the basic sanitize() if content.js hasn't loaded yet.
    const sanitizeVT = typeof window.sanitizeVisibleText === "function"
      ? window.sanitizeVisibleText
      : sanitize;
    const visibleText = sanitizeVT(
      (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
    );

    let safeUrl = "<URL>";
    try {
      const u = new URL(window.location.href);
      u.username = ""; u.password = ""; u.search = ""; u.hash = "";
      safeUrl = u.toString();
    } catch (_) { }

    return {
      page: {
        url: safeUrl,
        title: sanitize(document.title),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
      interactiveElements: interactiveEl,
      forms: [],
      visualText: [],
      visibleText,
      privacy: { sanitized: true, rawScreenshotIncluded: false, redactedRegionCount: 0 },
    };
  }

  async function getPrivacyPipeline(timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const privacy = window.vpbaPrivacy;
      if (
        privacy &&
        typeof privacy.extractPageContext === "function" &&
        typeof privacy.redactScreenshot === "function" &&
        typeof privacy.createRedactionMap === "function" &&
        typeof privacy.assertSanitizedScreenshot === "function"
      ) return privacy;
      await delay(50);
    }
    return null;
  }

  async function screenshotRaw() {
    return new Promise(resolve => {
      try {
        if (!extensionContextAvailable()) return resolve(null);
        chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, res => {
          if (chrome.runtime.lastError || !res?.success) return resolve(null);
          resolve(res.screenshot);
        });
      } catch { resolve(null); }
    });
  }

  async function sanitizeTile(privacy, raw, full = false) {
    if (full && typeof window.vpbaPrepareCapture === "function") {
      try {
        const pc = privacy.extractPageContext();
        const r = await window.vpbaPrepareCapture(pc, raw);
        const dataUrl = r.sanitizedScreenshot;
        return { dataUrl, b64: dataUrl.replace(/^data:image\/\w+;base64,/, ""), redactionMap: r.redactionMap };
      } catch (_) { }
    }
    const pc = privacy.extractPageContext();
    const sensitive = pc.sensitiveElements || [];
    const redactionMap = privacy.createRedactionMap(sensitive);
    const dataUrl = await privacy.redactScreenshot(raw, sensitive);
    privacy.assertSanitizedScreenshot(dataUrl, redactionMap);
    return { dataUrl, b64: dataUrl.replace(/^data:image\/\w+;base64,/, ""), redactionMap };
  }

  async function captureSanitizedImage() {
    // Clear any leftover abort flag from a previously stopped task.
    window.vpbaCancelCapture = false;
    const privacy = await getPrivacyPipeline(3000);
    if (!privacy) return null;

    const rawPrimary = await screenshotRaw();
    if (!rawPrimary || taskCancelled) return null;

    // Full ML scan (face blur + OCR PII) on the primary viewport.
    const primary = await sanitizeTile(privacy, rawPrimary, true);
    if (!primary || taskCancelled) return primary;

    // Scroll-based extra tiles — only when page is significantly taller than
    // the viewport. Uses fast DOM-only redaction (no ML) per extra tile.
    const viewH = window.innerHeight;
    const pageH = document.documentElement.scrollHeight;
    if (pageH <= viewH * 1.35) return primary;

    const extraTiles = [];
    const origScroll = window.scrollY;
    const step = Math.round(viewH * 0.85); // 15% overlap between tiles
    try {
      for (let i = 1; i <= 2; i++) {
        if (taskCancelled || window.vpbaCancelCapture) break;
        const targetY = origScroll + step * i;
        if (targetY >= pageH) break;
        window.scrollTo({ top: targetY, behavior: "instant" });
        await delay(130); // let the layout repaint
        if (taskCancelled || window.vpbaCancelCapture) break;
        const rawTile = await screenshotRaw();
        if (!rawTile) break;
        const tile = await sanitizeTile(privacy, rawTile, false);
        if (tile) extraTiles.push(tile);
      }
    } finally {
      window.scrollTo({ top: origScroll, behavior: "instant" });
    }

    return extraTiles.length ? { ...primary, extraTiles } : primary;
  }

  // This preview is deliberately sent only as an in-memory runtime message.
  // It is not added to browser history, chrome.storage, or Downloads.
  function publishSanitizedPreview(source, label) {
    try {
      chrome.runtime.sendMessage({
        type: "VPBA_SANITIZED_PREVIEW",
        preview: {
          label,
          sanitizedText: String(source?.sanitizedText || ""),
          sanitizedImage: source?.imageDataUrl || null,
        },
      }).catch(() => { });
    } catch (_) { }
  }

  // ── Call agent backend ────────────────────────────────────────────────────────
  async function callAgent(intent, forceImage = false) {
    ensureNotCancelled();
    if (!extensionContextAvailable()) throw extensionReloadError();
    reportAgentStatus("sanitizing", forceImage
      ? "Preparing sanitized page context and screenshot…"
      : "Preparing sanitized page context…", true);
    const ctx = getPageContext();
    const sendImage = forceImage;
    if (sendImage) {
      // Make it explicit that the local privacy pipeline runs before anything
      // leaves the browser. The VLM call only starts after this completes.
      reportAgentStatus("sanitizing", "Scanning locally \u2014 nothing uploaded yet\u2026", true);
    }
    const image = sendImage ? await captureSanitizedImage() : null;
    ensureNotCancelled(); // exit cleanly if user stopped during the local scan

    reportAgentStatus("vlm", "Waiting for VLM response…", true);
    return new Promise((resolve, reject) => {
      try {
        // Include extra scroll tiles if we captured them.
        const extraTileB64s = (image?.extraTiles || []).map(t => t.b64).filter(Boolean);
        chrome.runtime.sendMessage({
          type: "SEND_AGENT_TASK",
          agentPayload: {
            task_intent: intent,
            perception_state: ctx,
            image_b64: image?.b64 || null,
            image_b64_tiles: extraTileB64s.length ? extraTileB64s : undefined,
            redaction_regions: (image?.redactionMap || []).map(r => ({ rect: r.boundingBox, strategy: r.strategy, category: r.category })),
            privacy_proof: { sanitized: true, rawScreenshotIncluded: false, redactionMap: image?.redactionMap || [] },
          },
        }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (taskCancelled) return reject(new Error("Stopped by user"));
          if (!res?.success) return reject(new Error(res?.error || "Agent call failed"));
          const source = {
            sanitizedText: ctx.visibleText || "",
            imageDataUrl: image?.dataUrl || null,
            redactionMap: image?.redactionMap || [],
          };
          publishSanitizedPreview(
            source,
            image ? "Sanitized text and image sent to the VLM" : "Sanitized text sent to the VLM"
          );
          resolve({
            tasks: res.tasks,
            hadImage: !!image,
            elementCount: ctx.interactiveElements.length,
            visibleTextLen: (ctx.visibleText || "").length,
            model: res.model,
            latencyMs: res.latency_ms,
            source,
          });
        });
      } catch (e) { reject(e); }
    });
  }

  // ── Latency badge (source pill removed — no mode/model/elements/text/image) ──
  function appendSourcePill(handle, { latencyMs, tries = 1 } = {}) {
    const latStr = latencyMs != null ? `${Math.round(latencyMs)}ms` : "";
    const triesStr = tries > 1 ? ` · ${tries} tries` : "";
    if (!latStr && !triesStr) return;
    handle.append(`<span class="vsrc-lat">⏱ ${latStr}${triesStr}</span>`);
  }

  // Ensure every pending/running vstep is marked done when a task finishes.
  function finaliseSteps(handle) {
    const root = handle?.bubble;
    if (!root) return;
    root.querySelectorAll(".vstep:not(.done):not(.fail)").forEach(el => {
      el.classList.remove("running");
      el.classList.add("done");
      const ic = el.querySelector(".vstep-ic");
      if (ic) ic.textContent = "✓";
    });
    const bar = root.querySelector(".vprog-bar");
    if (bar) bar.style.width = "100%";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BROWSER EXECUTOR
  //  Executes tasks returned by the VLM directly in the DOM.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a VLM target object to a live DOM element.
   *
   * Priority:
   *  1. _elMap lookup — the live DOM node stored when getPageContext() ran
   *  2. CSS selector fallback (if the model provided one)
   *
   * Using _elMap is critical: it guarantees we target the EXACT element
   * shown to the VLM. A plain querySelectorAll() would skip the visibility
   * filter and return elements in a different order, causing index mismatches
   * and silent no-ops (steps appear ✓ done but nothing actually happened).
   */
  function resolveEl(target) {
    if (!target) return null;

    // Prefer the selector when it identifies a live node.  A multi-step plan
    // can legitimately refer to a control created by an earlier step (Gmail's
    // compose editor or a YouTube search result), which was absent from the
    // original element-ID snapshot.
    if (target.selector) {
      try {
        const candidates = Array.from(document.querySelectorAll(target.selector))
          .filter(e => !e.closest("#vpba-root"));
        if (candidates.length === 1) return candidates[0];
        const cachedForSelector = target.elementId && _elMap.get(target.elementId);
        if (cachedForSelector && candidates.includes(cachedForSelector)) return cachedForSelector;
        if (candidates.length) return candidates.find(e => {
          const r = e.getBoundingClientRect();
          const s = window.getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        }) || candidates[0];
      } catch (_) { }
    }

    if (target.elementId) {
      const cached = _elMap.get(target.elementId);
      if (cached && isVisiblePageElement(cached)) return cached;
      const replacement = recoverReplacedElement(target.elementId);
      if (replacement) return replacement;
    }

    return null;
  }

  function isVisiblePageElement(el) {
    if (!el || !document.contains(el) || el.closest("#vpba-root")) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function recoverReplacedElement(elementId) {
    const descriptor = _elDescriptors.get(elementId);
    if (!descriptor) return null;
    const norm = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const expected = [descriptor.label, descriptor.placeholder, descriptor.text, descriptor.testId, descriptor.name]
      .map(norm).filter(Boolean);
    if (!expected.length) return null;
    const candidates = Array.from(document.querySelectorAll(
      "button,input,textarea,select,a[href],[contenteditable],[role='button'],[role='link'],[role='textbox']"
    )).filter(isVisiblePageElement).map(el => {
      const values = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder"),
      el.getAttribute("data-testid"), el.getAttribute("name"), elementText(el)].map(norm);
      let score = descriptor.tag === el.tagName.toLowerCase() ? 3 : 0;
      if (descriptor.role && descriptor.role === el.getAttribute("role")) score += 3;
      for (const term of expected) {
        if (values.includes(term)) score += 12;
        else if (values.some(value => value && (value.includes(term) || term.includes(value)))) score += 4;
      }
      return { el, score };
    }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.score < 12 || (candidates[1] && best.score === candidates[1].score)) return null;
    best.el.setAttribute("data-vpba-element", elementId);
    _elMap.set(elementId, best.el);
    return best.el;
  }

  async function resolveLiveElement(target, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    do {
      const element = resolveEl(target);
      if (element) return element;
      await delay(50);
    } while (Date.now() < deadline);
    return null;
  }

  function resolveTypeTarget(task) {
    const planned = resolveEl(task.target);
    if (!planned) return null;

    // Small VLMs commonly confuse Gmail's persistent Search mail input with a
    // compose editor that appeared after an earlier click. Use only local DOM
    // semantics to repair that unsafe mismatch; the page data is not exported.
    const descriptor = [
      planned.getAttribute("aria-label"), planned.getAttribute("placeholder"),
      planned.getAttribute("role"), planned.type,
    ].filter(Boolean).join(" ").toLowerCase();
    const value = String(task.value || "");
    const looksLikeLongProse = value.length > 80 && /\s/.test(value);
    if (!looksLikeLongProse || !descriptor.includes("search")) return planned;

    const editors = Array.from(document.querySelectorAll("[contenteditable='true'], [role='textbox'][contenteditable='true']"))
      .filter(el => !el.closest("#vpba-root"))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
    const composeEditor = editors.find(el => el.closest("[role='dialog']")) || editors[0];
    if (composeEditor) {
      return composeEditor;
    }
    return planned;
  }

  // Native value setters — bypass framework wrappers so React/Vue/Angular
  // state actually updates when we write to an input's value.
  const _nativeInputSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set;
  const _nativeTextaSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  function setNativeValue(el, value) {
    if (el instanceof HTMLInputElement && _nativeInputSetter) {
      _nativeInputSetter.call(el, value);
    } else if (el instanceof HTMLTextAreaElement && _nativeTextaSetter) {
      _nativeTextaSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Full pointer + mouse event sequence.
   * Dispatches the complete chain that browsers + React/SPA frameworks expect:
   * pointerover → mouseover → pointermove → pointerdown → mousedown →
   * focus → pointerup → mouseup → one native click.
   */
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, view: window,
      detail: 1, clientX: cx, clientY: cy,
    };

    el.dispatchEvent(new PointerEvent("pointerover", { ...base, isPrimary: true }));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...base, isPrimary: true, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new PointerEvent("pointermove", { ...base, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousemove", base));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true, button: 0, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }));
    el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, isPrimary: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 0 }));
    // Dispatching a click and then calling click() activates toggle controls
    // twice (Play immediately becomes Pause).  Use one activation only.
    try { el.click(); } catch (_) { }
  }

  function elementText(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return (el.innerText || el.textContent || "").trim();
  }

  // Rich editors (notably Gmail) render line breaks, non-breaking spaces and
  // invisible caret markers differently from the submitted text. Compare a
  // normalized representation so a successful trusted input is not reported
  // as failed merely because of rendering details.
  function hasTypedText(el, expected) {
    const normalize = value => String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return normalize(elementText(el)).includes(normalize(expected));
  }

  async function observePageEffect(beforeVideoState, action, timeoutMs = 900) {
    let mutated = false;
    const observer = new MutationObserver(() => { mutated = true; });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["aria-expanded", "aria-pressed", "class", "style", "hidden"],
    });
    await action();
    await delay(timeoutMs);
    observer.disconnect();
    const video = document.querySelector("video");
    return mutated || Boolean(video && beforeVideoState != null && video.paused !== beforeVideoState);
  }

  /**
   * Ask the background worker to use Chrome DevTools Protocol input at this
   * exact local DOM element. Coordinates and typed text stay inside Chrome;
   * neither is added to the VLM request. Returns false when CDP is unavailable
   * (for example, a user has DevTools attached), so the DOM fallback remains.
   */
  async function performTrustedAction(action, el, { value = "", key = "Enter" } = {}) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return new Promise(resolve => {
      try {
        if (!extensionContextAvailable()) return resolve(false);
        chrome.runtime.sendMessage({
          type: "PERFORM_TRUSTED_ACTION",
          request: {
            action,
            value,
            key,
            point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          },
        }, response => {
          if (chrome.runtime.lastError || !response?.success) return resolve(false);
          resolve(true);
        });
      } catch (_) { resolve(false); }
    });
  }

  // ── Action implementations ─────────────────────────────────────────────────

  async function doClick(task) {
    const el = await resolveLiveElement(task.target);
    if (!el) throw new Error(`click: element not found (${task.target?.elementId || task.target?.selector})`);
    const video = document.querySelector("video");
    const beforeVideoState = video ? video.paused : null;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(350);
    // A dispatched event alone is not success: a site can ignore it or an
    // overlay can intercept it. Do not report completion without an effect.
    let trusted = false;
    const changed = await observePageEffect(beforeVideoState, async () => {
      trusted = await performTrustedAction("click", el);
      if (!trusted) simulateClick(el);
    });
    // A real CDP click on a link commonly begins a document navigation before
    // this isolated world can observe a mutation.  It is still a successful
    // final activation, not a no-op.  CDP has verified the point resolves to
    // an actual page node in the background worker before reporting success.
    const isNavigationControl = el instanceof HTMLAnchorElement || el.closest("a[href]");
    if (!changed && !(trusted && isNavigationControl)) {
      throw new Error("click: no observable page change after activation");
    }
  }

  /**
   * Last-resort completion for a YouTube results continuation when the model
   * ignores its required final-click instruction. It stays entirely in the
   * page: choose a visible video title by the user's query and activate that
   * real element through the normal CDP-backed click path. No page text is
   * sent anywhere and this never creates another API call.
   */
  async function clickYoutubeFinalResult(intent) {
    let url;
    try { url = new URL(location.href); } catch (_) { return false; }
    if (!/(^|\.)youtube\.com$/i.test(url.hostname) || url.pathname !== "/results") return false;

    const firstLine = String(intent || "").split("\n", 1)[0];
    const match = firstLine.match(/\b(?:play|watch|listen(?:\s+to)?)\s+(.+?)(?:\s+(?:on|in)\s+youtube(?:\s+music)?)?\s*$/i);
    if (!match) return false;
    const stopWords = new Set(["play", "watch", "listen", "to", "on", "in", "youtube", "music", "song", "video"]);
    const terms = (match[1].toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .filter(term => term.length > 2 && !stopWords.has(term));
    if (!terms.length) return false;

    const candidates = Array.from(document.querySelectorAll("ytd-video-renderer a#video-title, a#video-title"))
      .filter(el => !el.closest("#vpba-root"))
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
    const score = el => {
      const words = (elementText(el).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
      return terms.reduce((total, term) => total + Math.max(...words.map(word => {
        if (word === term) return 8;
        if (word.startsWith(term.slice(0, 3)) || term.startsWith(word.slice(0, 3))) return 4;
        return 0;
      }), 0), 0);
    };
    const best = candidates.map(el => ({ el, score: score(el) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.score === 0) return false;

    best.el.setAttribute("data-vpba-final-result", "true");
    try {
      await doClick({ target: { selector: '[data-vpba-final-result="true"]' } });
      return true;
    } catch (_) {
      return false;
    } finally {
      best.el.removeAttribute("data-vpba-final-result");
    }
  }

  async function doType(task) {
    const el = resolveTypeTarget(task);
    if (!el) throw new Error(`type: element not found (${task.target?.elementId})`);

    // Hard guard — refuse to type into the VPBA panel itself
    if (el.closest("#vpba-root")) {
      throw new Error("type: target resolved to VPBA panel element — refusing to type there");
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(200);

    const text = String(task.value || "");
    if (await performTrustedAction("type", el, { value: text })) {
      // Gmail updates its contenteditable rendering asynchronously. Give it a
      // short render window; if it really did not retain the value, continue
      // into the normal DOM fallback below instead of falsely stopping.
      await delay(el.isContentEditable ? 450 : 180);
      if (hasTypedText(el, text)) return;
    }

    // Click first so focus lands AND React's synthetic system registers the interaction
    simulateClick(el);
    await delay(150);
    el.focus({ preventScroll: true });
    await delay(80);

    if (el.isContentEditable) {
      // Gmail and similar rich editors need an editing command, not an
      // assignment to a non-existent `value` property.
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      const inserted = document.execCommand("insertText", false, text);
      if (!inserted) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      await delay(120);
      if (!hasTypedText(el, text)) throw new Error("type: editor did not retain entered text");
      return;
    }

    // Clear using native setter so React/Vue detects the change
    setNativeValue(el, "");
    await delay(60);

    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true }));

      // Append character using native setter for React incremental state updates
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const setter = el instanceof HTMLInputElement ? _nativeInputSetter : _nativeTextaSetter;
        if (setter) {
          setter.call(el, el.value + ch);
        } else {
          el.value += ch;
        }
      } else if (el.isContentEditable) {
        el.textContent += ch;
      }

      el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true, cancelable: true }));
      await delay(35 + Math.random() * 35);
    }

    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (!hasTypedText(el, text)) throw new Error("type: input did not retain entered text");
  }

  /**
   * Press a keyboard key on the focused element or a specified target.
   * Use for Enter, Tab, Escape, ArrowDown, etc.
   * task.key   — the key string e.g. "Enter", "Tab", "Escape"
   * task.value — alias for key (so the model can use either field)
   * task.target — optional element; defaults to document.activeElement
   */
  async function doKey(task) {
    const key = task.key || task.value || "Enter";
    const el = task.target ? resolveEl(task.target) : document.activeElement;
    const tgt = el || document.body;
    if (el && await performTrustedAction("key", el, { key })) {
      await delay(250);
      return;
    }
    const opts = { key, bubbles: true, cancelable: true, view: window };

    tgt.dispatchEvent(new KeyboardEvent("keydown", opts));
    await delay(60);
    tgt.dispatchEvent(new KeyboardEvent("keypress", opts));
    tgt.dispatchEvent(new KeyboardEvent("keyup", opts));

    // Synthetic key events do not invoke the browser's default Enter action.
    // requestSubmit invokes normal form submit handlers (e.g. YouTube search).
    if (key === "Enter" && el && el.form) {
      if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
      else el.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    await delay(200);
  }

  async function doSelect(task) {
    const el = resolveEl(task.target);
    if (!el || el.tagName.toLowerCase() !== "select") throw new Error("select: not a <select>");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(150);
    const val = String(task.value || "");
    let matched = false;
    for (const opt of el.options) {
      if (opt.value === val || opt.text.trim().toLowerCase() === val.toLowerCase()) {
        el.value = opt.value; matched = true; break;
      }
    }
    if (!matched) throw new Error(`select: no option matching '${val}'`);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function doScroll(task) {
    const dir = task.direction || "down";
    const px = task.pixels || 300;
    if (task.target) {
      const el = resolveEl(task.target);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    }
    const map = {
      down: { top: px, left: 0 }, up: { top: -px, left: 0 },
      right: { top: 0, left: px }, left: { top: 0, left: -px },
    };
    window.scrollBy({ ...(map[dir] || map.down), behavior: "smooth" });
    await delay(380);
  }

  async function doWait(task) {
    const ms = task.timeout_ms || 2000;
    const cond = task.condition || "timeout";
    if (cond === "timeout") { await delay(ms); return; }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond === "navigation" && document.readyState === "complete") return;
      if (cond === "selector" && task.selector && document.querySelector(task.selector)) return;
      await delay(100);
    }
  }

  async function doNavigate(task) {
    if (!task.url) throw new Error("navigate: url required");
    window.location.href = task.url;
    await delay(400);
  }

  async function doHover(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error("hover: element not found");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await delay(180);
  }

  /**
   * Double-click an element.
   * Dispatches the full pointer sequence ending in a dblclick event.
   */
  async function doDblClick(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error(`dblclick: element not found (${task.target?.elementId || task.target?.selector})`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(300);
    simulateClick(el);           // first click
    await delay(80);
    simulateClick(el);           // second click
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
    await delay(200);
  }

  /**
   * Right-click an element (opens context menu).
   */
  async function doRightClick(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error(`rightclick: element not found (${task.target?.elementId || task.target?.selector})`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(300);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true, button: 2, buttons: 2 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 2, buttons: 2 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, isPrimary: true, button: 2 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, button: 2 }));
    el.dispatchEvent(new MouseEvent("contextmenu", { ...base, button: 2 }));
    await delay(200);
  }

  /**
   * Clear an input / textarea field completely.
   * Uses native value setters so React/Vue state also resets.
   */
  async function doClear(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error(`clear: element not found (${task.target?.elementId || task.target?.selector})`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(150);
    simulateClick(el);
    await delay(100);
    setNativeValue(el, "");
    // Also select-all + delete so contentEditable elements are cleared
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Delete", bubbles: true }));
    if (el.isContentEditable) el.textContent = "";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(100);
  }

  /**
   * Focus an element without clicking it.
   * Useful for activating dropdowns or triggering focus-dependent popups.
   */
  async function doFocus(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error(`focus: element not found (${task.target?.elementId || task.target?.selector})`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(150);
    el.focus({ preventScroll: false });
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await delay(150);
  }

  /**
   * Drag from one element (task.from) to another element (task.target).
   * Both are resolved via the standard resolveEl() path.
   * task.from   — { elementId, selector } of the drag source
   * task.target — { elementId, selector } of the drop destination
   */
  async function doDrag(task) {
    const src = resolveEl(task.from || task.source);
    const dst = resolveEl(task.target);
    if (!src) throw new Error("drag: source element not found");
    if (!dst) throw new Error("drag: destination element not found");

    src.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(300);

    const sr = src.getBoundingClientRect();
    const dr = dst.getBoundingClientRect();
    const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
    const dx = dr.left + dr.width / 2, dy = dr.top + dr.height / 2;

    const mkPtr = (type, x, y, extra = {}) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, clientX: x, clientY: y, ...extra });
    const mkMouse = (type, x, y, buttons = 1) =>
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });

    src.dispatchEvent(mkPtr("pointerdown", sx, sy, { button: 0, buttons: 1 }));
    src.dispatchEvent(mkMouse("mousedown", sx, sy));
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: sx, clientY: sy }));
    await delay(80);

    // Interpolate a few intermediate pointermove events for realism
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const mx = sx + (dx - sx) * (i / steps);
      const my = sy + (dy - sy) * (i / steps);
      document.elementFromPoint(mx, my)?.dispatchEvent(mkPtr("pointermove", mx, my));
      document.elementFromPoint(mx, my)?.dispatchEvent(mkMouse("mousemove", mx, my));
      await delay(20);
    }

    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
    src.dispatchEvent(mkPtr("pointerup", dx, dy, { button: 0 }));
    src.dispatchEvent(mkMouse("mouseup", dx, dy, 0));
    await delay(250);
  }

  /**
   * Open a URL in a new browser tab.
   * Content scripts cannot call chrome.tabs.create() directly, so this
   * delegates to background.js via OPEN_NEW_TAB message.
   * task.url — the URL to open (required)
   */
  async function doOpenTab(task) {
    const url = task.url;
    if (!url) throw new Error("opentab: url required");
    return new Promise((resolve, reject) => {
      try {
        if (!extensionContextAvailable()) return reject(extensionReloadError());
        chrome.runtime.sendMessage({ type: "OPEN_NEW_TAB", url, continuation: task._continuation }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res?.success) return reject(new Error(res?.error || "Could not open tab"));
          resolve({ tabId: res.tabId });
        });
      } catch (e) { reject(e); }
    });
  }

  async function doCloseTabs(task) {
    return new Promise((resolve, reject) => {
      try {
        if (!extensionContextAvailable()) return reject(extensionReloadError());
        chrome.runtime.sendMessage({
          type: "CLOSE_TABS",
          scope: task.scope || "all_except_current",
          tabNumbers: task.tab_numbers || [],
          tabRange: task.tab_range || null,
        }, response => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response?.success) return reject(new Error(response?.error || "Could not close other tabs"));
          resolve(response);
        });
      } catch (error) { reject(error); }
    });
  }

  /** Actions whose completion mutates the DOM (AJAX, navigation, React re-renders). */
  const DOM_MUTATING = new Set(["click", "dblclick", "rightclick", "type", "key", "navigate", "opentab", "drag"]);

  const ACTION = {
    click: doClick,
    dblclick: doDblClick,
    rightclick: doRightClick,
    type: doType,
    key: doKey,
    select: doSelect,
    scroll: doScroll,
    wait: doWait,
    navigate: doNavigate,
    hover: doHover,
    focus: doFocus,
    clear: doClear,
    drag: doDrag,
    opentab: doOpenTab,
    closetabs: doCloseTabs,
    screenshot: async () => { },
  };

  // A search result is not the user's requested final outcome. Some models do
  // not emit task_complete consistently, so recognize the standard search
  // sequence as well: an Enter submission with no later result click.
  function needsFreshResultPlan(tasksJson) {
    const steps = tasksJson?.tasks || [];
    // The returned list is an execution contract: execute every listed step.
    // A continuation is only for a single, explicitly incomplete phase whose
    // next target cannot exist until that phase changes the page. This applies
    // uniformly to every task type—tabs, forms, shopping, mail, searches,
    // and mixed plans—not merely a particular URL or prompt.
    if (steps.length !== 1) {
      return false;
    }
    if (tasksJson?.task_complete === false) return true;
    // A direct YouTube/Google results URL is a search phase even when a model
    // incorrectly labels its one navigation step as complete.
    const hasResultsNavigation = steps.some(step => {
      if (!['navigate', 'opentab'].includes(step.action)) return false;
      const url = String(step.url || '').toLowerCase();
      return (url.includes('youtube.com/results') && url.includes('search_query=')) ||
        (url.includes('google.') && url.includes('/search'));
    });
    if (hasResultsNavigation && !steps.some(step => ['click', 'dblclick'].includes(step.action))) return true;
    const submitAt = steps.findIndex(step =>
      step.action === "key" && String(step.key || step.value || "").toLowerCase() === "enter"
    );
    if (submitAt < 0) return false;
    return !steps.slice(submitAt + 1).some(step =>
      ["click", "dblclick", "navigate", "opentab"].includes(step.action)
    );
  }

  function continuationIntent(originalIntent, completedTasks) {
    const completed = (completedTasks || [])
      .map(step => step.description || step.action)
      .filter(Boolean)
      .slice(-8)
      .join("; ");
    return `${originalIntent}\n\nAGENT CONTINUATION: The browser has already completed: ${completed || "the previous phase"}. ` +
      "Read the current sanitized page state as the source of truth. Do not repeat, reopen, navigate back, or search again for completed actions. " +
      "Return only the remaining steps needed to finish the original request.";
  }

  /**
   * Local final-step recovery for an explicit shopping request. Some small
   * models answer instead of clicking a visibly available cart control on a
   * results page. We only use this when a cart button belongs to a product
   * card matching the requested product words; checkout/payment is never
   * touched and no third model call is created.
   */
  async function addMatchedResultToCart(intent) {
    const task = String(intent || "").split("\n", 1)[0].toLowerCase();
    if (!/\b(?:add|put)\b[\s\S]*\b(?:cart|basket|bag)\b/.test(task)) return false;
    const ignored = new Set(["add", "put", "cart", "basket", "bag", "my", "to", "in", "on", "the", "a", "an", "of", "amazon", "amazonin"]);
    const terms = (task.match(/[a-z0-9]+/g) || []).filter(word => word.length > 2 && !ignored.has(word));
    if (!terms.length) return false;
    const requestedNumbers = terms.filter(word => /^\d+$/.test(word));
    const buttons = Array.from(document.querySelectorAll(
      "button,input[type='submit'],input[type='button'],[role='button'],a"
    )).filter(isVisiblePageElement).filter(button => {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      const label = [elementText(button), button.getAttribute("aria-label"), button.getAttribute("title"), button.value]
        .filter(Boolean).join(" ").toLowerCase();
      return /add\s*(to)?\s*(cart|basket|bag)/i.test(label);
    });
    const scored = buttons.map(button => {
      // Result cards vary across shops. Prefer semantic product containers,
      // then use the smallest nearby ancestor with substantial product text.
      const card = button.closest("[data-component-type='s-search-result'], [data-asin], article, li, [role='listitem']") || button.parentElement;
      const cardText = (card?.innerText || "").toLowerCase();
      const score = terms.reduce((total, term) => total + (cardText.includes(term) ? 1 : 0), 0);
      const hasRequestedNumbers = requestedNumbers.every(number => new RegExp(`\\b${number}\\b`).test(cardText));
      return { button, score, hasRequestedNumbers };
    }).sort((a, b) => b.score - a.score);
    const best = scored[0];
    // Require two independent product words (e.g. sony + bravia), avoiding a
    // random recommended item whose only match is the generic word "tv".
    if (!best || best.score < Math.min(2, terms.length) ||
      (scored[1] && best.score === scored[1].score)) return false;
    best.button.setAttribute("data-vpba-cart-fallback", "true");
    try {
      await doClick({ target: { selector: '[data-vpba-cart-fallback="true"]' } });
      return true;
    } catch (_) {
      return false;
    } finally {
      best.button.removeAttribute("data-vpba-cart-fallback");
    }
  }

  // ── Task execution with live progress ─────────────────────────────────────
  async function execTasks(tasksJson, onProg, continuation = {}) {
    const steps = tasksJson?.tasks || [];
    if (!steps.length) return { success: true, completedSteps: 0 };
    let done = 0;
    for (let index = 0; index < steps.length; index++) {
      if (taskCancelled) return { success: false, completedSteps: done, error: "Stopped by user" };
      const step = steps[index];
      reportAgentStatus(
        "executing",
        `Executing step ${step.step} of ${steps.length}: ${step.description || step.action}`,
        true
      );
      onProg(step.step, steps.length, "running");
      const fn = ACTION[step.action];
      if (!fn) {
        onProg(step.step, steps.length, "fail");
        return { success: false, error: `Unknown action: ${step.action}` };
      }
      try {
        // A document navigation removes this content script. Persist the rest
        // before leaving; the script on the destination page resumes it.
        if (step.action === "navigate") {
          if (myTabId != null && (index + 1 < steps.length || continuation.replanAfterNavigation)) {
            await sessionSet(`${NAVIGATION_STATE_PREFIX}${myTabId}`, {
              tasks: steps.slice(index + 1),
              intent: continuation.intent || "",
              completed: steps.slice(0, index + 1),
              replan: Boolean(continuation.replanAfterNavigation),
              createdAt: Date.now(), fromUrl: location.href,
            });
          }
          window.location.assign(step.url);
          return { success: true, completedSteps: done + 1, navigating: true };
        }
        // Search submit often performs a normal document navigation (Google)
        // instead of an SPA update. Save the fresh-page re-plan before Enter,
        // otherwise this content script disappears before it can click the
        // actual search result.
        if (
          continuation.replanAfterNavigation &&
          step.action === "key" &&
          String(step.key || step.value || "").toLowerCase() === "enter" &&
          myTabId != null
        ) {
          await sessionSet(`${NAVIGATION_STATE_PREFIX}${myTabId}`, {
            tasks: [], intent: continuation.intent || "", replan: true,
            completed: steps.slice(0, index + 1),
            createdAt: Date.now(), fromUrl: location.href,
          });
        }
        const executableStep = step.action === "opentab" && continuation.replanAfterNavigation
          ? { ...step, _continuation: { intent: continuation.intent || "", replan: true } }
          : step;
        const actionResult = await fn(executableStep);
        done++;
        onProg(step.step, steps.length, "done");
        // Opening a new tab also replaces the execution context. Transfer a
        // required fresh-page plan to the new tab so "open YouTube then play
        // X" continues from YouTube instead of stopping at the first step.
        if (step.action === "opentab" && continuation.replanAfterNavigation && actionResult?.tabId != null) {
          return { success: true, completedSteps: done, navigating: true };
        }
      } catch (e) {
        onProg(step.step, steps.length, "fail");
        return { success: false, completedSteps: done, error: e.message };
      }

      // Keep IDs bound to the exact snapshot the VLM planned against. Rebuilding
      // element_1, element_2, ... after a DOM change can silently target a
      // different control in later steps.
      if (DOM_MUTATING.has(step.action)) {
        await delay(600); // let AJAX / React re-render
      } else {
        await delay(140);
      }
    }
    // If Enter updated an SPA instead of navigating, the caller will re-plan
    // immediately from the new DOM. Do not leave stale continuation state for
    // an unrelated future refresh.
    if (continuation.replanAfterNavigation && myTabId != null) {
      await sessionRemove(`${NAVIGATION_STATE_PREFIX}${myTabId}`);
    }
    return { success: true, completedSteps: done };
  }

  async function resumeAfterNavigation() {
    if (myTabId == null) return;
    const key = `${NAVIGATION_STATE_PREFIX}${myTabId}`;
    const saved = await sessionGet(key);
    if (!saved) return;
    await sessionRemove(key); // avoid replaying a plan after a later reload
    if (Date.now() - saved.createdAt > 120000) return;

    if (saved.replan && saved.intent) {
      const handle = addAgent(`<div class="vretry">Reading the new page to continue the task\u2026</div>`);
      setProcessing(true);
      try {
        // Wait for the page to be fully interactive before taking the
        // continuation screenshot. Heavy SPAs (Gmail, Notion, Outlook) mount
        // their UI asynchronously — a screenshot taken too early shows only a
        // loading shell, so the VLM can't see the controls it needs to click.
        await new Promise(resolve => {
          if (document.readyState === "complete") return resolve();
          window.addEventListener("load", resolve, { once: true });
        });
        // Extra settle time for known heavy SPAs.
        const slowSite = /mail\.google\.com|outlook\.(live|office)\.com|notion\.so|linear\.app/i.test(location.hostname);
        await delay(slowSite ? 2000 : 800);

        ensureNotCancelled();
        const followUpIntent = continuationIntent(saved.intent, saved.completed);
        // Provide a fresh sanitized screenshot so the model sees the current
        // page state (inbox open, search results loaded, etc.).
        const next = await callAgent(followUpIntent, true);
        const hasTasks = Array.isArray(next.tasks?.tasks) && next.tasks.tasks.length > 0;

        if (!hasTasks) {
          // VLM returned an answer/reasoning — the model considers the task
          // done or is summarising the situation.  Treat it as a completion
          // rather than an error so the user sees the response text.
          if (await clickYoutubeFinalResult(saved.intent)) {
            handle.set(`<div class="vans">Opened the best matching YouTube video.</div>`);
          } else if (await addMatchedResultToCart(saved.intent)) {
            handle.set(`<div class="vans">Added the visible matching item to the cart.</div>`);
          } else {
            const answer = next.tasks?.answer || next.tasks?.reasoning;
            if (answer) {
              // Model gave a text answer — show it as a normal agent response.
              handle.set(`<div class="vans">${esc(answer)}</div>`);
            } else {
              // No tasks and no answer: retry once with longer settle time.
              await delay(1500);
              ensureNotCancelled();
              const retry = await callAgent(followUpIntent, true);
              if (Array.isArray(retry.tasks?.tasks) && retry.tasks.tasks.length > 0) {
                renderTasks(handle, retry.tasks);
                handle.save();
                const retryExec = await execTasks(retry.tasks, (s, t, status) => updateStep(s, status, t), {
                  intent: saved.intent, replanAfterNavigation: needsFreshResultPlan(retry.tasks),
                });
                appendSourcePill(handle, retry);
                finaliseSteps(handle);
                if (!retryExec.navigating && !retryExec.success)
                  handle.append(`<div class="verr">Stopped: ${esc(retryExec.error || "")}</div>`);
              } else {
                const retryAnswer = retry.tasks?.answer || retry.tasks?.reasoning;
                handle.set(retryAnswer
                  ? `<div class="vans">${esc(retryAnswer)}</div>`
                  : `<div class="verr">Could not determine next steps on this page. Try rephrasing your request.</div>`);
              }
            }
          }
        } else {
          renderTasks(handle, next.tasks);
          handle.save();
          const navExecResult = await execTasks(next.tasks, (s, t, status) => updateStep(s, status, t), {
            intent: saved.intent, replanAfterNavigation: needsFreshResultPlan(next.tasks),
          });
          appendSourcePill(handle, next);
          finaliseSteps(handle);
          if (!navExecResult.navigating && !navExecResult.success)
            handle.append(`<div class="verr">Stopped: ${esc(navExecResult.error || "")}</div>`);
        }
      } catch (err) {
        if (await clickYoutubeFinalResult(saved.intent)) {
          handle.set(`<div class="vans">Opened the best matching YouTube video.</div>`);
        } else {
          handle.set(`<div class="verr">Could not continue: ${esc(err?.message || err)}</div>`);
        }
      }
      setProcessing(false);
      handle.save();
      return;
    }
    if (!Array.isArray(saved.tasks) || !saved.tasks.length) return;

    const handle = addAgent(`<div class="vretry">Continuing the task after navigation…</div>`);
    setProcessing(true);
    renderTasks(handle, { tasks: saved.tasks });
    handle.save();
    const contResult = await execTasks({ tasks: saved.tasks }, (s, t, status) => updateStep(s, status, t), { intent: saved.intent });
    finaliseSteps(handle);
    if (!contResult.navigating) {
      handle.append(contResult.success
        ? `<div class="vans" style="margin-top:8px">Remaining steps completed.</div>`
        : `<div class="verr" style="margin-top:8px">Stopped: ${esc(contResult.error || "")}</div>`);
      setProcessing(false);
      if (!contResult.success) setStatus("err");
    }
    handle.save();
  }

  // ── Render tasks card into a message handle ───────────────────────────────
  function renderTasks(handle, tasksJson) {
    const steps = tasksJson?.tasks || [];
    const answerHtml = tasksJson.answer
      ? `<div class="vans" style="margin-bottom:8px">${esc(tasksJson.answer)}</div>` : "";
    // Keep this markup compact. The native side-panel renders agent content with
    // preserved whitespace, so indented template literals otherwise become large
    // visible gaps above and between task rows.
    const stepsHtml = steps.map(s =>
      `<div class="vstep" id="vpba-s-${s.step}"><span class="vstep-ic">·</span><span class="vstep-tx">${esc(s.description || s.action)}</span></div>`
    ).join("");

    handle.set(`${answerHtml}<div class="vtasks"><div class="vtasks-hdr">▶ ${steps.length} step${steps.length !== 1 ? "s" : ""}</div><div class="vprog"><div class="vprog-bar" id="vpba-pbar"></div></div>${stepsHtml}</div>`);
  }

  function updateStep(step, status, total) {
    const el = document.getElementById(`vpba-s-${step}`);
    const bar = document.getElementById("vpba-pbar");
    // running shows the same pending dot — no spinner icon
    const ic = { done: "✓", fail: "✗" };
    if (el) {
      el.className = `vstep ${status}`;
      el.querySelector(".vstep-ic").textContent = ic[status] || "·";
    }
    if (bar && total) bar.style.width = `${Math.round(step / total * 100)}%`;
  }

  // ── Main send handler ──────────────────────────────────────────────────────
  async function handleSend() {
    const text = inp.value.trim();
    if (!text || processing) return;
    inp.value = ""; inp.style.height = "38px";

    taskCancelled = false;
    addUser(text);
    const handle = addAgent(); // shows thinking dots
    setProcessing(true);

    // Action tasks include a locally redacted image on their first call.
    let result;
    let tries = 1;
    try {
      result = await callAgent(text, !isQuestion(text));
    } catch (err) {
      const msg = err?.message || String(err);
      const isConn = /connect|fetch|network|tunnel|econnrefused/i.test(msg);
      handle.set(`<div class="verr">${esc(msg)}${isConn ? `
        <div class="verr-help">
          • Check VLM server: <code>curl http://127.0.0.1:9001/health</code><br>
          • The extension sends only browser-sanitized content directly to <code>/v1/agent</code>
        </div>` : ""}</div>`);
      handle.save();
      setProcessing(false);
      setStatus("err");
      reportAgentStatus("error", "VLM request failed", false);
      return;
    }

    let { tasks } = result;

    result.tries = tries;

    // Update model label in header
    if (result.model) {
      const lbl = document.getElementById("vpba-hdr-subtitle");
      if (lbl) lbl.textContent = result.model.split("/").pop() || result.model;
    }

    const hasTasks = Array.isArray(tasks?.tasks) && tasks.tasks.length > 0;
    const isAnswer = tasks?.type === "answer" || !hasTasks;

    // ── Pure Q&A answer ──
    if (isAnswer) {
      const txt = tasks?.answer || tasks?.reasoning || "Done.";
      handle.set(`<div class="vans">${esc(txt)}</div>`);
      appendSourcePill(handle, result);
      handle.save();
      setProcessing(false);
      reportAgentStatus("complete", "Response complete", false);
      return;
    }

    // ── Needs confirmation ──
    if (tasks.requires_confirmation) {
      const reason = esc(tasks.reasoning || "The agent needs confirmation before proceeding.");
      const ansHtml = tasks.answer
        ? `<div class="vans" style="margin-bottom:7px">${esc(tasks.answer)}</div>` : "";
      handle.set(`${ansHtml}<div class="vconf">
        <div class="vconf-title">⚠ Confirmation needed</div>
        <div class="vconf-reason">${reason}</div>
        <div class="vconf-actions">
          <button class="vbtn vbtn-go" id="vpba-yes">Proceed ✓</button>
          <button class="vbtn vbtn-no" id="vpba-no">Cancel</button>
        </div>
      </div>`);
      appendSourcePill(handle, result);
      handle.save();
      setProcessing(false);
      reportAgentStatus("confirmation", "Awaiting your confirmation", false);

      document.getElementById("vpba-yes").addEventListener("click", async () => {
        setProcessing(true);
        reportAgentStatus("executing", "Executing confirmed task…", true);
        renderTasks(handle, tasks);
        // The confirmed plan can also navigate away from this document.
        handle.save();
        const execResult = await execTasks(tasks, (s, t, status) => updateStep(s, status, t), {
          intent: text, replanAfterNavigation: needsFreshResultPlan(tasks),
        });
        appendSourcePill(handle, result);
        finaliseSteps(handle);
        setProcessing(false);
        if (!execResult.success) {
          handle.append(`<div class="verr" style="margin-top:8px">Stopped: ${esc(execResult.error || "")}</div>`);
          setStatus("err");
        }
        handle.save();
      });
      document.getElementById("vpba-no").addEventListener("click", () => {
        handle.set(`<div style="color:#8b949e;font-size:12px">Cancelled.</div>`);
        handle.save();
        setProcessing(false);
        reportAgentStatus("stopped", "Task cancelled", false);
      });
      return;
    }

    // ── Execute immediately ──
    renderTasks(handle, tasks);
    // Preserve the task card before a navigation destroys this document.
    handle.save();
    let execResult = await execTasks(tasks, (s, t, status) => updateStep(s, status, t), {
      intent: text, replanAfterNavigation: needsFreshResultPlan(tasks),
    });

    // SPA searches (for example YouTube) do not replace the document. Re-plan
    // from their fresh DOM only when Gemini explicitly marks the phase
    // incomplete. The explicit task-wide budget limits retries to prevent an
    // endlessly changing page from producing unbounded VLM calls.
    let followUp = 0;
    while (execResult.success && !execResult.navigating && needsFreshResultPlan(tasks) && followUp < MAX_AGENT_CALLS_PER_TASK - 1) {
      followUp++;
      handle.append(`<div class="vretry" style="margin-top:6px">Checking updated results (phase ${followUp + 1}/${MAX_AGENT_CALLS_PER_TASK})...</div>`);
      try {
        const followUpIntent = continuationIntent(text, tasks.tasks);
        const next = await callAgent(followUpIntent, true);
        result = next;
        tasks = next.tasks;
        if (!Array.isArray(tasks?.tasks) || !tasks.tasks.length) {
          execResult = { success: false, completedSteps: 0, error: tasks?.answer || "Model returned no remaining task." };
          break;
        }
        renderTasks(handle, tasks);
        handle.save();
        execResult = await execTasks(tasks, (s, t, status) => updateStep(s, status, t), {
          intent: text, replanAfterNavigation: needsFreshResultPlan(tasks),
        });
      } catch (err) {
        execResult = { success: false, completedSteps: 0, error: err?.message || String(err) };
        break;
      }
    }
    if (execResult.success && !execResult.navigating && needsFreshResultPlan(tasks)) {
      execResult = { success: false, completedSteps: execResult.completedSteps, error: `Task still needs another page change after the ${MAX_AGENT_CALLS_PER_TASK}-call limit.` };
    }

    appendSourcePill(handle, result);
    finaliseSteps(handle);
    setProcessing(false);
    if (!execResult.success) {
      handle.append(`<div class="verr" style="margin-top:8px">Stopped at step ${execResult.completedSteps + 1}: ${esc(execResult.error || "")}</div>`);
      setStatus("err");
    }
    handle.save();
    reportAgentStatus(execResult.success ? "complete" : "error", execResult.success ? "Task complete" : "Task stopped", false);
  }

  // ── Input events ──────────────────────────────────────────────────────────
  sendB.addEventListener("click", () => processing ? stopActiveTask() : handleSend());
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  inp.addEventListener("input", () => {
    inp.style.height = "38px";
    inp.style.height = Math.min(inp.scrollHeight, 110) + "px";
  });

  // The persistent native side panel delegates execution to this page-bound
  // agent, which is the only component allowed to read the page DOM.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "VPBA_STOP_SIDE_PANEL_TASK") {
      stopActiveTask();
      sendResponse({ success: true });
      return false;
    }
    if (message.type !== "VPBA_SIDEPANEL_TASK") return false;
    if (processing) {
      sendResponse({ success: false, error: "An agent task is already running." });
      return false;
    }
    const taskText = String(message.text || "").trim();
    if (!taskText) {
      sendResponse({ success: false, error: "Empty task text received." });
      return false;
    }
    // Set the hidden textarea so handleSend() can read it, temporarily
    // re-enabling it in case a previous task left it disabled.
    inp.disabled = false;
    inp.value = taskText;
    handleSend();
    sendResponse({ success: true });
    return false;
  });

  // ── Init: load the browser-wide (not per-tab) conversation ───────────────
  (async () => {
    myTabId = await getMyTabId();
    const panelState = await new Promise(resolve => {
      chrome.storage.local.get(BROWSER_PANEL_OPEN_KEY, value => resolve(value?.[BROWSER_PANEL_OPEN_KEY]));
    });
    if (panelState) openPanel();
    const hadHistory = await loadHistory();
    if (!hadHistory) {
      const elemCount = document.querySelectorAll("button,input,textarea,select,a[href]").length;
      _renderAgentBubble(
        `<div class="vans">Hi! I can see <strong>${elemCount}</strong> interactive elements on this page.</div>
         <div class="vctx">💬 Ask a question &nbsp;|&nbsp; 🤖 Give me a task to perform</div>`
      );
    }
    await resumeAfterNavigation();
  })();

})();
