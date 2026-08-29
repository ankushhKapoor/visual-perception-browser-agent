/**
 * Privacy Classifier
 * Classifies detected PII into categories with severity levels and confidence scores.
 * Provides recommended redaction actions for each detection.
 */

const PII_TYPES = {
  // CRITICAL SEVERITY
  PASSWORD: {
    name: "PASSWORD",
    severity: "CRITICAL",
    baseConfidence: 0.95
  },
  OTP: {
    name: "OTP",
    severity: "CRITICAL",
    baseConfidence: 0.90
  },
  CVV: {
    name: "CVV",
    severity: "CRITICAL",
    baseConfidence: 0.95
  },
  CARD: {
    name: "CARD",
    severity: "CRITICAL",
    baseConfidence: 0.85
  },
  API_KEY: {
    name: "API_KEY",
    severity: "CRITICAL",
    baseConfidence: 0.80
  },
  AUTH_TOKEN: {
    name: "AUTH_TOKEN",
    severity: "CRITICAL",
    baseConfidence: 0.85
  },
  SESSION_SECRET: {
    name: "SESSION_SECRET",
    severity: "CRITICAL",
    baseConfidence: 0.85
  },

  // HIGH SEVERITY
  EMAIL: {
    name: "EMAIL",
    severity: "HIGH",
    baseConfidence: 0.95
  },
  PHONE: {
    name: "PHONE",
    severity: "HIGH",
    baseConfidence: 0.90
  },
  GOVERNMENT_ID: {
    name: "GOVERNMENT_ID",
    severity: "HIGH",
    baseConfidence: 0.90
  },
  FINANCIAL_INFO: {
    name: "FINANCIAL_INFO",
    severity: "HIGH",
    baseConfidence: 0.80
  },
  EMPLOYEE_ID: {
    name: "EMPLOYEE_ID",
    severity: "HIGH",
    baseConfidence: 0.75
  },

  // CONTEXT_DEPENDENT SEVERITY
  PERSON: {
    name: "PERSON",
    severity: "CONTEXT_DEPENDENT",
    baseConfidence: 0.70
  },
  FACE: {
    name: "FACE",
    severity: "CONTEXT_DEPENDENT",
    baseConfidence: 0.82
  },
  ADDRESS: {
    name: "ADDRESS",
    severity: "CONTEXT_DEPENDENT",
    baseConfidence: 0.65
  },
  DATE_OF_BIRTH: {
    name: "DATE_OF_BIRTH",
    severity: "CONTEXT_DEPENDENT",
    baseConfidence: 0.75
  }
};

const REDACTION_ACTIONS = {
  CRITICAL: "BLACKOUT",
  HIGH: "MASK",
  CONTEXT_DEPENDENT: "PLACEHOLDER",
  FACE: "BLUR"
};

const STANDARDIZED_PII_MAP = {
  PASSWORD: "PASSWORD",
  OTP: "OTP",
  CARD: "CARD",
  CVV: "CVV",
  API_KEY: "API_KEY",
  AUTH_TOKEN: "AUTH_TOKEN",
  SESSION_SECRET: "SESSION_SECRET",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  GOVERNMENT_ID: "GOVERNMENT_ID",
  BANK_ACCOUNT: "BANK_ACCOUNT",
  FINANCIAL_INFO: "FINANCIAL_INFO",
  EMPLOYEE_ID: "EMPLOYEE_ID",
  STUDENT_ID: "STUDENT_ID",
  FACE: "FACE",
  PERSON: "PERSON",
  ADDRESS: "ADDRESS",
  DATE_OF_BIRTH: "DATE_OF_BIRTH"
};

const STANDARDIZED_SEVERITY = {
  PASSWORD: "CRITICAL",
  OTP: "CRITICAL",
  CARD: "CRITICAL",
  CVV: "CRITICAL",
  API_KEY: "CRITICAL",
  AUTH_TOKEN: "CRITICAL",
  SESSION_SECRET: "CRITICAL",
  EMAIL: "HIGH",
  PHONE: "HIGH",
  GOVERNMENT_ID: "HIGH",
  BANK_ACCOUNT: "HIGH",
  FINANCIAL_INFO: "HIGH",
  EMPLOYEE_ID: "HIGH",
  STUDENT_ID: "HIGH",
  FACE: "HIGH",
  PERSON: "CONTEXT",
  ADDRESS: "CONTEXT",
  DATE_OF_BIRTH: "CONTEXT"
};

const STANDARDIZED_ACTIONS = {
  PASSWORD: "BLACKOUT",
  OTP: "BLACKOUT",
  CARD: "BLACKOUT",
  CVV: "BLACKOUT",
  API_KEY: "BLACKOUT",
  AUTH_TOKEN: "BLACKOUT",
  SESSION_SECRET: "BLACKOUT",
  EMAIL: "MASK",
  PHONE: "MASK",
  GOVERNMENT_ID: "MASK",
  BANK_ACCOUNT: "MASK",
  FINANCIAL_INFO: "MASK",
  EMPLOYEE_ID: "MASK",
  STUDENT_ID: "MASK",
  FACE: "BLUR",
  PERSON: "PLACEHOLDER",
  ADDRESS: "PLACEHOLDER",
  DATE_OF_BIRTH: "PLACEHOLDER"
};

function normalizeStandardizedType(rawType, detection = {}) {
  const normalized = String(rawType || detection.piiType || detection.type || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!normalized) {
    return "UNKNOWN";
  }

  const overrideContext = String(detection.context || detection.reason || "").toLowerCase();

  if (normalized === "FINANCIAL_INFO" && /account|bank/.test(overrideContext)) {
    return "BANK_ACCOUNT";
  }

  if (normalized === "EMPLOYEE_ID" && /student/.test(overrideContext)) {
    return "STUDENT_ID";
  }

  if (STANDARDIZED_PII_MAP[normalized]) {
    return STANDARDIZED_PII_MAP[normalized];
  }

  return normalized;
}

function normalizeStandardizedSeverity(type, severity = "HIGH") {
  if (STANDARDIZED_SEVERITY[type]) {
    return STANDARDIZED_SEVERITY[type];
  }

  if (severity === "CONTEXT_DEPENDENT") {
    return "CONTEXT";
  }

  return severity || "HIGH";
}

function normalizeStandardizedAction(type, severity = "HIGH") {
  if (STANDARDIZED_ACTIONS[type]) {
    return STANDARDIZED_ACTIONS[type];
  }

  if (severity === "CRITICAL") return "BLACKOUT";
  if (severity === "HIGH") return "MASK";
  return "PLACEHOLDER";
}

function getDefaultRuleConfidence(source = "deterministic", severity = "HIGH", detection = {}) {
  if (typeof detection.confidence === "number" && Number.isFinite(detection.confidence)) {
    return Number(detection.confidence);
  }

  const sourceText = String(source || detection.source || "deterministic").toLowerCase();
  const contextText = String(detection.context || detection.reason || "").toLowerCase();

  if (severity === "CRITICAL" || /format|pattern|regex|luhn|token|secret|password|otp|card|api/.test(contextText) || sourceText.includes("input")) {
    return 0.95;
  }

  if (severity === "CONTEXT" || /context|name|address|dob|person/.test(contextText)) {
    return 0.85;
  }

  return 0.70;
}

function standardizeDetection(detection, fallbackSource = "deterministic") {
  const rawType = detection?.piiType || detection?.type || detection?.category || "";
  const type = normalizeStandardizedType(rawType, detection);
  const severity = normalizeStandardizedSeverity(type, detection?.severity || "HIGH");
  const action = detection?.action || detection?.recommendedAction || normalizeStandardizedAction(type, severity);
  const source = detection?.source || fallbackSource;
  const confidence = Number.isFinite(Number(detection?.confidence))
    ? Number(detection.confidence)
    : getDefaultRuleConfidence(source, severity, detection);

  return {
    type,
    severity,
    action,
    confidence,
    source,
    legacyType: rawType,
    legacySeverity: detection?.severity || severity,
    piiType: type,
    recommendedAction: action
  };
}

/**
 * Classify a PII detection based on input element metadata
 * @param {Object} detection - {source, type, name, id, placeholder, ariaLabel, value, metadata}
 * @returns {Object} - {type, severity, confidence, recommendedAction, source}
 */
function classifyInputElement(detection) {
  const {
    type,
    name,
    id,
    placeholder,
    ariaLabel,
    autocomplete,
    metadata
  } = detection;

  const allMetadata = [
    type,
    name,
    id,
    placeholder,
    ariaLabel,
    autocomplete,
    metadata
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // PASSWORD detection
  if (type === "password") {
    return standardizeDetection({
      type: PII_TYPES.PASSWORD.name,
      severity: PII_TYPES.PASSWORD.severity,
      confidence: 0.98,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "Input type is password"
    }, "input");
  }

  // OTP detection
  if (
    allMetadata.includes("otp") ||
    allMetadata.includes("one-time") ||
    allMetadata.includes("verification code")
  ) {
    return standardizeDetection({
      type: PII_TYPES.OTP.name,
      severity: PII_TYPES.OTP.severity,
      confidence: 0.90,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "OTP-related field detected"
    }, "input");
  }

  // CVV/CVC detection
  if (
    allMetadata.includes("cvv") ||
    allMetadata.includes("cvc") ||
    allMetadata.includes("csc") ||
    allMetadata.includes("security code")
  ) {
    return standardizeDetection({
      type: PII_TYPES.CVV.name,
      severity: PII_TYPES.CVV.severity,
      confidence: 0.95,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "CVV/security code field"
    }, "input");
  }

  // CARD detection (credit/debit card)
  if (
    type === "text" &&
    (allMetadata.includes("card") ||
      allMetadata.includes("credit") ||
      allMetadata.includes("debit") ||
      allMetadata.includes("cc-number") ||
      allMetadata.includes("cardnumber"))
  ) {
    return standardizeDetection({
      type: PII_TYPES.CARD.name,
      severity: PII_TYPES.CARD.severity,
      confidence: 0.92,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "Card number field"
    }, "input");
  }

  // API Key detection
  if (
    allMetadata.includes("api") &&
    allMetadata.includes("key")
  ) {
    return standardizeDetection({
      type: PII_TYPES.API_KEY.name,
      severity: PII_TYPES.API_KEY.severity,
      confidence: 0.85,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "API key field"
    }, "input");
  }

  // AUTH_TOKEN detection
  if (
    allMetadata.includes("token") ||
    allMetadata.includes("authorization") ||
    allMetadata.includes("bearer")
  ) {
    return standardizeDetection({
      type: PII_TYPES.AUTH_TOKEN.name,
      severity: PII_TYPES.AUTH_TOKEN.severity,
      confidence: 0.88,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "Auth token field"
    }, "input");
  }

  // SESSION_SECRET detection
  if (
    allMetadata.includes("session") &&
    (allMetadata.includes("secret") ||
      allMetadata.includes("token"))
  ) {
    return standardizeDetection({
      type: PII_TYPES.SESSION_SECRET.name,
      severity: PII_TYPES.SESSION_SECRET.severity,
      confidence: 0.85,
      recommendedAction: REDACTION_ACTIONS.CRITICAL,
      source: "input",
      reason: "Session secret field"
    }, "input");
  }

  // EMAIL detection
  if (
    type === "email" ||
    autocomplete === "email" ||
    allMetadata.includes("email")
  ) {
    return standardizeDetection({
      type: PII_TYPES.EMAIL.name,
      severity: PII_TYPES.EMAIL.severity,
      confidence: 0.95,
      recommendedAction: REDACTION_ACTIONS.HIGH,
      source: "input",
      reason: "Email field"
    }, "input");
  }

  // PHONE detection
  if (
    type === "tel" ||
    autocomplete === "tel" ||
    allMetadata.includes("phone") ||
    allMetadata.includes("mobile")
  ) {
    return standardizeDetection({
      type: PII_TYPES.PHONE.name,
      severity: PII_TYPES.PHONE.severity,
      confidence: 0.90,
      recommendedAction: REDACTION_ACTIONS.HIGH,
      source: "input",
      reason: "Phone field"
    }, "input");
  }

  // GOVERNMENT_ID detection (Aadhaar, PAN, SSN)
  if (
    allMetadata.includes("aadhaar") ||
    allMetadata.includes("ssn") ||
    allMetadata.includes("social security")
  ) {
    return standardizeDetection({
      type: PII_TYPES.GOVERNMENT_ID.name,
      severity: PII_TYPES.GOVERNMENT_ID.severity,
      confidence: 0.92,
      recommendedAction: REDACTION_ACTIONS.HIGH,
      source: "input",
      reason: "Government ID field"
    }, "input");
  }

  // PAN detection
  if (allMetadata.includes("pan")) {
    return standardizeDetection({
      type: PII_TYPES.GOVERNMENT_ID.name,
      severity: PII_TYPES.GOVERNMENT_ID.severity,
      confidence: 0.90,
      recommendedAction: REDACTION_ACTIONS.HIGH,
      source: "input",
      reason: "PAN field"
    }, "input");
  }

  // EMPLOYEE_ID detection
  if (
    allMetadata.includes("employee") &&
    allMetadata.includes("id")
  ) {
    return standardizeDetection({
      type: PII_TYPES.EMPLOYEE_ID.name,
      severity: PII_TYPES.EMPLOYEE_ID.severity,
      confidence: 0.85,
      recommendedAction: REDACTION_ACTIONS.HIGH,
      source: "input",
      reason: "Employee ID field"
    }, "input");
  }

  // Default: unknown sensitive field
  return null;
}

/**
 * Classify a text-based PII detection based on regex pattern match
 * @param {Object} detection - {text, patternType, matchContext}
 * @returns {Object} - {type, severity, confidence, recommendedAction, source}
 */
function classifyTextPattern(detection) {
  const { text, patternType, matchContext } = detection;

  switch (patternType) {
    case "email":
      return standardizeDetection({
        type: PII_TYPES.EMAIL.name,
        severity: PII_TYPES.EMAIL.severity,
        confidence: 0.95,
        recommendedAction: REDACTION_ACTIONS.HIGH,
        source: "text",
        reason: "Email pattern matched"
      }, "text");

    case "phone":
      return standardizeDetection({
        type: PII_TYPES.PHONE.name,
        severity: PII_TYPES.PHONE.severity,
        confidence: 0.90,
        recommendedAction: REDACTION_ACTIONS.HIGH,
        source: "text",
        reason: "Phone pattern matched"
      }, "text");

    case "aadhaar":
      return standardizeDetection({
        type: PII_TYPES.GOVERNMENT_ID.name,
        severity: PII_TYPES.GOVERNMENT_ID.severity,
        confidence: 0.92,
        recommendedAction: REDACTION_ACTIONS.HIGH,
        source: "text",
        reason: "Aadhaar pattern matched"
      }, "text");

    case "pan":
      return standardizeDetection({
        type: PII_TYPES.GOVERNMENT_ID.name,
        severity: PII_TYPES.GOVERNMENT_ID.severity,
        confidence: 0.90,
        recommendedAction: REDACTION_ACTIONS.HIGH,
        source: "text",
        reason: "PAN pattern matched"
      }, "text");

    case "card":
      return standardizeDetection({
        type: PII_TYPES.CARD.name,
        severity: PII_TYPES.CARD.severity,
        confidence: 0.85,
        recommendedAction: REDACTION_ACTIONS.CRITICAL,
        source: "text",
        reason: "Card number pattern matched"
      }, "text");

    default:
      return null;
  }
}

/**
 * Get the recommended redaction action for a severity level
 * @param {string} severity - CRITICAL, HIGH, or CONTEXT_DEPENDENT
 * @param {number} confidence - Confidence score (0-1)
 * @returns {string} - BLACKOUT, MASK, or PLACEHOLDER
 */
function getRecommendedRedactionAction(severity, confidence = 1.0) {
  // If confidence is too low for context-dependent, downgrade action
  if (
    severity === "CONTEXT_DEPENDENT" &&
    confidence < 0.7
  ) {
    return "PLACEHOLDER";
  }

  return REDACTION_ACTIONS[severity] || "PLACEHOLDER";
}

/**
 * Merge classification with detection metadata
 * @param {Object} detection - Original detection result
 * @param {Object} classification - Classification result
 * @returns {Object} - Enriched detection with classification data
 */
function enrichDetection(detection, classification) {
  if (!classification) {
    return detection;
  }

  const standardized = standardizeDetection({
    ...detection,
    piiType: classification.type,
    severity: classification.severity,
    confidence: classification.confidence,
    source: classification.source || detection?.source || "deterministic",
    reason: classification.reason
  }, classification.source || detection?.source || "deterministic");

  return {
    ...detection,
    piiType: standardized.piiType,
    type: standardized.type,
    severity: standardized.severity,
    action: standardized.action,
    confidence: standardized.confidence,
    recommendedAction: standardized.recommendedAction,
    source: standardized.source,
    classificationReason: classification.reason,
    legacySeverity: detection?.severity || classification.severity
  };
}

/**
 * DETERMINISTIC PATTERN DETECTORS
 * These functions detect PII using rule-based patterns, regex, and validation.
 */

/**
 * Validate a credit card number using Luhn algorithm
 * @param {string} cardNumber - Card number without spaces/dashes
 * @returns {boolean} - True if valid
 */
function isValidLuhn(cardNumber) {
  if (!cardNumber || !/^\d+$/.test(cardNumber)) return false;

  let sum = 0;
  let isEven = false;

  for (let i = cardNumber.length - 1; i >= 0; i--) {
    let digit = parseInt(cardNumber[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * Detect password assignments with strong secret validation.
 * @param {string} text - Text to scan
 * @returns {Array} - Detections
 */
function detectPassword(text) {
  if (!text) return [];

  const passwordContext = /(?:password|passwd|passcode)\s*(?:is|:|=)?\s*([A-Za-z0-9!@#$%^&*()_+\-=[\]{};:'",.<>/?\\|`~]{8,})/gi;
  const detections = [];
  let match;

  while ((match = passwordContext.exec(text)) !== null) {
    const candidate = (match[1] || "").trim();
    if (!candidate) continue;
    if (!/[a-z]/.test(candidate) || !/[A-Z]/.test(candidate) || !/\d/.test(candidate) || !/[^A-Za-z0-9]/.test(candidate)) {
      continue;
    }

    detections.push({
      match: candidate,
      confidence: 0.95,
      context: "Password assignment with strong secret format"
    });
  }

  return detections;
}

/**
 * Detect CVV/security code values with explicit context.
 * @param {string} text - Text to scan
 * @returns {Array} - Detections
 */
function detectCVV(text) {
  if (!text) return [];

  const cvvPattern = /(cvv|cvc|csc|security\s+code)\s*(?:[:=]|is)?\s*(\d{3,4})/gi;
  const detections = [];
  let match;

  while ((match = cvvPattern.exec(text)) !== null) {
    const candidate = match[2];
    if (!candidate || !/^\d{3,4}$/.test(candidate)) continue;
    detections.push({
      match: candidate,
      confidence: 0.95,
      context: "CVV/security code field detected"
    });
  }

  return detections;
}

/**
 * Detect credit card numbers using context + Luhn validation.
 * @param {string} text - Text to scan
 * @returns {Array} - Detections
 */
function detectCardNumber(text) {
  if (!text) return [];

  const lowerText = text.toLowerCase();
  const hasCardContext = /(?:card(?:\s+number)?|credit(?:\s+card)?|debit(?:\s+card)?|cc(?:\s+number)?)\b/.test(lowerText);
  if (!hasCardContext) return [];

  const cardPattern = /(?:card(?:\s+number)?|credit(?:\s+card)?|debit(?:\s+card)?|cc(?:\s+number)?)\s*(?:[:=]|is)?\s*(\d(?:[ -]?\d){12,18})/gi;
  const detections = [];
  let match;

  while ((match = cardPattern.exec(text)) !== null) {
    const candidate = (match[1] || "").replace(/\s+/g, "").replace(/-/g, "");
    if (!candidate || candidate.length < 13 || candidate.length > 19 || !isValidLuhn(candidate)) continue;

    detections.push({
      match: candidate,
      confidence: 0.9,
      context: "Credit/debit card number with Luhn validation"
    });
  }

  return detections;
}

/**
 * Detect email addresses.
 * @param {string} text - Text to scan
 * @returns {Array} - Detections
 */
function detectEmail(text) {
  if (!text) return [];

  const emailPattern = /(?<![A-Za-z0-9_])(?:[A-Za-z0-9._%+\-]+)@(?:[A-Za-z0-9.\-]+\.[A-Za-z]{2,})(?![A-Za-z0-9_])/g;
  const detections = [];
  let match;

  while ((match = emailPattern.exec(text)) !== null) {
    const candidate = match[0];
    if (!candidate || !/@/.test(candidate)) continue;

    detections.push({
      match: candidate,
      confidence: 0.95,
      context: "Email address pattern detected"
    });
  }

  return detections;
}

/**
 * Detect phone numbers with explicit context to avoid false positives.
 * @param {string} text - Text to scan
 * @returns {Array} - Detections
 */
function detectPhone(text) {
  if (!text) return [];

  const lowerText = text.toLowerCase();
  const hasPhoneContext = /(?:phone|mobile|tel|telephone|contact\s*(?:no|number))\b/.test(lowerText);
  if (!hasPhoneContext) return [];

  const phonePattern = /(\+?\d[\d\s().-]{8,}\d)/g;
  const detections = [];
  let match;

  while ((match = phonePattern.exec(text)) !== null) {
    const candidate = match[1].replace(/[^\d+]/g, "");
    if (!candidate || candidate.length < 10 || candidate.length > 15) continue;
    if (/^\d{4,6}$/.test(candidate.replace(/\D/g, ""))) continue;

    detections.push({
      match: candidate,
      confidence: 0.9,
      context: "Phone/mobile number with explicit context"
    });
  }

  return detections;
}

/**
 * Detect government ID numbers and PAN numbers.
 * @param {string} text - Text to scan
 * @returns {Array} - Detections
 */
function detectGovernmentId(text) {
  if (!text) return [];

  const detections = [];
  const lowerText = text.toLowerCase();

  const aadhaarPattern = /(?:aadhaar|uid|government\s+id|govt\s+id|id\s+number)\s*(?:[:=]|is)?\s*(\d{4}[\s-]?\d{4}[\s-]?\d{4})/gi;
  let match;
  while ((match = aadhaarPattern.exec(text)) !== null) {
    const candidate = (match[1] || "").replace(/\D/g, "");
    if (candidate.length === 12) {
      detections.push({
        match: candidate,
        confidence: 0.92,
        context: "Aadhaar/govt ID pattern with context"
      });
    }
  }

  const panPattern = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
  while ((match = panPattern.exec(text)) !== null) {
    const candidate = match[0];
    if (/(?:pan|tax\s*id|income\s*tax)/i.test(lowerText) || /\bPAN\b/i.test(text)) {
      detections.push({
        match: candidate,
        confidence: 0.9,
        context: "PAN pattern detected"
      });
    }
  }

  const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/g;
  while ((match = ssnPattern.exec(text)) !== null) {
    const candidate = match[0];
    if (/(?:ssn|social\s+security|tax\s+id)/i.test(lowerText)) {
      detections.push({
        match: candidate,
        confidence: 0.9,
        context: "SSN pattern detected"
      });
    }
  }

  return detections;
}

/**
 * Detect OTP (One-Time Password) patterns
 * Looks for 4-8 digit codes with contextual keywords
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections [{match, confidence, context}]
 */
function detectOTP(text) {
  if (!text) return [];
  
  const detections = [];
  
  // Context keywords that indicate OTP
  const otpContextKeywords = [
    "otp",
    "one-time password",
    "one time password",
    "verification code",
    "verify code",
    "security code",
    "confirmation code",
    "auth code",
    "2fa",
    "two-factor",
    "totp",
    "hotp"
  ];
  
  // Check if text contains OTP context keywords
  const lowerText = text.toLowerCase();
  const hasOtpContext = otpContextKeywords.some(
    keyword => lowerText.includes(keyword)
  );
  
  if (!hasOtpContext) return [];
  
  // Look for 4-8 digit sequences
  const otpPattern = /\b\d{4,8}\b/g;
  let match;
  
  while ((match = otpPattern.exec(text)) !== null) {
    detections.push({
      match: match[0],
      confidence: 0.85,
      context: "OTP context keywords present"
    });
  }
  
  return detections;
}

/**
 * Detect API keys and secrets
 * Looks for patterns like "api_key=...", "secret=...", etc.
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections
 */
function detectAPIKeyOrSecret(text) {
  if (!text) return [];
  
  const detections = [];
  
  // Patterns for API keys and secrets
  // Examples: sk-xxx, pk-xxx, ghp-xxx (GitHub), sv-xxx (Stripe)
  const apiKeyPatterns = [
    /\b(?:sk|pk|ghp|sv|rk|xox[baprs]-)[A-Za-z0-9_:-]{16,}\b/gi,
    /\b(?:sk|pk|ghp|sv|rk|xox[baprs]-)_(?:live|test)_[A-Za-z0-9_:-]{16,}\b/gi,
    /\b(api[_-]?key|secret[_-]?key|access[_-]?token|bearer[_-]?token)\s*[:=]\s*[a-zA-Z0-9._\-:]{20,}\b/gi,
    /\b(AKIA[0-9A-Z]{16})\b/g, // AWS Access Key
    /\b([a-zA-Z0-9/+]{40}={0,2})\b/g  // Base64 looking strings (conservative)
  ];
  
  for (const pattern of apiKeyPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // Only report if it looks like actual API key pattern
      if (match[0].length >= 20) {
        detections.push({
          match: match[0],
          confidence: 0.80,
          context: "API key/secret pattern detected"
        });
      }
    }
  }
  
  return detections;
}

/**
 * Detect authentication tokens
 * Looks for JWT, Bearer tokens, session tokens
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections
 */
function detectAuthToken(text) {
  if (!text) return [];
  
  const detections = [];
  
  // JWT pattern: xxx.xxx.xxx (3 base64-like segments)
  const jwtPattern = /\b[a-zA-Z0-9_-]{10,}\.([a-zA-Z0-9_-]{10,}\.)?[a-zA-Z0-9_-]{10,}\b/g;
  
  // Bearer token pattern
  const bearerPattern = /\b(bearer|bearer token|authorization bearer)\s+([a-zA-Z0-9._\-]{20,})\b/gi;
  
  // Session token pattern
  const sessionPattern = /\b(session[_-]?id|session[_-]?token|sessionid)\s*[:=]\s*([a-zA-Z0-9._\-]{20,})\b/gi;
  
  let match;
  
  // Check JWT pattern (more conservative due to false positives)
  while ((match = jwtPattern.exec(text)) !== null) {
    // Only count if we see jwt/token context nearby
    const context = text.substring(
      Math.max(0, match.index - 50),
      Math.min(text.length, match.index + match[0].length + 50)
    ).toLowerCase();
    
    if (
      context.includes("jwt") ||
      context.includes("token") ||
      context.includes("bearer")
    ) {
      detections.push({
        match: match[0],
        confidence: 0.82,
        context: "JWT/Token pattern detected"
      });
    }
  }
  
  // Check bearer pattern
  while ((match = bearerPattern.exec(text)) !== null) {
    detections.push({
      match: match[2] || match[0],
      confidence: 0.88,
      context: "Bearer token pattern detected"
    });
  }
  
  // Check session pattern
  while ((match = sessionPattern.exec(text)) !== null) {
    detections.push({
      match: match[2] || match[0],
      confidence: 0.80,
      context: "Session token pattern detected"
    });
  }
  
  return detections;
}

/**
 * Detect bank account and financial information
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections
 */
function detectFinancialInfo(text) {
  if (!text) return [];
  
  const detections = [];
  
  // IFSC code pattern (Indian bank): 4 letters + 0 + 6 digits
  const ifscPattern = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
  
  // SWIFT code pattern: 6-8 alphanumeric
  const swiftPattern = /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{1,3}\b/g;
  
  // IBAN-like pattern (flexible)
  const ibanPattern = /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g;
  
  // Bank account with account number context keywords
  const accountKeywords = [
    "account number",
    "account no",
    "a/c no",
    "a/c number",
    "acno",
    "bank account",
    "savings account",
    "checking account"
  ];
  
  const lowerText = text.toLowerCase();
  const hasAccountContext = accountKeywords.some(
    keyword => lowerText.includes(keyword)
  );
  
  const accountNumberPattern = /(?:account(?:\s+number|\s+no)?|bank\s+account|a\/c(?:\s*(?:no|number))?|acno)\s*(?:[:=]|is)?\s*(\d{9,18})/gi;

  let match;

  while ((match = accountNumberPattern.exec(text)) !== null) {
    const candidate = (match[1] || "").replace(/\D/g, "");
    if (candidate.length >= 9 && candidate.length <= 18) {
      detections.push({
        match: candidate,
        confidence: 0.8,
        context: "Account number pattern with explicit bank/account context"
      });
    }
  }

  // Check IFSC code (high confidence)
  while ((match = ifscPattern.exec(text)) !== null) {
    detections.push({
      match: match[0],
      confidence: 0.90,
      context: "IFSC code pattern detected"
    });
  }

  // Check SWIFT code (medium confidence)
  while ((match = swiftPattern.exec(text)) !== null) {
    detections.push({
      match: match[0],
      confidence: 0.75,
      context: "SWIFT code pattern detected"
    });
  }

  // Check IBAN (with context keywords for higher confidence)
  if (hasAccountContext) {
    while ((match = ibanPattern.exec(text)) !== null) {
      if (match[0].length >= 15) {
        detections.push({
          match: match[0],
          confidence: 0.80,
          context: "Account number pattern with context"
        });
      }
    }
  }

  return detections;
}

/**
 * Detect employee/student ID patterns
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections
 */
function detectEmployeeStudentID(text) {
  if (!text) return [];
  
  const detections = [];
  
  // Context keywords
  const idContextKeywords = [
    "employee id",
    "emp id",
    "empid",
    "employee number",
    "staff id",
    "student id",
    "student number",
    "roll number",
    "roll no",
    "enrollment number",
    "id number",
    "registration number"
  ];
  
  const lowerText = text.toLowerCase();
  const hasIDContext = idContextKeywords.some(
    keyword => lowerText.includes(keyword)
  );
  
  if (!hasIDContext) return [];
  
  // Common ID patterns: 6-12 alphanumeric
  const idPattern = /\b([A-Z]{2,4})?[-]?(\d{6,12})\b/g;
  
  let match;
  while ((match = idPattern.exec(text)) !== null) {
    // Avoid matching common numbers like years or simple sequences
    const idPart = match[2];
    if (
      !/^\d{4}$/.test(idPart) && // Not a 4-digit year
      !/(1111|2222|3333|4444|5555|6666|7777|8888|9999|0000)/.test(idPart) // Not repeating digits
    ) {
      detections.push({
        match: match[0],
        confidence: 0.80,
        context: "Employee/Student ID with context keywords"
      });
    }
  }
  
  return detections;
}

/**
 * Detect date of birth patterns
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections
 */
function detectDateOfBirth(text) {
  if (!text) return [];
  
  const detections = [];
  
  // Context keywords for DOB
  const dobContextKeywords = [
    "date of birth",
    "dob",
    "birth date",
    "date of birth:",
    "born",
    "birthday"
  ];
  
  const lowerText = text.toLowerCase();
  const hasDobContext = dobContextKeywords.some(
    keyword => lowerText.includes(keyword)
  );
  
  if (!hasDobContext) return [];
  
  // Common date patterns: DD-MM-YYYY, DD/MM/YYYY, MM-DD-YYYY, etc.
  const datePatterns = [
    /\b(0?[1-9]|[12]\d|3[01])[-\/](0?[1-9]|1[0-2])[-\/](19|20)\d{2}\b/g,
    /\b(19|20)\d{2}[-\/](0?[1-9]|1[0-2])[-\/](0?[1-9]|[12]\d|3[01])\b/g
  ];
  
  for (const pattern of datePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      detections.push({
        match: match[0],
        confidence: 0.85,
        context: "Date of birth pattern with context"
      });
    }
  }
  
  return detections;
}

/**
 * Detect person names (contextual)
 * Very conservative: only flags when explicitly marked as name field
 * @param {string} text - Text to scan
 * @returns {Array} - Array of detections
 */
function detectPersonName(text) {
  if (!text || text.length > 200) return [];

  const detections = [];

  const nameContextKeywords = [
    "full name",
    "first name",
    "last name",
    "your name",
    "contact name",
    "name:"
  ];

  const lowerText = text.toLowerCase();
  const hasNameContext = nameContextKeywords.some(
    keyword => lowerText.includes(keyword)
  );

  if (!hasNameContext) return [];

  const namePattern = /(?:full\s+name|first\s+name|last\s+name|your\s+name|contact\s+name|name)\s*(?:[:=]|is)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
  let match;

  while ((match = namePattern.exec(text)) !== null) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;

    const words = candidate.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 4 && words.every(word => /^[A-Z][a-z]+$/.test(word))) {
      detections.push({
        match: candidate,
        confidence: 0.70,
        context: "Person name with context keywords"
      });
    }
  }

  return detections;
}

function detectAddress(text) {
  if (!text || text.length > 500) return [];

  const detections = [];

  const addressContextKeywords = [
    "address",
    "street",
    "city",
    "state",
    "zip code",
    "postal code",
    "zipcode",
    "zip:",
    "location",
    "mailing address",
    "residential address"
  ];

  const lowerText = text.toLowerCase();
  const hasAddressContext = addressContextKeywords.some(
    keyword => lowerText.includes(keyword)
  );

  if (!hasAddressContext) return [];

  const addressWords = [
    "st\\b", "street", "ave\\b", "avenue", "rd\\b", "road",
    "blvd", "boulevard", "ln\\b", "lane", "dr\\b", "drive",
    "ct\\b", "court", "pl\\b", "place", "way", "circle",
    "town", "city", "state", "zip", "postal"
  ];

  const hasAddressWord = addressWords.some(
    word => lowerText.includes(word)
  );

  if (hasAddressWord) {
    detections.push({
      match: text,
      confidence: 0.75,
      context: "Address pattern with context keywords"
    });
  }

  return detections;
}

function runAllDeterministicDetectors(text) {
  if (!text) return [];

  const allDetections = [];

  const passwordResults = detectPassword(text);
  const otpResults = detectOTP(text);
  const cvvResults = detectCVV(text);
  const cardResults = detectCardNumber(text);
  const emailResults = detectEmail(text);
  const phoneResults = detectPhone(text);
  const apiKeyResults = detectAPIKeyOrSecret(text);
  const authTokenResults = detectAuthToken(text);
  const governmentIdResults = detectGovernmentId(text);
  const financialResults = detectFinancialInfo(text);
  const employeeIDResults = detectEmployeeStudentID(text);
  const dobResults = detectDateOfBirth(text);
  const nameResults = detectPersonName(text);
  const addressResults = detectAddress(text);

  passwordResults.forEach(det => {
    allDetections.push({ ...det, piiType: "PASSWORD", severity: "CRITICAL" });
  });

  otpResults.forEach(det => {
    allDetections.push({ ...det, piiType: "OTP", severity: "CRITICAL" });
  });

  cvvResults.forEach(det => {
    allDetections.push({ ...det, piiType: "CVV", severity: "CRITICAL" });
  });

  cardResults.forEach(det => {
    allDetections.push({ ...det, piiType: "CARD", severity: "CRITICAL" });
  });

  emailResults.forEach(det => {
    allDetections.push({ ...det, piiType: "EMAIL", severity: "HIGH" });
  });

  phoneResults.forEach(det => {
    allDetections.push({ ...det, piiType: "PHONE", severity: "HIGH" });
  });

  apiKeyResults.forEach(det => {
    allDetections.push({ ...det, piiType: "API_KEY", severity: "CRITICAL" });
  });

  authTokenResults.forEach(det => {
    allDetections.push({ ...det, piiType: "AUTH_TOKEN", severity: "CRITICAL" });
  });

  governmentIdResults.forEach(det => {
    allDetections.push({ ...det, piiType: "GOVERNMENT_ID", severity: "HIGH" });
  });

  financialResults.forEach(det => {
    allDetections.push({ ...det, piiType: "FINANCIAL_INFO", severity: "HIGH" });
  });

  employeeIDResults.forEach(det => {
    allDetections.push({ ...det, piiType: "EMPLOYEE_ID", severity: "HIGH" });
  });

  dobResults.forEach(det => {
    allDetections.push({ ...det, piiType: "DATE_OF_BIRTH", severity: "CONTEXT_DEPENDENT" });
  });

  nameResults.forEach(det => {
    allDetections.push({ ...det, piiType: "PERSON", severity: "CONTEXT_DEPENDENT" });
  });

  addressResults.forEach(det => {
    allDetections.push({ ...det, piiType: "ADDRESS", severity: "CONTEXT_DEPENDENT" });
  });

  return allDetections;
}

// Export functions
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PII_TYPES,
    REDACTION_ACTIONS,
    classifyInputElement,
    classifyTextPattern,
    getRecommendedRedactionAction,
    enrichDetection,
    standardizeDetection,
    normalizeStandardizedType,
    normalizeStandardizedSeverity,
    normalizeStandardizedAction,
    detectOTP,
    detectAPIKeyOrSecret,
    detectAuthToken,
    detectFinancialInfo,
    detectEmployeeStudentID,
    detectDateOfBirth,
    detectPersonName,
    detectAddress,
    runAllDeterministicDetectors,
    isValidLuhn
  };
}
