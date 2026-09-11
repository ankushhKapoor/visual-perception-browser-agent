import { inspectScreenshotLocally } from "./local-vision-privacy.js";

// Local-only demonstration mode: begin a browser privacy scan when a matching
// page finishes loading, then rescan on settled page changes. No result from
// this path is posted to FastAPI or the VLM.
const LOCAL_PRIVACY_AUTO_SCAN = true;

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

function getCategory(element) {
  const tag = element.tagName.toLowerCase();

  if (tag === "button") return "button";
  if (tag === "input") return "input";
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (tag === "a") return "link";
  if (element.isContentEditable) return "contenteditable";
  if (/^h[1-6]$/.test(tag)) return "heading";

  return tag;
}

function getAccessibilityInfo(element) {
  return {
    role: element.getAttribute("role") || null,
    ariaLabel: element.getAttribute("aria-label") || null,
    ariaLabelledBy: element.getAttribute("aria-labelledby") || null,
    ariaDescribedBy: element.getAttribute("aria-describedby") || null,
    ariaExpanded: element.getAttribute("aria-expanded") || null,
    ariaHasPopup: element.getAttribute("aria-haspopup") || null,
    ariaChecked: element.getAttribute("aria-checked") || null,
    ariaSelected: element.getAttribute("aria-selected") || null,
    tabIndex: element.tabIndex,
    title: element.getAttribute("title") || null,
    accessibleName:
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.value ||
      null,
    disabled: Boolean(element.disabled)
  };
}

function getLabelForElement(element) {
  if (element.id) {
    const label = document.querySelector(
      `label[for="${CSS.escape(element.id)}"]`
    );

    if (label) {
      return (
        label.innerText ||
        label.textContent ||
        ""
      ).trim();
    }
  }

  const parentLabel = element.closest("label");

  if (parentLabel) {
    return (
      parentLabel.innerText ||
      parentLabel.textContent ||
      ""
    ).trim();
  }

  return "";
}

function getDomElements() {
  const selectors = [
    "button",
    "input",
    "textarea",
    "select",
    "a[href]",
    "[contenteditable='true']",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "[role='button']",
    "[role='link']",
    "[role='textbox']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='tab']",
    "[role='menuitem']"
  ];

  const elements = Array.from(
    document.querySelectorAll(
      selectors.join(",")
    )
  );

  return elements
    .filter(isElementVisible)
    .map((element, index) => ({
      elementId:
        `element_${index + 1}`,
      tag:
        element.tagName.toLowerCase(),
      category:
        getCategory(element),
      type:
        element.getAttribute("type") ||
        null,
      id:
        element.id || null,
      name:
        element.getAttribute("name") ||
        null,
      autocomplete:
        element.getAttribute("autocomplete") ||
        null,
      text: (
        element.innerText ||
        element.value ||
        element.textContent ||
        ""
      )
        .trim()
        .slice(0, 500),
      placeholder:
        element.getAttribute(
          "placeholder"
        ) || null,
      label:
        getLabelForElement(element),
      rect:
        getElementRect(element),
      accessibility:
        getAccessibilityInfo(element)
    }));
}

function getVisibleText() {
  return (
    document.body?.innerText ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000);
}

function getForms() {
  return Array.from(
    document.querySelectorAll("form")
  )
    .filter(isElementVisible)
    .map((form, formIndex) => {
      const controls = Array.from(
        form.querySelectorAll(
          "input, textarea, select, button"
        )
      )
        .filter(isElementVisible)
        .map(
          (control, controlIndex) => ({
            controlId:
              `form_${formIndex + 1}_control_${controlIndex + 1}`,
            tag:
              control.tagName.toLowerCase(),
            category:
              getCategory(control),
            type:
              control.getAttribute(
                "type"
              ) || null,
            id:
              control.id || null,
            name:
              control.getAttribute(
                "name"
              ) || null,
            autocomplete:
              control.getAttribute(
                "autocomplete"
              ) || null,
            text: (
              control.innerText ||
              control.value ||
              control.textContent ||
              ""
            )
              .trim()
              .slice(0, 500),
            placeholder:
              control.getAttribute(
                "placeholder"
              ) || null,
            label:
              getLabelForElement(control),
            rect:
              getElementRect(control),
            accessibility:
              getAccessibilityInfo(control)
          })
        );

      return {
        formId:
          `form_${formIndex + 1}`,
        id:
          form.id || null,
        name:
          form.getAttribute(
            "name"
          ) || null,
        rect:
          getElementRect(form),
        controls
      };
    });
}

function getSensitiveInputElements() {
  return Array.from(
    document.querySelectorAll(
      "input, textarea, select, [contenteditable='true']"
    )
  )
    .filter(isElementVisible)
    .filter((element) => {
      if (!String(element.value || "").trim()) {
        return false;
      }

      const metadata = [
        element.type,
        element.name,
        element.id,
        element.autocomplete,
        element.placeholder,
        element.getAttribute(
          "aria-label"
        ),
        element.getAttribute("aria-labelledby"),
        element.getAttribute("role"),
        getLabelForElement(element),
        element.getAttribute("title")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return Boolean(classifySensitiveText(metadata, element.value));
    })
    .map((element) => {
      const metadata = [
        element.type, element.name, element.id, element.autocomplete,
        element.placeholder, element.getAttribute("aria-label"),
        getLabelForElement(element)
      ].filter(Boolean).join(" ");
      const detection = classifySensitiveText(metadata, element.value);
      const rect = getElementRect(element);
      const valueRect = getInputValueRect(element, rect);
      return {
        source: "input",
        tag: element.tagName.toLowerCase(),
        type: element.type || null,
        category: detection?.category || "PII",
        severity: detection?.severity || "HIGH",
        reason: detection?.reason || "input metadata",
        text: "[REDACTED]",
        rect: valueRect
      };
    });
}

function getInputValueRect(element, inputRect) {
  const style = window.getComputedStyle(element);
  const value = String(element.value || "");
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;

  // A textarea can wrap across multiple lines. Its whole editable interior is
  // the sensitive value; measuring it like a single-line input leaves text
  // visible and places the blackout on an empty line below it.
  if (element instanceof HTMLTextAreaElement || element.isContentEditable) {
    return {
      x: Math.round(inputRect.x + paddingLeft),
      y: Math.round(inputRect.y + paddingTop),
      width: Math.max(1, Math.round(inputRect.width - paddingLeft - paddingRight)),
      height: Math.max(1, Math.round(inputRect.height - paddingTop - paddingBottom)),
    };
  }

  const renderedValue = element.type === "password"
    ? "*".repeat(value.length)
    : value;
  const measurementCanvas = document.createElement("canvas");
  const measurementContext = measurementCanvas.getContext("2d");
  const font = [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily
  ].filter(Boolean).join(" ");

  if (measurementContext) {
    measurementContext.font = font;
  }

  const measuredWidth = measurementContext
    ? measurementContext.measureText(renderedValue).width
    : value.length * 8;
  const textIndent = parseFloat(style.textIndent) || 0;
  const availableWidth = Math.max(
    1,
    inputRect.width - paddingLeft - paddingRight - textIndent - 4
  );
  const valueWidth = Math.min(
    availableWidth,
    Math.max(8, Math.ceil(measuredWidth) + 4)
  );
  const lineHeight = parseFloat(style.lineHeight);
  const fontSize = parseFloat(style.fontSize) || 16;
  const valueHeight = Math.min(
    inputRect.height - 2,
    Math.max(10, Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.25)
  );

  return {
    x: Math.round(inputRect.x + paddingLeft + textIndent),
    y: Math.round(inputRect.y + (inputRect.height - valueHeight) / 2),
    width: Math.max(1, Math.round(valueWidth)),
    height: Math.max(1, Math.round(valueHeight))
  };
}

function getInputTextMatchRect(element, inputRect, start, end) {
  const value = String(element.value || "");
  const style = window.getComputedStyle(element);
  const prefix = value.slice(0, start);
  const match = value.slice(start, end);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const textIndent = parseFloat(style.textIndent) || 0;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context) {
    context.font = [style.fontStyle, style.fontVariant, style.fontWeight, style.fontSize, style.fontFamily]
      .filter(Boolean).join(" ");
  }
  const widthOf = (text) => context ? context.measureText(text).width : text.length * 8;
  const lineHeight = parseFloat(style.lineHeight);
  const fontSize = parseFloat(style.fontSize) || 16;
  const height = Math.min(
    inputRect.height - 2,
    Math.max(10, Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.25)
  );
  const availableWidth = Math.max(1, inputRect.width - paddingLeft - paddingRight - textIndent - 4);

  // Google uses a one-line textarea for its search box. Measure only the
  // matched person name there instead of treating the textarea as a sensitive
  // multi-line field and blacking out the complete search area.
  return {
    x: Math.round(inputRect.x + paddingLeft + textIndent + Math.min(widthOf(prefix), availableWidth)),
    y: Math.round(inputRect.y + (inputRect.height - height) / 2),
    width: Math.max(1, Math.round(Math.min(widthOf(match) + 4, availableWidth))),
    height: Math.round(height),
  };
}

const PII_RULES = [
  { category: "PASSWORD", severity: "CRITICAL", reason: "input metadata", keywords: ["password", "passcode", "passwd"] },
  { category: "OTP", severity: "CRITICAL", reason: "input metadata or pattern", keywords: ["otp", "one time password", "verification code", "security code"] },
  { category: "API_KEY", severity: "CRITICAL", reason: "key/token metadata or pattern", keywords: ["api key", "api token", "access key"] },
  { category: "AUTH_TOKEN", severity: "CRITICAL", reason: "token metadata or pattern", keywords: ["auth token", "access token", "refresh token", "bearer", "jwt", "session token"] },
  { category: "CARD_NUMBER", severity: "CRITICAL", reason: "card metadata or pattern", keywords: ["credit card", "debit card", "card number", "card no", "cvv", "cvc"] },
  { category: "EMAIL", severity: "HIGH", reason: "email metadata or pattern", keywords: ["email", "e-mail"] },
  { category: "PHONE", severity: "HIGH", reason: "phone metadata or pattern", keywords: ["phone", "mobile", "telephone", "tel"] },
  { category: "GOVERNMENT_ID", severity: "HIGH", reason: "identity metadata or pattern", keywords: ["aadhaar", "aadhar", "pan number", "passport", "national id", "identity number"] },
  { category: "BANK_ACCOUNT", severity: "HIGH", reason: "bank metadata or pattern", keywords: ["bank account", "account number", "ifsc"] },
  { category: "EMPLOYEE_ID", severity: "MEDIUM", reason: "employee metadata", keywords: ["employee id", "employee number", "staff id", "worker id"] },
  { category: "PERSON", severity: "HIGH", reason: "name metadata", keywords: ["full name", "legal name", "first name", "last name", "person name", "customer name", "account holder", "account holder name", "beneficiary name"] },
  { category: "ADDRESS", severity: "HIGH", reason: "address metadata", keywords: ["address", "street", "city", "postal code", "zip code"] }
];

function classifySensitiveText(metadata, value = "") {
  const source = `${metadata || ""} ${value || ""}`.toLowerCase();
  const patterns = [
    ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["PHONE", /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/],
    ["CARD_NUMBER", /\b(?:\d[ -]*?){13,19}\b/],
    // Aadhaar is frequently shown without a label and may be contiguous,
    // space-separated, or hyphen-separated. Do not require word boundaries:
    // a digit is a safer boundary for the contiguous 12-digit form.
    ["GOVERNMENT_ID", /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)|\b[A-Z]{5}\d{4}[A-Z]\b/i],
    ["AUTH_TOKEN", /\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{10,}\b/],
    ["API_KEY", /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/i]
    , ["IFSC", /\b[A-Z]{4}0[A-Z0-9]{6}\b/i]
    , ["UPI_ID", /\b[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,}\b/i]
    , ["ADDRESS", /\b\d{1,6}\s+[A-Za-z][A-Za-z .'-]{2,}\s(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|nagar|colony|sector|block|apartment|flat)\b/i]
    , ["ADDRESS", /\b(?:zip|postal code|pincode)\s*[:#-]?\s*\d{5,6}\b/i]
    , ["PERSON", /\b(?:mr|mrs|ms|dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/]
  ];
  for (const [category, pattern] of patterns) {
    if (pattern.test(String(value || metadata))) {
      const rule = PII_RULES.find((item) => item.category === category);
      return { category, severity: rule?.severity || "HIGH", reason: "validated pattern" };
    }
  }
  for (const rule of PII_RULES) {
    if (rule.keywords.some((keyword) => source.includes(keyword))) {
      return { category: rule.category, severity: rule.severity, reason: rule.reason };
    }
  }
  return null;
}

function containsPII(text) {
  return Boolean(classifySensitiveText("", text));
}

function sanitizeText(text) {
  if (!text) {
    return "";
  }

  let sanitizedText =
    String(text);

  const patterns = [
    ["PASSWORD", /\b(?:password|passcode|passwd)\s*[:=\-]?\s*[^\s,;]+/gi],
    ["OTP", /\b(?:otp|verification code|security code)\s*[:=\-]?\s*[^\s,;]+/gi],
    ["AUTH_TOKEN", /\b(?:bearer|auth token|access token|refresh token|jwt)\s*[:=\-]?\s*[^\s,;]+/gi],
    ["EMPLOYEE_ID", /\b(?:employee id|employee number|staff id|worker id)\s*[:=\-]?\s*[^\s,;]+/gi],
    ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ["PHONE", /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g],
    ["CARD_NUMBER", /\b(?:\d[ -]*?){13,19}\b/g],
    ["GOVERNMENT_ID", /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)|\b[A-Z]{5}\d{4}[A-Z]\b/gi],
    ["API_KEY", /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/gi]
    , ["IFSC", /\b[A-Z]{4}0[A-Z0-9]{6}\b/g]
    , ["UPI_ID", /\b[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,}\b/g]
    , ["ADDRESS", /\b\d{1,6}\s+[A-Za-z][A-Za-z .'-]{2,}\s(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|nagar|colony|sector|block|apartment|flat)\b/gi]
    , ["ADDRESS", /\b(?:zip|postal code|pincode)\s*[:#-]?\s*\d{5,6}\b/gi]
    , ["PERSON", /\b(?:mr|mrs|ms|dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g]
  ];
  patterns.forEach(([category, pattern]) => {
    sanitizedText = sanitizedText.replace(pattern, `<${category}_1>`);
  });

  return sanitizedText;
}

function sanitizePageUrl(url) {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.username = "";
    parsedUrl.password = "";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return "<URL_REDACTED>";
  }
}

function getTextRedactionMatches(text) {
  const patterns = [
    ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ["PHONE", /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g],
    ["GOVERNMENT_ID", /(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)|\b[A-Z]{5}\d{4}[A-Z]\b/gi],
    ["CARD_NUMBER", /\b(?:\d[ -]*?){13,19}\b/g],
    ["AUTH_TOKEN", /\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{10,}\b/g],
    ["API_KEY", /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/gi]
    , ["IFSC", /\b[A-Z]{4}0[A-Z0-9]{6}\b/g]
    , ["UPI_ID", /\b[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,}\b/g]
    , ["ADDRESS", /\b\d{1,6}\s+[A-Za-z][A-Za-z .'-]{2,}\s(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|nagar|colony|sector|block|apartment|flat)\b/gi]
    , ["ADDRESS", /\b(?:zip|postal code|pincode)\s*[:#-]?\s*\d{5,6}\b/gi]
    , ["PERSON", /\b(?:mr|mrs|ms|dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g]
  ];
  const matches = [];

  for (const [category, pattern] of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const detection = classifySensitiveText(category, match[0]);
      if (detection) {
        matches.push({
          value: match[0],
          category: detection.category,
          severity: detection.severity,
          start: match.index,
          end: match.index + match[0].length
        });
      }
      if (!pattern.global) {
        break;
      }
    }
  }

  return matches;
}

function getTextRangeRect(textNode, start, end) {
  if (!textNode || typeof document.createRange !== "function") {
    return null;
  }

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rects = Array.from(range.getClientRects());
  if (rects.length === 0) {
    return null;
  }

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top))
  };
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

  const detections = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );
  let textNode;

  while ((textNode = walker.nextNode())) {
    const parent = textNode.parentElement;
    if (!parent || excludedTags.has(parent.tagName) || !isElementVisible(parent)) {
      continue;
    }

    const text = textNode.textContent || "";
    for (const match of getTextRedactionMatches(text)) {
      const rect = getTextRangeRect(textNode, match.start, match.end);
      if (!rect) {
        continue;
      }
      detections.push({
        source: "text",
        tag: parent.tagName.toLowerCase(),
        category: match.category,
        severity: match.severity,
        reason: "exact visible PII text match",
        text: match.value,
        rect
      });
    }
  }

  return detections;
}

const SENSITIVE_VALUE_LABELS = [
  ["PERSON", /\b(?:full\s*name|legal\s*name|customer\s*name|account\s*holder(?:\s*name)?|beneficiary\s*name)\b/i],
  ["PHONE", /\b(?:mobile|phone|telephone|contact)\b/i],
  ["ADDRESS", /\b(?:residential|mailing|home)?\s*address\b/i],
  ["DATE_OF_BIRTH", /\b(?:date\s*of\s*birth|dob|birthdate)\b/i],
  ["EMAIL", /\b(?:email|e-mail)\b/i],
  ["BANK_ACCOUNT", /\b(?:bank\s*account|account\s*(?:no|number))\b/i],
  ["IFSC", /\bifsc(?:\s*code)?\b/i],
  ["UPI_ID", /\bupi(?:\s*id)?\b/i],
  ["CARD_NUMBER", /\b(?:credit|debit)?\s*card(?:\s*(?:no|number))?\b/i],
  ["GOVERNMENT_ID", /\b(?:pan|aadhaar|aadhar|passport)\b/i],
  ["API_KEY", /\b(?:api\s*(?:key|token)|access\s*token)\b/i],
];

function getSensitiveLabeledValueElements() {
  const candidates = Array.from(document.querySelectorAll("tr, [role='row'], li, dl, p, div"));
  return candidates.flatMap((element) => {
    if (!isElementVisible(element)) return [];
    const rect = getElementRect(element);
    if (rect.width < 80 || rect.width > window.innerWidth * 0.95 || rect.height > 90) return [];
    const text = (element.innerText || "").replace(/\s+/g, " ").trim();
    const match = SENSITIVE_VALUE_LABELS.find(([, labelPattern]) => labelPattern.test(text));
    if (!match) return [];

    // Find the visual text node for the value. Never use the row/container
    // rectangle: doing so blacks out whole cards instead of just the field.
    const [category, labelPattern] = match;
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && isElementVisible(node.parentElement) && node.textContent?.trim()) {
        nodes.push(node);
      }
    }
    const labelNode = nodes.find((textNode) => labelPattern.test(textNode.textContent || ""));
    const valueNode = nodes.find((textNode) => {
      const value = (textNode.textContent || "").trim();
      return textNode !== labelNode && value.length >= 2 && !labelPattern.test(value);
    });

    if (valueNode) {
      const value = valueNode.textContent || "";
      const valueRect = getTextRangeRect(valueNode, 0, value.length);
      return valueRect ? [{
        source: "labelled-value",
        tag: valueNode.parentElement?.tagName.toLowerCase() || "text",
        category,
        severity: "HIGH",
        reason: "sensitive structured field label",
        text: "[REDACTED]",
        rect: valueRect,
      }] : [];
    }

    // Some pages put label and value in one text node. Redact only the text
    // following the label rather than the complete row.
    if (labelNode) {
      const value = labelNode.textContent || "";
      const labelMatch = value.match(labelPattern);
      const start = (labelMatch?.index ?? 0) + (labelMatch?.[0].length ?? 0);
      const suffix = value.slice(start);
      // Only accept an inline value when the page explicitly separates it from
      // its label. Without this guard, "Bank Account Number" would redact the
      // harmless trailing word "Number".
      const separator = suffix.match(/^\s*[:\-–—]\s*/);
      if (!separator) return [];
      const absoluteStart = start + separator[0].length;
      const valueRect = absoluteStart < value.length
        ? getTextRangeRect(labelNode, absoluteStart, value.length)
        : null;
      return valueRect ? [{
        source: "labelled-value",
        tag: labelNode.parentElement?.tagName.toLowerCase() || "text",
        category,
        severity: "HIGH",
        reason: "sensitive structured field label",
        text: "[REDACTED]",
        rect: valueRect,
      }] : [];
    }
    return [];
  });
}

function isPersonNameCandidate(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  // Require at least two name-like words. This deliberately avoids treating
  // ordinary labels such as "Customer Information" as a person.
  return /^[A-Za-z][A-Za-z'’-]{1,}(?:\s+[A-Za-z][A-Za-z'’-]{1,}){1,3}$/.test(normalized)
    ? normalized
    : null;
}

function getKnownSensitivePersonNames() {
  const names = new Set();

  // Inputs are the most reliable source: their associated label has already
  // identified the value as a name, even when the same name later appears in
  // an unstructured sentence elsewhere on the page.
  for (const element of document.querySelectorAll("input, textarea, [contenteditable='true']")) {
    if (!isElementVisible(element)) continue;
    const value = element.isContentEditable ? element.innerText : element.value;
    const metadata = [
      element.type,
      element.name,
      element.id,
      element.autocomplete,
      element.placeholder,
      element.getAttribute("aria-label"),
      getLabelForElement(element),
    ].filter(Boolean).join(" ");
    if (classifySensitiveText(metadata, value)?.category === "PERSON") {
      const name = isPersonNameCandidate(value);
      if (name) names.add(name);
    }
  }

  // Also support table/card layouts such as "Full Name | Rohan Mehta".
  for (const element of document.querySelectorAll("tr, [role='row'], li, dl, p, div")) {
    if (!isElementVisible(element)) continue;
    const rect = getElementRect(element);
    if (rect.width < 80 || rect.width > window.innerWidth * 0.95 || rect.height > 90) continue;
    const text = (element.innerText || "").replace(/\s+/g, " ").trim();
    const nameLabel = SENSITIVE_VALUE_LABELS.find(
      ([category, labelPattern]) => category === "PERSON" && labelPattern.test(text)
    )?.[1];
    if (!nameLabel) continue;
    const nodes = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.textContent?.replace(/\s+/g, " ").trim();
      if (value && node.parentElement && isElementVisible(node.parentElement)) nodes.push(value);
    }
    for (const value of nodes) {
      if (!nameLabel.test(value)) {
        const name = isPersonNameCandidate(value);
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

function getRepeatedSensitivePersonNameElements() {
  const names = getKnownSensitivePersonNames();
  if (names.length === 0) return [];
  const expression = new RegExp(
    `\\b(?:${names.map(escapeRegExp).join("|")})\\b`,
    "gi"
  );
  const detections = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const parent = textNode.parentElement;
    if (!parent || !isElementVisible(parent) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    const text = textNode.textContent || "";
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(text)) !== null) {
      const rect = getTextRangeRect(textNode, match.index, match.index + match[0].length);
      if (!rect) continue;
      detections.push({
        source: "known-person-name",
        tag: parent.tagName.toLowerCase(),
        category: "PERSON",
        severity: "HIGH",
        reason: "known sensitive name repeated in visible text",
        text: "[REDACTED]",
        rect,
      });
    }
  }
  return detections;
}

function getPersonQuery() {
  const queryInput = Array.from(document.querySelectorAll(
    // Google Search currently uses textarea[name=q] on many layouts; only
    // checking input elements meant person-query image redaction never ran.
    "input[name='q'], textarea[name='q'], input[type='search'], textarea[aria-label*='search' i], input[aria-label*='search' i]"
  )).find((input) => isElementVisible(input) && input.value?.trim());
  const query = queryInput?.value?.trim().replace(/\s+/g, " ");

  if (!query) return null;
  const words = query.split(" ");

  // Direct personal-name query, e.g. "max verstappen".
  if (/^[A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){1,2}$/.test(query)) {
    return query;
  }

  // A common Google Images query contains a person followed by a topic, e.g.
  // "max verstappen and car red bull". Infer only the leading two-word name
  // when Google already renders that same phrase as a title/caption in page
  // text. This avoids blacking out an arbitrary part of a generic query.
  if (words.length < 3) return null;
  const candidate = words.slice(0, 2).join(" ");
  const titleCaseCandidate = new RegExp(
    `\\b${words.slice(0, 2).map((word) => {
      const normalized = word.toLowerCase();
      return `(?:${escapeRegExp(normalized[0].toUpperCase() + normalized.slice(1))}|${escapeRegExp(normalized.toUpperCase())})`;
    }).join("\\s+")}\\b`,
    "g"
  );
  const visibleText = document.body?.innerText || "";
  return titleCaseCandidate.test(visibleText) ? candidate : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getQueryPersonSensitiveElements() {
  const query = getPersonQuery();
  if (!query) return [];

  const detections = [];
  const exactName = new RegExp(`\\b${escapeRegExp(query)}\\b`, "gi");
  const addDetection = (rect, source, text, category = "PERSON") => {
    if (!rect || rect.width < 1 || rect.height < 1) return;
    detections.push({
      source,
      tag: "person-query",
      category,
      severity: "HIGH",
      reason: "exact personal-name query match",
      text,
      rect,
    });
  };

  // Redact only the name characters in the search field—not the whole input
  // or textarea—and every exact name occurrence in image captions/results.
  for (const input of document.querySelectorAll("input[name='q'], textarea[name='q'], input[type='search'], textarea[aria-label*='search' i], input[aria-label*='search' i]")) {
    const inputValue = String(input.value || "");
    const start = inputValue.toLowerCase().indexOf(query.toLowerCase());
    if (isElementVisible(input) && start >= 0) {
      addDetection(
        getInputTextMatchRect(input, getElementRect(input), start, start + query.length),
        "person-query-input",
        query
      );
    }
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const parent = textNode.parentElement;
    if (!parent || !isElementVisible(parent) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    const value = textNode.textContent || "";
    exactName.lastIndex = 0;
    let match;
    while ((match = exactName.exec(value)) !== null) {
      addDetection(getTextRangeRect(textNode, match.index, match.index + match[0].length), "person-query-text", match[0]);
    }
  }

  return detections;
}

function getGitHubProfileIdentityElements() {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (window.location.hostname !== "github.com" || pathParts.length !== 1) return [];

  const detections = [];
  for (const element of document.querySelectorAll("[itemprop='name'], [itemprop='additionalName']")) {
    if (!isElementVisible(element)) continue;
    const textNode = Array.from(element.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
    );
    const value = textNode?.textContent || element.textContent || "";
    const rect = textNode
      ? getTextRangeRect(textNode, 0, value.length)
      : getElementRect(element);
    if (!rect || value.trim().length < 2) continue;
    detections.push({
      source: "github-profile-identity",
      tag: element.tagName.toLowerCase(),
      category: "PERSON",
      severity: "HIGH",
      reason: "public profile identity",
      text: "[REDACTED]",
      rect,
    });
  }
  return detections;
}

function getGitHubProfileAvatarElements() {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  if (window.location.hostname !== "github.com" || pathParts.length !== 1) return [];

  // GitHub supplies profile-avatar semantics directly. This provides a precise
  // privacy fallback when a vision model misses an otherwise obvious portrait;
  // it applies only to the profile's own avatar, never to repository artwork.
  return Array.from(document.querySelectorAll(
    "img.avatar-user, [itemprop='image'] img, img[alt*='Avatar' i]"
  )).flatMap((image) => {
    if (!isElementVisible(image)) return [];
    const rect = getElementRect(image);
    if (rect.width < 80 || rect.height < 80) return [];
    return [{
      source: "github-profile-avatar",
      tag: "img",
      category: "FACE",
      severity: "HIGH",
      reason: "GitHub profile avatar",
      text: "[FACE_REDACTED]",
      rect,
    }];
  });
}

function getSensitiveElements() {
  return [
    ...getSensitiveInputElements(),
    ...getSensitiveTextElements(),
    ...getSensitiveLabeledValueElements(),
    ...getRepeatedSensitivePersonNameElements(),
    ...getQueryPersonSensitiveElements(),
    ...getGitHubProfileIdentityElements(),
    ...getGitHubProfileAvatarElements()
  ];
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
        window.innerHeight,
      devicePixelRatio:
        window.devicePixelRatio,
      scrollX:
        window.scrollX,
      scrollY:
        window.scrollY,
      screenWidth:
        window.screen.width,
      screenHeight:
        window.screen.height
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

function decideContextRoute(pageContext) {
  const visualOnlyElements = document.querySelectorAll(
    "canvas, svg, video, iframe, object, embed, img, [style*='background-image']"
  );
  const hasVisibleVisualContent = Array.from(visualOnlyElements)
    .some(isElementVisible);

  return pageContext.visibleText && !hasVisibleVisualContent
    ? "DOM_ONLY"
    : "DOM + SCREENSHOT";
}

function sanitizeDomElement(
  element,
  sensitiveElements
) {
  const elementMetadata = [
    element.type,
    element.name,
    element.id,
    element.placeholder,
    element.label,
    element.accessibility?.ariaLabel,
    element.accessibility?.accessibleName
  ].filter(Boolean).join(" ");
  const detection = classifySensitiveText(
    elementMetadata,
    element.text
  );
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
          ) || (
            sensitiveElement.source === "input" &&
            sensitiveRect.x >= elementRect.x &&
            sensitiveRect.y >= elementRect.y &&
            sensitiveRect.x + sensitiveRect.width <= elementRect.x + elementRect.width &&
            sensitiveRect.y + sensitiveRect.height <= elementRect.y + elementRect.height
        );
      }
    );

  const sanitizedElement = {
    ...element
  };

  sanitizedElement.text =
    isSensitive ||
    containsPII(element.text)
      ? `<${detection?.category || "PII"}_1>`
      : sanitizeText(
          element.text
        );

  sanitizedElement.placeholder =
    containsPII(
      element.placeholder
    )
      ? `<${classifySensitiveText(elementMetadata, element.placeholder)?.category || "PII"}_1>`
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

          const isSensitive = [
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
          ].some(
            (keyword) =>
              metadata.includes(keyword)
          );
          const detection = classifySensitiveText(
            metadata,
            control.text
          );

          return {
            ...control,

            text:
              isSensitive ||
              containsPII(
                control.text
              )
                ? `<${detection?.category || "PII"}_1>`
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
        sanitizePageUrl(pageContext.url),
      title:
        sanitizeText(pageContext.title),
      viewport:
        pageContext.viewport
    },

    visualContext: {
      sanitizedScreenshot
    },

    domContext: {
      visibleText:
        sanitizeVisibleText(
          pageContext.visibleText
        ),

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

      redactedRegions:
        pageContext.sensitiveElements.map(
          (element) => ({
            source:
              element.source,
            rect:
              element.rect
          })
        ),

      redactedRegionCount:
        pageContext.sensitiveElements
          .length,

      rawScreenshotIncluded:
        false
    },

    timestamp:
      pageContext.timestamp
  };
}

const CRITICAL_REDACTION_CATEGORIES = new Set([
  "PASSWORD",
  "OTP",
  "PIN",
  "API_KEY",
  "AUTH_TOKEN",
  "CARD_NUMBER",
  "CREDIT_CARD",
  "BANK_ACCOUNT",
  "GOVERNMENT_ID",
  "AADHAAR",
  "PAN",
  "PASSPORT",
  "CVV",
  "SECRET_KEY"
]);

function getRedactionStrategy(category) {
  return category === "FACE" ? "BLUR" : "BLACKOUT";
}

function createRedactionMap(sensitiveElements) {
  return sensitiveElements
    .filter((element) => element?.rect?.width > 0 && element?.rect?.height > 0)
    .map((element) => ({
      type: element.category || "PII",
      category: element.category || "PII",
      severity: element.severity || "HIGH",
      source: [element.source || "DOM"],
      boundingBox: element.rect,
      strategy: getRedactionStrategy(element.category)
    }));
}

function assertSanitizedScreenshot(dataUrl, redactionMap) {
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:image/png") ||
    !Array.isArray(redactionMap)
  ) {
    throw new Error("Privacy gate blocked an unverified screenshot");
  }

  for (const detection of redactionMap) {
    const box = detection.boundingBox;
    if (
      !box ||
      !Number.isFinite(box.x) ||
      !Number.isFinite(box.y) ||
      !Number.isFinite(box.width) ||
      !Number.isFinite(box.height) ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      throw new Error("Privacy gate blocked an invalid redaction map");
    }
  }
}

function redactScreenshot(
  dataUrl,
  sensitiveElements
) {
  return new Promise(
    (resolve, reject) => {
      const image = new Image();

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

        const sourceCanvas =
          document.createElement("canvas");
        sourceCanvas.width = canvas.width;
        sourceCanvas.height = canvas.height;
        sourceCanvas.getContext("2d")?.drawImage(
          image,
          0,
          0
        );

        const scaleX =
          image.width /
          window.innerWidth;

        const scaleY =
          image.height /
          window.innerHeight;

        sensitiveElements.forEach(
          (element) => {
            const rect = element.rect;

            if (!rect || rect.width <= 0 || rect.height <= 0) {
              return;
            }

            const margin = Math.min(
              8,
              Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.08))
            );
            const imageRect = element.imageRect;
            const x1 = Math.max(0, Math.round(
              imageRect ? imageRect.x - margin : (rect.x - margin) * scaleX
            ));
            const y1 = Math.max(0, Math.round(
              imageRect ? imageRect.y - margin : (rect.y - margin) * scaleY
            ));
            const x2 = Math.min(
              canvas.width,
              Math.round(imageRect
                ? imageRect.x + imageRect.width + margin
                : (rect.x + rect.width + margin) * scaleX)
            );
            const y2 = Math.min(
              canvas.height,
              Math.round(imageRect
                ? imageRect.y + imageRect.height + margin
                : (rect.y + rect.height + margin) * scaleY)
            );
            const width = x2 - x1;
            const height = y2 - y1;

            if (width <= 0 || height <= 0) {
              return;
            }

            if (getRedactionStrategy(element.category) === "BLACKOUT") {
              context.fillStyle = "#000000";
              context.fillRect(x1, y1, width, height);
              return;
            }

            const blurredRegion = document.createElement("canvas");
            blurredRegion.width = width;
            blurredRegion.height = height;
            const blurredContext = blurredRegion.getContext("2d");

            if (!blurredContext) {
              return;
            }

            blurredContext.filter = `blur(${Math.min(18, Math.max(4, Math.round(Math.max(width, height) * 0.08)))}px)`;
            blurredContext.drawImage(
              sourceCanvas,
              x1,
              y1,
              width,
              height,
              0,
              0,
              width,
              height
            );
            context.drawImage(blurredRegion, x1, y1);
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

function viewportRectFromImageRect(imageRect, imageWidth, imageHeight) {
  return {
    x: Math.round(imageRect.x * window.innerWidth / imageWidth),
    y: Math.round(imageRect.y * window.innerHeight / imageHeight),
    width: Math.max(1, Math.round(imageRect.width * window.innerWidth / imageWidth)),
    height: Math.max(1, Math.round(imageRect.height * window.innerHeight / imageHeight)),
  };
}

/**
 * Fully sanitizes visible page text for any context where it may leave the
 * browser (model payload, console log). Applies:
 *   1. Pattern-based PII redaction (sanitizeText) — emails, phone, govt IDs…
 *   2. Structured-field name labels (e.g. "Full Name: John Smith")
 *   3. DOB / address label patterns
 *   4. Known person names harvested from form inputs
 *   5. Active search-query person name (getPersonQuery)
 */
function sanitizeVisibleText(text) {
  let sanitizedText = sanitizeText(text)
    .replace(
      /\b(?:full|legal|customer|account\s+holder|beneficiary|profile)\s+name\s*[:\-]?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g,
      "<PERSON_1>"
    )
    .replace(
      /\b(?:date\s+of\s+birth|dob|birth\s+date)\s*[:\-]?\s*(?:\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}\s+[A-Za-z]+\s+\d{2,4})\b/gi,
      "<DATE_OF_BIRTH_1>"
    )
    .replace(
      /\b(?:residential|current|home|mailing)?\s*address\s*[:\-]?\s*[^\n]{1,240}/gi,
      "<ADDRESS_1>"
    );

  // Redact person names identified through labeled form inputs.
  for (const name of getKnownSensitivePersonNames()) {
    sanitizedText = sanitizedText.replace(
      new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"),
      "<PERSON_1>"
    );
  }

  // Redact person names identified through an active search query so that
  // the name is not leaked in the text payload even when no form input
  // carries a "full name" label (e.g. Google Images person search).
  const queryName = getPersonQuery();
  if (queryName) {
    sanitizedText = sanitizedText.replace(
      new RegExp(`\\b${escapeRegExp(queryName)}\\b`, "gi"),
      "<PERSON_1>"
    );
  }

  return sanitizedText;
}

// Kept for backward compatibility — delegates to the unified helper.
function getConsoleSafeScreenText(text) {
  return sanitizeVisibleText(text);
}

function logFinalSanitizedScreenContent(pageContext, redactionMap) {
  const categories = [...new Set(redactionMap.map((region) => region.category))];
  console.log("[VPBA privacy] Final sanitized screen content:", {
    visibleText: sanitizeVisibleText(pageContext.visibleText),
    redactedRegionCount: redactionMap.length,
    redactedCategories: categories,
  });
}

function publishSanitizedPreview(pageContext, sanitizedScreenshot, label) {
  // Ephemeral side-panel inspection only: no storage, downloads, or raw image.
  chrome.runtime.sendMessage({
    type: "VPBA_SANITIZED_PREVIEW",
    preview: {
      label,
      sanitizedText: getConsoleSafeScreenText(pageContext.visibleText),
      sanitizedImage: sanitizedScreenshot,
    },
  }).catch(() => {});
}

// This is the only screenshot preparation path used by the extension. Model
// input remains in the browser, while this function returns only a redacted
// image and non-sensitive detection summaries for later server communication.
async function prepareClientSanitizedCapture(pageContext, screenshot) {
  const localVision = await inspectScreenshotLocally(screenshot, classifySensitiveText);
  const imageWidth = localVision.image.width;
  const imageHeight = localVision.image.height;
  const modelSensitiveElements = localVision.regions.map((region) => ({
    ...region,
    imageRect: region.rect,
    rect: viewportRectFromImageRect(region.rect, imageWidth, imageHeight),
  }));
  const protectedContext = {
    ...pageContext,
    sensitiveElements: [...pageContext.sensitiveElements, ...modelSensitiveElements],
  };
  const sanitizedScreenshot = await redactScreenshot(screenshot, protectedContext.sensitiveElements);
  const redactionMap = createRedactionMap(protectedContext.sensitiveElements);
  assertSanitizedScreenshot(sanitizedScreenshot, redactionMap);

  const analysis = {
    texts: [],
    regions: localVision.regions.map((region) => ({
      category: region.category,
      bounding_box: region.rect,
    })),
    objects: localVision.visualContext.objects.map((object) => ({
      label: object.label,
      confidence: object.score,
      bounding_box: object.rect,
    })),
    detection_summary: {
      provider: localVision.visualContext.provider,
      facesDetected: localVision.visualContext.facesDetected,
      faceDetectionFailed: localVision.visualContext.faceDetectionFailed,
      objectsDetected: localVision.visualContext.objects.length,
      ocrPiiDetected: localVision.visualContext.ocrPiiDetected,
    },
    image: { width: imageWidth, height: imageHeight },
  };
  // The raw capture is intentionally held only for this local redaction step.
  // This is the sole extension console entry and contains no image data.
  logFinalSanitizedScreenContent(protectedContext, redactionMap);

  return {
    pageContext: protectedContext,
    sanitizedScreenshot,
    redactionMap,
    analysis,
  };
}

function sendSanitizedScreenshotForAnalysis(
  sanitizedScreenshot,
  redactionRegions,
  privacyProof
) {
  return new Promise(
    (resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
        {
          type:
            "SEND_SANITIZED_FOR_ANALYSIS",

          screenshot:
            sanitizedScreenshot,

          redactionRegions,

          privacyProof
        },
        (analysisResponse) => {
          if (
            chrome.runtime.lastError
          ) {
            reject(
              new Error(
                chrome.runtime.lastError
                  .message
              )
            );

            return;
          }

          if (
            !analysisResponse?.success
          ) {
            reject(
              new Error(
                analysisResponse?.error ||
                "Sanitized screenshot analysis failed"
              )
            );

            return;
          }

          resolve(
            analysisResponse.analysis
          );
        }
        );
      } catch (error) {
        reject(new Error(getRuntimeErrorMessage(error)));
      }
    }
  );
}

function captureVisibleScreenshot() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.success) {
        reject(new Error(response?.error || "Screenshot capture failed"));
        return;
      }
      resolve(response.screenshot);
    });
  });
}

function getRuntimeErrorMessage(error) {
  const message = error?.message || String(error);
  if (message.toLowerCase().includes("extension context invalidated")) {
    return "Extension was reloaded; refresh this page before capturing again";
  }
  return message;
}

function getAnalysisRect(item) {
  if (!item) {
    return null;
  }

  const box =
    item.bounding_box ||
    item.boundingBox ||
    item.box ||
    item.rect ||
    item;

  if (
    typeof box.x === "number" &&
    typeof box.y === "number"
  ) {
    const width =
      box.width ??
      (
        typeof box.x2 ===
        "number"
          ? box.x2 - box.x
          : null
      );

    const height =
      box.height ??
      (
        typeof box.y2 ===
        "number"
          ? box.y2 - box.y
          : null
      );

    if (
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return {
        x:
          box.x,
        y:
          box.y,
        width,
        height
      };
    }
  }

  if (
    typeof box.x1 === "number" &&
    typeof box.y1 === "number" &&
    typeof box.x2 === "number" &&
    typeof box.y2 === "number"
  ) {
    return {
      x:
        box.x1,
      y:
        box.y1,
      width:
        box.x2 - box.x1,
      height:
        box.y2 - box.y1
    };
  }

  return null;
}

function scaleAnalysisRect(
  rect,
  imageInfo,
  viewport
) {
  if (!rect) {
    return null;
  }

  const imageWidth =
    imageInfo?.width;

  const imageHeight =
    imageInfo?.height;

  if (
    !imageWidth ||
    !imageHeight ||
    !viewport?.width ||
    !viewport?.height
  ) {
    return rect;
  }

  return {
    x:
      rect.x *
      (
        viewport.width /
        imageWidth
      ),

    y:
      rect.y *
      (
        viewport.height /
        imageHeight
      ),

    width:
      rect.width *
      (
        viewport.width /
        imageWidth
      ),

    height:
      rect.height *
      (
        viewport.height /
        imageHeight
      )
  };
}

function getIntersectionArea(
  rectA,
  rectB
) {
  const left =
    Math.max(
      rectA.x,
      rectB.x
    );

  const top =
    Math.max(
      rectA.y,
      rectB.y
    );

  const right =
    Math.min(
      rectA.x +
        rectA.width,
      rectB.x +
        rectB.width
    );

  const bottom =
    Math.min(
      rectA.y +
        rectA.height,
      rectB.y +
        rectB.height
    );

  const width =
    Math.max(
      0,
      right - left
    );

  const height =
    Math.max(
      0,
      bottom - top
    );

  return width * height;
}

function getOverlapScore(
  domRect,
  visualRect
) {
  const intersection =
    getIntersectionArea(
      domRect,
      visualRect
    );

  if (
    intersection <= 0
  ) {
    return 0;
  }

  const visualArea =
    visualRect.width *
    visualRect.height;

  if (
    visualArea <= 0
  ) {
    return 0;
  }

  return (
    intersection /
    visualArea
  );
}

function mapVisualItemsToDomElements(
  domElements,
  visualItems,
  imageInfo,
  viewport,
  minimumOverlap = 0.3
) {
  return visualItems.map(
    (item, itemIndex) => {
      const originalRect =
        getAnalysisRect(item);

      if (!originalRect) {
        return {
          ...item,

          visualItemId:
            item.visualItemId ||
            `visual_item_${itemIndex + 1}`,

          mapping: {
            mapped:
              false,

            matchedElements:
              []
          }
        };
      }

      const viewportRect =
        scaleAnalysisRect(
          originalRect,
          imageInfo,
          viewport
        );

      const matchedElements =
        domElements
          .map((element) => {
            const score =
              getOverlapScore(
                element.rect,
                viewportRect
              );

            return {
              element,
              score
            };
          })
          .filter(
            ({ score }) =>
              score >=
              minimumOverlap
          )
          .sort(
            (a, b) =>
              b.score -
              a.score
          )
          .map(
            ({
              element,
              score
            }) => ({
              elementId:
                element.elementId,

              tag:
                element.tag,

              category:
                element.category,

              text:
                element.text,

              score:
                Number(
                  score.toFixed(3)
                )
            })
          );

      return {
        ...item,

        visualItemId:
          item.visualItemId ||
          `visual_item_${itemIndex + 1}`,

        mapping: {
          mapped:
            matchedElements.length > 0,

          viewportRect,

          matchedElements
        }
      };
    }
  );
}

function addVisualMappings(
  domElements,
  analysis,
  page
) {
  const imageInfo =
    analysis.image || {};

  const viewport =
    page.viewport;

  const mappedTexts =
    mapVisualItemsToDomElements(
      domElements,
      analysis.texts || [],
      imageInfo,
      viewport
    );

  const mappedRegions =
    mapVisualItemsToDomElements(
      domElements,
      analysis.regions || [],
      imageInfo,
      viewport,
      0.2
    );

  const mappedObjects =
    mapVisualItemsToDomElements(
      domElements,
      analysis.objects || [],
      imageInfo,
      viewport,
      0.2
    );

  const domElementsWithVisualInfo =
    domElements.map(
      (element) => {
        const mappedTextsForElement =
          mappedTexts.filter(
            (item) =>
              item.mapping
                .matchedElements
                .some(
                  (match) =>
                    match.elementId ===
                    element.elementId
                )
          );

        const mappedRegionsForElement =
          mappedRegions.filter(
            (item) =>
              item.mapping
                .matchedElements
                .some(
                  (match) =>
                    match.elementId ===
                    element.elementId
                )
          );

        const mappedObjectsForElement =
          mappedObjects.filter(
            (item) =>
              item.mapping
                .matchedElements
                .some(
                  (match) =>
                    match.elementId ===
                    element.elementId
                )
          );

        return {
          ...element,

          visualMapping: {
            texts:
              mappedTextsForElement,

            regions:
              mappedRegionsForElement,

            objects:
              mappedObjectsForElement,

            hasVisualMatch:
              mappedTextsForElement.length >
                0 ||
              mappedRegionsForElement.length >
                0 ||
              mappedObjectsForElement.length >
                0
          }
        };
      }
    );

  return {
    domElementsWithVisualInfo,
    mappedTexts,
    mappedRegions,
    mappedObjects
  };
}

function createFinalLocalPerceptionOutput(
  finalPayload,
  analysis
) {
  const visualMappings =
    addVisualMappings(
      finalPayload
        .domContext
        .elements,
      analysis,
      finalPayload.page
    );

  const mappedInteractiveElements =
    visualMappings
      .domElementsWithVisualInfo
      .filter(
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
      );

  return {
    page:
      finalPayload.page,

    contextRoute:
      finalPayload.contextRoute,

    visualContext: {
      sanitizedScreenshot:
        finalPayload
          .visualContext
          .sanitizedScreenshot,

      objects:
        visualMappings.mappedObjects,

      regions:
        visualMappings.mappedRegions,

      texts:
        visualMappings.mappedTexts
    },

    domContext: {
      ...finalPayload.domContext,

      elements:
        visualMappings
          .domElementsWithVisualInfo,

      interactiveElements:
        mappedInteractiveElements
    },

    privacy:
      finalPayload.privacy,

    detectionSummary:
      analysis.detection_summary ||
      {},

    image:
      analysis.image || {},

    mappingSummary: {
      totalDomElements:
        visualMappings
          .domElementsWithVisualInfo
          .length,

      elementsWithVisualMatches:
        visualMappings
          .domElementsWithVisualInfo
          .filter(
            (element) =>
              element.visualMapping
                .hasVisualMatch
          )
          .length,

      mappedTextRegions:
        visualMappings
          .mappedTexts
          .filter(
            (item) =>
              item.mapping.mapped
          )
          .length,

      mappedVisualRegions:
        visualMappings
          .mappedRegions
          .filter(
            (item) =>
              item.mapping.mapped
          )
          .length,

      mappedObjects:
        visualMappings
          .mappedObjects
          .filter(
            (item) =>
              item.mapping.mapped
          )
          .length
    },

    timestamp:
      finalPayload.timestamp
  };
}

function getMatchedElementIds(item) {
  return (
    item.mapping
      ?.matchedElements
      ?.map(
        (match) =>
          match.elementId
      ) || []
  );
}

function createCompactVisualTextItem(
  item
) {
  return {
    visualItemId:
      item.visualItemId,

    text:
      sanitizeText(
        item.text ||
        item.value ||
        item.content ||
        ""
      ),

    rect:
      item.mapping
        ?.viewportRect ||
      getAnalysisRect(item),

    mappedElementIds:
      getMatchedElementIds(item)
  };
}

function createCompactVisualRegionItem(
  item
) {
  const rect =
    item.mapping
      ?.viewportRect ||
    getAnalysisRect(item);

  return {
    visualItemId:
      item.visualItemId,

    type:
      item.type ||
      item.class ||
      item.category ||
      item.label ||
      "visual_region",

    rect,

    mappedElementIds:
      getMatchedElementIds(item)
  };
}

function createCompactObjectItem(
  item
) {
  const rect =
    item.mapping
      ?.viewportRect ||
    getAnalysisRect(item);

  return {
    visualItemId:
      item.visualItemId,

    class:
      item.class ||
      item.label ||
      item.category ||
      "object",

    confidence:
      item.confidence ??
      item.score ??
      null,

    rect,

    mappedElementIds:
      getMatchedElementIds(item)
  };
}

function getElementVisualContext(
  element
) {
  const texts =
    (
      element.visualMapping
        ?.texts || []
    ).map(
      createCompactVisualTextItem
    );

  const regions =
    (
      element.visualMapping
        ?.regions || []
    ).map(
      createCompactVisualRegionItem
    );

  const objects =
    (
      element.visualMapping
        ?.objects || []
    ).map(
      createCompactObjectItem
    );

  return {
    hasVisualMatch:
      element.visualMapping
        ?.hasVisualMatch ||
      false,

    texts,
    regions,
    objects
  };
}

function createCompactInteractiveElement(
  element
) {
  return {
    elementId:
      element.elementId,

    tag:
      element.tag,

    category:
      element.category,

    type:
      element.type,

    text:
      sanitizeText(
        element.text
      ),

    placeholder:
      sanitizeText(
        element.placeholder
      ) || null,

    label:
      sanitizeText(
        element.label
      ) || null,

    rect:
      element.rect,

    accessibility: {
      role:
        element.accessibility
          ?.role || null,

      ariaLabel:
        sanitizeText(
          element.accessibility
            ?.ariaLabel
        ) || null,

      accessibleName:
        sanitizeText(
          element.accessibility
            ?.accessibleName
        ) || null,

      disabled:
        Boolean(
          element.accessibility
            ?.disabled
        )
    },

    visualContext:
      getElementVisualContext(
        element
      )
  };
}

function createCompactForm(form) {
  return {
    formId:
      form.formId,

    rect:
      form.rect,

    controls:
      form.controls.map(
        (control) => ({
          controlId:
            control.controlId,

          tag:
            control.tag,

          category:
            control.category,

          type:
            control.type,

          name:
            control.name,

          text:
            sanitizeText(
              control.text
            ),

          placeholder:
            sanitizeText(
              control.placeholder
            ) || null,

          label:
            sanitizeText(
              control.label
            ) || null,

          rect:
            control.rect,

          accessibility: {
            role:
              control.accessibility
                ?.role || null,

            accessibleName:
              sanitizeText(
                control.accessibility
                  ?.accessibleName
              ) || null,

            disabled:
              Boolean(
                control.accessibility
                  ?.disabled
              )
          }
        })
      )
  };
}

function createBrowserPerceptionState(
  finalLocalPerceptionOutput
) {
  const interactiveElements =
    finalLocalPerceptionOutput
      .domContext
      .interactiveElements
      .map(
        createCompactInteractiveElement
      );

  const forms =
    finalLocalPerceptionOutput
      .domContext
      .forms
      .map(
        createCompactForm
      );

  const visualText =
    finalLocalPerceptionOutput
      .visualContext
      .texts
      .map(
        createCompactVisualTextItem
      );

  const visualRegions =
    finalLocalPerceptionOutput
      .visualContext
      .regions
      .map(
        createCompactVisualRegionItem
      );

  const objects =
    finalLocalPerceptionOutput
      .visualContext
      .objects
      .map(
        createCompactObjectItem
      );

  return {
    page: {
      url:
        sanitizePageUrl(finalLocalPerceptionOutput.page.url),

      title:
        sanitizeText(finalLocalPerceptionOutput.page.title),

      viewport:
        finalLocalPerceptionOutput
          .page
          .viewport
    },

    interactiveElements,
    forms,
    visualText,
    visualRegions,
    objects,

    privacy: {
      sanitized: true,
      piiDetected:
        finalLocalPerceptionOutput
          .privacy
          .piiDetected,

      redactedRegionCount:
        finalLocalPerceptionOutput
          .privacy
          .redactedRegionCount,

      rawScreenshotIncluded:
        false
    },

    summary: {
      totalElements:
        finalLocalPerceptionOutput
          .mappingSummary
          .totalDomElements,

      interactiveElements:
        interactiveElements.length,

      mappedElements:
        finalLocalPerceptionOutput
          .mappingSummary
          .elementsWithVisualMatches,

      visualTextRegions:
        visualText.length,

      mappedTextRegions:
        finalLocalPerceptionOutput
          .mappingSummary
          .mappedTextRegions,

      visualRegions:
        visualRegions.length,

      mappedVisualRegions:
        finalLocalPerceptionOutput
          .mappingSummary
          .mappedVisualRegions,

      objects:
        objects.length,

      mappedObjects:
        finalLocalPerceptionOutput
          .mappingSummary
          .mappedObjects,

      forms:
        forms.length
    },

    timestamp:
      finalLocalPerceptionOutput
        .timestamp
  };
}

function sendBrowserPerceptionState(
  browserPerceptionState
) {
  return new Promise(
    (resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
        {
          type:
            "SEND_BROWSER_PERCEPTION",

          perceptionState:
            browserPerceptionState
        },
        (response) => {
          if (
            chrome.runtime.lastError
          ) {
            reject(
              new Error(
                chrome.runtime.lastError
                  .message
              )
            );

            return;
          }

          if (
            !response?.success
          ) {
            reject(
              new Error(
                response?.error ||
                "Failed to send browser perception state"
              )
            );

            return;
          }

          resolve(
            response.serverResponse
          );
        }
        );
      } catch (error) {
        reject(new Error(getRuntimeErrorMessage(error)));
      }
    }
  );
}

function captureScreenshot(
  pageContext,
  contextRoute
) {
  if (isCaptureInProgress) {
    
    return;
  }

  isCaptureInProgress = true;
  

  try {
    chrome.runtime.sendMessage(
      {
        type:
          "CAPTURE_SCREENSHOT"
      },
      async (response) => {
      if (
        chrome.runtime.lastError
      ) {
        isCaptureInProgress = false;
        

        return;
      }

      if (
        !response?.success
      ) {
        isCaptureInProgress = false;
        

        return;
      }

      try {
        

        const clientCapture = await prepareClientSanitizedCapture(
          pageContext,
          response.screenshot
        );
        const { sanitizedScreenshot, redactionMap, analysis } = clientCapture;

        

        

        const finalPayload =
          createSanitizedPayload(
            clientCapture.pageContext,
            sanitizedScreenshot
          );

        

        

        

        

        

        

        

        const finalLocalPerceptionOutput =
          createFinalLocalPerceptionOutput(
            finalPayload,
            analysis
          );

        

        

        

        const browserPerceptionState =
          createBrowserPerceptionState(
            finalLocalPerceptionOutput
          );

        

        

        

        

        

        

        const serverResponse =
          await sendBrowserPerceptionState(
            browserPerceptionState
          );

        

        

        

        

        
      } catch (error) {
        // The UI receives failures through its normal response path. Do not
        // emit page or privacy diagnostics into the site's developer console.
      } finally {
        isCaptureInProgress = false;
        if (captureRequested) {
          requestAutomaticCapture("queued update");
        }
        }
      }
    );
  } catch (error) {
    isCaptureInProgress = false;
  }
}

let isCaptureInProgress = false;
// Capture only after an explicit extension invocation. Automatic capture does
// not receive Chrome's activeTab grant and is not appropriate for private
// page observation.
const AUTO_CAPTURE_ENABLED = false;
let captureRequested = false;
let captureTimer = null;

function requestAutomaticCapture(reason) {
  captureRequested = true;

  if (captureTimer !== null) {
    clearTimeout(captureTimer);
  }

  captureTimer = setTimeout(() => {
    captureTimer = null;

    if (isCaptureInProgress) {
      return;
    }

    if (!captureRequested) {
      return;
    }

    captureRequested = false;
    const pageContext = extractPageContext();
    const contextRoute = decideContextRoute(pageContext);
    
    captureScreenshot(pageContext, contextRoute);
  }, 250);
}



// `chatbot.js` is a separate content-script bundle. Export the redaction
// pipeline explicitly so it is available in the shared isolated world; raw
// screenshots remain local until these redactors have completed.
window.vpbaPrivacy = Object.freeze({
  extractPageContext,
  redactScreenshot,
  createRedactionMap,
  assertSanitizedScreenshot,
  sanitizeVisibleText,
});

// Export text-sanitization helpers on window so chatbot.js can use the full
// pipeline (person-query redaction, form-name redaction, pattern PII) rather
// than its own lightweight fallback regex set.
window.sanitizeText = sanitizeText;
window.sanitizeVisibleText = sanitizeVisibleText;

// Export the full client-side capture pipeline so chatbot.js can run
// MediaPipe face detection + OCR before sending an image to the VLM.
// The raw screenshot is held only for this local redaction step.
window.vpbaPrepareCapture = prepareClientSanitizedCapture;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "START_ON_DEMAND_CAPTURE") {
    return false;
  }

  

  if (isCaptureInProgress) {
    sendResponse({ success: false, error: "Capture already in progress" });
    return false;
  }

  requestAutomaticCapture("extension action");
  sendResponse({ success: true, status: "capture started" });
  return false;
});

let localPrivacyScanInProgress = false;
let localPrivacyWatcher;
let localPrivacyWatchTimer;
let lastLocalPrivacyScanAt = 0;

async function runLocalPrivacyScan(reason) {
  if (localPrivacyScanInProgress) {
    throw new Error("A local privacy scan is already running");
  }

  localPrivacyScanInProgress = true;
  try {
    chrome.runtime.sendMessage({
      type: "VPBA_PRIVACY_SCAN_PROGRESS",
      text: `Capturing page for local privacy scan (${reason})…`,
    });
    const pageContext = extractPageContext();
    const screenshot = await captureVisibleScreenshot();
    const clientCapture = await prepareClientSanitizedCapture(pageContext, screenshot);
    const summary = clientCapture.analysis.detection_summary;
    if (reason === "manual request") {
      publishSanitizedPreview(
        clientCapture.pageContext,
        clientCapture.sanitizedScreenshot,
        "Sanitized text and image from the privacy scan"
      );
    }
    lastLocalPrivacyScanAt = Date.now();
    return {
      redactedRegions: clientCapture.redactionMap.length,
      facesDetected: summary.facesDetected,
      objectsDetected: summary.objectsDetected,
      provider: summary.provider,
    };
  } finally {
    localPrivacyScanInProgress = false;
  }
}

function startLocalPrivacyWatcher() {
  if (localPrivacyWatcher) return;

  localPrivacyWatcher = new MutationObserver((mutations) => {
    const relevantChange = mutations.some((mutation) => {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE
        ? mutation.target
        : mutation.target.parentElement;
      return target && !target.closest("#vpba-root");
    });
    if (!relevantChange || localPrivacyScanInProgress || localPrivacyWatchTimer) return;

    // Dynamic sites mutate continually. Scan only after changes settle and no
    // more often than once every 15 seconds; every scan stays browser-local.
    localPrivacyWatchTimer = setTimeout(async () => {
      localPrivacyWatchTimer = null;
      if (Date.now() - lastLocalPrivacyScanAt < 15000 || localPrivacyScanInProgress) return;
      try {
        await runLocalPrivacyScan("page changed");
      } catch {}
    }, 2000);
  });

  localPrivacyWatcher.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "RUN_LOCAL_PRIVACY_SCAN") return false;

  runLocalPrivacyScan("manual request")
    .then((summary) => {
      startLocalPrivacyWatcher();
      sendResponse({ success: true, summary });
    })
    .catch((error) => {
      sendResponse({ success: false, error: getRuntimeErrorMessage(error) });
    });

  return true;
});

if (LOCAL_PRIVACY_AUTO_SCAN) {
  setTimeout(() => {
    runLocalPrivacyScan("page loaded")
      .then(() => startLocalPrivacyWatcher())
      .catch(() => {});
  }, 1200);
}

if (AUTO_CAPTURE_ENABLED) {
  requestAutomaticCapture("page load");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "AGENT_TASK_REQUEST") {
    const taskIntent = message.taskIntent || "";

    (async () => {
      try {
        const pageContext = extractPageContext();

        // Capture + sanitize screenshot
        const screenshotResponse = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve(res);
          });
        });

        if (!screenshotResponse?.success) {
          throw new Error(screenshotResponse?.error || "Screenshot capture failed");
        }

        const clientCapture = await prepareClientSanitizedCapture(
          pageContext,
          screenshotResponse.screenshot
        );
        const { sanitizedScreenshot, redactionMap, analysis } = clientCapture;
        const finalPayload = createSanitizedPayload(
          clientCapture.pageContext,
          sanitizedScreenshot
        );
        const browserPerceptionState = createBrowserPerceptionState(
          createFinalLocalPerceptionOutput(finalPayload, analysis)
        );

        // Strip "data:image/png;base64," prefix for transport
        const image_b64 = sanitizedScreenshot.replace(/^data:image\/\w+;base64,/, "");

        const agentPayload = {
          task_intent: taskIntent,
          perception_state: browserPerceptionState,
          image_b64,
          redaction_regions: redactionMap.map((r) => ({
            rect: r.boundingBox,
            strategy: r.strategy,
            category: r.category,
          })),
          privacy_proof: {
            sanitized: true,
            rawScreenshotIncluded: false,
            redactionMap,
          },
        };

        const agentResponse = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: "SEND_AGENT_TASK", agentPayload },
            (res) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(res);
            }
          );
        });

        if (!agentResponse?.success) {
          throw new Error(agentResponse?.error || "Agent task API failed");
        }

        sendResponse({ success: true, tasks: agentResponse.tasks, model: agentResponse.model });
      } catch (err) {
        sendResponse({ success: false, error: getRuntimeErrorMessage(err) });
      }
    })();

    return true; // keep message channel open for async response
  }

  if (message.type === "EXECUTE_TASKS") {
    const tasks = message.tasks;

    (async () => {
      try {
        

        const result = await executeTasks(tasks, (step, totalSteps, status, error) => {
          const stepData = tasks?.tasks?.[step - 1];
          // Broadcast progress to popup (popup listens via onMessage)
          chrome.runtime.sendMessage({
            type: "TASK_PROGRESS",
            step,
            totalSteps,
            status,
            description: stepData?.description || "",
            error: error || null,
          }).catch(() => {}); // popup may have closed
        });

        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, completedSteps: 0, error: err.message });
      }
    })();

    return true;
  }

  return false;
});
