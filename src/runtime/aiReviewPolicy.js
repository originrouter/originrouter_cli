import { createHash } from "node:crypto";

const TEMPLATE_ID = /^ait_[A-Za-z0-9._~-]{8,80}$/;
const CONTENT_HASH = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const SCOPE_IDS = new Set([
  "plan_continue",
  "explicit_continue_questions",
  "read_tools",
  "workspace_edits",
  "workspace_commands",
  "additional_permissions",
  "destructive_commands",
  "elevated_commands",
  "network_mutations",
  "outside_workspace",
  "unknown_tools",
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function invalid(message = "The AI approval template is invalid.") {
  const error = new Error(message);
  error.code = "AI_REVIEW_POLICY_INVALID";
  return error;
}

export function normalizeAiReviewPolicySnapshot(value, { required = false } = {}) {
  if (value == null) {
    if (required) throw invalid("Select an AI approval template before enabling AI approval.");
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const allowedKeys = new Set([
    "protocol_version",
    "template_id",
    "version",
    "name",
    "instructions",
    "allowed_scopes",
    "applicability",
    "content_hash",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw invalid();
  const templateId = String(value.template_id || "").trim();
  const name = String(value.name || "").trim();
  const instructions = String(value.instructions || "").trim();
  const version = Number(value.version);
  const contentHash = String(value.content_hash || "").trim().toLowerCase();
  const rawScopes = Array.isArray(value.allowed_scopes) ? value.allowed_scopes : null;
  const allowedScopes = (rawScopes || [])
    .map((item) => String(item || "").trim())
    .filter((item) => SCOPE_IDS.has(item));
  const applicability = value.applicability;
  if (
    value.protocol_version !== "1"
    || !TEMPLATE_ID.test(templateId)
    || !Number.isSafeInteger(version)
    || version < 0
    || !name
    || name.length > 128
    || !instructions
    || instructions.length > 8000
    || rawScopes == null
    || allowedScopes.length !== rawScopes.length
    || new Set(rawScopes).size !== rawScopes.length
    || !applicability
    || typeof applicability !== "object"
    || Array.isArray(applicability)
    || Object.keys(applicability).some((key) => !["device_id", "workspace_reference"].includes(key))
    || Object.values(applicability).some((item) => typeof item !== "string" || !item.trim() || item.length > 4096)
    || !CONTENT_HASH.test(contentHash)
  ) {
    throw invalid();
  }
  const template = {
    protocol_version: "1",
    template_id: templateId,
    name,
    instructions,
    allowed_scopes: allowedScopes,
    applicability: { ...applicability },
  };
  const expectedHash = createHash("sha256").update(canonicalJson(template)).digest("hex");
  if (expectedHash !== contentHash) {
    throw invalid("The AI approval template changed during delivery. Apply it again.");
  }
  const snapshot = Object.freeze({
    ...template,
    applicability: Object.freeze(template.applicability),
    allowed_scopes: Object.freeze(template.allowed_scopes),
    version,
    content_hash: contentHash,
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw invalid("The AI approval template is too large.");
  }
  return snapshot;
}

export function aiReviewPolicyFromPayload(payload, options) {
  return normalizeAiReviewPolicySnapshot(
    payload?.aiReviewPolicy || payload?.ai_review_policy,
    options,
  );
}

export function aiReviewPolicyFromEnvironment(env = process.env) {
  const encoded = String(env.ORIGINROUTER_AI_REVIEW_POLICY_B64 || "").trim();
  if (!encoded) return null;
  try {
    return normalizeAiReviewPolicySnapshot(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch (error) {
    if (error?.code === "AI_REVIEW_POLICY_INVALID") throw error;
    throw invalid();
  }
}

export function encodeAiReviewPolicyEnvironment(snapshot) {
  const normalized = normalizeAiReviewPolicySnapshot(snapshot, { required: true });
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function aiReviewPolicySummary(snapshot) {
  if (!snapshot) return null;
  return {
    templateId: snapshot.template_id,
    version: snapshot.version,
    name: snapshot.name,
    contentHash: snapshot.content_hash,
  };
}
