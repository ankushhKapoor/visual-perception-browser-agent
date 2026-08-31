/**
 * Privacy Fusion Engine
 * Fuses privacy detections from multiple sources into final privacy decisions.
 * Handles normalization, spatial fusion, severity priority, and redaction action selection.
 */

const SEVERITY_PRIORITY = {
  CRITICAL: 3,
  HIGH: 2,
  CONTEXT: 1,
  CONTEXT_DEPENDENT: 1
};

/**
 * Normalize a detection from any source to standard format
 * @param {Object} detection - Detection with any schema
 * @param {string} source - Source type: 'dom', 'text', 'ocr', 'ml', 'face'
 * @returns {Object} - Normalized detection
 */
function normalizeDetection(detection, source = 'dom') {
  if (!detection) return null;

  const normalizedSource = String(detection.source || source || 'dom').toUpperCase();
  const normalizedType = detection.piiType || detection.type || 'UNKNOWN';
  const normalizedSeverity = detection.severity || 'CONTEXT';
  const normalizedAction = detection.action || detection.finalRedactionAction || detection.recommendedAction || 'PLACEHOLDER';
  const safeRect = normalizeRect(detection.rect || detection.boundingBox || detection.box || detection.bbox);
  const safeId = detection.safeId || detection.elementId || detection.id || `safe_${Math.random().toString(16).slice(2, 10)}`;

  // If already normalized (has required fields), return as-is
  if (
    detection.normalized === true &&
    detection.piiType &&
    detection.severity &&
    detection.confidence !== undefined
  ) {
    return {
      ...detection,
      safeId: detection.safeId || safeId,
      source: normalizedSource,
      piiType: normalizedType,
      severity: normalizedSeverity,
      action: detection.action || detection.finalRedactionAction || detection.recommendedAction || normalizedAction,
      rect: normalizeRect(detection.rect || detection.boundingBox || detection.box || detection.bbox),
      boundingBox: normalizeRect(detection.rect || detection.boundingBox || detection.box || detection.bbox),
      safeElementId: detection.safeId || safeId,
      originalSource: detection.source || source
    };
  }

  const normalized = {
    normalized: true,
    safeId,
    safeElementId: safeId,
    source: normalizedSource,
    piiType: normalizedType,
    type: normalizedType,
    severity: normalizedSeverity,
    action: normalizedAction,
    confidence: detection.confidence !== undefined ? detection.confidence : 0.5,
    rect: safeRect,
    boundingBox: safeRect,
    reason: detection.reason || detection.classificationReason || '',
    recommendedAction: normalizedAction,
    finalRedactionAction: normalizedAction,
    originalSource: detection.source || source,
    value: null,
    text: null,
    match: null,
    startIndex: detection.startIndex,
    endIndex: detection.endIndex,
    sources: [normalizedSource]
  };

  return normalized;
}

/**
 * Normalize rectangle coordinates
 * @param {Object} rect - Rectangle with x, y, width, height
 * @returns {Object} - Normalized rectangle
 */
function normalizeRect(rect) {
  if (!rect) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    x: Math.round(rect.x || 0),
    y: Math.round(rect.y || 0),
    width: Math.round(rect.width || 0),
    height: Math.round(rect.height || 0)
  };
}

/**
 * Canonical coordinate system used for screenshot redaction:
 * all boxes are represented in screenshot-pixel space with origin at the top-left of the
 * captured screenshot canvas. DOM rects, viewport coordinates, OCR boxes, and face boxes are
 * converted into this same space before redaction is applied.
 *
 * CSS pixels from DOM.getBoundingClientRect() are not identical to screenshot pixels because of
 * browser zoom, devicePixelRatio, and viewport scaling. This canonical system keeps all sources
 * internally consistent so they can be fused and redacted without mixing coordinate units.
 */
function getScreenshotMetrics(options = {}) {
  const viewportWidth = options.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
  const viewportHeight = options.viewportHeight ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
  const screenshotWidth = options.screenshotWidth ?? (options.width ?? viewportWidth);
  const screenshotHeight = options.screenshotHeight ?? (options.height ?? viewportHeight);
  const scrollX = options.scrollX ?? (typeof window !== 'undefined' ? window.scrollX || 0 : 0);
  const scrollY = options.scrollY ?? (typeof window !== 'undefined' ? window.scrollY || 0 : 0);
  const devicePixelRatio = options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const zoomScale = options.zoomScale ?? (typeof window !== 'undefined' && window.visualViewport ? window.visualViewport.scale : 1);

  const cssToScreenshotScaleX = screenshotWidth / Math.max(1, viewportWidth * zoomScale);
  const cssToScreenshotScaleY = screenshotHeight / Math.max(1, viewportHeight * zoomScale);

  return {
    viewportWidth,
    viewportHeight,
    screenshotWidth,
    screenshotHeight,
    scrollX,
    scrollY,
    devicePixelRatio,
    zoomScale,
    cssToScreenshotScaleX,
    cssToScreenshotScaleY,
    screenshotScaleX: cssToScreenshotScaleX,
    screenshotScaleY: cssToScreenshotScaleY
  };
}

/**
 * Clamp a rectangle so it stays within screenshot boundaries.
 * @param {Object} rect - {x, y, width, height}
 * @param {number} maxWidth - screenshot width
 * @param {number} maxHeight - screenshot height
 * @returns {Object} - rect clamped to screenshot bounds
 */
function clampRectToBounds(rect, maxWidth = 0, maxHeight = 0) {
  const safeRect = {
    x: Number.isFinite(rect.x) ? rect.x : 0,
    y: Number.isFinite(rect.y) ? rect.y : 0,
    width: Number.isFinite(rect.width) ? rect.width : 0,
    height: Number.isFinite(rect.height) ? rect.height : 0
  };

  if (safeRect.width < 0) safeRect.width = 0;
  if (safeRect.height < 0) safeRect.height = 0;

  safeRect.x = Math.max(0, Math.min(safeRect.x, Math.max(0, maxWidth - 1)));
  safeRect.y = Math.max(0, Math.min(safeRect.y, Math.max(0, maxHeight - 1)));

  if (maxWidth > 0) {
    safeRect.width = Math.max(0, Math.min(safeRect.width, maxWidth - safeRect.x));
  }

  if (maxHeight > 0) {
    safeRect.height = Math.max(0, Math.min(safeRect.height, maxHeight - safeRect.y));
  }

  return {
    x: Math.round(safeRect.x),
    y: Math.round(safeRect.y),
    width: Math.round(safeRect.width),
    height: Math.round(safeRect.height)
  };
}

/**
 * Convert a DOM viewport rect (CSS pixels) to screenshot pixels.
 * Screenshot creation can be larger than the viewport because of devicePixelRatio and browser zoom,
 * so the conversion uses the viewport size, scroll offsets, and zoom scale before clamping.
 */
function convertDOMRectToScreenshot(rect, options = {}) {
  const metrics = getScreenshotMetrics(options);
  const left = Number.isFinite(rect.left) ? rect.left : (Number.isFinite(rect.x) ? rect.x : 0);
  const top = Number.isFinite(rect.top) ? rect.top : (Number.isFinite(rect.y) ? rect.y : 0);
  const width = Number.isFinite(rect.width) ? rect.width : 0;
  const height = Number.isFinite(rect.height) ? rect.height : 0;

  const viewportLeft = options.viewportLeft ?? 0;
  const viewportTop = options.viewportTop ?? 0;
  const scrollX = options.scrollX ?? metrics.scrollX ?? 0;
  const scrollY = options.scrollY ?? metrics.scrollY ?? 0;

  const pageX = left + viewportLeft + scrollX;
  const pageY = top + viewportTop + scrollY;

  const screenshotRect = {
    x: pageX * metrics.cssToScreenshotScaleX,
    y: pageY * metrics.cssToScreenshotScaleY,
    width: Math.max(0, width * metrics.cssToScreenshotScaleX),
    height: Math.max(0, height * metrics.cssToScreenshotScaleY)
  };

  return clampRectToBounds(screenshotRect, metrics.screenshotWidth, metrics.screenshotHeight);
}

/**
 * OCR and face detections often already arrive in screenshot/image pixel space.
 * We normalize only to enforce clipping and consistent fields.
 */
function convertScreenshotRectToCanonical(rect, options = {}) {
  const metrics = getScreenshotMetrics(options);
  const normalized = {
    x: Number.isFinite(rect.x) ? rect.x : (Number.isFinite(rect.left) ? rect.left : 0),
    y: Number.isFinite(rect.y) ? rect.y : (Number.isFinite(rect.top) ? rect.top : 0),
    width: Number.isFinite(rect.width) ? rect.width : 0,
    height: Number.isFinite(rect.height) ? rect.height : 0
  };

  return clampRectToBounds(normalized, metrics.screenshotWidth, metrics.screenshotHeight);
}

/**
 * Convert any detection rect into the canonical screenshot coordinate system.
 * DOM/viewport rectangles are translated from CSS pixels; OCR/face/image coordinates are treated as
 * screenshot pixels and normalized for clipping.
 */
function convertRectToCanonical(rect, source = 'dom', options = {}) {
  if (!rect) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const normalizedSource = String(source || 'dom').toLowerCase();

  if (['dom', 'viewport', 'input', 'text'].includes(normalizedSource)) {
    return convertDOMRectToScreenshot(rect, options);
  }

  return convertScreenshotRectToCanonical(rect, options);
}

/**
 * Calculate intersection area between two rectangles
 * @param {Object} rect1 - First rectangle
 * @param {Object} rect2 - Second rectangle
 * @returns {number} - Intersection area in pixels
 */
function calculateIntersectionArea(rect1, rect2) {
  const x1 = Math.max(rect1.x, rect2.x);
  const y1 = Math.max(rect1.y, rect2.y);
  const x2 = Math.min(
    rect1.x + rect1.width,
    rect2.x + rect2.width
  );
  const y2 = Math.min(
    rect1.y + rect1.height,
    rect2.y + rect2.height
  );

  if (x2 <= x1 || y2 <= y1) {
    return 0;
  }

  return (x2 - x1) * (y2 - y1);
}

/**
 * Calculate union area of two rectangles
 * @param {Object} rect1 - First rectangle
 * @param {Object} rect2 - Second rectangle
 * @returns {number} - Union area in pixels
 */
function calculateUnionArea(rect1, rect2) {
  const area1 = rect1.width * rect1.height;
  const area2 = rect2.width * rect2.height;
  const intersection = calculateIntersectionArea(rect1, rect2);

  return area1 + area2 - intersection;
}

/**
 * Calculate Intersection over Union (IoU) for spatial overlap
 * @param {Object} rect1 - First rectangle
 * @param {Object} rect2 - Second rectangle
 * @returns {number} - IoU score 0-1
 */
function calculateIoU(rect1, rect2) {
  const intersection = calculateIntersectionArea(rect1, rect2);
  const union = calculateUnionArea(rect1, rect2);

  if (union === 0) return 0;

  return intersection / union;
}

/**
 * Check if two detections are spatially overlapping
 * @param {Object} det1 - First detection
 * @param {Object} det2 - Second detection
 * @param {number} overlapThreshold - IoU threshold (default 0.1)
 * @returns {boolean} - True if overlapping
 */
function isOverlapping(det1, det2, overlapThreshold = 0.1) {
  const iou = calculateIoU(det1.rect, det2.rect);
  return iou >= overlapThreshold;
}

/**
 * Merge two bounding boxes
 * @param {Object} rect1 - First rectangle
 * @param {Object} rect2 - Second rectangle
 * @returns {Object} - Merged rectangle
 */
function mergeRects(rect1, rect2) {
  const x = Math.min(rect1.x, rect2.x);
  const y = Math.min(rect1.y, rect2.y);
  const x2 = Math.max(
    rect1.x + rect1.width,
    rect2.x + rect2.width
  );
  const y2 = Math.max(
    rect1.y + rect1.height,
    rect2.y + rect2.height
  );

  return {
    x: x,
    y: y,
    width: x2 - x,
    height: y2 - y
  };
}

/**
 * Select the strongest detection when multiple overlap the same area
 * Prefers: CRITICAL > HIGH > CONTEXT_DEPENDENT, then highest confidence
 * @param {Array} detections - Array of overlapping detections
 * @returns {Object} - Strongest detection
 */
function selectStrongestDetection(detections) {
  if (detections.length === 0) return null;
  if (detections.length === 1) return detections[0];

  // Sort by severity priority (descending), then confidence (descending)
  const sorted = [...detections].sort((a, b) => {
    const severityDiff =
      (SEVERITY_PRIORITY[b.severity] || 0) -
      (SEVERITY_PRIORITY[a.severity] || 0);

    if (severityDiff !== 0) {
      return severityDiff;
    }

    return b.confidence - a.confidence;
  });

  return sorted[0];
}

/**
 * Fuse overlapping detections in a region
 * Combines spatial detections, prefers strongest by severity + confidence
 * @param {Array} detections - Detections in a region
 * @returns {Object} - Fused detection
 */
function fuseDetectionsInRegion(detections) {
  if (detections.length === 0) return null;

  // Select strongest detection
  const strongest = selectStrongestDetection(detections);

  // Merge all bounding boxes to create union
  let mergedRect = { ...detections[0].rect };
  for (let i = 1; i < detections.length; i++) {
    mergedRect = mergeRects(mergedRect, detections[i].rect);
  }

  // Combine confidence scores: average with bias toward highest
  const avgConfidence =
    detections.reduce((sum, d) => sum + d.confidence, 0) /
    detections.length;
  const maxConfidence = Math.max(
    ...detections.map(d => d.confidence)
  );
  const combinedConfidence =
    avgConfidence * 0.4 + maxConfidence * 0.6;

  // Return strongest with merged rect and boosted confidence
  return {
    ...strongest,
    rect: mergedRect,
    confidence: Math.min(0.99, combinedConfidence),
    fusedCount: detections.length,
    sourceCount: new Set(detections.map(d => d.source)).size
  };
}

/**
 * Apply safety margin to detection bounding box
 * Expands box by percentage to ensure full coverage
 * @param {Object} detection - Detection with rect
 * @param {number} marginPercent - Margin percentage (default 10%)
 * @returns {Object} - Detection with expanded rect
 */
function applySafetyMargin(detection, marginPercent = 0, fixedMargin = 0) {
  const rect = detection.rect || { x: 0, y: 0, width: 0, height: 0 };

  const marginX = Math.max(0, fixedMargin ?? 0);
  const marginY = Math.max(0, fixedMargin ?? 0);
  const expandedX = Math.max(0, Math.round(rect.width * (marginPercent / 100)));
  const expandedY = Math.max(0, Math.round(rect.height * (marginPercent / 100)));

  const finalMarginX = Math.max(marginX, expandedX);
  const finalMarginY = Math.max(marginY, expandedY);

  return {
    ...detection,
    rect: {
      x: Math.max(0, rect.x - finalMarginX),
      y: Math.max(0, rect.y - finalMarginY),
      width: Math.max(1, rect.width + finalMarginX * 2),
      height: Math.max(1, rect.height + finalMarginY * 2)
    },
    safetyMarginApplied: finalMarginX > 0 || finalMarginY > 0,
    safetyMarginPercent: marginPercent,
    safetyMarginPixels: fixedMargin
  };
}

/**
 * Spatially cluster and fuse overlapping detections
 * @param {Array} detections - Array of normalized detections
 * @param {number} overlapThreshold - IoU threshold for overlap (0-1)
 * @returns {Array} - Fused detections
 */
function deduplicateDetections(detections) {
  if (!Array.isArray(detections) || detections.length <= 1) {
    return detections;
  }

  const unique = [];

  for (const detection of detections) {
    const matchIndex = unique.findIndex(existing => {
      if (existing.piiType !== detection.piiType) {
        return false;
      }

      const sameText =
        (existing.text && detection.text && existing.text === detection.text) ||
        (existing.value && detection.value && existing.value === detection.value);

      if (sameText) {
        return true;
      }

      const rectA = existing.rect || { x: 0, y: 0, width: 0, height: 0 };
      const rectB = detection.rect || { x: 0, y: 0, width: 0, height: 0 };
      const centerDelta = Math.hypot(
        (rectA.x + rectA.width / 2) - (rectB.x + rectB.width / 2),
        (rectA.y + rectA.height / 2) - (rectB.y + rectB.height / 2)
      );

      const iou = calculateIoU(rectA, rectB);
      return iou > 0.75 || centerDelta < 12;
    });

    if (matchIndex >= 0) {
      const current = unique[matchIndex];
      const strongerBySeverity = (SEVERITY_PRIORITY[detection.severity] || 0) > (SEVERITY_PRIORITY[current.severity] || 0);
      const strongerByConfidence = (detection.confidence || 0) > (current.confidence || 0);

      if (strongerBySeverity || strongerByConfidence) {
        unique[matchIndex] = {
          ...current,
          ...detection,
          rect: detection.rect || current.rect,
          boundingBox: detection.boundingBox || detection.rect || current.boundingBox || current.rect,
          confidence: Math.max(current.confidence || 0, detection.confidence || 0),
          severity: strongerBySeverity ? detection.severity : current.severity,
          action: strongerBySeverity ? (detection.action || detection.finalRedactionAction || current.action) : (current.action || detection.action || detection.finalRedactionAction),
          source: strongerBySeverity ? (detection.source || current.source) : (current.source || detection.source),
          sources: Array.from(new Set([...(Array.isArray(current.sources) ? current.sources : [current.source]), ...(Array.isArray(detection.sources) ? detection.sources : [detection.source])].filter(Boolean)))
        };
      }
    } else {
      unique.push(detection);
    }
  }

  return unique;
}

function fuseDetectionsByRegion(
  detections,
  overlapThreshold = 0.1
) {
  if (detections.length === 0) return [];
  if (detections.length === 1) return detections;

  const processed = new Set();
  const fusedDetections = [];

  for (let i = 0; i < detections.length; i++) {
    if (processed.has(i)) continue;

    // Start a new cluster with detection i
    const cluster = [detections[i]];
    processed.add(i);

    // Find all detections overlapping with cluster
    for (let j = i + 1; j < detections.length; j++) {
      if (processed.has(j)) continue;

      // Check if j overlaps with any detection in cluster
      const overlapsWithCluster = cluster.some(det =>
        isOverlapping(det, detections[j], overlapThreshold)
      );

      if (overlapsWithCluster) {
        cluster.push(detections[j]);
        processed.add(j);
      }
    }

    // Fuse this cluster
    const fused = fuseDetectionsInRegion(cluster);
    if (fused) {
      fusedDetections.push(fused);
    }
  }

  return fusedDetections;
}

/**
 * Merge detections of the same PII type in close proximity
 * @param {Array} detections - Array of detections
 * @param {number} spatialThreshold - Distance threshold in pixels
 * @returns {Array} - Merged detections
 */
function mergeDetectionsByProximity(
  detections,
  spatialThreshold = 50
) {
  if (detections.length <= 1) return detections;

  const merged = [];
  const processed = new Set();

  for (let i = 0; i < detections.length; i++) {
    if (processed.has(i)) continue;

    const current = detections[i];
    const nearby = [current];
    processed.add(i);

    // Find nearby detections of same type
    for (let j = i + 1; j < detections.length; j++) {
      if (processed.has(j)) continue;

      const other = detections[j];

      // Same PII type?
      if (current.piiType !== other.piiType) continue;

      // Close proximity?
      const distance = Math.sqrt(
        Math.pow(
          current.rect.x + current.rect.width / 2 -
          (other.rect.x + other.rect.width / 2),
          2
        ) +
        Math.pow(
          current.rect.y + current.rect.height / 2 -
          (other.rect.y + other.rect.height / 2),
          2
        )
      );

      if (distance <= spatialThreshold) {
        nearby.push(other);
        processed.add(j);
      }
    }

    if (nearby.length > 1) {
      // Merge group
      const merged_det = fuseDetectionsInRegion(nearby);
      merged.push(merged_det);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Select final redaction action based on severity and confidence
 * @param {Object} detection - Detection with severity and confidence
 * @returns {string} - Final redaction action
 */
function computeFinalRedactionAction(detection) {
  const { severity, confidence, piiType, type } = detection;

  if (piiType === 'FACE' || type === 'FACE') {
    return 'BLUR';
  }

  // CRITICAL always gets BLACKOUT
  if (severity === 'CRITICAL') {
    return 'BLACKOUT';
  }

  // HIGH gets MASK (dark gray with overlay)
  if (severity === 'HIGH') {
    return 'MASK';
  }

  // CONTEXT_DEPENDENT: depends on confidence
  if (severity === 'CONTEXT' || severity === 'CONTEXT_DEPENDENT') {
    if (confidence >= 0.75) {
      return 'MASK';
    } else if (confidence >= 0.6) {
      return 'PLACEHOLDER';
    } else {
      return 'PLACEHOLDER';
    }
  }

  return 'PLACEHOLDER';
}

/**
 * Apply severity-based priority to conflicting detections
 * When PII types conflict, CRITICAL > HIGH > CONTEXT_DEPENDENT
 * @param {Array} detections - Array of detections
 * @returns {Array} - Detections with conflicts resolved
 */
function applySeverityPriority(detections) {
  const byRegion = new Map();

  // Group detections by region
  for (const detection of detections) {
    // Create region key based on bbox (rounded to 10px grid)
    const regionKey = `${Math.round(detection.rect.x / 10)}_${Math.round(
      detection.rect.y / 10
    )}`;

    if (!byRegion.has(regionKey)) {
      byRegion.set(regionKey, []);
    }

    byRegion.get(regionKey).push(detection);
  }

  // For each region, keep only strongest by severity
  const result = [];
  for (const [region, dets] of byRegion) {
    if (dets.length === 1) {
      result.push(dets[0]);
    } else {
      // Multiple detections in same region - keep strongest
      const strongest = selectStrongestDetection(dets);
      result.push(strongest);
    }
  }

  return result;
}

/**
 * Run the complete privacy fusion engine
 * @param {Array} domDetections - Detections from DOM extraction
 * @param {Array} textDetections - Detections from text/regex scanning
 * @param {Array} ocrDetections - (optional) Detections from OCR
 * @param {Array} mlDetections - (optional) Detections from ML models
 * @param {Array} faceDetections - (optional) Detections from face detection
 * @param {Object} options - Fusion options
 * @returns {Array} - Final fused detections with redaction metadata
 */
function runFusionEngine(
  domDetections = [],
  textDetections = [],
  ocrDetections = [],
  mlDetections = [],
  faceDetections = [],
  options = {}
) {
  const {
    overlapThreshold = 0.1,
    proximityThreshold = 50,
    safetyMarginPercent = 0,
    safetyMarginPixels = 0,
    deduplicateSources = true
  } = options;

  // Normalize all detections
  const normalized = [
    ...domDetections.map(d => normalizeDetection(d, 'dom')),
    ...textDetections.map(d => normalizeDetection(d, 'text')),
    ...ocrDetections.map(d => normalizeDetection(d, 'ocr')),
    ...mlDetections.map(d => normalizeDetection(d, 'ml')),
    ...faceDetections.map(d => normalizeDetection(d, 'face'))
  ].filter(Boolean);

  if (normalized.length === 0) {
    return [];
  }

  const deduped = deduplicateDetections(normalized);

  // Step 1: Spatial fusion - merge overlapping detections
  let fused = fuseDetectionsByRegion(
    deduped,
    overlapThreshold
  );

  // Step 2: Proximity-based merging for same type
  fused = mergeDetectionsByProximity(
    fused,
    proximityThreshold
  );

  // Step 3: Apply severity priority to conflicts
  fused = applySeverityPriority(fused);

  // Step 4: Compute final redaction actions
  fused = fused.map(detection => ({
    ...detection,
    finalRedactionAction: computeFinalRedactionAction(
      detection
    )
  }));

  // Step 5: Apply safety margins
  fused = fused.map(detection =>
    applySafetyMargin(detection, safetyMarginPercent, safetyMarginPixels)
  );

  // Step 6: Build final redaction metadata without preserving raw PII values.
  // The engine may keep sensitive values internally for local redaction, but the
  // exported metadata must stay as safe summaries only.
  const finalDetections = fused.map((detection, idx) => {
    const sourceList = Array.from(new Set([
      ...(Array.isArray(detection.sources) ? detection.sources : []),
      detection.source,
      detection.originalSource
    ].filter(Boolean).map(value => String(value).toUpperCase())));

    const normalizedRect = normalizeRect(detection.rect || detection.boundingBox || { x: 0, y: 0, width: 0, height: 0 });
    const finalAction = detection.action || detection.finalRedactionAction || computeFinalRedactionAction(detection);

    return {
      safeId: detection.safeId || detection.safeElementId || `safe_region_${idx + 1}`,
      elementId: detection.safeId || detection.safeElementId || `safe_region_${idx + 1}`,
      type: detection.piiType || detection.type || 'UNKNOWN',
      piiType: detection.piiType || detection.type || 'UNKNOWN',
      severity: detection.severity || 'HIGH',
      action: finalAction,
      confidence: Math.round((detection.confidence || 0) * 100) / 100,
      source: sourceList[0] || 'FUSED',
      sources: sourceList,
      rect: normalizedRect,
      boundingBox: normalizedRect,
      finalRedactionAction: finalAction,
      fusedCount: detection.fusedCount || 1,
      sourceCount: detection.sourceCount || sourceList.length || 1,
      safetyMarginApplied: detection.safetyMarginApplied || false,
      reason: detection.reason || 'Fused detection',
      startIndex: detection.startIndex,
      endIndex: detection.endIndex
    };
  });

  return finalDetections;
}

/**
 * Format detection for debugging (without raw values)
 * @param {Object} detection - Detection to format
 * @returns {Object} - Safe representation for logging
 */
function formatDetectionForDebug(detection) {
  return {
    piiType: detection.piiType,
    severity: detection.severity,
    confidence: detection.confidence,
    rect: detection.rect,
    action: detection.finalRedactionAction,
    sources: detection.sourceCount || 1
  };
}

// Export functions
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeDetection,
    normalizeRect,
    getScreenshotMetrics,
    clampRectToBounds,
    convertDOMRectToScreenshot,
    convertScreenshotRectToCanonical,
    convertRectToCanonical,
    calculateIntersectionArea,
    calculateUnionArea,
    calculateIoU,
    isOverlapping,
    mergeRects,
    selectStrongestDetection,
    fuseDetectionsInRegion,
    applySafetyMargin,
    fuseDetectionsByRegion,
    mergeDetectionsByProximity,
    computeFinalRedactionAction,
    applySeverityPriority,
    runFusionEngine,
    formatDetectionForDebug,
    SEVERITY_PRIORITY
  };
}
