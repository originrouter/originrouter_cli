const SECRET_KEY = /secret|password|passphrase|api[_-]?key|authorization|cookie|credential/i;
const TOKEN_KEY = /(^|[_-])(?:access|refresh|auth|bearer|session)?[_-]?token(?:[_-]?(?:value|key))?($|[_-])/i;
const SAFE_TOKEN_KEY = /(^|[_-])(tokens|token_count|token_usage|max_tokens|estimated_tokens|input_tokens|output_tokens|sampled_tokens|fencing_token)($|[_-])/i;

function secretKey(key) {
  const normalized = String(key || "");
  return SECRET_KEY.test(normalized)
    || (TOKEN_KEY.test(normalized) && !SAFE_TOKEN_KEY.test(normalized));
}

export function redactDisplayText(value, maxLength = 8192) {
  return String(value ?? "")
    .slice(0, Math.max(0, Number(maxLength) || 0))
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]")
    .replace(/\b(?:sk[-_]|or_(?:at|rt|lk)_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._~-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function redactDisplayValue(value, {
  maxStringLength = 8192,
  maxDepth = 8,
  maxArrayLength = 100,
  maxObjectEntries = 64,
} = {}, key = "", seen = new WeakSet(), depth = 0) {
  if (secretKey(key)) return "[REDACTED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactDisplayText(value, maxStringLength);
  if (typeof value !== "object") return redactDisplayText(value, maxStringLength);
  if (depth >= maxDepth) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayLength).map((item) =>
      redactDisplayValue(item, {
        maxStringLength, maxDepth, maxArrayLength, maxObjectEntries,
      }, "", seen, depth + 1));
  }
  const output = {};
  for (const [name, item] of Object.entries(value).slice(0, maxObjectEntries)) {
    output[name] = redactDisplayValue(item, {
      maxStringLength, maxDepth, maxArrayLength, maxObjectEntries,
    }, name, seen, depth + 1);
  }
  return output;
}
