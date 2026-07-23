import { createHash } from "node:crypto";

export const EVIDENCE_POLICY = Object.freeze({
  citation_required: true,
  treat_as_untrusted_data: true,
  allow_actions: false,
  allow_cross_domain: false,
});

const ID_PATTERN = /^[A-Za-z0-9._~-]{8,191}$/;
const FORBIDDEN_KEYS = /^(?:access_token|refresh_token|authorization|cookie|api_key|service_key|key_plaintext|key_ciphertext|encrypted_dek|environment|env_dump)$/i;

export function stableDigest(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function stableProtocolId(prefix, value, length = 32) {
  return `${prefix}${stableDigest(value).slice(0, length)}`;
}

export function requireInquiryId(value, field, prefix) {
  const normalized = String(value ?? "").trim();
  const suffix = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "";
  if (!suffix || !ID_PATTERN.test(suffix)) {
    const error = new Error(`invalid_${field}`);
    error.code = `invalid_${field}`;
    throw error;
  }
  return normalized;
}

export function assertNoSecretFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) {
      const error = new Error(`forbidden_field:${key.toLowerCase()}`);
      error.code = "forbidden_evidence_field";
      throw error;
    }
    assertNoSecretFields(child);
  }
}

export function contentHash(value) {
  return stableDigest(JSON.stringify(value));
}

