console.log(
  "Visual Perception Browser Agent: content script loaded",
  chrome.runtime.id
);

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
    .map((element) => ({
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
    }));
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

  return Object.values(
    patterns
  ).some((pattern) => {
    pattern.lastIndex = 0;

    return pattern.test(text);
  });
}

function sanitizeText(text) {
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
    .map((element) => ({
      source:
        "text",

      tag:
        element.tagName.toLowerCase(),

      text:
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
          .slice(0, 200),

      rect:
        getElementRect(element)
    }));
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
        pageContext.sensitiveElements
          .map((element) => ({
            source:
              element.source,

            rect:
              element.rect
          })),

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

        const scaleX =
          image.width /
          window.innerWidth;

        const scaleY =
          image.height /
          window.innerHeight;

        context.fillStyle =
          "black";

        sensitiveElements.forEach(
          (element) => {
            const rect =
              element.rect;

            context.fillRect(
              Math.round(
                rect.x * scaleX
              ),
              Math.round(
                rect.y * scaleY
              ),
              Math.round(
                rect.width * scaleX
              ),
              Math.round(
                rect.height * scaleY
              )
            );
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

function captureScreenshot(
  pageContext
) {
  chrome.runtime.sendMessage(
    {
      type:
        "CAPTURE_SCREENSHOT"
    },
    async (response) => {
      if (
        chrome.runtime.lastError
      ) {
        console.error(
          "Could not communicate with background script:",
          chrome.runtime.lastError
            .message
        );

        return;
      }

      if (
        !response?.success
      ) {
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

        console.log(
          "Screenshot sanitized successfully"
        );

        console.log(
          "Sensitive regions redacted:",
          pageContext
            .sensitiveElements
            .length
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
          "Sanitized payload is ready for Team Member 2"
        );
      } catch (error) {
        console.error(
          "Local screenshot redaction failed:",
          error.message
        );
      }
    }
  );
}

const pageContext =
  extractPageContext();

console.log("Page Context:");
console.log(pageContext);

console.log(
  "Page Context JSON:\n",
  JSON.stringify(
    pageContext,
    null,
    2
  )
);

console.log(
  "DOM Elements JSON:\n",
  JSON.stringify(
    pageContext.domElements,
    null,
    2
  )
);

console.log(
  "DOM elements extracted:",
  pageContext
    .domElements.length
);

console.log(
  "Forms extracted:",
  pageContext.forms.length
);

console.log(
  "Accessibility extracted for:",
  pageContext
    .domElements.length,
  "elements"
);

captureScreenshot(
  pageContext
);