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
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
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
  { category: "PERSON", severity: "HIGH", reason: "name metadata", keywords: ["full name", "first name", "last name", "person name"] },
  { category: "ADDRESS", severity: "HIGH", reason: "address metadata", keywords: ["address", "street", "city", "postal code", "zip code"] }
];

function classifySensitiveText(metadata, value = "") {
  const source = `${metadata || ""} ${value || ""}`.toLowerCase();
  const patterns = [
    ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["PHONE", /\b(?:\+?\d{1,3}[\s-]?)?[6-9]\d{9}\b/],
    ["CARD_NUMBER", /\b(?:\d[ -]*?){13,19}\b/],
    ["GOVERNMENT_ID", /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b|\b[A-Z]{5}\d{4}[A-Z]\b/i],
    ["AUTH_TOKEN", /\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{10,}\b/],
    ["API_KEY", /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/i]
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
    ["PHONE", /\b(?:\+?\d{1,3}[\s-]?)?[6-9]\d{9}\b/g],
    ["CARD_NUMBER", /\b(?:\d[ -]*?){13,19}\b/g],
    ["GOVERNMENT_ID", /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b|\b[A-Z]{5}\d{4}[A-Z]\b/gi],
    ["API_KEY", /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/gi]
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
    ["PHONE", /\b(?:\+?\d{1,3}[\s-]?)?[6-9]\d{9}\b/g],
    ["GOVERNMENT_ID", /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b|\b[A-Z]{5}\d{4}[A-Z]\b/gi],
    ["CARD_NUMBER", /\b(?:\d[ -]*?){13,19}\b/g],
    ["AUTH_TOKEN", /\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{10,}\b/g],
    ["API_KEY", /\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{16,}\b/gi]
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

function getSensitiveElements() {
  return [
    ...getSensitiveInputElements(),
    ...getSensitiveTextElements()
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
        sanitizeText(
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
            const rect =
              element.rect;

            if (!rect || rect.width <= 0 || rect.height <= 0) {
              return;
            }

            const margin = Math.min(
              8,
              Math.max(2, Math.round(Math.min(rect.width, rect.height) * 0.08))
            );
            const x1 = Math.max(0, Math.round((rect.x - margin) * scaleX));
            const y1 = Math.max(0, Math.round((rect.y - margin) * scaleY));
            const x2 = Math.min(
              canvas.width,
              Math.round((rect.x + rect.width + margin) * scaleX)
            );
            const y2 = Math.min(
              canvas.height,
              Math.round((rect.y + rect.height + margin) * scaleY)
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
    console.warn("Capture already in progress");
    return;
  }

  isCaptureInProgress = true;
  console.log("Privacy pipeline started", { contextRoute });

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
        console.error(
          "Could not communicate with background script:",
          chrome.runtime.lastError.message
        );

        return;
      }

      if (
        !response?.success
      ) {
        isCaptureInProgress = false;
        console.error(
          "Screenshot capture failed:",
          response?.error
        );

        return;
      }

      try {
        console.log(
          "Screenshot captured successfully"
        );

        const sanitizedScreenshot =
          await redactScreenshot(
            response.screenshot,
            pageContext.sensitiveElements
          );

        const redactionMap = createRedactionMap(
          pageContext.sensitiveElements
        );
        assertSanitizedScreenshot(
          sanitizedScreenshot,
          redactionMap
        );

        console.log(
          "Screenshot sanitized successfully"
        );

        console.log(
          "Sensitive regions redacted:",
          pageContext.sensitiveElements.length
        );

        const finalPayload =
          createSanitizedPayload(
            pageContext,
            sanitizedScreenshot
          );

        console.log(
          "FINAL SANITIZED PAYLOAD:"
        );

        console.log(
          finalPayload
        );

        console.log(
          "Final payload summary:",
          {
            domElements:
              finalPayload.domContext
                .elements.length,

            interactiveElements:
              finalPayload.domContext
                .interactiveElements.length,

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
          "Sanitized payload is ready for Team Member 2"
        );

        console.log(
          "Sending sanitized screenshot for analysis..."
        );

        const analysis =
          await sendSanitizedScreenshotForAnalysis(
            sanitizedScreenshot,
            redactionMap.map(
              (element) => ({
                ...element.boundingBox,
                source: element.source[0].toLowerCase(),
                category: element.category,
                severity: element.severity,
                strategy: element.strategy
              })
            ),
            {
              sanitized: true,
              redactionMap,
              rawScreenshotIncluded: false
            }
          );

        console.log(
          "LOCAL PERCEPTION ANALYSIS:"
        );

        console.log(
          analysis
        );

        const finalLocalPerceptionOutput =
          createFinalLocalPerceptionOutput(
            finalPayload,
            analysis
          );

        console.log(
          "FINAL LOCAL PERCEPTION OUTPUT:"
        );

        console.log(
          finalLocalPerceptionOutput
        );

        console.log(
          "Final local perception summary:",
          {
            domElements:
              finalLocalPerceptionOutput
                .domContext
                .elements.length,

            interactiveElements:
              finalLocalPerceptionOutput
                .domContext
                .interactiveElements.length,

            forms:
              finalLocalPerceptionOutput
                .domContext
                .forms.length,

            objects:
              finalLocalPerceptionOutput
                .visualContext
                .objects.length,

            visualRegions:
              finalLocalPerceptionOutput
                .visualContext
                .regions.length,

            textRegions:
              finalLocalPerceptionOutput
                .visualContext
                .texts.length,

            sensitiveRegions:
              finalLocalPerceptionOutput
                .privacy
                .redactedRegionCount,

            mappingSummary:
              finalLocalPerceptionOutput
                .mappingSummary
          }
        );

        const browserPerceptionState =
          createBrowserPerceptionState(
            finalLocalPerceptionOutput
          );

        console.log(
          "BROWSER PERCEPTION STATE:"
        );

        console.log(
          browserPerceptionState
        );

        console.log(
          "BROWSER PERCEPTION STATE JSON:\n" +
          JSON.stringify(
            browserPerceptionState,
            null,
            2
          )
        );

        console.log(
          "Browser perception state summary:",
          browserPerceptionState.summary
        );

        console.log(
          "Compact browser perception state is ready for Team Member 2"
        );

        console.log(
          "Sending browser perception state through background service worker..."
        );

        const serverResponse =
          await sendBrowserPerceptionState(
            browserPerceptionState
          );

        console.log(
          "Browser perception state sent successfully"
        );

        console.log(
          "SERVER RESPONSE:"
        );

        console.log(
          serverResponse
        );

        console.log(
          "MEMBER 2 COMPLETE OUTPUT:",
          {
            route:
              browserPerceptionState.contextRoute,
            page:
              browserPerceptionState.page,
            summary:
              browserPerceptionState.summary,
            privacy:
              browserPerceptionState.privacy,
            artifacts:
              analysis.artifacts || null
          }
        );

        console.log(
          "Sanitized screenshot analysis completed successfully"
        );
      } catch (error) {
        console.error(
          "Local screenshot processing failed:",
          error.message
        );
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
    console.warn("Privacy capture stopped:", getRuntimeErrorMessage(error));
  }
}

let isCaptureInProgress = false;
const AUTO_CAPTURE_ENABLED = true;
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
    console.log("Privacy capture requested", { reason });
    captureScreenshot(pageContext, contextRoute);
  }, 250);
}

console.log(
  "Visual Perception Agent loaded; waiting for an explicit extension click",
  {
    url: sanitizePageUrl(window.location.href),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    }
  }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "START_ON_DEMAND_CAPTURE") {
    return false;
  }

  console.log("On-demand capture request received");

  if (isCaptureInProgress) {
    sendResponse({ success: false, error: "Capture already in progress" });
    return false;
  }

  requestAutomaticCapture("extension action");
  sendResponse({ success: true, status: "capture started" });
  return false;
});

if (AUTO_CAPTURE_ENABLED) {
  requestAutomaticCapture("page load");
}

document.addEventListener("click", () => {
  requestAutomaticCapture("click");
}, true);

document.addEventListener("input", () => {
  requestAutomaticCapture("input");
}, true);

document.addEventListener("change", () => {
  requestAutomaticCapture("change");
}, true);

const pageMutationObserver = new MutationObserver(() => {
  requestAutomaticCapture("DOM mutation");
});

pageMutationObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true
});
