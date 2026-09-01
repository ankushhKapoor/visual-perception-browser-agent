export const PRIVACY_RAW_FIELD_KEYS = new Set([
  "value",
  "text",
  "match",
  "originalvalue",
  "originalValue",
  "originaltext",
  "originalText",
  "rawvalue",
  "rawValue",
  "rawvalues",
  "rawValues",
  "sourceText",
  "sourcetext",
  "fulltext",
  "fullText",
  "authorization",
  "bearer",
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
  "sessionSecret",
  "session_secret"
]);

export function isPrivacyRawFieldKey(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) {
    return false;
  }

  return PRIVACY_RAW_FIELD_KEYS.has(normalized)
    || PRIVACY_RAW_FIELD_KEYS.has(normalized.toLowerCase())
    || PRIVACY_RAW_FIELD_KEYS.has(normalized.toUpperCase());
}

export const PRIVACY_EXPORT_BLOCKLIST = new Set([
  ...PRIVACY_RAW_FIELD_KEYS,
  "authorization",
  "bearer",
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
  "sessionSecret",
  "session_secret"
]);

export function shouldStripPrivacyExportKey(key) {
  return isPrivacyRawFieldKey(key);
}
