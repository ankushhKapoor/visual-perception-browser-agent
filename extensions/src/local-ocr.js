import Tesseract from 'tesseract.js';

import {
  runAllDeterministicDetectors,
  getRecommendedRedactionAction,
  standardizeDetection
} from './privacy-classifier.js';

import { getScreenshotMetrics, convertRectToCanonical } from './privacy-fusion.js';

const DEFAULT_OCR_ENABLED = false;

export function isOCREnabled(options = {}) {
  if (options.enabled !== undefined) {
    return Boolean(options.enabled);
  }

  const globalFlag = typeof globalThis !== 'undefined' ? Boolean(globalThis.__ENABLE_LOCAL_OCR__ === true) : false;

  if (typeof window !== 'undefined') {
    return Boolean(window.__ENABLE_LOCAL_OCR__ === true || globalFlag);
  }

  return globalFlag || DEFAULT_OCR_ENABLED;
}

function normalizeOCRRect(word) {
  const bbox = word?.bbox || {};
  const x = Number.isFinite(bbox.x0) ? bbox.x0 : 0;
  const y = Number.isFinite(bbox.y0) ? bbox.y0 : 0;
  const width = Number.isFinite(bbox.x1) && Number.isFinite(bbox.x0)
    ? Math.max(1, bbox.x1 - bbox.x0)
    : (Number.isFinite(bbox.width) ? bbox.width : 0);
  const height = Number.isFinite(bbox.y1) && Number.isFinite(bbox.y0)
    ? Math.max(1, bbox.y1 - bbox.y0)
    : (Number.isFinite(bbox.height) ? bbox.height : 0);

  return { x, y, width, height };
}

async function loadImageDimensions(dataUrl) {
  if (typeof Image === 'undefined') {
    return { width: 1280, height: 720 };
  }

  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      resolve({
        width: image.width,
        height: image.height
      });
    };

    image.onerror = () => reject(new Error('Failed to load OCR image'));
    image.src = dataUrl;
  });
}

export async function detectOCRTextRegions(dataUrl, options = {}) {
  if (!dataUrl || !isOCREnabled(options)) {
    return [];
  }

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 720;
  const scrollX = typeof window !== 'undefined' ? (window.scrollX || 0) : 0;
  const scrollY = typeof window !== 'undefined' ? (window.scrollY || 0) : 0;
  const devicePixelRatio = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  const zoomScale = typeof window !== 'undefined' && window.visualViewport ? window.visualViewport.scale : 1;

  try {
    const dimensions = await loadImageDimensions(dataUrl);
    const metrics = getScreenshotMetrics({
      screenshotWidth: dimensions.width,
      screenshotHeight: dimensions.height,
      viewportWidth,
      viewportHeight,
      scrollX,
      scrollY,
      devicePixelRatio,
      zoomScale
    });

    const result = await Tesseract.recognize(dataUrl, 'eng', {
      logger: false,
      preserve_interword_spaces: '1'
    });

    const words = Array.isArray(result?.data?.words) ? result.data.words : [];
    const detections = [];

    for (const word of words) {
      const text = String(word?.text || '').trim();
      if (!text || text.length < 3) {
        continue;
      }

      const detectionsForWord = runAllDeterministicDetectors(text);
      if (!detectionsForWord.length) {
        continue;
      }

      const rect = normalizeOCRRect(word);
      const canonicalRect = convertRectToCanonical(rect, 'ocr', metrics);

      for (const match of detectionsForWord) {
        const candidate = {
          ...match,
          piiType: match.piiType || match.type,
          type: match.piiType || match.type,
          source: 'OCR',
          severity: match.severity || 'CONTEXT_DEPENDENT',
          confidence: Number((match.confidence ?? word.confidence ?? 0.7).toFixed(3)),
          match: match.match || text,
          text,
          value: match.match || text,
          reason: 'Local OCR text detected'
        };

        const standardized = standardizeDetection(candidate, 'OCR');
        const confidence = Number((standardized.confidence ?? candidate.confidence ?? 0.7).toFixed(3));
        const action = standardized.action || getRecommendedRedactionAction(standardized.severity || candidate.severity || 'CONTEXT_DEPENDENT', confidence);

        detections.push({
          piiType: standardized.type,
          type: standardized.type,
          text: candidate.match || text,
          value: candidate.match || text,
          confidence,
          rect: canonicalRect,
          boundingBox: canonicalRect,
          source: 'OCR',
          severity: standardized.severity || candidate.severity || 'CONTEXT_DEPENDENT',
          action,
          recommendedAction: action,
          finalRedactionAction: action,
          reason: 'Local OCR text detected',
          sourceCount: 1,
          fusedCount: 1,
          safetyMarginApplied: false,
          ocrText: text,
          ocrConfidence: Number((word.confidence ?? confidence).toFixed(3))
        });
      }
    }

    return detections;
  } catch (error) {
    console.warn('Local OCR failed:', error?.message || error);
    return [];
  }
}

export default {
  detectOCRTextRegions,
  isOCREnabled
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectOCRTextRegions,
    isOCREnabled,
    default: {
      detectOCRTextRegions,
      isOCREnabled
    }
  };
}
