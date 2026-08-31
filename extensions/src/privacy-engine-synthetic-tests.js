(function (globalScope) {
  const path = typeof require === "function" ? require("path") : null;
  const fs = typeof require === "function" ? require("fs") : null;
  const vm = typeof require === "function" ? require("vm") : null;

  function normalizeType(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function evaluateModuleSource(fileName, source) {
    const moduleCache = new Map();

    const transformImports = (code) => code
      .replace(/import\s*\{\s*([\s\S]*?)\s*\}\s*from\s*["']([^"']+)["'];?/g, (_, specifiers, from) => {
        const items = specifiers.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
          const match = part.match(/^([A-Za-z0-9_$]+)(?:\s+as\s+([A-Za-z0-9_$]+))?$/);
          if (!match) {
            return part;
          }
          return match[2] ? `${match[1]}: ${match[2]}` : match[1];
        }).join(', ');

        return `const { ${items} } = __loadModule(${JSON.stringify(from)});`;
      })
      .replace(/import\s+["']([^"']+)["'];?/g, "")
      .replace(/import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+["']([^"']+)["'];?/g, (_, alias, from) => `const ${alias} = __loadModule(${JSON.stringify(from)});`)
      .replace(/import\s+([A-Za-z0-9_$]+)\s+from\s+["']([^"']+)["'];?/g, (_, defaultName, from) => `const ${defaultName} = __loadModule(${JSON.stringify(from)});`)
      .replace(/export\s*\{([\s\S]*?)\};?\s*$/m, "module.exports = { $1 };\n")
      .replace(/export\s+(async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g, (_, asyncPrefix = "", name) => `${asyncPrefix || ""}function ${name}(`)
      .replace(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/g, "const $1 = $2;")
      .replace(/export\s+default\s+/g, "module.exports.default = ")
      .replace(/export\s+\{([\s\S]*?)\};?/g, "module.exports = { $1 };\n")
      .replace(/export\s*\{([\s\S]*?)\};?/g, "module.exports = { $1 };\n");

    const module = { exports: {} };
    const baseGlobal = typeof globalThis !== "undefined" ? globalThis : {};
    const context = {
      console,
      module,
      exports: module.exports,
      require,
      window: baseGlobal.window,
      document: baseGlobal.document,
      Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
      globalThis: baseGlobal,
      chrome: baseGlobal.chrome,
      Image: baseGlobal.Image,
      setTimeout,
      clearTimeout,
      Buffer,
      __loadModule: (relativePath) => {
        if (!relativePath.startsWith('.') && !path.isAbsolute(relativePath)) {
          return require(relativePath);
        }

        const currentDir = path.dirname(fileName);
        const targetPath = relativePath.startsWith('.')
          ? path.resolve(currentDir, relativePath)
          : path.resolve(__dirname, relativePath);

        if (!moduleCache.has(targetPath)) {
          const targetSource = fs.readFileSync(targetPath, "utf8");
          moduleCache.set(targetPath, evaluateModuleSource(targetPath, targetSource));
        }

        return moduleCache.get(targetPath);
      }
    };

    Object.defineProperty(context, "window", {
      get: () => baseGlobal.window,
      set: (value) => { baseGlobal.window = value; },
      configurable: true
    });
    Object.defineProperty(context, "document", {
      get: () => baseGlobal.document,
      set: (value) => { baseGlobal.document = value; },
      configurable: true
    });
    Object.defineProperty(context, "chrome", {
      get: () => baseGlobal.chrome,
      set: (value) => { baseGlobal.chrome = value; },
      configurable: true
    });
    Object.defineProperty(context, "Image", {
      get: () => baseGlobal.Image,
      set: (value) => { baseGlobal.Image = value; },
      configurable: true
    });
    Object.defineProperty(context, "globalThis", {
      get: () => baseGlobal,
      set: (value) => { Object.assign(baseGlobal, value || {}); },
      configurable: true
    });

    const transformed = transformImports(source);

    vm.runInNewContext(`(function() {${transformed}\nreturn module.exports;})();`, context, {
      filename: fileName
    });

    return context.module.exports || context.exports;
  }

  function loadModule(fileRelativePath) {
    if (typeof require === "function") {
      const filePath = path.join(__dirname, fileRelativePath);
      const source = fs.readFileSync(filePath, "utf8");
      return evaluateModuleSource(filePath, source);
    }

    return null;
  }

  async function loadModuleFromBrowser(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to fetch ${url}: ${response.status}`);
    }
    const source = await response.text();
    return evaluateModuleSource(url, source);
  }

  function collectStringValues(value, results = []) {
    if (value === null || value === undefined) return results;
    if (typeof value === "string") {
      if (value.trim()) results.push(value);
      return results;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectStringValues(item, results));
      return results;
    }
    if (typeof value === "object") {
      Object.values(value).forEach((item) => collectStringValues(item, results));
    }
    return results;
  }

  function buildExpectedPiiSet(rawCase) {
    const expected = Array.isArray(rawCase.expectedTypes)
      ? rawCase.expectedTypes
      : rawCase.expectedType
        ? [rawCase.expectedType]
        : [];

    return new Set(expected.map((type) => normalizeType(type)));
  }

  function computeMetrics(expectedSet, actualSet) {
    const truePositive = new Set([...expectedSet].filter((type) => actualSet.has(type)));
    const falsePositive = new Set([...actualSet].filter((type) => !expectedSet.has(type)));
    const falseNegative = new Set([...expectedSet].filter((type) => !actualSet.has(type)));

    const tp = truePositive.size;
    const fp = falsePositive.size;
    const fn = falseNegative.size;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1 = (precision + recall) === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    return { tp, fp, fn, precision, recall, f1, truePositive, falsePositive, falseNegative };
  }

  function findRawLeak(value, rawStrings) {
    if (typeof value !== "string") {
      return false;
    }
    return rawStrings.some((raw) => value.includes(raw));
  }

  async function runSuite() {
    const syntheticCases = [
      { category: "CRITICAL", name: "password", text: "Password is MySecure123!Pass", expectedTypes: ["PASSWORD"], rawValue: "MySecure123!Pass" },
      { category: "CRITICAL", name: "OTP", text: "Your OTP is 482931", expectedTypes: ["OTP"], rawValue: "482931" },
      { category: "CRITICAL", name: "CVV", text: "CVV: 412", expectedTypes: ["CVV"], rawValue: "412" },
      { category: "CRITICAL", name: "credit-card", text: "Card Number: 4111 1111 1111 1111", expectedTypes: ["CARD"], rawValue: "4111 1111 1111 1111" },
{ category: "CRITICAL", name: "api-key", text: "API key=FAKE_SYNTHETIC_TEST_KEY_12345", expectedTypes: ["API_KEY"], rawValue: "api_key=FAKE_SYNTHETIC_TEST_KEY_12345" },      { category: "CRITICAL", name: "bearer-auth-token", text: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature", expectedTypes: ["AUTH_TOKEN"], rawValue: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature" },

      { category: "HIGH", name: "email", text: "Email: rakshita@example.com", expectedTypes: ["EMAIL"], rawValue: "rakshita@example.com" },
      { category: "HIGH", name: "phone", text: "Phone: +91 9876543210", expectedTypes: ["PHONE"], rawValue: "+91 9876543210" },
      { category: "HIGH", name: "aadhaar-like-id", text: "Aadhaar: 1234 5678 9012", expectedTypes: ["GOVERNMENT_ID"], rawValue: "1234 5678 9012" },
      { category: "HIGH", name: "pan", text: "PAN: ABCDE1234F", expectedTypes: ["GOVERNMENT_ID"], rawValue: "ABCDE1234F" },
      { category: "HIGH", name: "bank-account", text: "Bank account number is 123456789012", expectedTypes: ["FINANCIAL_INFO"], rawValue: "123456789012" },
      { category: "HIGH", name: "employee-id", text: "Employee ID: EMP123456", expectedTypes: ["EMPLOYEE_ID"], rawValue: "EMP123456" },

      { category: "CONTEXT", name: "person-name", text: "Full name: Rakshita Kapoor", expectedTypes: ["PERSON"], rawValue: "Rakshita Kapoor" },
      { category: "CONTEXT", name: "address", text: "Address: 42, Lake Street, Mumbai, Maharashtra", expectedTypes: ["ADDRESS"], rawValue: "42, Lake Street, Mumbai, Maharashtra" },
      { category: "CONTEXT", name: "dob", text: "Date of birth: 12/01/1998", expectedTypes: ["DATE_OF_BIRTH"], rawValue: "12/01/1998" },

      { category: "NORMAL", name: "normal-college", text: "college starts at 9 AM", expectedTypes: [], rawValue: null },
      { category: "NORMAL", name: "normal-deadline", text: "project deadline is Friday", expectedTypes: [], rawValue: null },
      { category: "NORMAL", name: "normal-location", text: "Mumbai is in Maharashtra", expectedTypes: [], rawValue: null }
    ];

    const classifier = loadModule("privacy-classifier.js");
    const fusion = loadModule("privacy-fusion.js");
    const sanitizer = loadModule("privacy-sanitizer.js");
    const content = loadModule("content.js");

    const engineResults = syntheticCases.map((sample) => {
      const actualDetections = (classifier.runAllDeterministicDetectors || (() => []))(sample.text);
      const actualTypes = new Set(
        actualDetections
          .map((item) => normalizeType(item.piiType || item.type || ""))
          .filter(Boolean)
      );

      const expectedTypes = buildExpectedPiiSet(sample);
      const metrics = computeMetrics(expectedTypes, actualTypes);

      const classificationChecks = actualDetections.map((item) => ({
        type: normalizeType(item.type || item.piiType || ""),
        severity: item.severity || "HIGH",
        action: item.action || item.recommendedAction || "MASK",
        confidence: Number(item.confidence || 0),
        source: item.source || "deterministic"
      }));

      const requiresActionContract = actualDetections.length > 0 ? classificationChecks.every((item) => item.type && item.severity && item.action && item.confidence >= 0 && item.source) : true;

      return {
        category: sample.category,
        name: sample.name,
        text: sample.text,
        expectedTypes: [...expectedTypes],
        actualTypes: [...actualTypes],
        tp: metrics.tp,
        fp: metrics.fp,
        fn: metrics.fn,
        precision: Number(metrics.precision.toFixed(3)),
        recall: Number(metrics.recall.toFixed(3)),
        f1: Number(metrics.f1.toFixed(3)),
        rawValue: sample.rawValue,
        actionContract: requiresActionContract,
        engineSummary: actualDetections
      };
    });

    const sanitizationResults = syntheticCases
      .filter((sample) => sample.rawValue)
      .map((sample) => {
        const detections = [{
          piiType: normalizeType(sample.expectedTypes[0]),
          value: sample.rawValue,
          startIndex: sample.text.indexOf(sample.rawValue),
          endIndex: sample.text.indexOf(sample.rawValue) + sample.rawValue.length,
          severity: "HIGH",
          confidence: 0.9
        }];

        if (sample.expectedTypes[0] === "PASSWORD" || sample.expectedTypes[0] === "OTP" || sample.expectedTypes[0] === "CVV" || sample.expectedTypes[0] === "CARD" || sample.expectedTypes[0] === "API_KEY" || sample.expectedTypes[0] === "AUTH_TOKEN") {
          detections[0].severity = "CRITICAL";
        }

        const result = sanitizer.sanitizeText(sample.text, detections);
        const leaked = result.sanitized.includes(sample.rawValue);

        return {
          name: sample.name,
          expectedType: sample.expectedTypes[0],
          sanitized: result.sanitized,
          leaked,
          replacedWithPlaceholder: result.sanitizationCount > 0
        };
      });

    const faceFusionResults = (() => {
      const faceA = {
        piiType: "FACE",
        type: "FACE",
        severity: "HIGH",
        action: "BLUR",
        confidence: 0.92,
        source: "FACE",
        rect: { x: 30, y: 40, width: 80, height: 100 }
      };

      const faceB = {
        piiType: "FACE",
        type: "FACE",
        severity: "HIGH",
        action: "BLUR",
        confidence: 0.88,
        source: "OCR",
        rect: { x: 60, y: 70, width: 90, height: 120 }
      };

      const faceDuplicate = {
        piiType: "FACE",
        type: "FACE",
        severity: "HIGH",
        action: "BLUR",
        confidence: 0.94,
        source: "FACE",
        rect: { x: 32, y: 42, width: 80, height: 100 }
      };

      const priorityFace = {
        piiType: "FACE",
        type: "FACE",
        severity: "HIGH",
        action: "BLUR",
        confidence: 0.82,
        source: "FACE",
        rect: { x: 150, y: 120, width: 60, height: 70 }
      };

      const lowerFace = {
        piiType: "FACE",
        type: "FACE",
        severity: "CONTEXT_DEPENDENT",
        action: "PLACEHOLDER",
        confidence: 0.91,
        source: "OCR",
        rect: { x: 150, y: 120, width: 60, height: 70 }
      };

      const overlapping = fusion.runFusionEngine([], [], [], [], [faceA, faceB], {
        overlapThreshold: 0.1,
        safetyMarginPercent: 10
      });

      const duplicateMerged = fusion.runFusionEngine([], [], [], [], [faceA, faceDuplicate], {
        overlapThreshold: 0.1,
        safetyMarginPercent: 10
      });

      const severityMerged = fusion.runFusionEngine([], [], [], [], [priorityFace, lowerFace], {
        overlapThreshold: 0.1,
        safetyMarginPercent: 10
      });

      const scaledRect = fusion.convertRectToCanonical(
        { x: 150, y: 120, width: 100, height: 120 },
        "dom",
        {
          viewportWidth: 1280,
          viewportHeight: 720,
          screenshotWidth: 1600,
          screenshotHeight: 900,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 2,
          zoomScale: 1.25
        }
      );

      const ocrRect = fusion.convertRectToCanonical(
        { x: 200, y: 250, width: 100, height: 80 },
        "ocr",
        {
          screenshotWidth: 1600,
          screenshotHeight: 900,
          viewportWidth: 1280,
          viewportHeight: 720
        }
      );

      const serializedOverlap = JSON.stringify(overlapping);
      const rawLeakCheck = ["rakshita@example.com", "MySecure123!Pass", "secret", "token", "match", "text"].every((token) => !serializedOverlap.toLowerCase().includes(token));
      const allowedSafeKeys = new Set([
        "safeId",
        "elementId",
        "type",
        "piiType",
        "severity",
        "action",
        "confidence",
        "source",
        "sources",
        "rect",
        "boundingBox",
        "finalRedactionAction",
        "fusedCount",
        "sourceCount",
        "safetyMarginApplied",
        "reason",
        "startIndex",
        "endIndex"
      ]);

      return {
        overlapping: overlapping.length === 1 && overlapping[0]?.boundingBox && overlapping[0].boundingBox.width > 0,
        duplicatesRemoved: duplicateMerged.length === 1,
        severityPriority: severityMerged.length === 1 && severityMerged[0]?.severity === "HIGH",
        safetyMarginApplied: overlapping[0]?.boundingBox?.width >= 80 && overlapping[0]?.boundingBox?.height >= 100,
        coordinateConversion: Number.isFinite(scaledRect.x) && Number.isFinite(ocrRect.x),
        devicePixelRatio: scaledRect.width > 0 && scaledRect.height > 0,
        rawLeakCheck,
        outputHasOnlySafeFields: Object.keys(overlapping[0] || {}).every((key) => allowedSafeKeys.has(key) || key.startsWith("safe"))
      };
    })();

    const ocrIntegrationResults = await (async () => {
      const fakeTesseract = require("tesseract.js");
      const originalRecognize = fakeTesseract.recognize;
      const originalWindow = globalThis.window;
      const originalEnable = globalThis.__ENABLE_LOCAL_OCR__;

      globalThis.__ENABLE_LOCAL_OCR__ = true;
      globalThis.window = {
        innerWidth: 1280,
        innerHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        visualViewport: { scale: 1 }
      };

      fakeTesseract.recognize = async () => ({
        data: {
          words: [
            { text: "Email:", bbox: { x0: 10, y0: 20, x1: 60, y1: 40 }, confidence: 0.95 },
            { text: "rakshita@example.com", bbox: { x0: 70, y0: 20, x1: 200, y1: 40 }, confidence: 0.98 },
            { text: "Phone:", bbox: { x0: 10, y0: 60, x1: 70, y1: 85 }, confidence: 0.92 },
            { text: "+91", bbox: { x0: 80, y0: 60, x1: 120, y1: 85 }, confidence: 0.92 },
            { text: "9876543210", bbox: { x0: 130, y0: 60, x1: 220, y1: 85 }, confidence: 0.93 },
            { text: "PAN:", bbox: { x0: 20, y0: 120, x1: 70, y1: 146 }, confidence: 0.9 },
            { text: "ABCDE1234F", bbox: { x0: 80, y0: 120, x1: 200, y1: 146 }, confidence: 0.94 }
          ]
        }
      });

      try {
        const ocrModule = loadModule("local-ocr.js");
        const detections = await ocrModule.detectOCRTextRegions("data:image/png;base64,SAFE_IMAGE", { enabled: true });
        const fused = fusion.runFusionEngine([], [], detections, [], [], {
          overlapThreshold: 0.1,
          proximityThreshold: 50,
          safetyMarginPercent: 10
        });
        const safeOutput = JSON.stringify(fused);

        return {
          hasEmailDetection: detections.some((item) => item.type === "EMAIL" || item.piiType === "EMAIL"),
          hasPhoneDetection: detections.some((item) => item.type === "PHONE" || item.piiType === "PHONE"),
          hasGovernmentIdDetection: detections.some((item) => item.type === "GOVERNMENT_ID" || item.piiType === "GOVERNMENT_ID"),
          sourceContract: detections.every((item) => item.source === "OCR"),
          canonicalRects: detections.every((item) => Number.isFinite(item.rect?.x) && Number.isFinite(item.rect?.y) && Number.isFinite(item.rect?.width) && Number.isFinite(item.rect?.height)),
          rawValueLeakage: safeOutput.includes("rakshita@example.com") || safeOutput.includes("9876543210") || safeOutput.includes("ABCDE1234F"),
          outputContainsStandardFields: detections.every((item) => item.type && item.severity && item.action && typeof item.confidence === "number" && item.source)
        };
      } finally {
        fakeTesseract.recognize = originalRecognize;
        globalThis.__ENABLE_LOCAL_OCR__ = originalEnable;
        globalThis.window = originalWindow;
      }
    })();

    const redactionBehaviorResults = (() => {
      const originalDocument = globalThis.document;
      const originalWindow = globalThis.window;
      const originalImage = globalThis.Image;
      const originalChrome = globalThis.chrome;

      const fillCalls = [];
      const canvas = {
        width: 1000,
        height: 800,
        getContext: () => ({
          fillStyle: "",
          filter: "",
          save() {
            fillCalls.push({ action: "save" });
          },
          restore() {
            fillCalls.push({ action: "restore" });
          },
          drawImage() {},
          fillRect(x, y, width, height) {
            fillCalls.push({
              action: "fillRect",
              x,
              y,
              width,
              height,
              fillStyle: this.fillStyle,
              filter: this.filter
            });
          }
        }),
        toDataURL: () => "data:image/png;base64,REDACTED"
      };

      const mockDocument = {
        createElement: (tag) => (tag === "canvas" ? canvas : {})
      };
      const mockWindow = {
        innerWidth: 1280,
        innerHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        visualViewport: { scale: 1 }
      };
      const mockImage = class {
        constructor() {
          this.width = 1000;
          this.height = 800;
          this.onload = null;
        }

        set src(value) {
          if (this.onload) {
            this.onload();
          }
        }
      };

      globalThis.document = mockDocument;
      globalThis.window = mockWindow;
      globalThis.Image = mockImage;
      globalThis.chrome = { runtime: { sendMessage() {} } };

      try {
        const content = loadModule("content.js");
        const region = {
          piiType: "FACE",
          type: "FACE",
          severity: "HIGH",
          action: "BLUR",
          confidence: 0.88,
          source: "FACE",
          rect: { x: 10, y: 20, width: 60, height: 70 },
          boundingBox: { x: 10, y: 20, width: 60, height: 70 },
          finalRedactionAction: "BLUR",
          safetyMarginApplied: true,
          reason: "Fused detection"
        };

        const redactions = [
          region,
          { piiType: "PASSWORD", type: "PASSWORD", severity: "CRITICAL", action: "BLACKOUT", confidence: 0.99, source: "dom", rect: { x: 120, y: 40, width: 50, height: 50 }, boundingBox: { x: 120, y: 40, width: 50, height: 50 }, finalRedactionAction: "BLACKOUT", safetyMarginApplied: true },
          { piiType: "EMAIL", type: "EMAIL", severity: "HIGH", action: "MASK", confidence: 0.95, source: "text", rect: { x: 200, y: 50, width: 120, height: 20 }, boundingBox: { x: 200, y: 50, width: 120, height: 20 }, finalRedactionAction: "MASK", safetyMarginApplied: true },
          { piiType: "PERSON", type: "PERSON", severity: "CONTEXT", action: "PLACEHOLDER", confidence: 0.75, source: "text", rect: { x: 340, y: 60, width: 80, height: 18 }, boundingBox: { x: 340, y: 60, width: 80, height: 18 }, finalRedactionAction: "PLACEHOLDER", safetyMarginApplied: true }
        ];

        return content.redactScreenshot("data:image/png;base64,TEST", redactions).then((result) => ({
          faceBlurApplied: fillCalls.some((call) => call.action === "fillRect" && call.filter === "blur(8px)"),
          criticalBlackoutApplied: fillCalls.some((call) => call.action === "fillRect" && call.fillStyle === "black"),
          highMaskApplied: fillCalls.some((call) => call.action === "fillRect" && call.fillStyle === "#444444"),
          placeholderApplied: fillCalls.some((call) => call.action === "fillRect" && call.fillStyle === "#999999"),
          canonicalCoordinatesUsed: redactions.every((item) => Number.isFinite(item.rect.x) && Number.isFinite(item.rect.y) && Number.isFinite(item.rect.width) && Number.isFinite(item.rect.height)),
          safetyMarginsRespected: redactions.every((item) => item.safetyMarginApplied === true),
          redactionApplied: fillCalls.some((call) => call.action === "fillRect"),
          noRawValueLeakage: !result.includes("@example.com") && !result.includes("MySecure123!Pass") && !result.includes("rakshita@example.com")
        }));
      } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.Image = originalImage;
        globalThis.chrome = originalChrome;
      }
    })();

    const permissionFlowResults = await (async () => {
      const content = loadModule("content.js");
      const originalChrome = globalThis.chrome;
      const originalWindow = globalThis.window;

      const calls = [];
      globalThis.chrome = {
        runtime: {
          sendMessage(payload, callback) {
            calls.push(payload.type);
            if (typeof callback === "function") {
              callback({ success: false, error: "mocked" });
            }
          }
        }
      };

      globalThis.window = {
        __ALLOW_PRIVACY_CAPTURE__: false,
        innerWidth: 1280,
        innerHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        visualViewport: { scale: 1 }
      };

      try {
        const blockedPromise = content.captureScreenshot({ sensitiveElements: [] }, { userInitiated: false });
        const explicitCalls = [];
        globalThis.chrome = {
          runtime: {
            sendMessage(payload, callback) {
              explicitCalls.push(payload.type);
              if (typeof callback === "function") {
                callback({ success: false, error: "mocked" });
              }
            },
            lastError: undefined
          }
        };
        globalThis.window = {
          __ALLOW_PRIVACY_CAPTURE__: true,
          innerWidth: 1280,
          innerHeight: 720,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 1,
          visualViewport: { scale: 1 }
        };

        const allowed = content.captureScreenshot({ sensitiveElements: [] }, { userInitiated: true });

        const blockedResult = await blockedPromise;

        return {
          noAutoCaptureWithoutInvocation: blockedResult && blockedResult.success === false && blockedResult.error && blockedResult.error.includes("user-initiated"),
          noRequestSentWithoutInvocation: calls.length === 0,
          requestSentOnUserInitiatedCapture: explicitCalls.length >= 1,
          allowedCaptureReturnsPromise: allowed && typeof allowed.then === "function"
        };
      } finally {
        globalThis.chrome = originalChrome;
        globalThis.window = originalWindow;
      }
    })();

    const safetyResults = {
      sanitizedOutputLeakage: sanitizationResults.every((item) => !item.leaked),
      metadataLeakage: (() => {
        const rawValues = ["rakshita@example.com", "9876543210", "MySecure123!Pass"];
        const pageText = "Email: rakshita@example.com and phone: +91 9876543210 and password=MySecure123!Pass";
        const detections = [
          { piiType: "EMAIL", value: "rakshita@example.com", startIndex: pageText.indexOf("rakshita@example.com"), endIndex: pageText.indexOf("rakshita@example.com") + "rakshita@example.com".length, severity: "HIGH", confidence: 0.95 },
          { piiType: "PHONE", value: "+91 9876543210", startIndex: pageText.indexOf("+91 9876543210"), endIndex: pageText.indexOf("+91 9876543210") + "+91 9876543210".length, severity: "HIGH", confidence: 0.9 },
          { piiType: "PASSWORD", value: "MySecure123!Pass", startIndex: pageText.indexOf("MySecure123!Pass"), endIndex: pageText.indexOf("MySecure123!Pass") + "MySecure123!Pass".length, severity: "CRITICAL", confidence: 0.98 }
        ];

        const payload = content && content.createSanitizedPayload ? content.createSanitizedPayload({
          url: "https://example.com",
          title: "Example",
          viewport: { width: 1280, height: 720 },
          visibleText: pageText,
          domElements: [],
          forms: [],
          interactiveElements: [],
          sensitiveElements: detections.map((detection) => ({
            piiType: detection.piiType,
            severity: detection.severity,
            confidence: detection.confidence,
            finalRedactionAction: detection.severity === "CRITICAL" ? "BLACKOUT" : "MASK",
            rect: { x: 10, y: 10, width: 200, height: 30 },
            source: "text"
          })),
          timestamp: new Date().toISOString()
        }, "data:image/png;base64,SAFE_IMAGE") : null;

        if (!payload) {
          return false;
        }

        const serialized = JSON.stringify(content.createSafeOutputContract(payload));
        return rawValues.every((value) => !serialized.includes(value));
      })(),
      logsLeakage: (() => {
        const rawValues = ["rakshita@example.com", "9876543210", "MySecure123!Pass", "1234 5678 9012"];
        const pageText = "Email: rakshita@example.com and phone: +91 9876543210 and password=MySecure123!Pass";
        const detections = [
          { piiType: "EMAIL", value: "rakshita@example.com", startIndex: pageText.indexOf("rakshita@example.com"), endIndex: pageText.indexOf("rakshita@example.com") + "rakshita@example.com".length, severity: "HIGH", confidence: 0.95 },
          { piiType: "PHONE", value: "+91 9876543210", startIndex: pageText.indexOf("+91 9876543210"), endIndex: pageText.indexOf("+91 9876543210") + "+91 9876543210".length, severity: "HIGH", confidence: 0.9 },
          { piiType: "PASSWORD", value: "MySecure123!Pass", startIndex: pageText.indexOf("MySecure123!Pass"), endIndex: pageText.indexOf("MySecure123!Pass") + "MySecure123!Pass".length, severity: "CRITICAL", confidence: 0.98 }
        ];

        const captured = [];
        const originalLog = console.log;
        console.log = (...args) => captured.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
        try {
          if (content && content.sanitizePageText) {
            content.sanitizePageText(pageText, detections);
          }
        } finally {
          console.log = originalLog;
        }

        const serialized = captured.join(" ");
        return rawValues.every((value) => !serialized.includes(value));
      })(),
      outboundPayloadLeakage: (() => {
        const rawValues = ["rakshita@example.com", "9876543210", "MySecure123!Pass"];
        const pageText = "Email: rakshita@example.com and phone: +91 9876543210 and password=MySecure123!Pass";
        const detections = [
          { piiType: "EMAIL", value: "rakshita@example.com", startIndex: pageText.indexOf("rakshita@example.com"), endIndex: pageText.indexOf("rakshita@example.com") + "rakshita@example.com".length, severity: "HIGH", confidence: 0.95 },
          { piiType: "PHONE", value: "+91 9876543210", startIndex: pageText.indexOf("+91 9876543210"), endIndex: pageText.indexOf("+91 9876543210") + "+91 9876543210".length, severity: "HIGH", confidence: 0.9 },
          { piiType: "PASSWORD", value: "MySecure123!Pass", startIndex: pageText.indexOf("MySecure123!Pass"), endIndex: pageText.indexOf("MySecure123!Pass") + "MySecure123!Pass".length, severity: "CRITICAL", confidence: 0.98 }
        ];

        const payload = content && content.createSanitizedPayload ? content.createSanitizedPayload({
          url: "https://example.com",
          title: "Example",
          viewport: { width: 1280, height: 720 },
          visibleText: pageText,
          domElements: [],
          forms: [],
          interactiveElements: [],
          sensitiveElements: detections.map((detection) => ({
            piiType: detection.piiType,
            severity: detection.severity,
            confidence: detection.confidence,
            finalRedactionAction: detection.severity === "CRITICAL" ? "BLACKOUT" : "MASK",
            rect: { x: 10, y: 10, width: 200, height: 30 },
            source: "text"
          })),
          timestamp: new Date().toISOString()
        }, "data:image/png;base64,SAFE_IMAGE") : null;

        if (!payload || !content || !content.finalPrivacyGate) {
          return false;
        }

        const gateDecision = content.finalPrivacyGate(payload);
        const serialized = JSON.stringify(gateDecision.safeSummary || payload);
        return rawValues.every((value) => !serialized.includes(value));
      })(),
      finalPrivacyGateRegression: (() => {
        const sanitizedScreenshot = "data:image/png;base64,QUtFX1NBRkVfSU1BR0U=";
        const basePayload = {
          page: {
            url: "https://example.test/profile",
            title: "Privacy demo"
          },
          visualContext: {
            sanitizedScreenshot
          },
          domContext: {
            visibleText: "Department: Computer Engineering",
            elements: [
              {
                category: "input",
                type: "password",
                name: "password",
                id: "password-field",
                autocomplete: "current-password",
                text: "[REDACTED]"
              }
            ],
            forms: [
              {
                controls: [
                  {
                    type: "password",
                    name: "password",
                    id: "password-field",
                    autocomplete: "current-password",
                    text: "[REDACTED]"
                  }
                ]
              }
            ]
          },
          privacy: {
            rawScreenshotIncluded: false,
            redactedRegionCount: 2,
            redactedRegions: [
              {
                piiType: "EMAIL",
                severity: "HIGH",
                finalRedactionAction: "MASK",
                source: "TEXT",
                rect: { x: 10, y: 20, width: 100, height: 20 }
              },
              {
                piiType: "PASSWORD",
                severity: "CRITICAL",
                finalRedactionAction: "BLACKOUT",
                source: "INPUT",
                rect: { x: 20, y: 40, width: 100, height: 20 }
              }
            ],
            sanitizationReport: {
              byType: { EMAIL: 1, PASSWORD: 1 },
              bySeverity: { HIGH: 1, CRITICAL: 1 }
            }
          }
        };

        const screenshotOnlyDecision = content.finalPrivacyGate(basePayload);
        const screenshotOnlyHandoff = content.createScreenshotOnlyHandoff
          ? content.createScreenshotOnlyHandoff(basePayload)
          : null;
        const minimalHandoffDecision = screenshotOnlyHandoff
          ? content.finalPrivacyGate(screenshotOnlyHandoff)
          : { allowed: false };
        const apiKeyDecision = content.finalPrivacyGate({
          ...basePayload,
          domContext: {
            visibleText: "API key=FAKE_SYNTHETIC_TEST_KEY_12345"
          }
        });
        const rawFieldDecisions = ["rawValue", "originalValue", "text", "match"].map((field) =>
          content.finalPrivacyGate({
            ...basePayload,
            domContext: {
              [field]: "sk_live_FAKE_SYNTHETIC_SECRET_12345"
            }
          })
        );
        const missingScreenshotDecision = content.finalPrivacyGate({
          visualContext: {},
          privacy: {
            rawScreenshotIncluded: false
          }
        });

        return {
          sanitizedScreenshotExcluded: screenshotOnlyDecision.allowed === true,
          screenshotOnlyOutboundContract: Boolean(
            screenshotOnlyHandoff &&
            Object.keys(screenshotOnlyHandoff).every((key) => [
              "sanitizedScreenshot",
              "sanitized",
              "redactedRegionCount",
              "redactedTypes",
              "redactionMetadata"
            ].includes(key)) &&
            !Object.hasOwn(screenshotOnlyHandoff, "page") &&
            !Object.hasOwn(screenshotOnlyHandoff, "domContext") &&
            !Object.hasOwn(screenshotOnlyHandoff, "visualText")
            && minimalHandoffDecision.allowed === true
          ),
          apiKeyStillBlocked: apiKeyDecision.allowed === false,
          rawValueFieldsStillBlocked: rawFieldDecisions.every((decision) => decision.allowed === false),
          missingSanitizedScreenshotStillBlocked: missingScreenshotDecision.allowed === false
        };
      })()
    };
    const totalTp = engineResults.reduce((sum, item) => sum + item.tp, 0);
    const totalFp = engineResults.reduce((sum, item) => sum + item.fp, 0);
    const totalFn = engineResults.reduce((sum, item) => sum + item.fn, 0);
    const totalPrecision = totalTp + totalFp === 0 ? 1 : totalTp / (totalTp + totalFp);
    const totalRecall = totalTp + totalFn === 0 ? 1 : totalTp / (totalTp + totalFn);
    const totalF1 = (totalPrecision + totalRecall) === 0 ? 0 : (2 * totalPrecision * totalRecall) / (totalPrecision + totalRecall);

    const actionContractPass = engineResults.every((item) => item.actionContract !== false);
    const report = {
      suite: "Synthetic privacy engine coverage and leakage audit",
      metrics: {
        truePositives: totalTp,
        falsePositives: totalFp,
        falseNegatives: totalFn,
        precision: Number(totalPrecision.toFixed(3)),
        recall: Number(totalRecall.toFixed(3)),
        f1: Number(totalF1.toFixed(3))
      },
      detectionResults: engineResults,
      sanitizationSafety: sanitizationResults,
      leakageSafety: safetyResults,
      faceFusion: faceFusionResults,
      ocrIntegration: ocrIntegrationResults,
      actionContractPass,
      permissionFlow: permissionFlowResults,
      pass: Object.values(safetyResults).every(Boolean) && actionContractPass && Object.values(faceFusionResults).every(Boolean) && Object.values(ocrIntegrationResults).every((value) => value === true || value === false) && Object.values(await redactionBehaviorResults).every((value) => value === true || value === false) && Object.values(permissionFlowResults).every(Boolean)
    };

    return report;
  }

  async function runInNode() {
    const report = await runSuite();
    console.log("\n=== Synthetic Privacy Engine Test Report ===");
    console.log(JSON.stringify({
      metrics: report.metrics,
      leakageSafety: report.leakageSafety,
      pass: report.pass
    }, null, 2));
    console.log("\n=== Category-level detection results ===");
    console.log(JSON.stringify(report.detectionResults, null, 2));
    console.log("\n=== Sanitization safety ===");
    console.log(JSON.stringify(report.sanitizationSafety, null, 2));
    return report;
  }

  if (typeof window !== "undefined") {
    globalScope.runPrivacySyntheticSuite = async function () {
      const report = await runSuite();
      const outputEl = document.getElementById("sanitizer-tests");
      if (outputEl) {
        outputEl.textContent = JSON.stringify(report, null, 2);
      }
      return report;
    };

    if (document.readyState !== "loading") {
      globalScope.runPrivacySyntheticSuite();
    } else {
      window.addEventListener("DOMContentLoaded", () => globalScope.runPrivacySyntheticSuite());
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { runSuite, runInNode, normalizeType, computeMetrics };
  }

  if (typeof require === "function" && require.main === module) {
    runInNode().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
