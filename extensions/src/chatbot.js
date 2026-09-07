/**
 * chatbot.js — Visual Perception Agent Side Panel
 *
 * A self-contained content script that injects a fixed right-side chat panel.
 * Handles Q&A about the current page AND executes browser automation tasks.
 * No dependency on content.js or executor.js at runtime.
 */

/* global chrome */

(function vpbaChatbot() {
  "use strict";

  // ── Guard: don't inject twice ──────────────────────────────────────────────
  if (document.getElementById("vpba-root")) return;

  // ── Config ─────────────────────────────────────────────────────────────────
  const PANEL_W      = 390;
  const MAX_ELEMS    = 60;
  const MAX_TEXT     = 3000;
  const PII_RE       = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
    /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    /\b[A-Z]{5}\d{4}[A-Z]\b/gi,
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  let panelOpen    = false;
  let processing   = false;
  let pendingTasks = null;

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
      <span id="vpba-hdr-subtitle" id="vpba-model-label">Qwen2.5-VL-3B</span>
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

  // ── Message renderers ───────────────────────────────────────────────────────
  function addUser(text) {
    const el = document.createElement("div");
    el.className = "vm u";
    el.innerHTML = `<div class="vb">${esc(text)}</div><div class="vts">${now()}</div>`;
    msgs.appendChild(el); scrollBot(); return el;
  }

  function addAgent(innerHtml = null) {
    const el = document.createElement("div");
    el.className = "vm a";
    const bubble = document.createElement("div");
    bubble.className = "vb";
    bubble.innerHTML = innerHtml ?? `<div class="vdots"><span></span><span></span><span></span></div>`;
    const ts = document.createElement("div");
    ts.className = "vts"; ts.textContent = now();
    el.appendChild(bubble); el.appendChild(ts);
    msgs.appendChild(el); scrollBot();
    return {
      el, bubble, ts,
      set(html) { bubble.innerHTML = html; ts.textContent = now(); scrollBot(); },
      append(html) { bubble.insertAdjacentHTML("beforeend", html); scrollBot(); },
    };
  }

  function setProcessing(v) {
    processing = v;
    sendB.disabled = v; inp.disabled = v;
    setStatus(v ? "run" : "ok");
  }

  // ── PII sanitizer ──────────────────────────────────────────────────────────
  function sanitize(t) {
    if (!t) return "";
    let s = String(t);
    PII_RE.forEach(p => { s = s.replace(p, "<REDACTED>"); });
    return s;
  }

  // ── Page context extraction ─────────────────────────────────────────────────
  function getPageContext() {
    const interactiveEl = Array.from(
      document.querySelectorAll(
        "button,input,textarea,select,a[href],[contenteditable='true']," +
        "[role='button'],[role='link'],[role='textbox'],[role='checkbox'],[role='tab']"
      )
    ).filter(el => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    }).slice(0, MAX_ELEMS).map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        elementId: `element_${i + 1}`,
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
    } catch (_) { /* */ }

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

  // ── Screenshot via background.js ────────────────────────────────────────────
  async function captureB64() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, res => {
          if (chrome.runtime.lastError || !res?.success) return resolve(null);
          resolve(res.screenshot.replace(/^data:image\/\w+;base64,/, ""));
        });
      } catch { resolve(null); }
    });
  }

  // ── Call agent backend ──────────────────────────────────────────────────────
  async function callAgent(intent) {
    const ctx = getPageContext();
    const img  = await captureB64();

    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({
          type: "SEND_AGENT_TASK",
          agentPayload: {
            task_intent: intent,
            perception_state: ctx,
            image_b64: img,
            redaction_regions: [],
            privacy_proof: { sanitized: true, rawScreenshotIncluded: false, redactionMap: [] },
          },
        }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res?.success) return reject(new Error(res?.error || "Agent call failed"));
          resolve(res.tasks);
        });
      } catch (e) { reject(e); }
    });
  }

  // ── Inline task executor ────────────────────────────────────────────────────
  function resolveEl(target) {
    if (!target) return null;
    if (target.elementId) {
      const idx = parseInt(target.elementId.replace("element_", ""), 10) - 1;
      if (!isNaN(idx) && idx >= 0) {
        const all = document.querySelectorAll(
          "button,input,textarea,select,a[href],[contenteditable],[role='button'],[role='link']"
        );
        if (all[idx]) return all[idx];
      }
    }
    if (target.selector) { try { return document.querySelector(target.selector); } catch(_){} }
    return null;
  }

  async function doClick(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error(`click: element not found (${task.target?.elementId || task.target?.selector})`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(280);
    el.focus({ preventScroll: true });
    ["mousedown","mouseup","click"].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }))
    );
    await delay(180);
  }

  async function doType(task) {
    const el = resolveEl(task.target);
    if (!el) throw new Error(`type: element not found`);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(200);
    el.focus({ preventScroll: true });
    if ("value" in el) el.value = "";
    for (const ch of String(task.value || "")) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      if ("value" in el) el.value += ch;
      else if (el.isContentEditable) el.textContent += ch;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await delay(28 + Math.random() * 30);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
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
    if (task.target) { const el = resolveEl(task.target); if (el) { el.scrollIntoView({ behavior:"smooth",block:"center"}); return; } }
    const map = { down:{top:px,left:0},up:{top:-px,left:0},right:{top:0,left:px},left:{top:0,left:-px} };
    window.scrollBy({ ...(map[dir]||map.down), behavior:"smooth" });
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
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles:true }));
    el.dispatchEvent(new MouseEvent("mouseenter",{ bubbles:true }));
    await delay(180);
  }

  const ACTION = { click:doClick, type:doType, select:doSelect, scroll:doScroll,
                   wait:doWait, navigate:doNavigate, hover:doHover,
                   screenshot: async()=>{} };

  // ── Task execution with live progress ──────────────────────────────────────
  async function execTasks(tasksJson, onProg) {
    const steps = tasksJson?.tasks || [];
    if (!steps.length) return { success:true, completedSteps:0 };
    let done = 0;
    for (const step of steps) {
      onProg(step.step, steps.length, "running");
      const fn = ACTION[step.action];
      if (!fn) { onProg(step.step, steps.length, "fail"); return { success:false, error:`Unknown action: ${step.action}` }; }
      try {
        await fn(step);
        done++;
        onProg(step.step, steps.length, "done");
      } catch (e) {
        onProg(step.step, steps.length, "fail");
        return { success:false, completedSteps:done, error:e.message };
      }
      await delay(140);
    }
    return { success:true, completedSteps:done };
  }

  // ── Render tasks card into a message handle ─────────────────────────────────
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
        <div class="vtasks-hdr">▶ ${steps.length} step${steps.length!==1?"s":""}</div>
        <div class="vprog"><div class="vprog-bar" id="vpba-pbar"></div></div>
        ${stepsHtml}
      </div>
    `);
  }

  function updateStep(step, status, total) {
    const el  = document.getElementById(`vpba-s-${step}`);
    const bar = document.getElementById("vpba-pbar");
    const ic  = { running:"⟳", done:"✓", fail:"✗" };
    if (el) { el.className = `vstep ${status}`; el.querySelector(".vstep-ic").textContent = ic[status]||"○"; }
    if (bar && total) bar.style.width = `${Math.round(step/total*100)}%`;
  }

  // ── Main send handler ────────────────────────────────────────────────────────
  async function handleSend() {
    const text = inp.value.trim();
    if (!text || processing) return;
    inp.value = ""; inp.style.height = "38px";

    addUser(text);
    const handle = addAgent();
    setProcessing(true);

    try {
      const tasks = await callAgent(text);
      if (!tasks) throw new Error("No response received from agent");

      // Model label
      if (tasks.model) {
        const lbl = document.getElementById("vpba-hdr-subtitle");
        if (lbl) lbl.textContent = tasks.model.split("/").pop() || tasks.model;
      }

      const hasTasks = Array.isArray(tasks.tasks) && tasks.tasks.length > 0;
      const isAnswer = tasks.type === "answer" || !hasTasks;

      // Pure Q&A answer
      if (isAnswer) {
        const txt = tasks.answer || tasks.reasoning || "Done.";
        handle.set(`<div class="vans">${esc(txt)}</div>
          <div class="vctx">
            📄 ${document.querySelectorAll("button,input,textarea,select,a[href]").length} elements on page
          </div>`);
        setProcessing(false);
        return;
      }

      // Needs confirmation
      if (tasks.requires_confirmation) {
        const reason = esc(tasks.reasoning || "The agent needs confirmation before proceeding.");
        const ansHtml = tasks.answer ? `<div class="vans" style="margin-bottom:7px">${esc(tasks.answer)}</div>` : "";
        handle.set(`${ansHtml}<div class="vconf">
          <div class="vconf-title">⚠ Confirmation needed</div>
          <div class="vconf-reason">${reason}</div>
          <div class="vconf-actions">
            <button class="vbtn vbtn-go" id="vpba-yes">Proceed ✓</button>
            <button class="vbtn vbtn-no" id="vpba-no">Cancel</button>
          </div>
        </div>`);
        setProcessing(false);

        document.getElementById("vpba-yes").addEventListener("click", async () => {
          setProcessing(true);
          renderTasks(handle, tasks);
          const result = await execTasks(tasks, (s, t, status) => updateStep(s, status, t));
          setProcessing(false);
          if (!result.success) {
            handle.append(`<div class="verr" style="margin-top:8px">Stopped: ${esc(result.error||"")}</div>`);
            setStatus("err");
          }
        });
        document.getElementById("vpba-no").addEventListener("click", () => {
          handle.set(`<div style="color:#8b949e;font-size:12px">Cancelled.</div>`);
          setProcessing(false);
        });
        return;
      }

      // Execute immediately
      renderTasks(handle, tasks);
      const result = await execTasks(tasks, (s, t, status) => updateStep(s, status, t));
      setProcessing(false);
      if (!result.success) {
        handle.append(`<div class="verr" style="margin-top:8px">Stopped at step ${result.completedSteps+1}: ${esc(result.error||"")}</div>`);
        setStatus("err");
      }

    } catch (err) {
      const msg = err?.message || String(err);
      const isConn = /connect|fetch|network|tunnel|econnrefused/i.test(msg);
      handle.set(`<div class="verr">${esc(msg)}${isConn ? `
        <div class="verr-help">
          • Check tunnel: <code>curl http://localhost:9001/health</code><br>
          • Check backend: <code>curl http://127.0.0.1:8000/agent/status</code>
        </div>` : ""}</div>`);
      setProcessing(false);
      setStatus("err");
    }
  }

  // ── Input events ─────────────────────────────────────────────────────────────
  sendB.addEventListener("click", handleSend);
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } });
  inp.addEventListener("input", () => { inp.style.height = "38px"; inp.style.height = Math.min(inp.scrollHeight, 110) + "px"; });

  // ── Welcome message ───────────────────────────────────────────────────────────
  const elemCount = document.querySelectorAll("button,input,textarea,select,a[href]").length;
  addAgent(
    `<div class="vans">Hi! I can see <strong>${elemCount}</strong> interactive elements on this page.</div>
     <div class="vctx">💬 Ask a question &nbsp;|&nbsp; 🤖 Give me a task to perform</div>`
  );

})();
