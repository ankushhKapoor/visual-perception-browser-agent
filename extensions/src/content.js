import {
  classifyInputElement,
  classifyTextPattern,
  getRecommendedRedactionAction,
  enrichDetection,
  runAllDeterministicDetectors,
  REDACTION_ACTIONS,
  isValidLuhn
} from "./privacy-classifier.js";

import {
  isCriticalSecret,
  shouldSanitize,
  SECRET_PLACEHOLDER
} from "./privacy-sanitizer.js";

import {
  runFusionEngine,
  normalizeDetection,
  formatDetectionForDebug,
  convertRectToCanonical,
  getScreenshotMetrics
} from "./privacy-fusion.js";

import {
  sanitizeText as sanitizeTextWithPlaceholders,
  createSanitizationReport,
  generatePlaceholder
} from "./privacy-sanitizer.js";

import {
  detectOCRTextRegions,
  isOCREnabled
} from "./local-ocr.js";

if (typeof chrome !== "undefined" && chrome.runtime) {
  console.log(
    "Visual Perception Browser Agent: content script loaded",
    chrome.runtime.id
  );
}

let elementCounter = 0;

function generateElementId() {
  elementCounter += 1;
  return `element_${elementCounter}`;
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function getElementRect(element) {
  const rect = element.getBoundingClientRect();

  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function getElementText(element) {
  return (
    element.innerText ||
    element.value ||
    element.placeholder ||
    element.getAttribute("aria-label") ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function getVisibleText() {
  return document.body.innerText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function getLabelTextForElement(element) {
  const labels = [];

  if (element.labels) {
    Array.from(element.labels).forEach((label) => {
      const text = getElementText(label);

      if (text) {
        labels.push(text);
      }
    });
  }

  const ariaLabelledBy =
    element.getAttribute("aria-labelledby");

  if (ariaLabelledBy) {
    ariaLabelledBy.split(/\s+/).forEach((id) => {
      const referencedElement =
        document.getElementById(id);

      if (referencedElement) {
        const text =
          getElementText(referencedElement);

        if (text) {
          labels.push(text);
        }
      }
    });
  }

  return [...new Set(labels)]
    .join(" ")
    .slice(0, 500) || null;
}

function getImplicitRole(element) {
  const tag =
    element.tagName.toLowerCase();

  if (tag === "button") {
    return "button";
  }

  if (
    tag === "a" &&
    element.hasAttribute("href")
  ) {
    return "link";
  }

  if (tag === "textarea") {
    return "textbox";
  }

  if (tag === "select") {
    return "combobox";
  }

  if (tag === "img") {
    return "img";
  }

  if (/^h[1-6]$/.test(tag)) {
    return "heading";
  }

  if (tag === "input") {
    const type =
      (element.type || "text").toLowerCase();

    if (
      [
        "text",
        "email",
        "password",
        "search",
        "tel",
        "url"
      ].includes(type)
    ) {
      return "textbox";
    }

    if (type === "checkbox") {
      return "checkbox";
    }

    if (type === "radio") {
      return "radio";
    }

    if (
      [
        "button",
        "submit",
        "reset",
        "image"
      ].includes(type)
    ) {
      return "button";
    }

    if (type === "range") {
      return "slider";
    }

    if (type === "number") {
      return "spinbutton";
    }
  }

  return null;
}

function getAccessibleName(element) {
  const ariaLabel =
    element.getAttribute("aria-label");

  if (
    ariaLabel &&
    ariaLabel.trim()
  ) {
    return ariaLabel
      .trim()
      .slice(0, 500);
  }

  const ariaLabelledBy =
    element.getAttribute("aria-labelledby");

  if (ariaLabelledBy) {
    const text = ariaLabelledBy
      .split(/\s+/)
      .map((id) => {
        const referencedElement =
          document.getElementById(id);

        return referencedElement
          ? getElementText(referencedElement)
          : "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();

    if (text) {
      return text.slice(0, 500);
    }
  }

  if (
    element.labels &&
    element.labels.length > 0
  ) {
    const labelText =
      Array.from(element.labels)
        .map((label) =>
          getElementText(label)
        )
        .filter(Boolean)
        .join(" ")
        .trim();

    if (labelText) {
      return labelText.slice(0, 500);
    }
  }

  if (
    element.alt &&
    element.alt.trim()
  ) {
    return element.alt
      .trim()
      .slice(0, 500);
  }

  const title =
    element.getAttribute("title");

  if (
    title &&
    title.trim()
  ) {
    return title
      .trim()
      .slice(0, 500);
  }

  const text =
    getElementText(element);

  if (text) {
    return text;
  }

  return null;
}

function getAriaStates(element) {
  const states = {};

  const attributes = [
    "aria-expanded",
    "aria-checked",
    "aria-selected",
    "aria-pressed",
    "aria-current",
    "aria-hidden",
    "aria-required",
    "aria-invalid",
    "aria-readonly"
  ];

  attributes.forEach((attribute) => {
    const value =
      element.getAttribute(attribute);

    if (value !== null) {
      states[attribute] = value;
    }
  });

  return states;
}

function getAccessibilityInfo(element) {
  const explicitRole =
    element.getAttribute("role");

  const implicitRole =
    getImplicitRole(element);

  return {
    explicitRole:
      explicitRole || null,

    implicitRole,

    role:
      explicitRole ||
      implicitRole ||
      null,

    ariaLabel:
      element.getAttribute(
        "aria-label"
      ) || null,

    ariaLabelledBy:
      element.getAttribute(
        "aria-labelledby"
      ) || null,

    accessibleName:
      getAccessibleName(element),

    enabled:
      !element.disabled &&
      element.getAttribute(
        "aria-disabled"
      ) !== "true",

    disabled:
      Boolean(element.disabled) ||
      element.getAttribute(
        "aria-disabled"
      ) === "true",

    ariaStates:
      getAriaStates(element)
  };
}

function assignFormIds() {
  Array.from(
    document.querySelectorAll("form")
  ).forEach((form, index) => {
    if (
      !form.id &&
      !form.dataset.agentFormId
    ) {
      form.dataset.agentFormId =
        `form_${index + 1}`;
    }
  });
}

function getFormId(element) {
  const form =
    element.closest("form");

  if (!form) {
    return null;
  }

  return (
    form.id ||
    form.dataset.agentFormId ||
    null
  );
}

function getRelevantElements() {
  const selectors = [
    "button",
    "input",
    "textarea",
    "select",
    "a[href]",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "form",
    "label",
    "img",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    "[role='tab']",
    "[role='menuitem']"
  ];

  return Array.from(
    document.querySelectorAll(
      selectors.join(",")
    )
  ).filter(isElementVisible);
}

function getElementCategory(element) {
  const tag =
    element.tagName.toLowerCase();

  const role =
    element.getAttribute("role");

  if (
    tag === "button" ||
    role === "button"
  ) {
    return "button";
  }

  if (tag === "input") {
    return "input";
  }

  if (tag === "textarea") {
    return "textarea";
  }

  if (tag === "select") {
    return "select";
  }

  if (
    tag === "a" ||
    role === "link"
  ) {
    return "link";
  }

  if (/^h[1-6]$/.test(tag)) {
    return "heading";
  }

  if (tag === "form") {
    return "form";
  }

  if (tag === "label") {
    return "label";
  }

  if (tag === "img") {
    return "image";
  }

  if (element.isContentEditable) {
    return "contenteditable";
  }

  return "other";
}

function getDomElements() {
  assignFormIds();

  elementCounter = 0;

  return getRelevantElements()
    .slice(0, 300)
    .map((element) => {
      const tag =
        element.tagName.toLowerCase();

      return {
        elementId:
          generateElementId(),

        category:
          getElementCategory(element),

        tag,

        text:
          getElementText(element),

        type:
          element.type || null,

        name:
          element.name || null,

        id:
          element.id || null,

        placeholder:
          element.placeholder || null,

        href:
          tag === "a"
            ? element.href || null
            : null,

        src:
          tag === "img"
            ? (
                element.currentSrc ||
                element.src ||
                null
              )
            : null,

        alt:
          tag === "img"
            ? element.alt || null
            : null,

        label:
          getLabelTextForElement(
            element
          ),

        formId:
          getFormId(element),

        rect:
          getElementRect(element),

        visible:
          true,

        accessibility:
          getAccessibilityInfo(
            element
          )
      };
    });
}

function getForms() {
  assignFormIds();

  return Array.from(
    document.querySelectorAll("form")
  )
    .filter(isElementVisible)
    .map((form) => {
      const formId =
        form.id ||
        form.dataset.agentFormId;

      const controls =
        Array.from(
          form.querySelectorAll(
            "input, textarea, select, button"
          )
        )
          .filter(isElementVisible)
          .map((element) => ({
            tag:
              element.tagName.toLowerCase(),

            type:
              element.type || null,

            name:
              element.name || null,

            id:
              element.id || null,

            text:
              getElementText(element),

            accessibility:
              getAccessibilityInfo(
                element
              )
          }));

      return {
        formId,

        action:
          form.action || null,

        method:
          form.method || "get",

        rect:
          getElementRect(form),

        controls
      };
    });
}

function isSensitiveInput(element) {
  const sensitiveKeywords = [
    "password",
    "email",
    "phone",
    "tel",
    "mobile",
    "card",
    "credit",
    "debit",
    "cvv",
    "cvc",
    "ssn",
    "aadhaar",
    "pan"
  ];

  const metadata = [
    element.type,
    element.name,
    element.id,
    element.autocomplete,
    element.placeholder,
    element.getAttribute(
      "aria-label"
    )
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    element.type === "password" ||
    sensitiveKeywords.some(
      (keyword) =>
        metadata.includes(keyword)
    )
  );
}

function getSensitiveInputElements() {
  return Array.from(
    document.querySelectorAll(
      "input, textarea"
    )
  )
    .filter((element) => {
      if (
        !isElementVisible(element)
      ) {
        return false;
      }

      return isSensitiveInput(
        element
      );
    })
    .map((element) => {
      const detection = {
        source:
          "input",

        tag:
          element.tagName.toLowerCase(),

        type:
          element.type || null,

        name:
          element.name || null,

        id:
          element.id || null,

        rect:
          getElementRect(element)
      };

      // Classify the sensitive input
      const classification = classifyInputElement({
        type: element.type || null,
        name: element.name || null,
        id: element.id || null,
        placeholder: element.placeholder || null,
        ariaLabel: element.getAttribute("aria-label"),
        autocomplete: element.autocomplete || null
      });

      // Enrich detection with classification data
      return enrichDetection(detection, classification);
    });
}

function getPIIPatterns() {
  return {
    email:
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,

    phone:
      /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,

    aadhaar:
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,

    pan:
      /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,

    card:
      /\b(?:\d{4}[\s-]?){3}\d{4}\b/g
  };
}

function containsPII(text) {
  if (!text) {
    return false;
  }

  const patterns =
    getPIIPatterns();

  // Check regex patterns first
  const hasRegexPII = Object.values(
    patterns
  ).some((pattern) => {
    pattern.lastIndex = 0;

    return pattern.test(text);
  });

  if (hasRegexPII) {
    return true;
  }

  // Check deterministic detectors
  const deterministicDetections =
    runAllDeterministicDetectors(text);

  return deterministicDetections.length > 0;
}

/**
 * Legacy text sanitization (replaces with [REDACTED])
 * Kept for backward compatibility
 * Use sanitizeTextWithPlaceholders for new code
 */
function sanitizeTextLegacy(text) {
  if (!text) {
    return text;
  }

  let sanitizedText =
    String(text);

  const patterns =
    getPIIPatterns();

  Object.values(patterns).forEach(
    (pattern) => {
      pattern.lastIndex = 0;

      sanitizedText =
        sanitizedText.replace(
          pattern,
          "[REDACTED]"
        );
    }
  );

  return sanitizedText;
}

/**
 * Find text positions for detected PII values in full text
 * Returns detections with startIndex and endIndex populated
 * @param {string} fullText - Full visible text from page
 * @param {array} detections - Detection objects with 'text' or 'value' properties
 * @returns {array} Detections with startIndex/endIndex added
 */
function enrichDetectionsWithPositions(fullText, detections) {
  if (!fullText || !Array.isArray(detections)) {
    return Array.isArray(detections) ? detections : [];
  }

  const enriched = [];

  detections.forEach((det) => {
    if (!det) {
      return;
    }

    if (det.startIndex !== undefined && det.endIndex !== undefined) {
      enriched.push(det);
      return;
    }

    const searchText = det.value || det.text || det.match || det.originalValue;
    if (!searchText || typeof searchText !== 'string') {
      return;
    }

    let cursor = 0;
    let foundMatch = false;

    while (cursor <= fullText.length) {
      const index = fullText.indexOf(searchText, cursor);
      if (index === -1) {
        break;
      }

      foundMatch = true;
      enriched.push({
        ...det,
        value: searchText,
        text: searchText,
        startIndex: index,
        endIndex: index + searchText.length
      });

      cursor = index + Math.max(searchText.length, 1);
    }

    if (!foundMatch) {
      enriched.push(det);
    }
  });

  return enriched.filter(
    (det) => det.startIndex !== undefined && det.endIndex !== undefined
  );
}

function getTextMatchRect(element, searchText) {
  if (!element || !searchText || typeof document.createRange !== "function") {
    return null;
  }

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node;

  while ((node = walker.nextNode())) {
    const text = node.textContent || "";
    const start = text.indexOf(searchText);
    if (start === -1) continue;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + searchText.length);
    const rects = Array.from(range.getClientRects());
    if (rects.length === 0) return null;

    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));

    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  return null;
}

/**
 * Sanitize page text using privacy detections with proper placeholders
 * @param {string} visibleText - Full visible text from page
 * @param {array} sensitiveElements - Detected sensitive elements from fusion engine
 * @returns {object} { sanitized: string, report: {}, piiTypeCounts: {} }
 */
function sanitizePageText(visibleText, sensitiveElements) {
  if (!visibleText) {
    return {
      sanitized: visibleText,
      report: {},
      piiTypeCounts: {},
      sanitizationCount: 0
    };
  }

  if (!Array.isArray(sensitiveElements) || sensitiveElements.length === 0) {
    return {
      sanitized: visibleText,
      report: {},
      piiTypeCounts: {},
      sanitizationCount: 0
    };
  }

  try {
    // Enrich detections with text positions
    let enriched = enrichDetectionsWithPositions(visibleText, sensitiveElements);

    // Fusion strips raw values from normalized detections. Re-derive only the
    // replacement spans from the page text before creating the safe payload.
    if (enriched.length === 0) {
      enriched = enrichDetectionsWithPositions(
        visibleText,
        runAllDeterministicDetectors(visibleText).map((detection) => ({
          ...detection,
          value: detection.match,
          text: detection.match
        }))
      );
    }

    // Sanitize using privacy-sanitizer
    const result = sanitizeTextWithPlaceholders(visibleText, enriched);

    const report = createSanitizationReport(enriched);

    return {
      sanitized: result.sanitized,
      report,
      piiTypeCounts: result.piiTypeCounts || {},
      sanitizationCount: result.sanitizationCount || 0,
      mapping: result.mapping || {}
    };
  } catch (error) {
    console.error("Error sanitizing page text:", error);
    return {
      sanitized: visibleText,
      report: {},
      piiTypeCounts: {},
      sanitizationCount: 0,
      error: error.message
    };
  }
}

function buildFullTextMap() {
  // Build a complete map of all visible text in the page with position info
  const textNodes = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent || !isElementVisible(parent)) continue;
    textNodes.push({ node, parent, text: node.textContent });
  }

  return textNodes;
}

function findTextRectInNodes(searchText, textNodes) {
  if (!searchText || !textNodes || textNodes.length === 0) return null;

  for (const { node, parent, text } of textNodes) {
    const index = text.indexOf(searchText);
    if (index === -1) continue;

    try {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + searchText.length);
      const rects = Array.from(range.getClientRects());
      if (rects.length === 0) continue;

      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));

      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch (e) {
      // Fall through to next node
    }
  }
  return null;
}

function resolveTextContainerRect(searchText, textNodes) {
  if (!searchText || !textNodes || textNodes.length === 0) return null;

  const exactRect = findTextRectInNodes(searchText, textNodes);
  if (exactRect) {
    return exactRect;
  }

  for (const { node, parent, text } of textNodes) {
    if (!text || !text.includes(searchText)) continue;

    let candidate = parent;
    while (candidate && candidate !== document.body) {
      if (isElementVisible(candidate)) {
        const candidateText = (candidate.textContent || "").replace(/\s+/g, " ").trim();
        if (candidateText.includes(searchText)) {
          const rect = candidate.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height
            };
          }
        }
      }
      candidate = candidate.parentElement;
    }
  }

  return null;
}

function getSensitiveTextElements() {
  const excludedTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "OPTION"
  ]);

  const profileNameCandidates = [];
  document.querySelectorAll(
    "h1, h2, h3, [class*='name'], [class*='profile'], [id*='name'], [aria-label*='name'], [alt*='person'], [alt*='profile']"
  ).forEach((element) => {
    if (!isElementVisible(element)) return;
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 80) return;
    const words = text.split(/\s+/).filter(Boolean);
    const looksLikeName = words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-Z][A-Za-z'-]+$/.test(word));
    const notCommonTitle = !/(^|\s)(Department|Project|Status|Dashboard|Settings|Help|Privacy|Visual|Perception|Agent|Account|Contact|Personal|Information|Home|Profile|Reports|Tasks|Projects|University|College|Organization)(\s|$)/i.test(text);
    if (looksLikeName && notCommonTitle) {
      profileNameCandidates.push({
        value: text,
        rect: getElementRect(element),
        piiType: "PERSON",
        severity: "CONTEXT_DEPENDENT",
        confidence: 0.76,
        source: "text",
        finalRedactionAction: "PLACEHOLDER"
      });
    }
  });

  const patterns = getPIIPatterns();
  const detections = [];
  const seen = new Set();

  // Build complete text map for accurate position finding
  const textNodes = buildFullTextMap();
  const fullPageText = textNodes.map((tn) => tn.text).join(" ").slice(0, 10000);

  // Scan full page text for regex patterns
  Object.entries(patterns).forEach(([patternType, pattern]) => {
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(fullPageText)) !== null) {
      const candidate = match[0];
      if (patternType === "card") {
        const cardNumberOnly = candidate.replace(/[\s-]/g, "");
        if (!isValidLuhn(cardNumberOnly)) continue;
      }

      const key = `${patternType}:${candidate}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const rect = resolveTextContainerRect(candidate, textNodes);
      if (!rect) continue;

      const detection = {
        piiType: patternType === "card" ? "CARD" : patternType.toUpperCase(),
        severity: patternType === "card" ? "CRITICAL" : "HIGH",
        confidence: 0.95,
        source: "text",
        rect,
        value: candidate,
        match: candidate,
        finalRedactionAction: REDACTION_ACTIONS[patternType === "card" ? "CRITICAL" : "HIGH"] || "BLACKOUT",
        reason: `Visible text ${patternType} match`
      };

      detections.push(detection);
    }
  });

  // Scan full page text with deterministic detectors
  const deterministicDetections = runAllDeterministicDetectors(fullPageText);
  deterministicDetections.forEach((det) => {
    const matchText = det.match || det.value;
    if (!matchText) return;

    const key = `${det.piiType}:${matchText}`;
    if (seen.has(key)) return;
    seen.add(key);

    const rect = resolveTextContainerRect(matchText, textNodes);
    if (!rect) return;

    const detection = {
      piiType: det.piiType,
      severity: det.severity || "HIGH",
      confidence: det.confidence || 0.9,
      source: "text",
      rect,
      value: matchText,
      match: matchText,
      finalRedactionAction: REDACTION_ACTIONS[det.severity || "HIGH"] || "BLACKOUT",
      reason: det.context || `Visible text ${det.piiType} detection`
    };

    detections.push(detection);
  });

  profileNameCandidates.forEach((candidate) => {
    const key = `${candidate.piiType}:${candidate.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!candidate.rect || candidate.rect.width <= 0 || candidate.rect.height <= 0) return;
    detections.push({
      piiType: candidate.piiType,
      severity: candidate.severity,
      confidence: candidate.confidence,
      source: candidate.source,
      rect: candidate.rect,
      value: candidate.value,
      match: candidate.value,
      finalRedactionAction: candidate.finalRedactionAction,
      reason: "Visible profile name fallback"
    });
  });

  console.log(
    "Comprehensive text scanning:",
    { foundDetections: detections.length, fullPageTextLength: fullPageText.length }
  );

  return detections.filter(Boolean);
}

async function detectFacesInScreenshot(dataUrl, options = {}) {
  const mockFaces = globalThis.__PRIVACY_TEST_FACE_DETECTIONS__;
  if (Array.isArray(mockFaces) && mockFaces.length > 0) {
    return mockFaces.map((face) => ({
      piiType: "FACE",
      type: "FACE",
      severity: "HIGH",
      action: "BLUR",
      confidence: Number(face.confidence ?? 0.8),
      source: "FACE",
      rect: {
        x: Number(face.x ?? 0),
        y: Number(face.y ?? 0),
        width: Number(face.width ?? 0),
        height: Number(face.height ?? 0)
      },
      boundingBox: {
        x: Number(face.x ?? 0),
        y: Number(face.y ?? 0),
        width: Number(face.width ?? 0),
        height: Number(face.height ?? 0)
      },
      finalRedactionAction: "BLUR",
      reason: "Mocked local face detection",
      sourceCount: 1,
      fusedCount: 1,
      safetyMarginApplied: false
    }));
  }

  if (typeof window === "undefined") {
    return [];
  }

  try {
    // Try Shape Detection API (FaceDetector)
    if ("FaceDetector" in window) {
      console.log("Attempting Shape Detection API face detection...");
      try {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);
        const faceDetector = new FaceDetector({
          fastMode: true,
          maxDetectedFaces: 10,
          scoreThreshold: 0.5
        });

        const detectedFaces = await faceDetector.detect(imageBitmap);
        console.log(`Shape Detection API found ${detectedFaces.length} faces`);
        imageBitmap.close?.();

        if (detectedFaces.length > 0) {
          return detectedFaces.map((face) => {
            const box = face.boundingBox || {};
            return {
              piiType: "FACE",
              type: "FACE",
              severity: "HIGH",
              confidence: Number((face.score ?? 0.8).toFixed(3)),
              source: "FACE",
              rect: {
                x: Math.round(box.x || 0),
                y: Math.round(box.y || 0),
                width: Math.round(box.width || 1),
                height: Math.round(box.height || 1)
              },
              finalRedactionAction: "BLUR",
              reason: "Local Shape Detection API face detection",
              sourceCount: 1,
              fusedCount: 1,
              safetyMarginApplied: false
            };
          });
        }
      } catch (apiError) {
        console.warn("Shape Detection API face detection failed:", apiError.message);
      }
    }

    // Try MediaPipe Face Landmarker if available
    if (window.FaceLandmarker || window.__PRIVACY_MEDIA_PIPE_FACE_LANDMARKER__) {
      const faceLandmarker = window.__PRIVACY_MEDIA_PIPE_FACE_LANDMARKER__ || window.FaceLandmarker;
      if (faceLandmarker && typeof faceLandmarker.detect === "function") {
        console.log("Attempting MediaPipe face detection...");
        try {
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const imageBitmap = await createImageBitmap(blob);
          const result = faceLandmarker.detect(imageBitmap);
          const boxes = Array.isArray(result?.faceLandmarks) ? result.faceLandmarks : [];
          console.log(`MediaPipe found ${boxes.length} faces`);
          imageBitmap.close?.();

          if (boxes.length > 0) {
            return boxes.map((landmarks, index) => {
              const points = landmarks || [];
              const xs = points.map((point) => Number(point?.x ?? 0));
              const ys = points.map((point) => Number(point?.y ?? 0));
              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const minY = Math.min(...ys);
              const maxY = Math.max(...ys);

              return {
                piiType: "FACE",
                type: "FACE",
                severity: "HIGH",
                confidence: 0.85,
                source: "FACE",
                rect: {
                  x: Math.round(minX),
                  y: Math.round(minY),
                  width: Math.round(Math.max(1, maxX - minX)),
                  height: Math.round(Math.max(1, maxY - minY))
                },
                finalRedactionAction: "BLUR",
                reason: "Local MediaPipe face detection",
                sourceCount: 1,
                fusedCount: 1,
                safetyMarginApplied: false
              };
            });
          }
        } catch (mediaError) {
          console.warn("MediaPipe face detection failed:", mediaError.message);
        }
      }
    }

    const profileFaceCandidates = Array.from(
      document.querySelectorAll("img, [role='img'], [class*='avatar'], [class*='profile'], [alt*='person'], [alt*='profile'], [aria-label*='person'], [aria-label*='profile']")
    ).filter((element) => isElementVisible(element) && !element.closest("svg"));

    const fallbackFaces = profileFaceCandidates
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const altText = (element.getAttribute("alt") || element.getAttribute("aria-label") || "").toLowerCase();
        const isLikelyPersonImage = /person|profile|avatar|face|portrait|headshot/.test(altText) || (rect.width > 18 && rect.height > 18 && rect.width / Math.max(rect.height, 1) < 1.5);
        if (!isLikelyPersonImage) return null;

        return {
          piiType: "FACE",
          type: "FACE",
          severity: "HIGH",
          confidence: 0.72,
          source: "DOM_FACE",
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          boundingBox: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          finalRedactionAction: "BLUR",
          reason: "Local profile-image face fallback",
          sourceCount: 1,
          fusedCount: 1,
          safetyMarginApplied: false
        };
      })
      .filter(Boolean);

    if (fallbackFaces.length > 0) {
      console.log(`Local DOM face fallback found ${fallbackFaces.length} profile-image regions`);
      return fallbackFaces;
    }

    console.log("Face detection APIs not available in this browser. Skipping local face detection.");
    return [];
  } catch (error) {
    console.error("Unexpected face detection error:", error.message || error);
    return [];
  }
}

function getSensitiveElements() {
  const domDetections =
    getSensitiveInputElements();

  const textDetections =
    getSensitiveTextElements();

  console.log(
    "Privacy Fusion Engine Input:",
    {
      domDetections: domDetections.length,
      textDetections: textDetections.length,
      totalPreFusion:
        domDetections.length +
        textDetections.length
    }
  );

  // Run privacy fusion engine to combine detections
  // The fusion engine:
  // 1. Normalizes all detections
  // 2. Spatially fuses overlapping detections
  // 3. Applies severity priority
  // 4. Adds safety margins
  // 5. Computes final redaction actions
  const fusedDetections =
    runFusionEngine(
      domDetections,
      textDetections,
      [], // ocrDetections (not available yet)
      [], // mlDetections (not available yet)
      [], // faceDetections (not available yet)
      {
        overlapThreshold: 0.15,
        proximityThreshold: 20,
        safetyMarginPercent: 0,
        safetyMarginPixels: 2
      }
    );

  console.log(
    "Privacy Fusion Engine Output:",
    {
      fusedDetections:
        fusedDetections.length,
      reductionRatio:
        (
          (
            (domDetections.length +
              textDetections.length -
              fusedDetections.length) /
            (domDetections.length +
              textDetections.length)
          ) * 100
        ).toFixed(1) + "%"
    }
  );

  return fusedDetections;
}

function extractPageContext() {
  const domElements =
    getDomElements();

  return {
    url:
      window.location.href,

    title:
      document.title,

    viewport: {
      width:
        window.innerWidth,

      height:
        window.innerHeight
    },

    visibleText:
      getVisibleText(),

    domElements,

    interactiveElements:
      domElements.filter(
        (element) =>
          [
            "button",
            "input",
            "textarea",
            "select",
            "link",
            "contenteditable"
          ].includes(
            element.category
          )
      ),

    forms:
      getForms(),

    sensitiveElements:
      getSensitiveElements(),

    timestamp:
      new Date().toISOString()
  };
}

function sanitizeDomElement(
  element,
  sensitiveElements
) {
  const isSensitive =
    sensitiveElements.some(
      (sensitiveElement) => {
        const sensitiveRect =
          sensitiveElement.rect;

        const elementRect =
          element.rect;

        return (
          Math.abs(
            sensitiveRect.x -
              elementRect.x
          ) < 3 &&
          Math.abs(
            sensitiveRect.y -
              elementRect.y
          ) < 3 &&
          Math.abs(
            sensitiveRect.width -
              elementRect.width
          ) < 3 &&
          Math.abs(
            sensitiveRect.height -
              elementRect.height
          ) < 3
        );
      }
    );

  const sanitizedElement = {
    ...element
  };

  sanitizedElement.text =
    isSensitive ||
    containsPII(element.text)
      ? "[REDACTED]"
      : sanitizeText(element.text);

  sanitizedElement.placeholder =
    containsPII(
      element.placeholder
    )
      ? "[REDACTED]"
      : sanitizeText(
          element.placeholder
        );

  sanitizedElement.label =
    sanitizeText(element.label);

  sanitizedElement.accessibility = {
    ...element.accessibility,

    accessibleName:
      sanitizeText(
        element.accessibility
          ?.accessibleName
      ),

    ariaLabel:
      sanitizeText(
        element.accessibility
          ?.ariaLabel
      )
  };

  return sanitizedElement;
}

function sanitizeForms(
  forms,
  sensitiveElements
) {
  return forms.map((form) => ({
    ...form,

    controls:
      form.controls.map(
        (control) => {
          const metadata = [
            control.type,
            control.name,
            control.id,
            control.text,
            control.accessibility
              ?.accessibleName,
            control.accessibility
              ?.ariaLabel
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          const isSensitive =
            [
              "password",
              "email",
              "phone",
              "tel",
              "mobile",
              "card",
              "credit",
              "debit",
              "cvv",
              "cvc",
              "ssn",
              "aadhaar",
              "pan"
            ].some((keyword) =>
              metadata.includes(keyword)
            );

          return {
            ...control,

            text:
              isSensitive ||
              containsPII(
                control.text
              )
                ? "[REDACTED]"
                : sanitizeText(
                    control.text
                  ),

            accessibility: {
              ...control.accessibility,

              accessibleName:
                sanitizeText(
                  control.accessibility
                    ?.accessibleName
                ),

              ariaLabel:
                sanitizeText(
                  control.accessibility
                    ?.ariaLabel
                )
            }
          };
        }
      )
  }));
}

const RAW_VALUE_KEYS = new Set([
  "value",
  "text",
  "match",
  "originalvalue",
  "originalValue",
  "rawvalue",
  "rawValue",
  "rawvalues",
  "rawValues",
  "fulltext",
  "fullText",
  "sourceText",
  "sourcetext"
]);

function stripRawSensitiveFields(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripRawSensitiveFields(item));
  }

  if (typeof value !== "object") {
    return value;
  }

  const sanitized = {};

  Object.entries(value).forEach(([key, nestedValue]) => {
    const normalizedKey = String(key).toLowerCase();
    if (RAW_VALUE_KEYS.has(key) || RAW_VALUE_KEYS.has(normalizedKey)) {
      return;
    }

    sanitized[key] = stripRawSensitiveFields(nestedValue);
  });

  return sanitized;
}

function containsRawSensitiveFields(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsRawSensitiveFields(item));
  }

  if (typeof value !== "object") {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    const normalizedKey = String(key).toLowerCase();
    if (RAW_VALUE_KEYS.has(key) || RAW_VALUE_KEYS.has(normalizedKey)) {
      return true;
    }

    return containsRawSensitiveFields(nestedValue);
  });
}

const SANITIZED_VISUAL_KEYS = new Set([
  "sanitizedscreenshot",
  "screenshot",
  "imagedata",
  "blob",
  "image"
]);

const SAFE_METADATA_PATHS = [
  /^\$\.privacy\.redactedRegions\[\d+\]\.(piiType|type|severity|action|finalRedactionAction|recommendedAction|source|reason)$/,
  /^\$\.privacy\.sanitizationReport\.(byType|bySeverity)\.[^.]+$/,
  /^\$\.domContext\.(elements|interactiveElements)\[\d+\]\.(type|category|name|id|autocomplete)$/,
  /^\$\.domContext\.forms\[\d+\]\.controls\[\d+\]\.(type|name|id|autocomplete)$/
];

function isSafeMetadataPath(path) {
  return SAFE_METADATA_PATHS.some((pattern) => pattern.test(path));
}

function getDiagnosticCategory(rule) {
  const normalizedRule = String(rule || "").toUpperCase();
  if (normalizedRule.includes("API_KEY") || normalizedRule.includes("PASSWORD") || normalizedRule.includes("OTP") || normalizedRule.includes("TOKEN") || normalizedRule.includes("CARD") || normalizedRule.includes("CVV")) {
    return "RAW_SENSITIVE_OR_UNSANITIZED_TEXT";
  }
  return "SUSPICIOUS_METADATA_OR_TEXT";
}

function isExcludedSanitizedVisualPath(path, key, options = {}) {
  if (options.excludedPaths?.has(path)) {
    return true;
  }

  if (isSafeMetadataPath(path)) {
    return true;
  }

  const normalizedKey = String(key || "").toLowerCase();
  return path.startsWith("$.visualContext.") && SANITIZED_VISUAL_KEYS.has(normalizedKey);
}

function collectStringValues(value, results = [], options = {}, path = "$", parentPath = "", key = "") {
  if (isExcludedSanitizedVisualPath(path, key, options)) {
    return results;
  }

  if (value === null || value === undefined) {
    return results;
  }

  if (typeof value === "string") {
    if (value.trim()) {
      results.push(value);
    }
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStringValues(item, results, options, `${path}[${index}]`, path, index);
    });
    return results;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      collectStringValues(nestedValue, results, options, `${path}.${key}`, path, key);
    });
  }

  return results;
}

function looksLikeSensitiveString(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 4) {
    return false;
  }

  if (/^<\w+_\d+>$/.test(trimmed) || trimmed === SECRET_PLACEHOLDER || trimmed === "[REDACTED]") {
    return false;
  }

  const groupedDetections = runAllDeterministicDetectors(trimmed);
  if (groupedDetections.length > 0) {
    return true;
  }

  const lower = trimmed.toLowerCase();
  const suspiciousMarkers = [
    "password",
    "otp",
    "api key",
    "secret",
    "authorization",
    "bearer",
    "session token",
    "ssn",
    "aadhaar",
    "pan number",
    "email is",
    "phone is",
    "dob",
    "date of birth",
    "address",
    "full name"
  ];

  return suspiciousMarkers.some((marker) => lower.includes(marker));
}

function maskDiagnosticValue(value) {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  const visiblePrefix = value.slice(0, 3);
  const visibleSuffix = value.slice(-3);
  return `${visiblePrefix}${"*".repeat(Math.min(value.length - 6, 24))}${visibleSuffix}`;
}

function getSensitiveStringRule(value) {
  const deterministicDetections = runAllDeterministicDetectors(value);
  if (deterministicDetections.length > 0) {
    return deterministicDetections
      .map((detection) => detection.piiType || detection.type || "deterministic-detector")
      .join(", ");
  }

  const lower = value.toLowerCase();
  const suspiciousMarkers = [
    "password",
    "otp",
    "api key",
    "secret",
    "authorization",
    "bearer",
    "session token",
    "ssn",
    "aadhaar",
    "pan number",
    "email is",
    "phone is",
    "dob",
    "date of birth",
    "address",
    "full name"
  ];

  return suspiciousMarkers.find((marker) => lower.includes(marker)) || "unknown";
}

function findSuspiciousStringDiagnostics(value, path = "$", results = [], options = {}, parentPath = "", key = "") {
  if (isExcludedSanitizedVisualPath(path, key, options)) {
    return results;
  }

  if (typeof value === "string") {
    if (looksLikeSensitiveString(value)) {
      results.push({
        path,
        fieldName: key || path.split(".").pop(),
        type: "SUSPICIOUS_STRING",
        length: value.length,
        value: maskDiagnosticValue(value),
        rule: getSensitiveStringRule(value),
        category: getDiagnosticCategory(getSensitiveStringRule(value)),
        severity: "BLOCKING_SCAN_MATCH"
      });
    }
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findSuspiciousStringDiagnostics(item, `${path}[${index}]`, results, options, path, index);
    });
    return results;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      findSuspiciousStringDiagnostics(nestedValue, `${path}.${key}`, results, options, path, key);
    });
  }

  return results;
}

function createSafeOutputContract(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      allowed: false,
      decision: "BLOCK",
      safeSummary: { blocked: true, reason: "Invalid payload" }
    };
  }

  const safePayload = {
    visualContext: {
      sanitizedScreenshot: Boolean(payload.visualContext?.sanitizedScreenshot),
      sanitizedScreenshotLength: payload.visualContext?.sanitizedScreenshot ? payload.visualContext.sanitizedScreenshot.length : 0
    },
    domContext: {
      visibleTextSanitized: Boolean(payload.domContext?.visibleText),
      elementCount: payload.domContext?.elements?.length ?? 0,
      interactiveElementCount: payload.domContext?.interactiveElements?.length ?? 0,
      formCount: payload.domContext?.forms?.length ?? 0
    },
    privacy: {
      piiDetected: Boolean(payload.privacy?.piiDetected),
      redactedRegionCount: payload.privacy?.redactedRegionCount ?? 0,
      severitySummary: payload.privacy?.severitySummary ?? {},
      piiTypesSummary: payload.privacy?.piiTypesSummary ?? {},
      rawScreenshotIncluded: false
    },
    redactionMetadata: (payload.privacy?.redactedRegions || []).map((region) => ({
      piiType: region.piiType,
      severity: region.severity,
      confidence: region.confidence,
      action: region.finalRedactionAction,
      source: region.source || "fused",
      elementId: region.elementId || null,
      rect: region.rect ? {
        x: Number(region.rect.x),
        y: Number(region.rect.y),
        width: Number(region.rect.width),
        height: Number(region.rect.height)
      } : null
    })),
    safety: {
      rawValueFieldsRemoved: true,
      sanitizationBoundary: "safe-summary-only"
    }
  };

  return stripRawSensitiveFields(safePayload);
}

function logPrivacyGateDecision(decision, payload, suspiciousStringCount) {
  console.log(
    "Final privacy gate decision:",
    {
      decision,
      sanitizedScreenshotPresent: payload?.visualContext?.sanitizedScreenshot !== undefined,
      redactedRegionCount: payload?.privacy?.redactedRegionCount ?? 0,
      suspiciousStringCount
    }
  );
}

function finalPrivacyGate(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      allowed: false,
      decision: "BLOCK",
      reason: "Invalid payload",
      safeSummary: { blocked: true }
    };
  }

  if (payload.sanitized === true || Object.hasOwn(payload, "sanitizedScreenshot")) {
    const allowedKeys = new Set([
      "sanitized",
      "sanitizedScreenshot",
      "redactedRegionCount",
      "redactedTypes",
      "redactionMetadata"
    ]);
    const unexpectedKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));

    if (
      unexpectedKeys.length > 0 ||
      payload.sanitized !== true ||
      typeof payload.sanitizedScreenshot !== "string" ||
      !payload.sanitizedScreenshot
    ) {
      console.warn(
        "Final privacy gate blocked outbound payload:",
        { reason: "Invalid screenshot-only handoff", unexpectedKeys }
      );
      return {
        allowed: false,
        decision: "BLOCK",
        reason: "Invalid screenshot-only handoff",
        safeSummary: { blocked: true, unexpectedKeys }
      };
    }

    const redactedTypes = Array.isArray(payload.redactedTypes)
      && payload.redactedTypes.every(
        (type) => typeof type === "string" && /^[A-Z][A-Z0-9_]*$/.test(type)
      );
    const redactionMetadata = Array.isArray(payload.redactionMetadata)
      && payload.redactionMetadata.every((region) => {
        if (!region || typeof region !== "object") return false;
        const metadataKeys = new Set(["piiType", "severity", "confidence", "action", "source", "rect"]);
        return Object.keys(region).every((key) => metadataKeys.has(key))
          && typeof region.piiType === "string"
          && /^[A-Z][A-Z0-9_]*$/.test(region.piiType)
          && typeof region.severity === "string"
          && /^[A-Z][A-Z0-9_]*$/.test(region.severity)
          && typeof region.action === "string"
          && /^[A-Z][A-Z0-9_]*$/.test(region.action)
          && typeof region.source === "string"
          && /^[A-Z][A-Z0-9_]*$/.test(region.source);
      });

    if (!redactedTypes || !redactionMetadata || containsRawSensitiveFields(payload)) {
      console.warn(
        "Final privacy gate blocked outbound payload:",
        { reason: "Unsafe screenshot-only metadata" }
      );
      return {
        allowed: false,
        decision: "BLOCK",
        reason: "Unsafe screenshot-only metadata",
        safeSummary: { blocked: true }
      };
    }

    console.log(
      "Final privacy gate decision:",
      {
        decision: "ALLOW",
        sanitizedScreenshotPresent: true,
        redactedRegionCount: payload.redactedRegionCount || 0,
        suspiciousStringCount: 0
      }
    );

    return {
      allowed: true,
      decision: "ALLOW",
      reason: "Final privacy gate passed",
      safeSummary: {
        sanitized: true,
        sanitizedScreenshotPresent: true,
        redactedRegionCount: payload.redactedRegionCount || 0,
        redactedTypes: payload.redactedTypes
      }
    };
  }

  const safePayload = createSafeOutputContract(payload);
  const rawSensitiveFieldsDetected = containsRawSensitiveFields(safePayload);
  const stringScanOptions = {};
  const allStringValues = collectStringValues(payload, [], stringScanOptions);
  const suspiciousStrings = allStringValues.filter((value) => looksLikeSensitiveString(value));
  const suspiciousStringDiagnostics = findSuspiciousStringDiagnostics(payload, "$", [], stringScanOptions);

  if (suspiciousStringDiagnostics.length > 0) {
    console.warn(
      "Final privacy gate suspicious string diagnostics (local only):",
      suspiciousStringDiagnostics
    );
  }

  const hasMissingSanitizedFlags =
    payload.privacy?.rawScreenshotIncluded === true ||
    payload.visualContext?.sanitizedScreenshot === undefined;

  if (rawSensitiveFieldsDetected) {
    logPrivacyGateDecision("BLOCK", payload, suspiciousStrings.length);
    return {
      allowed: false,
      decision: "BLOCK",
      reason: "Unsafe raw fields detected in payload",
      safeSummary: {
        blocked: true,
        reason: "Raw value fields were found in the payload",
        redactedRegionCount: payload.privacy?.redactedRegionCount ?? 0
      }
    };
  }

  if (hasMissingSanitizedFlags) {
    logPrivacyGateDecision("BLOCK", payload, suspiciousStrings.length);
    return {
      allowed: false,
      decision: "BLOCK",
      reason: "Payload missing required sanitized output",
      safeSummary: {
        blocked: true,
        reason: "Missing sanitized screenshot",
        redactedRegionCount: payload.privacy?.redactedRegionCount ?? 0
      }
    };
  }

  if (suspiciousStrings.length > 0) {
    logPrivacyGateDecision("BLOCK", payload, suspiciousStrings.length);
    return {
      allowed: false,
      decision: "BLOCK",
      reason: "Sensitive data detected during final privacy gate",
      safeSummary: {
        blocked: true,
        suspiciousScanCount: suspiciousStrings.length,
        redactedRegionCount: payload.privacy?.redactedRegionCount ?? 0,
        piiTypesSummary: payload.privacy?.piiTypesSummary ?? {}
      }
    };
  }

  logPrivacyGateDecision("ALLOW", payload, suspiciousStrings.length);

  return {
    allowed: true,
    decision: "ALLOW",
    reason: "Final privacy gate passed",
    safeSummary: {
      ...safePayload,
      allowed: true,
      decision: "ALLOW"
    }
  };
}

function createScreenshotOnlyHandoff(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return {
    sanitizedScreenshot: payload.visualContext?.sanitizedScreenshot,
    sanitized: true,
    redactedRegionCount: Number(payload.privacy?.redactedRegionCount || 0),
    redactedTypes: Object.keys(payload.privacy?.piiTypesSummary || {}),
    redactionMetadata: (payload.privacy?.redactedRegions || []).map((region) => ({
      piiType: region.piiType || "UNKNOWN",
      severity: region.severity || "UNKNOWN",
      confidence: Number(region.confidence || 0),
      action: region.finalRedactionAction || "PLACEHOLDER",
      source: region.source || "fused",
      rect: region.rect ? {
        x: Number(region.rect.x),
        y: Number(region.rect.y),
        width: Number(region.rect.width),
        height: Number(region.rect.height)
      } : null
    }))
  };
}

function createSanitizedPayload(
  pageContext,
  sanitizedScreenshot
) {
  const sanitizedDomElements =
    pageContext.domElements.map(
      (element) =>
        sanitizeDomElement(
          element,
          pageContext.sensitiveElements
        )
    );

  const sanitizedForms =
    sanitizeForms(
      pageContext.forms,
      pageContext.sensitiveElements
    );

  const visibleTextSanitization =
    sanitizePageText(
      pageContext.visibleText,
      pageContext.sensitiveElements
    );

  const redactedRegions =
    pageContext.sensitiveElements.map((element) => ({
      piiType:
        element.piiType || "UNKNOWN",

      severity:
        element.severity || "UNKNOWN",

      confidence:
        element.confidence || 0,

      finalRedactionAction:
        element.finalRedactionAction ||
        element.action ||
        "PLACEHOLDER",

      source:
        element.source || "fused",

      rect:
        element.rect ||
        element.boundingBox ||
        null
    }));

  const byType = {};
  const bySeverity = {};

  redactedRegions.forEach((region) => {
    byType[region.piiType] = (byType[region.piiType] || 0) + 1;
    bySeverity[region.severity] = (bySeverity[region.severity] || 0) + 1;
  });

  const sanitizationReport = {
    ...visibleTextSanitization.report,
    totalDetections: redactedRegions.length,
    sanitized: redactedRegions.length,
    byType,
    bySeverity
  };

  console.log(
    "Privacy Sanitization Report:",
    {
      totalDetections: sanitizationReport.totalDetections,
      sanitized: sanitizationReport.sanitized,
      byType: sanitizationReport.byType || {},
      bySeverity: sanitizationReport.bySeverity || {}
    }
  );

  return {
    page: {
      url:
        pageContext.url,

      title:
        pageContext.title,

      viewport:
        pageContext.viewport
    },

    visualContext: {
      sanitizedScreenshot
    },

    domContext: {
      visibleText:
        visibleTextSanitization.sanitized,

      elements:
        sanitizedDomElements,

      interactiveElements:
        sanitizedDomElements.filter(
          (element) =>
            [
              "button",
              "input",
              "textarea",
              "select",
              "link",
              "contenteditable"
            ].includes(
              element.category
            )
        ),

      forms:
        sanitizedForms
    },

    privacy: {
      piiDetected:
        pageContext.sensitiveElements
          .length > 0,

      sanitizationReport:
        sanitizationReport,

      redactedRegions:
        redactedRegions.map((element) => ({
            piiType:
              element.piiType || "UNKNOWN",

            severity:
              element.severity || "UNKNOWN",

            confidence:
              element.confidence !== undefined ? element.confidence : null,

            finalRedactionAction:
              element.finalRedactionAction ||
              element.recommendedAction ||
              "BLACKOUT",

            rect:
              element.rect,

            fusedCount:
              element.fusedCount || 1,

            sourceCount:
              element.sourceCount || 1,

            safetyMarginApplied:
              element.safetyMarginApplied || false
          })),

      redactedRegionCount:
        pageContext.sensitiveElements
          .length,

      severitySummary: {
        critical:
          pageContext.sensitiveElements.filter(
            (e) => e.severity === "CRITICAL"
          ).length,

        high:
          pageContext.sensitiveElements.filter(
            (e) => e.severity === "HIGH"
          ).length,

        contextDependent:
          pageContext.sensitiveElements.filter(
            (e) => e.severity === "CONTEXT_DEPENDENT"
          ).length
      },

      piiTypesSummary:
        pageContext.sensitiveElements
          .reduce((acc, element) => {
            const type = element.piiType || "UNKNOWN";
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {}),

      rawScreenshotIncluded:
        false
    },

    timestamp:
      pageContext.timestamp
  };
}

function redactScreenshot(
  dataUrl,
  sensitiveElements
) {
  return new Promise(
    (resolve, reject) => {
      const ImageCtor = typeof globalThis !== "undefined" ? globalThis.Image : undefined;

      if (!ImageCtor) {
        reject(
          new Error(
            "Screenshot redaction requires a browser Image implementation"
          )
        );
        return;
      }

      const image = new ImageCtor();

      image.onload = () => {
        const canvas =
          document.createElement(
            "canvas"
          );

        const context =
          canvas.getContext("2d");

        if (!context) {
          reject(
            new Error(
              "Could not create canvas context"
            )
          );

          return;
        }

        canvas.width =
          image.width;

        canvas.height =
          image.height;

        context.drawImage(
          image,
          0,
          0
        );

        const screenshotMetrics = getScreenshotMetrics({
          screenshotWidth: image.width,
          screenshotHeight: image.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          devicePixelRatio: window.devicePixelRatio,
          zoomScale: window.visualViewport ? window.visualViewport.scale : 1
        });

        console.log(
          "Screenshot sanitization dimensions:",
          {
            original: { width: image.width, height: image.height },
            viewport: { width: window.innerWidth, height: window.innerHeight },
            devicePixelRatio: screenshotMetrics.devicePixelRatio,
            zoomScale: screenshotMetrics.zoomScale,
            scroll: { x: screenshotMetrics.scrollX, y: screenshotMetrics.scrollY },
            scale: {
              x: screenshotMetrics.cssToScreenshotScaleX,
              y: screenshotMetrics.cssToScreenshotScaleY
            },
            detections: sensitiveElements.length
          }
        );

        const normalizedRedactionRegions = sensitiveElements
          .map((element) => {
            const sourceRect = element.rect || element.boundingBox || { x: 0, y: 0, width: 0, height: 0 };
            const rect = convertRectToCanonical(
              sourceRect,
              element.source || "dom",
              screenshotMetrics
            );

            const paddedRect = {
              x: Math.max(0, Math.round(rect.x - 2)),
              y: Math.max(0, Math.round(rect.y - 2)),
              width: Math.max(1, Math.round(rect.width + 4)),
              height: Math.max(1, Math.round(rect.height + 4))
            };

            return {
              type: element.piiType || element.type || "UNKNOWN",
              source: element.source || "dom",
              confidence: element.confidence ?? null,
              inputBoundingBox: sourceRect,
              mappedScreenshotRect: paddedRect,
              action: element.finalRedactionAction || element.recommendedAction || "BLACKOUT"
            };
          })
          .filter((region) => region.mappedScreenshotRect.width > 0 && region.mappedScreenshotRect.height > 0);

        normalizedRedactionRegions.forEach((region) => {
          const { x, y, width, height } = region.mappedScreenshotRect;

          console.log(
            "Screenshot redaction region:",
            {
              type: region.type,
              source: region.source,
              confidence: region.confidence,
              inputBoundingBox: region.inputBoundingBox,
              mappedScreenshotRect: { x, y, width, height }
            }
          );

          if (region.action === "BLACKOUT") {
            context.fillStyle = "#000000";
            context.fillRect(x, y, width, height);
          } else if (region.action === "MASK") {
            context.fillStyle = "#2d2d2d";
            context.fillRect(x, y, width, height);
          } else if (region.action === "PLACEHOLDER") {
            context.fillStyle = "#7c7c7c";
            context.fillRect(x, y, width, height);
          } else if (region.action === "BLUR") {
            context.save();
            context.filter = "blur(4px)";
            context.fillStyle = "rgba(0, 0, 0, 0.92)";
            context.fillRect(x, y, width, height);
            context.restore();
          }
        });

        const sanitizedScreenshot = canvas.toDataURL("image/png");

        console.log(
          "Sanitized screenshot dimensions:",
          { width: canvas.width, height: canvas.height }
        );

        resolve(sanitizedScreenshot);
      };

      image.onerror = () => {
        reject(
          new Error(
            "Failed to load screenshot for redaction"
          )
        );
      };

      image.src = dataUrl;
    }
  );
}

function sanitizeText(text) {
  if (typeof text !== "string" || !text) {
    return text || "";
  }

  const detections = [];
  const patterns = getPIIPatterns();
  const typeMap = {
    email: "EMAIL",
    phone: "PHONE",
    aadhaar: "GOVERNMENT_ID",
    pan: "GOVERNMENT_ID",
    card: "CARD"
  };

  Object.entries(patterns).forEach(([patternType, pattern]) => {
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      detections.push({
        piiType: typeMap[patternType],
        value: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        severity: ["CARD"].includes(typeMap[patternType]) ? "CRITICAL" : "HIGH",
        confidence: 0.95
      });

      if (!pattern.global) {
        break;
      }
    }
  });

  if (/(password|otp|cvv|secret|token|authorization|bearer)\s*(?:=|:|is)?/i.test(text)) {
    detections.push({
      piiType: "SECRET",
      value: text,
      startIndex: 0,
      endIndex: text.length,
      severity: "CRITICAL",
      confidence: 0.99
    });
  }

  return sanitizeTextWithPlaceholders(text, detections).sanitized;
}

function sendSanitizedScreenshotForAnalysis(handoffPayload) {
  return new Promise((resolve, reject) => {
    const chromeApi = typeof globalThis !== "undefined" ? globalThis.chrome : undefined;

    if (!chromeApi?.runtime?.sendMessage) {
      reject(new Error("Chrome runtime is unavailable for visual analysis"));
      return;
    }

    chromeApi.runtime.sendMessage(
      {
        type: "SEND_SANITIZED_FOR_ANALYSIS",
        ...handoffPayload
      },
      (response) => {
        if (chromeApi.runtime.lastError) {
          reject(new Error(chromeApi.runtime.lastError.message));
          return;
        }

        if (!response?.success) {
          reject(new Error(response?.error || "Sanitized screenshot analysis failed"));
          return;
        }

        resolve(response.analysis || {});
      }
    );
  });
}

function getAnalysisRect(item) {
  const box = item?.bounding_box || item?.boundingBox || item?.box || item?.rect || item;
  if (!box) {
    return null;
  }

  if ([box.x, box.y, box.width, box.height].every((value) => typeof value === "number")) {
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  if ([box.x1, box.y1, box.x2, box.y2].every((value) => typeof value === "number")) {
    return {
      x: box.x1,
      y: box.y1,
      width: box.x2 - box.x1,
      height: box.y2 - box.y1
    };
  }

  return null;
}

function mapVisualItemsToDomElements(domElements, items, imageInfo, viewport, minimumOverlap = 0.3) {
  const imageWidth = Number(imageInfo?.width);
  const imageHeight = Number(imageInfo?.height);
  const scaleX = imageWidth && viewport?.width ? viewport.width / imageWidth : 1;
  const scaleY = imageHeight && viewport?.height ? viewport.height / imageHeight : 1;

  return (Array.isArray(items) ? items : []).map((item, index) => {
    const rect = getAnalysisRect(item);
    const viewportRect = rect ? {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    } : null;
    const matchedElements = viewportRect ? domElements.map((element) => {
      const left = Math.max(element.rect.x, viewportRect.x);
      const top = Math.max(element.rect.y, viewportRect.y);
      const right = Math.min(element.rect.x + element.rect.width, viewportRect.x + viewportRect.width);
      const bottom = Math.min(element.rect.y + element.rect.height, viewportRect.y + viewportRect.height);
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      const visualArea = viewportRect.width * viewportRect.height;
      return { element, score: visualArea > 0 ? area / visualArea : 0 };
    }).filter(({ score }) => score >= minimumOverlap).sort((a, b) => b.score - a.score).map(({ element, score }) => ({
      elementId: element.elementId,
      tag: element.tag,
      category: element.category,
      score: Number(score.toFixed(3))
    })) : [];

    return {
      ...item,
      visualItemId: item.visualItemId || `visual_item_${index + 1}`,
      mapping: { mapped: matchedElements.length > 0, viewportRect, matchedElements }
    };
  });
}

function createBrowserPerceptionState(finalPayload, analysis) {
  const imageInfo = analysis?.image || {};
  const domElements = finalPayload.domContext.elements || [];
  const visualText = mapVisualItemsToDomElements(domElements, analysis?.texts, imageInfo, finalPayload.page.viewport);
  const visualRegions = mapVisualItemsToDomElements(domElements, analysis?.regions, imageInfo, finalPayload.page.viewport, 0.2);
  const objects = mapVisualItemsToDomElements(domElements, analysis?.objects, imageInfo, finalPayload.page.viewport, 0.2);
  const compactText = visualText.map((item) => ({
    visualItemId: item.visualItemId,
    text: sanitizeText(item.text || item.value || item.content || ""),
    rect: item.mapping.viewportRect || getAnalysisRect(item),
    mappedElementIds: item.mapping.matchedElements.map((match) => match.elementId)
  }));
  const compactRegions = visualRegions.map((item) => ({
    visualItemId: item.visualItemId,
    type: item.type || item.class || item.category || item.label || "visual_region",
    rect: item.mapping.viewportRect || getAnalysisRect(item),
    mappedElementIds: item.mapping.matchedElements.map((match) => match.elementId)
  }));
  const compactObjects = objects.map((item) => ({
    visualItemId: item.visualItemId,
    class: item.class || item.label || item.category || "object",
    confidence: item.confidence ?? item.score ?? null,
    rect: item.mapping.viewportRect || getAnalysisRect(item),
    mappedElementIds: item.mapping.matchedElements.map((match) => match.elementId)
  }));

  return stripRawSensitiveFields({
    page: {
      url: sanitizeText(finalPayload.page.url),
      title: sanitizeText(finalPayload.page.title),
      viewport: finalPayload.page.viewport
    },
    interactiveElements: (domElements.filter((element) => ["button", "input", "textarea", "select", "link", "contenteditable"].includes(element.category))).map((element) => ({
      elementId: element.elementId,
      tag: element.tag,
      category: element.category,
      type: element.type,
      text: sanitizeText(element.text),
      placeholder: sanitizeText(element.placeholder) || null,
      label: sanitizeText(element.label) || null,
      rect: element.rect,
      visualContext: { hasVisualMatch: false }
    })),
    forms: finalPayload.domContext.forms.map((form) => ({
      ...form,
      action: sanitizeText(form.action),
      controls: form.controls.map((control) => ({
        ...control,
        text: sanitizeText(control.text),
        placeholder: sanitizeText(control.placeholder),
        label: sanitizeText(control.label),
        accessibility: {
          ...control.accessibility,
          accessibleName: sanitizeText(control.accessibility?.accessibleName),
          ariaLabel: sanitizeText(control.accessibility?.ariaLabel)
        }
          }))
    })),
    visualText: compactText,
    visualRegions: compactRegions,
    objects: compactObjects,
    privacy: {
      piiDetected: finalPayload.privacy.piiDetected,
      redactedRegionCount: finalPayload.privacy.redactedRegionCount,
      rawScreenshotIncluded: false
    },
    summary: {
      totalElements: domElements.length,
      interactiveElements: finalPayload.domContext.interactiveElements.length,
      visualTextRegions: compactText.length,
      visualRegions: compactRegions.length,
      objects: compactObjects.length,
      forms: finalPayload.domContext.forms.length
    },
    timestamp: finalPayload.timestamp
  });
}

function sendBrowserPerceptionState(browserPerceptionState) {
  return new Promise((resolve, reject) => {
    const chromeApi = typeof globalThis !== "undefined" ? globalThis.chrome : undefined;
    if (!chromeApi?.runtime?.sendMessage) {
      reject(new Error("Chrome runtime is unavailable for browser perception"));
      return;
    }

    chromeApi.runtime.sendMessage(
      { type: "SEND_BROWSER_PERCEPTION", perceptionState: browserPerceptionState },
      (response) => {
        if (chromeApi.runtime.lastError) {
          reject(new Error(chromeApi.runtime.lastError.message));
        } else if (!response?.success) {
          reject(new Error(response?.error || "Failed to send browser perception state"));
        } else {
          resolve(response.serverResponse);
        }
      }
    );
  });
}

function captureScreenshot(
  pageContext,
  options = {}
) {
  const {
    userInitiated = false
  } = options;

  if (!userInitiated) {
    return Promise.resolve({
      success: false,
      error: "Screenshot capture requires an explicit user-initiated extension action."
    });
  }

  const chromeApi = typeof globalThis !== "undefined" ? globalThis.chrome : undefined;
  if (!chromeApi || !chromeApi.runtime || !chromeApi.runtime.sendMessage) {
    return Promise.resolve({
      success: false,
      error: "Screenshot capture requires a Chrome runtime context."
    });
  }

  return new Promise(
    (resolve, reject) => {
      chromeApi.runtime.sendMessage(
        {
          type:
            "CAPTURE_SCREENSHOT",
          source: "user-invoked"
        },
        async (response) => {
          if (
            chromeApi.runtime.lastError
          ) {
            console.error(
              "Could not communicate with background script:",
              chromeApi.runtime.lastError
                .message
            );

            resolve({
              success: false,
              error: chromeApi.runtime.lastError.message
            });

            return;
          }

          if (
            !response?.success
          ) {
            console.error(
              "Screenshot capture failed:",
              response?.error
            );

            resolve({
              success: false,
              error: response?.error || "Screenshot capture failed"
            });

            return;
          }

          try {
            console.log(
              "Screenshot captured successfully"
            );

            const ocrEnabled = isOCREnabled({
              enabled: Boolean(window.__ENABLE_LOCAL_OCR__)
            });

            const ocrDetections = ocrEnabled
              ? await detectOCRTextRegions(response.screenshot, {
                  enabled: true
                })
              : [];

            const faceDetections =
              await detectFacesInScreenshot(
                response.screenshot
              );

            const fusedSensitiveElements =
              runFusionEngine(
                pageContext.sensitiveElements || [],
                [],
                ocrDetections,
                [],
                faceDetections,
                {
                  overlapThreshold: 0.1,
                  proximityThreshold: 50,
                  safetyMarginPercent: 10
                }
              );

            const sensitiveElements = fusedSensitiveElements;

            const sanitizedScreenshot =
              await redactScreenshot(
                response.screenshot,
                sensitiveElements
              );

            console.log(
              "Screenshot sanitized successfully"
            );

            console.log(
              "Sensitive regions redacted:",
              sensitiveElements.length
            );

            const sanitizedHandoff = {
              sanitized: true,
              sanitizedScreenshot,
              redactedRegionCount: sensitiveElements.length,
              redactedTypes: [
                ...new Set(
                  sensitiveElements.map(
                    (element) => element.piiType || element.type || "UNKNOWN"
                  )
                )
              ],
              redactionMetadata: sensitiveElements.map((element) => ({
                piiType: element.piiType || element.type || "UNKNOWN",
                severity: element.severity || "UNKNOWN",
                confidence: Number(element.confidence || 0),
                action: element.finalRedactionAction || element.action || "PLACEHOLDER",
                source: element.source || "fused",
                rect: element.rect || element.boundingBox || null
              }))
            };

            const preGateDiagnostics =
              findSuspiciousStringDiagnostics(
                sanitizedHandoff,
                "$",
                [],
                {}
              );

            console.log(
              "Final privacy gate payload diagnostics (local only):",
              {
                topLevelKeys: Object.keys(sanitizedHandoff),
                visualContextKeys: [],
                sanitizedScreenshotPresent:
                  sanitizedHandoff.sanitizedScreenshot !== undefined,
                sanitizedScreenshotLength:
                  sanitizedHandoff.sanitizedScreenshot.length,
                rawScreenshotIncluded: false,
                redactedRegionCount:
                  sanitizedHandoff.redactedRegionCount,
                redactedTypes: sanitizedHandoff.redactedTypes,
                suspiciousDiagnostics:
                  preGateDiagnostics.map((diagnostic) => ({
                    path: diagnostic.path,
                    fieldName: diagnostic.fieldName,
                    type: diagnostic.type,
                    length: diagnostic.length,
                    rule: diagnostic.rule,
                    category: diagnostic.category,
                    severity: diagnostic.severity,
                    maskedPreview: diagnostic.value
                  }))
              }
            );

            const gateDecision = finalPrivacyGate(sanitizedHandoff);

            if (!gateDecision.allowed) {
              console.warn(
                "Final privacy gate blocked outbound payload:",
                gateDecision.safeSummary
              );
              resolve({
                success: false,
                error: gateDecision.reason,
                gate: gateDecision
              });
              return;
            }

            console.log(
              "Final privacy gate passed:",
              gateDecision.safeSummary
            );

            console.log(
              "Sanitized screenshot handoff started"
            );

            console.log(
              "Sanitized payload summary:",
              {
                redactedRegions: sanitizedHandoff.redactedRegionCount,
                redactedTypes: sanitizedHandoff.redactedTypes,
                sanitizedScreenshotPresent: true
              }
            );

            let analysis = null;
            let browserPerceptionState = null;
            const finalPayload = createSanitizedPayload(
              { ...pageContext, sensitiveElements },
              sanitizedScreenshot
            );

            try {
              analysis =
                await sendSanitizedScreenshotForAnalysis(
                  sanitizedHandoff
                );

              console.log(
                "Sanitized screenshot handoff completed"
              );

              browserPerceptionState =
                createBrowserPerceptionState(
                  finalPayload,
                  analysis
                );

              await sendBrowserPerceptionState(
                browserPerceptionState
              );
            } catch (error) {
              console.warn(
                "Optional visual perception analysis failed:",
                error.message
              );
            }

            resolve({
              success: true,
              screenshot: sanitizedScreenshot,
              payload: finalPayload,
              analysis,
              browserPerceptionState,
              gate: gateDecision
            });
          } catch (error) {
            console.error(
              "Local screenshot redaction failed:",
              error.message
            );

            reject(error);
          }
        }
      );
    }
  );
}

if (
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  typeof chrome.runtime.onMessage?.addListener === "function"
) {
  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      if (message?.type !== "RUN_PRIVACY_CAPTURE_AND_ANALYZE") {
        return false;
      }

      try {
        const pageContext = extractPageContext();

        captureScreenshot(
          pageContext,
          { userInitiated: true }
        )
          .then((result) => {
            sendResponse(result);
          })
          .catch((error) => {
            sendResponse({
              success: false,
              error: error.message
            });
          });
      } catch (error) {
        sendResponse({
          success: false,
          error: error.message
        });
      }

      return true;
    }
  );
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof document.querySelectorAll === "function" &&
  typeof chrome !== "undefined" &&
  chrome.runtime &&
  window.__ALLOW_PRIVACY_CAPTURE__ === true
) {
  const pageContext =
    extractPageContext();

  console.log(
    "Privacy pipeline initialized:",
    {
      domElementCount:
        pageContext.domElements.length,
      formCount:
        pageContext.forms.length,
      viewport:
        pageContext.viewport,
      piiDetectionCount:
        pageContext.sensitiveElements.length
    }
  );

  captureScreenshot(
    pageContext,
    { userInitiated: true }
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    extractPageContext,
    sanitizePageText,
    createSanitizedPayload,
    createScreenshotOnlyHandoff,
    createSafeOutputContract,
    finalPrivacyGate,
    getSensitiveElements,
    captureScreenshot,
    redactScreenshot,
    detectFacesInScreenshot
  };
}
