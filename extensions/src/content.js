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
  PRIVACY_RAW_FIELD_KEYS,
  isPrivacyRawFieldKey
} from "./privacy-core.js";

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
    const enriched = enrichDetectionsWithPositions(visibleText, sensitiveElements);

    // Sanitize using privacy-sanitizer
    const result = sanitizeTextWithPlaceholders(visibleText, enriched);

    // Create report for logging
    const report = createSanitizationReport(enriched);

    // Do not log raw matches or the original sensitive text.
    console.log(
      "Privacy Sanitization Report:",
      {
        totalDetections: report.totalDetections,
        sanitized: report.sanitized,
        byType: report.byType,
        bySeverity: report.bySeverity
      }
    );

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

  const patterns = getPIIPatterns();

  return Array.from(
    document.querySelectorAll("body *")
  )
    .filter((element) => {
      if (
        excludedTags.has(
          element.tagName
        )
      ) {
        return false;
      }

      if (
        !isElementVisible(element)
      ) {
        return false;
      }

      const directText =
        Array.from(
          element.childNodes
        )
          .filter(
            (node) =>
              node.nodeType ===
              Node.TEXT_NODE
          )
          .map((node) =>
            node.textContent.trim()
          )
          .filter(Boolean)
          .join(" ");

      return containsPII(
        directText
      );
    })
    .map((element) => {
      const directText =
        Array.from(
          element.childNodes
        )
          .filter(
            (node) =>
              node.nodeType ===
              Node.TEXT_NODE
          )
          .map((node) =>
            node.textContent.trim()
          )
          .filter(Boolean)
          .join(" ")
          .slice(0, 200);

      const detection = {
        source:
          "text",

        tag:
          element.tagName.toLowerCase(),

        text:
          directText,

        rect:
          getElementRect(element)
      };

      // Find which PII pattern matched (existing regex patterns)
      let matchedPatternType = null;
      for (const [patternType, pattern] of Object.entries(patterns)) {
        pattern.lastIndex = 0;
        
        if (pattern.test(directText)) {
          // For card numbers, validate with Luhn algorithm
          if (patternType === "card") {
            // Extract the card number and validate with Luhn
            const cardPattern = /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/;
            const cardMatch = directText.match(cardPattern);
            
            if (cardMatch) {
              const cardNumberOnly = cardMatch[0].replace(/[\s-]/g, "");
              
              // Validate using Luhn algorithm
              if (isValidLuhn(cardNumberOnly)) {
                matchedPatternType = patternType;
                break;
              }
            }
          } else {
            matchedPatternType = patternType;
            break;
          }
        }
      }

      // Classify based on matched pattern
      let classification = null;
      if (matchedPatternType) {
        classification = classifyTextPattern({
          text: directText,
          patternType: matchedPatternType
        });
        
        return enrichDetection(detection, classification);
      }

      // Run deterministic detectors on remaining text
      const deterministicDetections =
        runAllDeterministicDetectors(directText);

      // Return first detection if any found
      if (deterministicDetections.length > 0) {
        const det = deterministicDetections[0];
        
        return enrichDetection(detection, {
          type: det.piiType,
          severity: det.severity,
          confidence: det.confidence,
          recommendedAction:
            REDACTION_ACTIONS[det.severity],
          reason: det.context
        });
      }

      // No PII detected in this element
      return null;
    })
    .filter(Boolean);
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
    if ("FaceDetector" in window) {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);
      const faceDetector = new FaceDetector({
        fastMode: true,
        maxDetectedFaces: 10,
        scoreThreshold: 0.5
      });

      const detectedFaces = await faceDetector.detect(imageBitmap);
      imageBitmap.close?.();

      const screenshotMetrics = getScreenshotMetrics({
        screenshotWidth: imageBitmap.width,
        screenshotHeight: imageBitmap.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio,
        zoomScale: window.visualViewport ? window.visualViewport.scale : 1
      });

      return detectedFaces.map((face) => {
        const box = face.boundingBox || {};
        const rect = convertRectToCanonical(
          {
            x: box.x || 0,
            y: box.y || 0,
            width: box.width || 0,
            height: box.height || 0
          },
          "face",
          screenshotMetrics
        );

        return {
          piiType: "FACE",
          type: "FACE",
          severity: "HIGH",
          action: "BLUR",
          confidence: Number((face.score ?? 0.8).toFixed(3)),
          source: "FACE",
          rect,
          boundingBox: rect,
          finalRedactionAction: "BLUR",
          reason: "Local browser face detection",
          sourceCount: 1,
          fusedCount: 1,
          safetyMarginApplied: false
        };
      });
    }

    if (window.FaceLandmarker || window.__PRIVACY_MEDIA_PIPE_FACE_LANDMARKER__) {
      const faceLandmarker = window.__PRIVACY_MEDIA_PIPE_FACE_LANDMARKER__ || window.FaceLandmarker;
      if (faceLandmarker && typeof faceLandmarker.detect === "function") {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const imageBitmap = await createImageBitmap(blob);
        const result = faceLandmarker.detect(imageBitmap);
        const boxes = Array.isArray(result?.faceLandmarks) ? result.faceLandmarks : [];
        imageBitmap.close?.();

        return boxes.map((landmarks, index) => {
          const points = landmarks || [];
          const xs = points.map((point) => Number(point?.x ?? 0));
          const ys = points.map((point) => Number(point?.y ?? 0));
          const minX = Math.min(...xs, 0);
          const maxX = Math.max(...xs, 0);
          const minY = Math.min(...ys, 0);
          const maxY = Math.max(...ys, 0);
          const rect = convertRectToCanonical(
            {
              x: minX,
              y: minY,
              width: Math.max(1, maxX - minX),
              height: Math.max(1, maxY - minY)
            },
            "face",
            getScreenshotMetrics({
              screenshotWidth: options.screenshotWidth || window.innerWidth * window.devicePixelRatio,
              screenshotHeight: options.screenshotHeight || window.innerHeight * window.devicePixelRatio,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              devicePixelRatio: window.devicePixelRatio,
              zoomScale: window.visualViewport ? window.visualViewport.scale : 1
            })
          );

          return {
            piiType: "FACE",
            type: "FACE",
            severity: "HIGH",
            action: "BLUR",
            confidence: Number((0.8 + (index * 0.05)).toFixed(3)),
            source: "FACE",
            rect,
            boundingBox: rect,
            finalRedactionAction: "BLUR",
            reason: "Local MediaPipe face detection",
            sourceCount: 1,
            fusedCount: 1,
            safetyMarginApplied: false
          };
        });
      }
    }

    console.warn("Face detection is not available in this browser; local face detection is skipped.");
    return [];
  } catch (error) {
    console.warn("Local face detection failed:", error.message || error);
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
        overlapThreshold: 0.1,
        proximityThreshold: 50,
        safetyMarginPercent: 10
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

const RAW_VALUE_KEYS = PRIVACY_RAW_FIELD_KEYS;

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
    if (isPrivacyRawFieldKey(key)) {
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
    if (isPrivacyRawFieldKey(key)) {
      return true;
    }

    return containsRawSensitiveFields(nestedValue);
  });
}

function collectStringValues(value, results = [], options = {}, path = "$") {
  const excludedPaths = options.excludedPaths || new Set();

  if (excludedPaths.has(path)) {
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
      collectStringValues(item, results, options, `${path}[${index}]`);
    });
    return results;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      collectStringValues(nestedValue, results, options, `${path}.${key}`);
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

function findSuspiciousStringDiagnostics(value, path = "$", results = [], options = {}) {
  const excludedPaths = options.excludedPaths || new Set();

  if (excludedPaths.has(path)) {
    return results;
  }

  if (typeof value === "string") {
    if (looksLikeSensitiveString(value)) {
      results.push({
        path,
        value: maskDiagnosticValue(value),
        rule: getSensitiveStringRule(value)
      });
    }
    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findSuspiciousStringDiagnostics(item, `${path}[${index}]`, results, options);
    });
    return results;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, nestedValue]) => {
      findSuspiciousStringDiagnostics(nestedValue, `${path}.${key}`, results, options);
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

function finalPrivacyGate(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      allowed: false,
      decision: "BLOCK",
      reason: "Invalid payload",
      safeSummary: { blocked: true }
    };
  }

  const safePayload = createSafeOutputContract(payload);
  const rawSensitiveFieldsDetected = containsRawSensitiveFields(safePayload);
  const stringScanOptions = {
    excludedPaths: new Set([
      "$.visualContext.sanitizedScreenshot"
    ])
  };
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
        sanitizePageText(
          pageContext.visibleText,
          pageContext.sensitiveElements
        ).sanitized,

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
        sanitizePageText(
          pageContext.visibleText,
          pageContext.sensitiveElements
        ).report,

      redactedRegions:
        pageContext.sensitiveElements
          .map((element) => ({
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

        sensitiveElements.forEach(
          (element) => {
            const rect = convertRectToCanonical(
              element.rect,
              element.source || "dom",
              screenshotMetrics
            );

            const x = Math.round(rect.x);
            const y = Math.round(rect.y);
            const width = Math.round(rect.width);
            const height = Math.round(rect.height);

            // Apply redaction based on final action from fusion engine
            const redactionAction =
              element.finalRedactionAction ||
              element.recommendedAction ||
              "BLACKOUT";

            if (
              redactionAction === "BLACKOUT"
            ) {
              // Solid black fill for critical PII
              context.fillStyle = "black";
              context.fillRect(x, y, width, height);
            } else if (
              redactionAction === "MASK"
            ) {
              // Dark gray fill for high-severity PII
              context.fillStyle = "#444444";
              context.fillRect(x, y, width, height);

              // Add a semi-transparent overlay
              context.fillStyle = "rgba(0, 0, 0, 0.3)";
              context.fillRect(x, y, width, height);
            } else if (
              redactionAction === "PLACEHOLDER"
            ) {
              // Medium gray fill for context-dependent PII
              context.fillStyle = "#999999";
              context.fillRect(x, y, width, height);
            } else if (
              redactionAction === "BLUR"
            ) {
              context.save();
              context.filter = "blur(8px)";
              context.fillStyle = "rgba(0, 0, 0, 0.9)";
              context.fillRect(x, y, width, height);
              context.restore();
            }
          }
        );

        resolve(
          canvas.toDataURL(
            "image/png"
          )
        );
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

function sendSanitizedScreenshotForAnalysis(sanitizedScreenshot) {
  return new Promise((resolve, reject) => {
    const chromeApi = typeof globalThis !== "undefined" ? globalThis.chrome : undefined;

    if (!chromeApi?.runtime?.sendMessage) {
      reject(new Error("Chrome runtime is unavailable for visual analysis"));
      return;
    }

    chromeApi.runtime.sendMessage(
      {
        type: "SEND_SANITIZED_FOR_ANALYSIS",
        screenshot: sanitizedScreenshot,
        sanitized: true
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
    schemaVersion: "phase1.v1",
    page: {
      url: sanitizeText(finalPayload.page.url),
      title: sanitizeText(finalPayload.page.title),
      viewport: finalPayload.page.viewport
    },
    visualContext: {
      sanitizedScreenshot: finalPayload.visualContext.sanitizedScreenshot,
      image: analysis?.image || {},
      texts: compactText,
      regions: compactRegions,
      objects: compactObjects
    },
    domContext: {
      visibleText: sanitizeText(finalPayload.domContext.visibleText),
      elements: domElements,
      interactiveElements: domElements
        .filter((element) => ["button", "input", "textarea", "select", "link", "contenteditable"].includes(element.category))
        .map((element) => ({
          elementId: element.elementId,
          tag: element.tag,
          category: element.category,
          type: element.type,
          text: sanitizeText(element.text),
          placeholder: sanitizeText(element.placeholder) || null,
          label: sanitizeText(element.label) || null,
          rect: element.rect
        })),
      forms: finalPayload.domContext.forms
    },
    privacy: {
      piiDetected: finalPayload.privacy.piiDetected,
      redactedRegionCount: finalPayload.privacy.redactedRegionCount,
      redactedRegions: finalPayload.privacy.redactedRegions,
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

function storeSanitizedCapture(screenshot, payload, reason) {
  return new Promise((resolve, reject) => {
    const chromeApi = typeof globalThis !== "undefined" ? globalThis.chrome : undefined;
    if (!chromeApi?.runtime?.sendMessage) {
      reject(new Error("Chrome runtime is unavailable for local capture storage"));
      return;
    }

    chromeApi.runtime.sendMessage(
      {
        type: "STORE_SANITIZED_CAPTURE",
        screenshot,
        payload,
        reason,
        url: window.location.href,
        title: document.title
      },
      (response) => {
        if (chromeApi.runtime.lastError) {
          reject(new Error(chromeApi.runtime.lastError.message));
        } else if (!response?.success) {
          reject(new Error(response?.error || "Could not store sanitized capture"));
        } else {
          resolve(response.id);
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

            const finalPayload =
              createSanitizedPayload(
                {
                  ...pageContext,
                  sensitiveElements
                },
                sanitizedScreenshot
              );

            const gateDecision = finalPrivacyGate(finalPayload);

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
              "FINAL SANITIZED PAYLOAD SUMMARY:",
              createSafeOutputContract(finalPayload)
            );

            console.log(
              "Sanitized payload summary:",
              {
                domElements:
                  finalPayload.domContext
                    .elements.length,

                interactiveElements:
                  finalPayload.domContext
                    .interactiveElements
                    .length,

                forms:
                  finalPayload.domContext
                    .forms.length,

                redactedRegions:
                  finalPayload.privacy
                    .redactedRegionCount,

                piiDetected:
                  finalPayload.privacy
                    .piiDetected,

                rawScreenshotIncluded:
                  finalPayload.privacy
                    .rawScreenshotIncluded
              }
            );

            console.log(
              "Sanitized text fetched from screen:",
              finalPayload.domContext.visibleText
            );

            try {
              const captureId = await storeSanitizedCapture(
                sanitizedScreenshot,
                {
                  safeSummary: createSafeOutputContract(finalPayload),
                  sanitizedText: finalPayload.domContext.visibleText,
                  timestamp: finalPayload.timestamp
                },
                options.reason || "manual"
              );
              console.log("Sanitized capture saved locally:", captureId);
            } catch (storageError) {
              console.error("Sanitized capture storage failed:", storageError.message);
            }

            let analysis = null;
            let browserPerceptionState = null;

            try {
              analysis =
                await sendSanitizedScreenshotForAnalysis(
                  sanitizedScreenshot
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

const AUTOMATIC_CAPTURE_DELAY_MS = 1200;
let automaticCaptureTimer = null;
let automaticCaptureInProgress = false;

function scheduleAutomaticCapture(reason) {
  if (automaticCaptureTimer !== null) {
    clearTimeout(automaticCaptureTimer);
  }

  automaticCaptureTimer = setTimeout(async () => {
    automaticCaptureTimer = null;
    if (automaticCaptureInProgress || document.visibilityState === "hidden") {
      return;
    }

    automaticCaptureInProgress = true;
    try {
      const pageContext = extractPageContext();
      console.log("Website event detected; capturing sanitized page:", reason);
      const result = await captureScreenshot(pageContext, {
        userInitiated: true,
        reason
      });
      if (!result.success) {
        console.warn("Automatic sanitized capture skipped:", result.error);
      }
    } catch (error) {
      console.error("Automatic sanitized capture failed:", error.message);
    } finally {
      automaticCaptureInProgress = false;
    }
  }, AUTOMATIC_CAPTURE_DELAY_MS);
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  ["click", "input", "change", "submit"].forEach((eventName) => {
    document.addEventListener(eventName, () => scheduleAutomaticCapture(eventName), true);
  });

  if (typeof MutationObserver === "function" && document.documentElement) {
    const observer = new MutationObserver(() => scheduleAutomaticCapture("dom-mutation"));
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
  }
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
    createSafeOutputContract,
    finalPrivacyGate,
    getSensitiveElements,
    captureScreenshot,
    redactScreenshot,
    detectFacesInScreenshot
  };
}