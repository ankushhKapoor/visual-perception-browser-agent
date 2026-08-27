console.log("Visual Perception Browser Agent: content script loaded");

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

    timestamp: new Date().toISOString()
  };
}

const pageContext = extractPageContext();

console.log("Page Context:");
console.log(pageContext);