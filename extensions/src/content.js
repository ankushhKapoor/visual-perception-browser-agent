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
  const sensitiveKeywords = [
    "password",
    "passcode",
    "otp",
    "verification",
    "pin",
    "cvv",
    "cvc",
    "card",
    "credit",
    "debit",
    "bank",
    "account",
    "email",
    "phone",
    "mobile",
    "tel",
    "aadhaar",
    "aadhar",
    "pan",
    "passport",
    "token",
    "secret",
    "api"
  ];

  return Array.from(
    document.querySelectorAll(
      "input, textarea"
    )
  )
    .filter(isElementVisible)
    .filter((element) => {
      const metadata = [
        element.type,
        element.name,
        element.id,
        element.autocomplete,
        element.placeholder,
        element.getAttribute(
          "aria-label"
        ),
        getLabelForElement(element)
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
    })
    .map((element) => ({
      source:
        "input",
      tag:
        element.tagName.toLowerCase(),
      type:
        element.type || null,
      text:
        "[REDACTED]",
      rect:
        getElementRect(element)
    }));
}

function containsPII(text) {
  if (!text) {
    return false;
  }

  const value = String(text);

  const patterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/,
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i,
    /\b(?:\d{4}[\s-]?){3}\d{4}\b/
  ];

  return patterns.some(
    (pattern) =>
      pattern.test(value)
  );
}

function sanitizeText(text) {
  if (!text) {
    return "";
  }

  let sanitizedText =
    String(text);

  const patterns = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,
    /\b(?:\d{4}[\s-]?){3}\d{4}\b/g
  ];

  patterns.forEach(
    (pattern) => {
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
    document.querySelectorAll(
      "body *"
    )
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
      : sanitizeText(
          element.text
        );

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

function sendSanitizedScreenshotForAnalysis(
  sanitizedScreenshot
) {
  return new Promise(
    (resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type:
            "SEND_SANITIZED_FOR_ANALYSIS",

          screenshot:
            sanitizedScreenshot
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
    }
  );
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
        finalLocalPerceptionOutput
          .page
          .url,

      title:
        finalLocalPerceptionOutput
          .page
          .title,

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
          chrome.runtime.lastError.message
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
            sanitizedScreenshot
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
          "Sanitized screenshot analysis completed successfully"
        );
      } catch (error) {
        console.error(
          "Local screenshot processing failed:",
          error.message
        );
      }
    }
  );
}

const pageContext =
  extractPageContext();

console.log(
  "Page Context:"
);

console.log(
  pageContext
);

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
  pageContext.domElements.length
);

console.log(
  "Forms extracted:",
  pageContext.forms.length
);

console.log(
  "Accessibility extracted for:",
  pageContext.domElements.length,
  "elements"
);

captureScreenshot(
  pageContext
);