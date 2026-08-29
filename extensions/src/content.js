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

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getBoundingClientRect().width > 0 &&
        element.getBoundingClientRect().height > 0
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

function getSensitiveElements() {
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
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      const isVisible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0;

      if (!isVisible) return false;

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
    .map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        tag: element.tagName.toLowerCase(),
        type: element.type || null,
        name: element.name || null,
        id: element.id || null,
        autocomplete: element.autocomplete || null,
        placeholder: element.placeholder || null,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
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

function displaySanitizedPreview(sanitizedScreenshot) {
  const existingPreview = document.getElementById(
    "visual-perception-sanitized-preview"
  );

  if (existingPreview) {
    existingPreview.remove();
  }

  const preview = document.createElement("img");

  preview.id = "visual-perception-sanitized-preview";
  preview.src = sanitizedScreenshot;
  preview.alt = "Sanitized Screenshot Preview";

  preview.style.position = "fixed";
  preview.style.top = "10px";
  preview.style.right = "10px";
  preview.style.width = "400px";
  preview.style.maxHeight = "80vh";
  preview.style.border = "3px solid red";
  preview.style.zIndex = "2147483647";
  preview.style.background = "white";
  preview.style.objectFit = "contain";

  document.body.appendChild(preview);

  console.log("Sanitized screenshot preview displayed");
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

        displaySanitizedPreview(sanitizedScreenshot);
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