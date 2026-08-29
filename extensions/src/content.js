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

function captureScreenshot() {
  chrome.runtime.sendMessage(
    { type: "CAPTURE_SCREENSHOT" },
    (response) => {
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

      console.log("Screenshot captured successfully");
      console.log("Screenshot size:", response.screenshot.length);
    }
  );
}

const pageContext = extractPageContext();

console.log("Page Context:");
console.log(pageContext);

captureScreenshot();