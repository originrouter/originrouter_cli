const SECRET_KEY = /secret|password|passphrase|api[_-]?key|authorization|cookie|credential/i;

function isSecretKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (SECRET_KEY.test(normalized)) return true;
  if (!normalized.includes("token")) return false;
  if (
    /(^|[_-])(tokens|token_count|token_usage|max_tokens|estimated_tokens|input_tokens|output_tokens|pre_tokens|post_tokens)($|[_-])/.test(normalized)
  ) {
    return false;
  }
  return /(^|[_-])(?:access|refresh|auth|bearer|session)?[_-]?token(?:[_-]?(?:value|key))?($|[_-])/.test(normalized);
}

export function toolInputContainsSecret(value, key = "", seen = new WeakSet()) {
  if (isSecretKey(key)) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => toolInputContainsSecret(item, "", seen));
  }
  return Object.entries(value).some(
    ([name, item]) => toolInputContainsSecret(item, name, seen),
  );
}

function sanitize(value, key, seen, depth) {
  if (isSecretKey(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 8192);
  if (typeof value !== "object") return String(value).slice(0, 8192);
  if (depth >= 8) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, "", seen, depth + 1));
  }
  const out = {};
  for (const [name, item] of Object.entries(value).slice(0, 64)) {
    out[name] = sanitize(item, name, seen, depth + 1);
  }
  return out;
}

export function displaySafeToolInput(input, { maxEncodedLength = 16_384 } = {}) {
  if (!input || typeof input !== "object") return {};
  const sanitized = sanitize(input, "", new WeakSet(), 0);
  try {
    const encoded = JSON.stringify(sanitized);
    if (encoded.length <= maxEncodedLength) return sanitized;
    return {
      preview: `${encoded.slice(0, maxEncodedLength)}...`,
      truncated: true,
    };
  } catch {
    return { preview: "[unavailable]", truncated: true };
  }
}
