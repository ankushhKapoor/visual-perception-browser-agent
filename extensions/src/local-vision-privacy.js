import { FaceDetector, FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { createWorker } from "tesseract.js";

// Both the model and WASM runtime are extension files. No image, page text, or
// model request leaves the browser while a local privacy scan is running.
const FACE_MODEL_PATH = "assets/models/face_landmarker.task";
const FACE_BOX_MODEL_PATH = "assets/models/blaze_face_short_range.tflite";

let faceLandmarkerPromise;
let faceBoxDetectorPromise;
let mediaPipeFactoryPromise;
let ocrWorkerPromise;

function reportProgress(text) {
  try {
    chrome.runtime.sendMessage({ type: "VPBA_PRIVACY_SCAN_PROGRESS", text });
  } catch {
    // The scan remains local even if the extension UI was closed.
  }
}

async function loadImage(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

function landmarksToFaceRect(landmarks, imageWidth, imageHeight) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) return null;
  const xValues = landmarks.map((point) => point.x).filter(Number.isFinite);
  const yValues = landmarks.map((point) => point.y).filter(Number.isFinite);
  if (xValues.length === 0 || yValues.length === 0) return null;

  const left = Math.min(...xValues) * imageWidth;
  const top = Math.min(...yValues) * imageHeight;
  const right = Math.max(...xValues) * imageWidth;
  const bottom = Math.max(...yValues) * imageHeight;
  const width = right - left;
  const height = bottom - top;
  // Landmark contours are tight around the skin. Expand their region so hair,
  // jawline and slight detector variance remain protected in the final image.
  const horizontalPadding = Math.max(5, width * 0.16);
  const verticalPadding = Math.max(5, height * 0.22);
  const x = Math.max(0, Math.floor(left - horizontalPadding));
  const y = Math.max(0, Math.floor(top - verticalPadding));
  const endX = Math.min(imageWidth, Math.ceil(right + horizontalPadding));
  const endY = Math.min(imageHeight, Math.ceil(bottom + verticalPadding));
  return { x, y, width: Math.max(0, endX - x), height: Math.max(0, endY - y) };
}

function reliableFaceBoxToRect(box, imageWidth, imageHeight) {
  const originX = box?.originX ?? box?.xmin ?? 0;
  const originY = box?.originY ?? box?.ymin ?? 0;
  const width = box?.width ?? ((box?.xmax ?? 0) - originX);
  const height = box?.height ?? ((box?.ymax ?? 0) - originY);
  const aspectRatio = width / Math.max(1, height);
  // The fallback exists only for clear, face-shaped detections in an
  // individual image crop. These guards reject the huge/low-confidence boxes
  // that caused scenery and full image cards to be blurred previously.
  if (width < 24 || height < 24 || aspectRatio < 0.48 || aspectRatio > 1.45) return null;
  if (width > imageWidth * 0.68 || height > imageHeight * 0.76) return null;
  const paddingX = Math.max(4, width * 0.13);
  const paddingY = Math.max(4, height * 0.18);
  const x = Math.max(0, Math.floor(originX - paddingX));
  const y = Math.max(0, Math.floor(originY - paddingY));
  const endX = Math.min(imageWidth, Math.ceil(originX + width + paddingX));
  const endY = Math.min(imageHeight, Math.ceil(originY + height + paddingY));
  return { x, y, width: Math.max(0, endX - x), height: Math.max(0, endY - y) };
}

function intersectionOverUnion(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = first.width * first.height + second.width * second.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function uniqueFaceRects(rects) {
  const result = [];
  for (const rect of rects) {
    if (!rect || rect.width < 12 || rect.height < 12) continue;
    if (!result.some((existing) => intersectionOverUnion(existing, rect) >= 0.42)) {
      result.push(rect);
    }
  }
  return result;
}

function getVisibleImageTiles(screenshot) {
  const scaleX = screenshot.width / window.innerWidth;
  const scaleY = screenshot.height / window.innerHeight;
  const tiles = [];
  for (const element of document.images) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    if (rect.width < 64 || rect.height < 64) continue;
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 64 || bottom - top < 64) continue;
    tiles.push({
      x: Math.round(left * scaleX),
      y: Math.round(top * scaleY),
      width: Math.round((right - left) * scaleX),
      height: Math.round((bottom - top) * scaleY),
    });
  }
  // Scan the largest visible cards first. These are the images most likely to
  // contain personal photos; a bounded count keeps inference browser-friendly.
  return tiles
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 14);
}

function makeTileCanvas(image, tile) {
  const canvas = document.createElement("canvas");
  canvas.width = tile.width;
  canvas.height = tile.height;
  canvas.getContext("2d")?.drawImage(
    image, tile.x, tile.y, tile.width, tile.height,
    0, 0, tile.width, tile.height
  );
  return canvas;
}

function modelRegion(category, rect, source = "LOCAL_MODEL") {
  return {
    category,
    severity: category === "FACE" ? "HIGH" : "MEDIUM",
    source,
    rect,
    reason: "client-side local vision model",
  };
}

async function getOcrWorker() {
  ocrWorkerPromise ||= (async () => {
    reportProgress("Loading bundled local OCR engine…");
    const extensionUrl = (path) => chrome.runtime.getURL(path);
    return createWorker(["eng", "hin"], 1, {
      workerPath: extensionUrl("assets/tesseract/worker.min.js"),
      corePath: extensionUrl("assets/tesseract/core"),
      langPath: extensionUrl("assets/tessdata-best"),
      gzip: false,
      // Do not reuse a browser-cached fast English model from earlier builds.
      // The high-accuracy local English+Hindi files are used on every scan.
      cacheMethod: "none",
      logger: () => {},
    });
  })();
  return ocrWorkerPromise;
}

function ocrLineRegion(line, category, image, scale = 1, offsetX = 0, offsetY = 0) {
  const box = line?.bbox;
  if (!box) return null;
  const x = Math.max(0, Math.floor(box.x0 / scale + offsetX - 4));
  const y = Math.max(0, Math.floor(box.y0 / scale + offsetY - 3));
  const right = Math.min(image.width, Math.ceil(box.x1 / scale + offsetX + 4));
  const bottom = Math.min(image.height, Math.ceil(box.y1 / scale + offsetY + 3));
  return right > x && bottom > y
    ? modelRegion(category, { x, y, width: right - x, height: bottom - y }, "LOCAL_OCR")
    : null;
}

function classifyDocumentLine(text, nextText = "") {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const lower = value.toLowerCase();
  if (!value) return null;
  if (/(?:\d[\s-]?){12,16}/.test(value) || /\b[a-z]{5}\d{4}[a-z]\b/i.test(value)) return "GOVERNMENT_ID";
  if (/\b(?:dob|date of birth|born)\b/.test(lower) || /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(value)) return "DATE_OF_BIRTH";
  if (/\b(?:address|s\/?o|d\/?o|c\/?o|nagar|colony|street|road|district|village|ward|pincode|pin code)\b/i.test(value) || /\b\d{6}\b/.test(value)) return "ADDRESS";
  // On government cards a title-cased two/three-word line immediately before
  // DOB is the cardholder name, even when the document has no English label.
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(value)
      && /\b(?:dob|date of birth|born)\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i.test(nextText)) {
    return "PERSON";
  }
  return null;
}

function documentZone(category, target, image, x, y, width, height, source = "DOCUMENT_LAYOUT") {
  const rect = {
    x: Math.max(0, Math.round(target.x + target.width * x)),
    y: Math.max(0, Math.round(target.y + target.height * y)),
    width: Math.round(target.width * width),
    height: Math.round(target.height * height),
  };
  return modelRegion(category, rect, source);
}

function aadhaarLayoutFallback(text, target, image) {
  const value = String(text || "").toLowerCase();
  const isAadhaar = /aadhaar|aadhar|unique identification|government of india/.test(value);
  if (!isAadhaar) return [];

  const hasAddress = /\baddress\b|\bs\/?o\b|\bd\/?o\b|\bc\/?o\b|\b\d{6}\b/.test(value);
  const hasFrontIdentity = /\bdob\b|date of birth|female|male|vid/.test(value);
  const regions = [];

  // A card's layout is stable enough to be a safe fallback after OCR has
  // established it is an Aadhaar/Government-ID card. These zones cover only
  // personal data—not the entire document, logo, or QR code.
  if (hasFrontIdentity) {
    regions.push(documentZone("FACE", target, image, 0.05, 0.20, 0.29, 0.48));
    regions.push(documentZone("PERSON", target, image, 0.31, 0.20, 0.47, 0.28));
    regions.push(documentZone("GOVERNMENT_ID", target, image, 0.28, 0.68, 0.48, 0.18));
  }
  if (hasAddress) {
    regions.push(documentZone("ADDRESS", target, image, 0.04, 0.28, 0.58, 0.48));
    regions.push(documentZone("GOVERNMENT_ID", target, image, 0.28, 0.76, 0.48, 0.14));
  }
  return regions;
}

async function detectDocumentPii(image) {
  const worker = await getOcrWorker();
  const visibleImages = getVisibleImageTiles(image)
    .filter((tile) => tile.width >= 180 && tile.height >= 120)
    .slice(0, 4);
  const targets = visibleImages.length > 0
    ? visibleImages
    : [{ x: 0, y: 0, width: image.width, height: image.height }];
  reportProgress(`Reading ${targets.length} document image${targets.length === 1 ? "" : "s"} locally for PII redaction…`);
  const regions = [];
  for (const target of targets) {
    // Honour a stop request between tiles so the UI is never stuck.
    if (window.vpbaCancelCapture) break;
    const source = makeTileCanvas(image, target);
    const scale = Math.min(3, Math.max(1, 1600 / Math.max(source.width, source.height)));
    const enlarged = document.createElement("canvas");
    enlarged.width = Math.round(source.width * scale);
    enlarged.height = Math.round(source.height * scale);
    enlarged.getContext("2d")?.drawImage(source, 0, 0, enlarged.width, enlarged.height);
    const { data } = await worker.recognize(enlarged);
    const lines = data.lines || [];
    for (let index = 0; index < lines.length; index += 1) {
      const category = classifyDocumentLine(lines[index]?.text, lines[index + 1]?.text);
      const region = category
        ? ocrLineRegion(lines[index], category, image, scale, target.x, target.y)
        : null;
      if (region) regions.push(region);
      // Addresses on Aadhaar cards usually span several lines. Once an address
      // marker is recognized, protect its following nearby lines as well.
      if (category === "ADDRESS") {
        for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
          const continuation = ocrLineRegion(lines[next], "ADDRESS", image, scale, target.x, target.y);
          if (continuation) regions.push(continuation);
        }
      }
    }
    const fallbackRegions = aadhaarLayoutFallback(data.text, target, image);
    if (fallbackRegions.length > 0) {
      regions.push(...fallbackRegions);
    }
  }
  return regions;
}

async function getFaceLandmarker() {
  faceLandmarkerPromise ||= (async () => {
    reportProgress("Loading bundled MediaPipe WASM runtime…");
    // FilesetResolver injects a classic script into the page world. Content
    // scripts run in an isolated world, so that script's ModuleFactory is not
    // visible here and MediaPipe reports "ModuleFactory not set". Import the
    // official ES module directly into this extension world first.
    mediaPipeFactoryPromise ||= import(
      /* @vite-ignore */ chrome.runtime.getURL("assets/mediapipe-wasm/vision_wasm_module_internal.js")
    );
    await mediaPipeFactoryPromise;
    if (typeof globalThis.ModuleFactory !== "function") {
      throw new Error("Bundled MediaPipe module did not expose ModuleFactory");
    }
    const wasmRoot = chrome.runtime.getURL("assets/mediapipe-wasm");
    const fileset = await FilesetResolver.forVisionTasks(wasmRoot);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL(FACE_MODEL_PATH) },
      runningMode: "IMAGE",
      numFaces: 20,
      minFaceDetectionConfidence: 0.35,
      minFacePresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
  })();
  return faceLandmarkerPromise;
}

async function getFaceBoxDetector() {
  faceBoxDetectorPromise ||= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL("assets/mediapipe-wasm")
    );
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL(FACE_BOX_MODEL_PATH) },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.60,
      minSuppressionThreshold: 0.45,
    });
  })();
  return faceBoxDetectorPromise;
}

async function detectFaces(image) {
  const [faceLandmarker, faceBoxDetector] = await Promise.all([
    getFaceLandmarker(),
    getFaceBoxDetector(),
  ]);
  const fullFrame = faceLandmarker.detect(image);
  const rects = (fullFrame.faceLandmarks || [])
    .map((landmarks) => landmarksToFaceRect(landmarks, image.width, image.height));

  const tiles = getVisibleImageTiles(image);
  if (tiles.length > 0) reportProgress(`Checking ${tiles.length} visible image cards locally for faces…`);
  for (const tile of tiles) {
    if (window.vpbaCancelCapture) break; // stop between image tiles
    const tileCanvas = makeTileCanvas(image, tile);
    const tileResult = faceLandmarker.detect(tileCanvas);
    for (const landmarks of tileResult.faceLandmarks || []) {
      const rect = landmarksToFaceRect(landmarks, tile.width, tile.height);
      if (rect) rects.push({ ...rect, x: rect.x + tile.x, y: rect.y + tile.y });
    }
    // A strict, independent detector catches clear portraits which may not
    // produce all 3D landmarks. It is deliberately limited to image crops.
    const boxResult = faceBoxDetector.detect(tileCanvas);
    for (const detection of boxResult.detections || []) {
      const rect = reliableFaceBoxToRect(detection.boundingBox, tile.width, tile.height);
      if (rect) rects.push({ ...rect, x: rect.x + tile.x, y: rect.y + tile.y });
    }
  }
  return uniqueFaceRects(rects);
}

/**
 * Analyze a captured screen entirely in the browser. The returned regions are
 * image-pixel coordinates and must be merged with DOM regions before canvas
 * redaction. Object/OCR labels are intentionally summary-only: no recognized
 * screen text is returned to the server.
 */
export async function inspectScreenshotLocally(dataUrl, classifySensitiveText) {
  reportProgress("Analyzing screenshot locally. No screenshot is being uploaded.");
  const image = await loadImage(dataUrl);
  let faces = [];
  let ocrRegions = [];
  let faceRuntime = "MediaPipe Face Landmarker Lite (bundled WASM)";
  let faceDetectionFailed = false;
  if (window.vpbaCancelCapture) return {
    regions: [], image: { width: image.width, height: image.height },
    visualContext: { provider: faceRuntime, objects: [], facesDetected: 0, faceDetectionFailed: false, ocrPiiDetected: false },
  };
  try {
    faces = await detectFaces(image);
  } catch (error) {
    // Keep DOM/regex redaction usable if the optional visual model fails. This
    // avoids replacing the whole page with black while exposing the exact
    // reason in the extension status/console for diagnosis.
    faceRuntime = "DOM/regex privacy fallback (face landmarker unavailable)";
    faceDetectionFailed = true;
    reportProgress("Face detector unavailable; continuing with DOM and OCR privacy redaction.");
  }
  try {
    ocrRegions = await detectDocumentPii(image);
  } catch {
    // OCR is additive; face/DOM redaction still completes if a browser blocks
    // a worker on a particular page.
  }
  const faceRegions = faces
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => modelRegion("FACE", rect));

  return {
    regions: [...faceRegions, ...ocrRegions],
    image: { width: image.width, height: image.height },
    visualContext: {
      provider: faceRuntime,
      objects: [],
      facesDetected: faceRegions.length,
      faceDetectionFailed,
      ocrPiiDetected: ocrRegions.length > 0,
    },
  };
}
