/**
 * chatbot.js v2 — Visual Perception Agent Side Panel
 *
 * Improvements over v1:
 *  1. Chat history persists across same-tab page navigations (chrome.storage.session)
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
  const PANEL_W   = 390;
  const MAX_ELEMS = 60;
  const MAX_TEXT  = 3000;
  const MAX_HIST  = 60;
  const histKey   = (id) => `vpba_hist_${id}`;

  const PII_RE = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
    /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen    = false;
  let processing   = false;
  let pendingTasks = null;   // eslint-disable-line no-unused-vars
  let myTabId      = null;
  let chatHistory  = [];     // [{ role:"user"|"agent", text?:"", html?:"" }]

  /**
   * Live element reference map — populated during each getPageContext() call.
   * Maps "element_N" → the actual DOM node captured at that index.
   *
   * This is critical: without it, resolveEl() falls back to a raw
   * querySelectorAll that doesn't apply the same visibility filter used
   * during capture, causing index mismatches and silent no-ops.
   */
  const _elMap = new Map();

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
    flex: 1; overflow-y: auto; padding: 12px 11px;
    display: flex; flex-direction: column; gap: 9px;
  }
  #vpba-msgs::-webkit-scrollbar { width: 3px; }
  #vpba-msgs::-webkit-scrollbar-thumb { background: rgba(255,255,255,.08); border-radius: 2px; }

  .vm { display: flex; flex-direction: column; max-width: 93%; }
  .vm.u { align-self: flex-end; align-items: flex-end; }
  .vm.a { align-self: flex-start; align-items: flex-start; }

  .vb {
    padding: 9px 12px; border-radius: 12px;
    font-size: 12.5px; line-height: 1.55; word-break: break-word; white-space: pre-wrap;
  }
  .vm.u .vb {
    background: linear-gradient(135deg,#7c3aed,#2563eb);
    color: #fff; border-bottom-right-radius: 4px;
  }
  .vm.a .vb {
    background: rgba(22,27,34,.85);
    border: 1px solid rgba(48,54,61,.55);
    color: #e6edf3; border-bottom-left-radius: 4px;
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
    margin-top: 7px;
    background: rgba(10,14,20,.7);
    border: 1px solid rgba(48,54,61,.5);
    border-radius: 9px; overflow: hidden; font-size: 11.5px;
  }
  .vtasks-hdr {
    padding: 7px 11px;
    background: rgba(124,58,237,.1);
    border-bottom: 1px solid rgba(48,54,61,.4);
    font-weight: 700; color: #a78bfa;
    font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em;
  }
  .vprog { height: 2px; background: rgba(48,54,61,.4); margin: 0 11px 0; }
  .vprog-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg,#7c3aed,#a78bfa);
    border-radius: 1px; transition: width .3s ease;
  }
  .vstep {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 7px 11px; border-bottom: 1px solid rgba(48,54,61,.25);
    color: #6e7681; transition: color .2s;
  }
  .vstep:last-child { border-bottom: none; }
  .vstep.running { color: #fbbf24; }
  .vstep.done    { color: #22c55e; }
  .vstep.fail    { color: #f87171; }
  .vstep-ic { flex-shrink: 0; width: 13px; text-align: center; }
  .vstep-tx { flex: 1; line-height: 1.4; }

  /* answer plain text */
  .vans { color: #e6edf3; line-height: 1.6; font-size: 12.5px; }

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
    margin-top: 7px;
    background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.22);
    border-radius: 9px; padding: 10px 12px;
  }
  .vconf-title { font-size: 11.5px; font-weight: 700; color: #fbbf24; }
  .vconf-reason { font-size: 11px; color: #8b949e; margin-top: 3px; }
  .vconf-actions { display: flex; gap: 7px; margin-top: 9px; }
  .vbtn {
    flex: 1; padding: 7px 0; border-radius: 7px; border: none;
    font-size: 11.5px; font-weight: 700; cursor: pointer; transition: opacity .15s;
  }
  .vbtn:hover{opacity:.8}
  .vbtn-go { background: #22c55e; color: #000; }
  .vbtn-no { background: rgba(48,54,61,.8); color: #e6edf3; }

  /* context pill */
  .vctx {
    font-size: 10.5px; color: #8b949e;
    background: rgba(22,27,34,.7);
    border: 1px solid rgba(48,54,61,.4);
    border-radius: 6px; padding: 4px 8px; margin-top: 6px;
    display: inline-flex; align-items: center; gap: 5px;
  }

  /* ── Source transparency pill ── */
  .vsrc { margin-top: 7px; font-size: 10.5px; }
  .vsrc > summary {
    cursor: pointer; color: #6e7681; list-style: none;
    background: rgba(22,27,34,.6); border: 1px solid rgba(48,54,61,.35);
    border-radius: 6px; padding: 4px 9px;
    display: inline-flex; align-items: center; gap: 5px;
    user-select: none; transition: color .15s, background .15s;
  }
  .vsrc > summary::-webkit-details-marker { display: none; }
  .vsrc > summary:hover { color: #c9d1d9; background: rgba(22,27,34,.95); }
  .vsrc[open] > summary { border-radius: 6px 6px 0 0; border-bottom-color: transparent; }
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
  `;

  // ── HTML ────────────────────────────────────────────────────────────────────
  const html = `
  <button id="vpba-tab" title="Open Visual Agent">
    <span id="vpba-tab-icon">👁</span>
    <span id="vpba-tab-letter">AGENT</span>
  </button>
  <div id="vpba-panel">
    <div id="vpba-hdr">
      <div id="vpba-hdr-logo">👁</div>
      <span id="vpba-hdr-title">Visual Agent</span>
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

  // ── Inject ─────────────────────────────────────────────────────────────────
  const styleEl = document.createElement("style");
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  const rootEl = document.createElement("div");
  rootEl.id = "vpba-root";
  rootEl.innerHTML = html;
  document.body.appendChild(rootEl);

  // Refs
  const tab    = document.getElementById("vpba-tab");
  const panel  = document.getElementById("vpba-panel");
  const closeB = document.getElementById("vpba-close");
  const msgs   = document.getElementById("vpba-msgs");
  const inp    = document.getElementById("vpba-in");
  const sendB  = document.getElementById("vpba-send");
  const statusD= document.getElementById("vpba-hdr-status");

  // ── Panel toggle ────────────────────────────────────────────────────────────
  function openPanel()  { panelOpen = true;  panel.classList.add("open");    tab.classList.add("shifted"); inp.focus(); }
  function closePanel() { panelOpen = false; panel.classList.remove("open"); tab.classList.remove("shifted"); }
  tab.addEventListener("click",   () => panelOpen ? closePanel() : openPanel());
  closeB.addEventListener("click", closePanel);

  // ── Status dot ──────────────────────────────────────────────────────────────
  function setStatus(s) { statusD.className = s ? s : ""; }
  setStatus("ok");

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function esc(t) {
    return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function now() { return new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}); }
  function scrollBot() { msgs.scrollTop = msgs.scrollHeight; }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Tab ID ──────────────────────────────────────────────────────────────────
  async function getMyTabId() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, res => {
          if (chrome.runtime.lastError || !res?.tabId) return resolve(null);
          resolve(res.tabId);
        });
      } catch { resolve(null); }
    });
  }

  // ── History storage ──────────────────────────────────────────────────────────
  async function loadHistory() {
    if (!myTabId) return false;
    return new Promise(resolve => {
      try {
        chrome.storage.session.get(histKey(myTabId), result => {
          if (chrome.runtime.lastError) return resolve(false);
          const hist = result[histKey(myTabId)];
          if (!hist || !hist.length) return resolve(false);
          chatHistory = hist;
          hist.forEach(m => {
            if (m.role === "user")  _renderUserBubble(m.text);
            else if (m.role === "agent") _renderAgentBubble(m.html);
          });
          resolve(true);
        });
      } catch { resolve(false); }
    });
  }

  function persistHistory() {
    if (!myTabId) return;
    try {
      const trimmed = chatHistory.slice(-MAX_HIST);
      chrome.storage.session.set({ [histKey(myTabId)]: trimmed });
    } catch (_) {}
  }

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
    return {
      el, bubble, ts,
      set(html)    { bubble.innerHTML = html; ts.textContent = now(); scrollBot(); },
      append(html) { bubble.insertAdjacentHTML("beforeend", html); scrollBot(); },
      save()       {
        const saved = bubble.cloneNode(true);
        saved.querySelectorAll(".vsrc-preview").forEach(node => node.remove());
        chatHistory.push({ role: "agent", html: saved.innerHTML });
        persistHistory();
      },
    };
  }

  function setProcessing(v) {
    processing = v;
    sendB.disabled = v;
    inp.disabled = v;
    setStatus(v ? "run" : "ok");
  }

  // ── PII sanitizer ────────────────────────────────────────────────────────────
  function sanitize(t) {
    if (!t) return "";
    let s = String(t);
    // Use the fuller local PII classifier from content.js when it is loaded;
    // it covers credentials, OTPs, tokens and IDs in addition to this
    // panel's lightweight fallback patterns.
    if (typeof window.sanitizeText === "function") return window.sanitizeText(s);
    PII_RE.forEach(p => { s = s.replace(p, "<REDACTED>"); });
    return s;
  }

  // ── Question vs task detection ────────────────────────────────────────────────
  // Only classify as a question if the intent STARTS with a question word.
  // Avoids false positives like "please ask chatgpt what is X" where
  // "what" is buried inside an action sentence.
  const QUESTION_START_RE = /^(what|how many|how much|is there|are there|show me|find|list|tell me|describe|count|which|where|when|who|why|does|did|can you see|do you see|any|how)\b/i;
  const QUESTION_FULL_RE  = /^(what|how|which|is|are|does|did|can|who|where|when|why)\b[^.!]*\?\s*$/i;

  function isQuestion(intent) {
    const t = intent.trim();
    return QUESTION_START_RE.test(t) || QUESTION_FULL_RE.test(t);
  }

  function modelNeedsImage(tasks) {
    if (!tasks) return false;
    // VLM explicitly requested a screenshot via the new schema field
    if (tasks.requires_screenshot === true) return true;
    // Reasoning text signals the model needs visual context to proceed
    const r = (tasks.reasoning || "").toLowerCase();
    return /need(s?\s+)?(to\s+)?(see|the\s+screenshot|image|visual|picture)|cannot\s+(see|identify|find|determine\s+visually)|need\s+visual|unclear\s+from\s+text/i.test(r);
  }

  // ── Page context extraction ────────────────────────────────────────────────
  function getPageContext() {
    _elMap.clear(); // reset for this capture session

    const allInteractive = Array.from(
      document.querySelectorAll(
        "button,input,textarea,select,a[href],[contenteditable='true']," +
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
      const r = el.getBoundingClientRect();
      return {
        elementId: id,
        tag: el.tagName.toLowerCase(),
        category: { BUTTON:"button", INPUT:"input", TEXTAREA:"textarea",
                    SELECT:"select", A:"link" }[el.tagName] || el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        text: sanitize((el.innerText || el.value || el.textContent || "").trim().slice(0, 120)),
        placeholder: sanitize(el.getAttribute("placeholder") || ""),
        label: sanitize(el.getAttribute("aria-label") || el.getAttribute("title") || ""),
        disabled: Boolean(el.disabled),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      };
    });

    const visibleText = sanitize(
      (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT)
    );

    let safeUrl = "<URL>";
    try {
      const u = new URL(window.location.href);
      u.username = ""; u.password = ""; u.search = ""; u.hash = "";
      safeUrl = u.toString();
    } catch (_) {}

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

  // ── Screenshot via background.js ─────────────────────────────────────────────
  async function captureSanitizedImage() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, res => {
          if (chrome.runtime.lastError || !res?.success) return resolve(null);
          resolve(res.screenshot);
        });
      } catch { resolve(null); }
    }).then(async rawScreenshot => {
      if (!rawScreenshot) return null;
      // content.js provides the local redactor. Never fall back to a raw image.
      const pageContext = window.extractPageContext?.();
      const redact = window.redactScreenshot;
      const makeMap = window.createRedactionMap;
      const assertSanitized = window.assertSanitizedScreenshot;
      if (!pageContext || typeof redact !== "function" || typeof makeMap !== "function" || typeof assertSanitized !== "function") {
        console.warn("[VPBA] Screenshot omitted: local redaction pipeline unavailable");
        return null;
      }
      const sensitive = pageContext.sensitiveElements || [];
      const redactionMap = makeMap(sensitive);
      const dataUrl = await redact(rawScreenshot, sensitive);
      assertSanitized(dataUrl, redactionMap);
      return { dataUrl, b64: dataUrl.replace(/^data:image\/\w+;base64,/, ""), redactionMap };
    });
  }

  // ── Call agent backend ────────────────────────────────────────────────────────
  async function callAgent(intent, forceImage = false) {
    const ctx = getPageContext();
    // Action intents always get the screenshot so the VLM can visually ground element IDs.
    // Question/info intents skip the screenshot (text context is sufficient).
    // forceImage overrides everything (used on retries).
    const sendImage = forceImage || !isQuestion(intent);
    const image = sendImage ? await captureSanitizedImage() : null;

    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: "SEND_AGENT_TASK",
          agentPayload: {
            task_intent: intent,
            perception_state: ctx,
            image_b64: image?.b64 || null,
            redaction_regions: (image?.redactionMap || []).map(r => ({ rect: r.boundingBox, strategy: r.strategy, category: r.category })),
            privacy_proof: { sanitized: true, rawScreenshotIncluded: false, redactionMap: image?.redactionMap || [] },
          },
        }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res?.success) return reject(new Error(res?.error || "Agent call failed"));
          resolve({
            tasks:          res.tasks,
            hadImage:       !!image,
            elementCount:   ctx.interactiveElements.length,
            visibleTextLen: (ctx.visibleText || "").length,
            model:          res.model,
            latencyMs:      res.latency_ms,
            source: {
              sanitizedText: ctx.visibleText || "",
              imageDataUrl: image?.dataUrl || null,
              redactionMap: image?.redactionMap || [],
            },
          });
        });
      } catch (e) { reject(e); }
    });
  }

  // ── Source transparency pill ──────────────────────────────────────────────────
  function appendSourcePill(handle, { hadImage, elementCount, visibleTextLen, model, latencyMs, tries = 1, source = {} }) {
    const imgBadge = hadImage
      ? `<span class="vsrc-badge img">📷 screenshot</span>`
      : `<span class="vsrc-badge">📄 text only</span>`;
    const modelShort = esc((model || "unknown").split("/").pop());
    const latStr  = latencyMs != null ? `${latencyMs}ms` : "?";
    const triesStr = tries > 1 ? ` · ${tries} tries` : "";
    const safeText = esc(source.sanitizedText || "");
    const regions = source.redactionMap || [];
    const categories = [...new Set(regions.map(r => r.category || r.type || "PII"))].join(", ") || "none detected";
    const imagePreview = hadImage && typeof source.imageDataUrl === "string" && source.imageDataUrl.startsWith("data:image/")
      ? `<div class="vsrc-preview"><img src="${source.imageDataUrl}" alt="Sanitized screenshot sent to the model"><div class="vsrc-note">Preview of the sanitized image sent to the model — ${regions.length} redaction region${regions.length === 1 ? "" : "s"}: ${esc(categories)}.</div></div>`
      : "";

    handle.append(`
      <details class="vsrc">
        <summary>📎 Source · ${hadImage ? "📷 with image" : "📄 text-only"} · ${latStr}${triesStr}</summary>
        <div class="vsrc-body">
          <div class="vsrc-row"><span>Mode</span>${imgBadge}</div>
          <div class="vsrc-row"><span>Model</span><span class="vsrc-code">${modelShort}</span></div>
          <div class="vsrc-row"><span>Page elements</span><span class="vsrc-val">${elementCount}</span></div>
          <div class="vsrc-row"><span>Text sent</span><span class="vsrc-val">${visibleTextLen.toLocaleString()} chars</span></div>
          <div class="vsrc-row"><span>Latency</span><span class="vsrc-val">${latStr}</span></div>
          <div class="vsrc-row"><span>Tries</span><span class="vsrc-val">${tries}</span></div>
          <div class="vsrc-row"><span>Text payload</span><span class="vsrc-val">sanitized</span></div>
          <pre class="vsrc-copy">${safeText || "(No page text was sent.)"}</pre>
          ${imagePreview}
        </div>
      </details>
    `);
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
      } catch (_) {}
    }

    if (target.elementId) {
      const cached = _elMap.get(target.elementId);
      if (cached && document.contains(cached)) return cached;
      console.warn(`[VPBA] _elMap miss for ${target.elementId}`);
    }

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
      console.warn("[VPBA] Repaired prose target from search control to visible editor");
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
    el.dispatchEvent(new Event("input",  { bubbles: true }));
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
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, view: window,
      detail: 1, clientX: cx, clientY: cy,
    };

    el.dispatchEvent(new PointerEvent("pointerover",  { ...base, isPrimary: true }));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...base, isPrimary: true, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseover",  base));
    el.dispatchEvent(new PointerEvent("pointermove", { ...base, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousemove",  base));
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true, button: 0, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, button: 0, buttons: 1 }));
    el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup",  { ...base, isPrimary: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup",  { ...base, button: 0 }));
    // Dispatching a click and then calling click() activates toggle controls
    // twice (Play immediately becomes Pause).  Use one activation only.
    try { el.click(); } catch (_) {}
  }

  function elementText(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return (el.innerText || el.textContent || "").trim();
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
    const el = resolveEl(task.target);
    if (!el) throw new Error(`click: element not found (${task.target?.elementId || task.target?.selector})`);
    const video = document.querySelector("video");
    const beforeVideoState = video ? video.paused : null;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(350);
    // A dispatched event alone is not success: a site can ignore it or an
    // overlay can intercept it. Do not report completion without an effect.
    if (!await observePageEffect(beforeVideoState, async () => {
      if (!await performTrustedAction("click", el)) simulateClick(el);
    })) {
      throw new Error("click: no observable page change after activation");
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
      await delay(150);
      if (!elementText(el).includes(text)) throw new Error("type: trusted input was not retained");
      return;
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
      if (!elementText(el).includes(text)) throw new Error("type: editor did not retain entered text");
      return;
    }

    // Clear using native setter so React/Vue detects the change
    setNativeValue(el, "");
    await delay(60);

    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown",  { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true, cancelable: true }));
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
    if (elementText(el) !== text) throw new Error("type: input did not retain entered text");
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
    const el  = task.target ? resolveEl(task.target) : document.activeElement;
    const tgt = el || document.body;
    if (el && await performTrustedAction("key", el, { key })) {
      await delay(250);
      return;
    }
    const opts = { key, bubbles: true, cancelable: true, view: window };

    tgt.dispatchEvent(new KeyboardEvent("keydown",  opts));
    await delay(60);
    tgt.dispatchEvent(new KeyboardEvent("keypress", opts));
    tgt.dispatchEvent(new KeyboardEvent("keyup",    opts));

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
    const px  = task.pixels || 300;
    if (task.target) {
      const el = resolveEl(task.target);
      if (el) { el.scrollIntoView({ behavior:"smooth", block:"center" }); return; }
    }
    const map = {
      down: { top: px, left: 0 }, up: { top: -px, left: 0 },
      right: { top: 0, left: px }, left: { top: 0, left: -px },
    };
    window.scrollBy({ ...(map[dir] || map.down), behavior:"smooth" });
    await delay(380);
  }

  async function doWait(task) {
    const ms   = task.timeout_ms || 2000;
    const cond = task.condition || "timeout";
    if (cond === "timeout") { await delay(ms); return; }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cond === "navigation" && document.readyState === "complete") return;
      if (cond === "selector"  && task.selector && document.querySelector(task.selector)) return;
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
    el.scrollIntoView({ behavior:"smooth", block:"center" });
    el.dispatchEvent(new MouseEvent("mouseover",  { bubbles:true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles:true }));
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
      clientY: rect.top  + rect.height / 2,
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
    const cy = rect.top  + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, isPrimary: true, button: 2, buttons: 2 }));
    el.dispatchEvent(new MouseEvent("mousedown",     { ...base, button: 2, buttons: 2 }));
    el.dispatchEvent(new PointerEvent("pointerup",   { ...base, isPrimary: true, button: 2 }));
    el.dispatchEvent(new MouseEvent("mouseup",       { ...base, button: 2 }));
    el.dispatchEvent(new MouseEvent("contextmenu",   { ...base, button: 2 }));
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
    el.dispatchEvent(new KeyboardEvent("keyup",   { key: "a", code: "KeyA", ctrlKey: true, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup",   { key: "Delete", bubbles: true }));
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
    el.dispatchEvent(new FocusEvent("focus",   { bubbles: true }));
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
    const sx = sr.left + sr.width  / 2, sy = sr.top  + sr.height / 2;
    const dx = dr.left + dr.width  / 2, dy = dr.top  + dr.height / 2;

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

    dst.dispatchEvent(new DragEvent("dragover",  { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
    dst.dispatchEvent(new DragEvent("drop",      { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
    src.dispatchEvent(new DragEvent("dragend",   { bubbles: true, cancelable: true, clientX: dx, clientY: dy }));
    src.dispatchEvent(mkPtr("pointerup",   dx, dy, { button: 0 }));
    src.dispatchEvent(mkMouse("mouseup",   dx, dy, 0));
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
        chrome.runtime.sendMessage({ type: "OPEN_NEW_TAB", url }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res?.success) return reject(new Error(res?.error || "Could not open tab"));
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  /** Actions whose completion mutates the DOM (AJAX, navigation, React re-renders). */
  const DOM_MUTATING = new Set(["click", "dblclick", "rightclick", "type", "key", "navigate", "opentab", "drag"]);

  const ACTION = {
    click:      doClick,
    dblclick:   doDblClick,
    rightclick: doRightClick,
    type:       doType,
    key:        doKey,
    select:     doSelect,
    scroll:     doScroll,
    wait:       doWait,
    navigate:   doNavigate,
    hover:      doHover,
    focus:      doFocus,
    clear:      doClear,
    drag:       doDrag,
    opentab:    doOpenTab,
    screenshot: async () => {},
  };

  // ── Task execution with live progress ─────────────────────────────────────
  async function execTasks(tasksJson, onProg) {
    const steps = tasksJson?.tasks || [];
    if (!steps.length) return { success: true, completedSteps: 0 };
    let done = 0;
    for (const step of steps) {
      onProg(step.step, steps.length, "running");
      const fn = ACTION[step.action];
      if (!fn) {
        onProg(step.step, steps.length, "fail");
        return { success: false, error: `Unknown action: ${step.action}` };
      }
      try {
        await fn(step);
        done++;
        onProg(step.step, steps.length, "done");
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
    return { success: true, completedSteps: done };
  }

  // ── Render tasks card into a message handle ───────────────────────────────
  function renderTasks(handle, tasksJson) {
    const steps = tasksJson?.tasks || [];
    const answerHtml = tasksJson.answer
      ? `<div class="vans" style="margin-bottom:8px">${esc(tasksJson.answer)}</div>` : "";
    const stepsHtml = steps.map(s => `
      <div class="vstep" id="vpba-s-${s.step}">
        <span class="vstep-ic">○</span>
        <span class="vstep-tx">${esc(s.description || s.action)}</span>
      </div>`).join("");

    handle.set(`
      ${answerHtml}
      <div class="vtasks">
        <div class="vtasks-hdr">▶ ${steps.length} step${steps.length !== 1 ? "s" : ""}</div>
        <div class="vprog"><div class="vprog-bar" id="vpba-pbar"></div></div>
        ${stepsHtml}
      </div>
    `);
  }

  function updateStep(step, status, total) {
    const el  = document.getElementById(`vpba-s-${step}`);
    const bar = document.getElementById("vpba-pbar");
    const ic  = { running:"⟳", done:"✓", fail:"✗" };
    if (el) {
      el.className = `vstep ${status}`;
      el.querySelector(".vstep-ic").textContent = ic[status] || "○";
    }
    if (bar && total) bar.style.width = `${Math.round(step / total * 100)}%`;
  }

  // ── Main send handler ──────────────────────────────────────────────────────
  async function handleSend() {
    const text = inp.value.trim();
    if (!text || processing) return;
    inp.value = ""; inp.style.height = "38px";

    addUser(text);
    const handle = addAgent(); // shows thinking dots
    setProcessing(true);

    // First call (smart image: skip screenshot for questions)
    let result;
    let tries = 1;
    try {
      result = await callAgent(text, false);
    } catch (err) {
      const msg = err?.message || String(err);
      const isConn = /connect|fetch|network|tunnel|econnrefused/i.test(msg);
      handle.set(`<div class="verr">${esc(msg)}${isConn ? `
        <div class="verr-help">
          • Check tunnel: <code>curl http://localhost:9001/health</code><br>
          • Check backend: <code>curl http://127.0.0.1:8000/health</code>
        </div>` : ""}</div>`);
      handle.save();
      setProcessing(false);
      setStatus("err");
      return;
    }

    let { tasks } = result;

    // Auto-retry with image if model signals it needs visual context
    if (!result.hadImage && modelNeedsImage(tasks)) {
      tries++;
      handle.set(`<div class="vretry">🔄 Try ${tries}: retrying with screenshot…</div>`);
      try {
        const retry = await callAgent(text, true);
        result = { ...retry, tries };
        tasks  = retry.tasks;
      } catch (_) { /* keep first result */ }
    }
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

      document.getElementById("vpba-yes").addEventListener("click", async () => {
        setProcessing(true);
        renderTasks(handle, tasks);
        const execResult = await execTasks(tasks, (s, t, status) => updateStep(s, status, t));
        appendSourcePill(handle, result);
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
      });
      return;
    }

    // ── Execute immediately ──
    renderTasks(handle, tasks);
    let execResult = await execTasks(tasks, (s, t, status) => updateStep(s, status, t));

    // ── Post-execution screenshot fallback ──────────────────────────────────
    // If execution failed because an element couldn't be resolved, and we
    // haven't already sent a screenshot, automatically re-call the agent
    // with a screenshot so it can use visual coordinates as a fallback.
    if (
      !execResult.success &&
      !result.hadImage &&
      /not found|could not resolve|element not found/i.test(execResult.error || "")
    ) {
      tries++;
      handle.append(`<div class="vretry" style="margin-top:6px">🔄 Element not found — retrying with screenshot (try ${tries})…</div>`);
      try {
        const retry = await callAgent(text, true /* forceImage */);
        result = { ...retry, tries };
        tasks  = retry.tasks;
        if (Array.isArray(tasks?.tasks) && tasks.tasks.length > 0) {
          renderTasks(handle, tasks);
          execResult = await execTasks(tasks, (s, t, status) => updateStep(s, status, t));
        }
      } catch (_retryErr) {
        /* keep original failure result */
      }
    }

    appendSourcePill(handle, result);
    setProcessing(false);
    if (!execResult.success) {
      handle.append(`<div class="verr" style="margin-top:8px">Stopped at step ${execResult.completedSteps + 1}: ${esc(execResult.error || "")}</div>`);
      setStatus("err");
    }
    handle.save();
  }

  // ── Input events ──────────────────────────────────────────────────────────
  sendB.addEventListener("click", handleSend);
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  inp.addEventListener("input", () => {
    inp.style.height = "38px";
    inp.style.height = Math.min(inp.scrollHeight, 110) + "px";
  });

  // ── Init: tab ID → load history → show welcome if fresh ──────────────────
  (async () => {
    myTabId = await getMyTabId();
    const hadHistory = await loadHistory();
    if (!hadHistory) {
      const elemCount = document.querySelectorAll("button,input,textarea,select,a[href]").length;
      _renderAgentBubble(
        `<div class="vans">Hi! I can see <strong>${elemCount}</strong> interactive elements on this page.</div>
         <div class="vctx">💬 Ask a question &nbsp;|&nbsp; 🤖 Give me a task to perform</div>`
      );
    }
  })();

})();
