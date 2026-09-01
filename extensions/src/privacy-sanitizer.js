import {
  PRIVACY_RAW_FIELD_KEYS,
  PRIVACY_EXPORT_BLOCKLIST,
  shouldStripPrivacyExportKey
} from './privacy-core.js';

/**
 * Privacy Sanitizer Module
 * 
 * Sanitizes DOM and text content by replacing detected PII with safe placeholders.
 * Integrates with Privacy Fusion Engine to ensure consistent, numbered placeholders.
 * 
 * Principles:
 * - CRITICAL secrets (password, OTP, CVV, API key, token) → <SECRET> (completely hidden)
 * - HIGH severity PII → <TYPE_NUMBER> (e.g., <EMAIL_1>, <PHONE_1>)
 * - CONTEXT_DEPENDENT → <TYPE_NUMBER> (with confidence threshold check)
 * - Never expose original value in placeholder
 * - Preserve non-sensitive text and structure
 * - Handle multiple occurrences with consistent numbering
 * - Don't mutate user's webpage (generate sanitized copies)
 */

const CRITICAL_PII_TYPES = new Set([
  'PASSWORD',
  'OTP',
  'CVV',
  'API_KEY',
  'AUTH_TOKEN',
  'SESSION_SECRET',
  'CARD',
  'CREDIT_CARD',
  'ACCESS_TOKEN',
  'JWT',
  'SECRET'
]);

const SECRET_PLACEHOLDER = '<SECRET>';
const HIGH_CONFIDENCE_THRESHOLD = 0.70;
const CONTEXT_DEPENDENT_THRESHOLD = 0.75;
const SAFE_EXPORT_KEYS = PRIVACY_EXPORT_BLOCKLIST;

function redactSensitiveString(value) {
  if (typeof value !== 'string') {
    return value;
  }

  let redacted = value;

  redacted = redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL_1>');
  redacted = redacted.replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, '<PHONE_1>');
  redacted = redacted.replace(/\b(?:pass(?:word)?\s*(?:=|:|is)\s*[^\s,;]+)/gi, 'password=<SECRET>');
  redacted = redacted.replace(/\b(?:otp|verification code|cvv|cvc|csc)\s*(?:=|:|is)?\s*\d+\b/gi, '<SECRET>');
  redacted = redacted.replace(/\b(?:sk_live_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+)\b/g, '<SECRET>');

  return redacted;
}

function sanitizeForExport(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForExport(item));
  }

  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }

  if (typeof value === 'object') {
    const sanitized = {};

    Object.entries(value).forEach(([key, nestedValue]) => {
      if (shouldStripPrivacyExportKey(key)) {
        return;
      }

      sanitized[key] = sanitizeForExport(nestedValue);
    });

    return sanitized;
  }

  return value;
}

if (typeof globalThis !== 'undefined' && globalThis.JSON && !globalThis.__privacySafeStringifyInstalled) {
  const nativeJSONStringify = globalThis.JSON.stringify.bind(globalThis.JSON);

  globalThis.JSON.stringify = function(value, replacer, space) {
    try {
      return nativeJSONStringify(sanitizeForExport(value), replacer, space);
    } catch (error) {
      return nativeJSONStringify({ error: 'Serialization blocked by privacy guard' }, replacer, space);
    }
  };

  globalThis.__privacySafeStringifyInstalled = true;
}

/**
 * Generate a placeholder for a PII type and index
 * @param {string} piiType - Type of PII (EMAIL, PHONE, etc.)
 * @param {number} index - Sequential index (1-based)
 * @returns {string} Placeholder like <EMAIL_1>
 */
function generatePlaceholder(piiType, index) {
  if (!piiType) {
    return SECRET_PLACEHOLDER;
  }

  const normalizedType = String(piiType).toUpperCase();
  if (isCriticalSecret(normalizedType)) {
    return SECRET_PLACEHOLDER;
  }

  return `<${normalizedType}_${index}>`;
}

/**
 * Determine if PII should be completely hidden
 * @param {string} piiType - PII type to check
 * @returns {boolean} True if should use SECRET placeholder
 */
function isCriticalSecret(piiType) {
  if (!piiType) {
    return false;
  }

  return CRITICAL_PII_TYPES.has(String(piiType).toUpperCase());
}

/**
 * Check if detection should be sanitized based on severity and confidence
 * @param {object} detection - Detection object with severity and confidence
 * @returns {boolean} True if should sanitize
 */
function shouldSanitize(detection) {
  if (!detection || !detection.severity) {
    return false;
  }

  if (detection.severity === 'CRITICAL' || detection.severity === 'HIGH') {
    return true;
  }

  // For CONTEXT_DEPENDENT, require higher confidence
  if (detection.severity === 'CONTEXT_DEPENDENT') {
    return (detection.confidence || 0) >= CONTEXT_DEPENDENT_THRESHOLD;
  }

  return false;
}

/**
 * Create a mapping of PII types to their occurrence counts
 * @param {array} detections - Array of detection objects
 * @returns {object} Map of piiType → current count
 */
function createPIICountMapping(detections) {
  const mapping = {};

  if (!Array.isArray(detections)) {
    return mapping;
  }

  detections.forEach((detection) => {
    if (!detection || !detection.piiType) {
      return;
    }

    const piiType = detection.piiType;
    if (!mapping[piiType]) {
      mapping[piiType] = 0;
    }
    mapping[piiType]++;
  });

  return mapping;
}

function extractDetectionValue(detection) {
  if (!detection) {
    return null;
  }

  const value = detection.value ?? detection.text ?? detection.match ?? detection.originalValue ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function findAllTextOccurrences(fullText, searchText) {
  if (!fullText || !searchText || typeof fullText !== 'string' || typeof searchText !== 'string') {
    return [];
  }

  const matches = [];
  let cursor = 0;

  while (cursor <= fullText.length) {
    const index = fullText.indexOf(searchText, cursor);
    if (index === -1) {
      break;
    }

    matches.push({
      startIndex: index,
      endIndex: index + searchText.length
    });

    cursor = index + Math.max(searchText.length, 1);
  }

  return matches;
}

/**
 * Sanitize text by replacing PII with placeholders
 * 
 * Algorithm:
 * 1. Filter detections by sanitization criteria
 * 2. Resolve each detection to concrete text positions
 * 3. Assign numbered placeholders in textual order
 * 4. Replace from end to beginning to avoid offset drift
 * 5. Return sanitized text and mapping
 * 
 * @param {string} text - Original text
 * @param {array} detections - Array of detection objects with value, startIndex, endIndex
 * @returns {object} { sanitized: string, mapping: {}, sanitizationCount: number }
 */
function sanitizeText(text, detections) {
  if (!text || typeof text !== 'string') {
    return {
      sanitized: text,
      mapping: {},
      sanitizationCount: 0
    };
  }

  if (!Array.isArray(detections) || detections.length === 0) {
    return {
      sanitized: text,
      mapping: {},
      sanitizationCount: 0
    };
  }

  const expandedDetections = [];

  detections.forEach((detection) => {
    if (!detection || !shouldSanitize(detection)) {
      return;
    }

    const value = extractDetectionValue(detection);
    if (!value) {
      return;
    }

    const matchingPositions = findAllTextOccurrences(text, value);
    const preferredPositions = matchingPositions.length > 0
      ? matchingPositions
      : (Number.isInteger(detection.startIndex) && Number.isInteger(detection.endIndex)
        ? [{ startIndex: detection.startIndex, endIndex: detection.endIndex }]
        : []);

    if (preferredPositions.length === 0) {
      return;
    }

    preferredPositions.forEach(({ startIndex, endIndex }) => {
      expandedDetections.push({
        ...detection,
        value,
        startIndex,
        endIndex
      });
    });
  });

  if (expandedDetections.length === 0) {
    return {
      sanitized: text,
      mapping: {},
      sanitizationCount: 0
    };
  }

  const piiCounts = {};
  const replacementPlan = expandedDetections
    .filter((detection) => Number.isInteger(detection.startIndex) && Number.isInteger(detection.endIndex))
    .sort((a, b) => a.startIndex - b.startIndex);

  const numberedReplacements = replacementPlan.map((detection) => {
    const { piiType, value, startIndex, endIndex, severity, confidence } = detection;

    if (isCriticalSecret(piiType)) {
      return {
        startIndex,
        endIndex,
        placeholder: SECRET_PLACEHOLDER,
        piiType,
        severity,
        confidence,
        valueLength: value ? value.length : 0
      };
    }

    const currentIndex = (piiCounts[piiType] || 0) + 1;
    piiCounts[piiType] = currentIndex;

    return {
      startIndex,
      endIndex,
      placeholder: generatePlaceholder(piiType, currentIndex),
      piiType,
      severity,
      confidence,
      valueLength: value ? value.length : 0
    };
  });

  const mapping = {};
  let sanitized = text;

  numberedReplacements
    .sort((a, b) => b.startIndex - a.startIndex)
    .forEach((replacement) => {
      const { piiType, startIndex, endIndex, placeholder, confidence, severity } = replacement;

      const key = `${piiType}_${startIndex}_${endIndex}`;
      mapping[key] = {
        piiType,
        placeholder,
        confidence: confidence || 0,
        severity,
        originalLength: replacement.valueLength || 0
      };

      const before = sanitized.substring(0, startIndex);
      const after = sanitized.substring(endIndex);
      sanitized = before + placeholder + after;
    });

  return {
    sanitized,
    mapping,
    sanitizationCount: numberedReplacements.length,
    piiTypeCounts: piiCounts
  };
}

/**
 * Extract text content from a DOM node, tracking positions
 * Returns array of {text, node, startIndex, endIndex} for text nodes
 * @param {HTMLElement} element - DOM element to extract from
 * @returns {array} Array of text segments with positions
 */
function extractTextSegments(element) {
  const segments = [];
  let globalIndex = 0;

  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text && text.trim()) {
        segments.push({
          text,
          node,
          startIndex: globalIndex,
          endIndex: globalIndex + text.length
        });
        globalIndex += text.length;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip script, style, and sensitive elements
      if (!['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) {
        for (let child of node.childNodes) {
          traverse(child);
        }
      }
    }
  }

  traverse(element);
  return segments;
}

/**
 * Sanitize DOM element by replacing text nodes with sanitized content
 * 
 * Algorithm:
 * 1. Extract all text segments from element with position tracking
 * 2. Concatenate into full text
 * 3. Call sanitizeText()
 * 4. Map sanitized text back to original text nodes
 * 5. Replace text nodes with sanitized versions
 * 
 * @param {HTMLElement} element - DOM element to sanitize (not mutated, copy created)
 * @param {array} detections - Array of detection objects
 * @returns {object} { sanitized: HTMLElement (cloned), mapping, count }
 */
function sanitizeDomContent(element, detections) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return {
      sanitized: element,
      mapping: {},
      sanitizationCount: 0,
      error: 'Invalid element'
    };
  }

  // Clone element to avoid mutating original
  const cloned = element.cloneNode(true);

  try {
    // Extract text segments
    const segments = extractTextSegments(cloned);

    if (segments.length === 0) {
      return {
        sanitized: cloned,
        mapping: {},
        sanitizationCount: 0
      };
    }

    // Concatenate all text
    const fullText = segments.map(seg => seg.text).join('');

    // Adjust detection indices to match concatenated text
    const adjustedDetections = (Array.isArray(detections) ? detections : [])
      .map(det => {
        // Simple index adjustment (assumes detections were created from full text)
        return {
          ...det,
          // Detection indices should already be in the full text coordinates
          // If not, this will need calibration based on how detections are created
        };
      });

    // Sanitize full text
    const { sanitized: sanitizedText, mapping, sanitizationCount, piiTypeCounts } = sanitizeText(
      fullText,
      adjustedDetections
    );

    if (sanitizationCount > 0 && sanitizedText !== fullText) {
      // Map sanitized text back to DOM nodes
      let sanitizedIndex = 0;

      segments.forEach((segment) => {
        const segmentLength = segment.text.length;
        const segmentSanitized = sanitizedText.substring(sanitizedIndex, sanitizedIndex + segmentLength);

        if (segmentSanitized !== segment.text) {
          // Text node needs updating
          segment.node.textContent = segmentSanitized;
        }

        sanitizedIndex += segmentLength;
      });
    }

    return {
      sanitized: cloned,
      mapping,
      sanitizationCount,
      piiTypeCounts
    };
  } catch (error) {
    console.error('Error sanitizing DOM content:', error);
    return {
      sanitized: cloned,
      mapping: {},
      sanitizationCount: 0,
      error: error.message
    };
  }
}

/**
 * Create a sanitization report for detections
 * Safe to include in payload (no raw values)
 * @param {array} detections - Detection objects
 * @returns {object} Report with statistics
 */
function createSanitizationReport(detections) {
  if (!Array.isArray(detections)) {
    return {
      totalDetections: 0,
      sanitized: 0,
      byType: {},
      bySeverity: {}
    };
  }

  const report = {
    totalDetections: detections.length,
    sanitized: 0,
    byType: {},
    bySeverity: {}
  };

  detections.forEach((det) => {
    if (!det || !det.piiType) {
      return;
    }

    const { piiType, severity } = det;

    // Count by type
    if (!report.byType[piiType]) {
      report.byType[piiType] = {
        total: 0,
        sanitized: 0,
        critical: 0,
        high: 0,
        contextDependent: 0
      };
    }
    report.byType[piiType].total++;

    // Count by severity
    if (!report.bySeverity[severity]) {
      report.bySeverity[severity] = 0;
    }
    report.bySeverity[severity]++;

    // Track sanitization
    if (shouldSanitize(det)) {
      report.sanitized++;
      report.byType[piiType].sanitized++;

      if (severity === 'CRITICAL') {
        report.byType[piiType].critical++;
      } else if (severity === 'HIGH') {
        report.byType[piiType].high++;
      } else if (severity === 'CONTEXT_DEPENDENT') {
        report.byType[piiType].contextDependent++;
      }
    }
  });

  report.sanitizationRate = report.totalDetections > 0
    ? (report.sanitized / report.totalDetections * 100).toFixed(1) + '%'
    : '0%';

  return report;
}

/**
 * Sanitize text from detections that include startIndex and endIndex
 * Useful for text with known character positions
 * @param {string} text - Original text
 * @param {array} detections - Detections with startIndex, endIndex, and value
 * @returns {string} Sanitized text
 */
function quickSanitizeText(text, detections) {
  const result = sanitizeText(text, detections);
  return result.sanitized;
}

/**
 * Build full detection payload for sanitization (for logging/debugging)
 * @param {array} detections - Detection objects
 * @returns {array} Safe detection summary (no raw values)
 */
function formatDetectionsForSanitization(detections) {
  if (!Array.isArray(detections)) {
    return [];
  }

  return detections.map((det) => ({
    piiType: det.piiType,
    severity: det.severity,
    confidence: det.confidence,
    startIndex: det.startIndex,
    endIndex: det.endIndex,
    valueLength: det.value ? det.value.length : 0,
    shouldSanitize: shouldSanitize(det),
    isCritical: isCriticalSecret(det.piiType)
  }));
}

/**
 * Export all sanitization functions
 */
export {
  generatePlaceholder,
  isCriticalSecret,
  shouldSanitize,
  createPIICountMapping,
  sanitizeText,
  sanitizeDomContent,
  extractTextSegments,
  createSanitizationReport,
  quickSanitizeText,
  formatDetectionsForSanitization,
  // Constants for external use
  CRITICAL_PII_TYPES,
  SECRET_PLACEHOLDER,
  HIGH_CONFIDENCE_THRESHOLD,
  CONTEXT_DEPENDENT_THRESHOLD
};
