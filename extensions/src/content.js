console.log(
  "Visual Perception Browser Agent: content script loaded",
  chrome.runtime.id
);

function getVisibleText() {
  return document.body.innerText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function getInteractiveElements() {
  const selectors = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[role='button']",
    "[contenteditable='true']"
  ];

  return Array.from(document.querySelectorAll(selectors.join(",")))
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .slice(0, 100)
    .map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        tag: element.tagName.toLowerCase(),
        text: (element.innerText || element.value || element.placeholder || "")
          .trim()
          .slice(0, 200),
        type: element.type || null,
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
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

function getSensitiveInputElements() {
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

  return Array.from(document.querySelectorAll("input, textarea"))
    .filter((element) => {
      if (!isElementVisible(element)) {
        return false;
      }

      const metadata = [
        element.type,
        element.name,
        element.id,
        element.autocomplete,
        element.placeholder,
        element.getAttribute("aria-label")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        element.type === "password" ||
        sensitiveKeywords.some((keyword) =>
          metadata.includes(keyword)
        )
      );
    })
    .map((element) => ({
      source: "input",
      tag: element.tagName.toLowerCase(),
      type: element.type || null,
      name: element.name || null,
      id: element.id || null,
      rect: getElementRect(element)
    }));
}

function containsPII(text) {
  if (!text) {
    return false;
  }

  const patterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/,
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i,
    /\b(?:\d{4}[\s-]?){3}\d{4}\b/
  ];

  return patterns.some((pattern) => pattern.test(text));
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

  return Array.from(document.querySelectorAll("body *"))
    .filter((element) => {
      if (excludedTags.has(element.tagName)) {
        return false;
      }

      if (!isElementVisible(element)) {
        return false;
      }

      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(" ");

      return containsPII(directText);
    })
    .map((element) => ({
      source: "text",
      tag: element.tagName.toLowerCase(),
      text: Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 200),
      rect: getElementRect(element)
    }));
}

function getSensitiveElements() {
  return [
    ...getSensitiveInputElements(),
    ...getSensitiveTextElements()
  ];
}

function extractPageContext() {
  return {
    url: window.location.href,
    title: document.title,

    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },

    visibleText: getVisibleText(),

    interactiveElements: getInteractiveElements(),

    sensitiveElements: getSensitiveElements(),

    timestamp: new Date().toISOString()
  };
}

function redactScreenshot(dataUrl, sensitiveElements) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("Could not create canvas context"));
        return;
      }

      canvas.width = image.width;
      canvas.height = image.height;

      context.drawImage(image, 0, 0);

      const scaleX = image.width / window.innerWidth;
      const scaleY = image.height / window.innerHeight;

      context.fillStyle = "black";

      sensitiveElements.forEach((element) => {
        const rect = element.rect;

        context.fillRect(
          Math.round(rect.x * scaleX),
          Math.round(rect.y * scaleY),
          Math.round(rect.width * scaleX),
          Math.round(rect.height * scaleY)
        );
      });

      resolve(canvas.toDataURL("image/png"));
    };

    image.onerror = () => {
      reject(new Error("Failed to load screenshot for redaction"));
    };

    image.src = dataUrl;
  });
}

function captureScreenshot(sensitiveElements) {
  chrome.runtime.sendMessage(
    { type: "CAPTURE_SCREENSHOT" },
    async (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          "Could not communicate with background script:",
          chrome.runtime.lastError.message
        );
        return;
      }

      if (!response?.success) {
        console.error(
          "Screenshot capture failed:",
          response?.error
        );
        return;
      }

      try {
        console.log("Screenshot captured successfully");
        console.log("Screenshot size:", response.screenshot.length);

        const sanitizedScreenshot = await redactScreenshot(
          response.screenshot,
          sensitiveElements
        );

        console.log("Screenshot sanitized successfully");
        console.log(
          "Sensitive regions redacted:",
          sensitiveElements.length
        );
        console.log(
          "Sanitized screenshot size:",
          sanitizedScreenshot.length
        );

        console.log("Sanitized screenshot is ready for secure processing");
      } catch (error) {
        console.error(
          "Local screenshot redaction failed:",
          error.message
        );
      }
    }
  );
}

const pageContext = extractPageContext();

console.log("Page Context:");
console.log(pageContext);

captureScreenshot(pageContext.sensitiveElements);