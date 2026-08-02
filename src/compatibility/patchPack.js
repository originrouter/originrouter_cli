import { createPublicKey, verify } from "node:crypto";

export const COMPATIBILITY_ENGINE_VERSION = "1.1.0";
export const COMPATIBILITY_PACK_SCHEMA = "originrouter-model-compatibility-pack-v1";
export const COMPATIBILITY_SIGNED_ENVELOPE = "originrouter-model-compatibility-signed-v1";
export const COMPATIBILITY_SIGNATURE_DOMAIN = "originrouter/model-compatibility-pack/v1\n";

const PHASES = new Set(["request", "response", "stream", "error"]);
const FAILURE_MODES = new Set(["reject", "passthrough"]);
const CHANNELS = new Set(["stable", "beta", "canary"]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || Number.isSafeInteger(value)) return value;
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalCompatibilityJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function text(value, field, { optional = false, max = 256 } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== "string" || !value || value.length > max) {
    throw new Error(`${field} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function stringList(value, field, { optional = true, maxItems = 128 } = {}) {
  if (optional && value == null) return null;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${field} must be an array with at most ${maxItems} entries`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported`);
  }
}

function validateMatch(match, field) {
  if (match == null) return {};
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    throw new Error(`${field} must be an object`);
  }
  const allowed = new Set([
    "methods", "paths", "protocols", "runtimes", "providers", "provider_families",
    "exclude_provider_families", "models", "stream", "min_litellm_version",
    "max_litellm_version",
  ]);
  for (const key of Object.keys(match)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported`);
  }
  const result = {};
  for (const key of [
    "methods", "paths", "protocols", "runtimes", "providers", "provider_families",
    "exclude_provider_families", "models",
  ]) {
    const list = stringList(match[key], `${field}.${key}`);
    if (list != null) result[key] = list;
  }
  if (match.stream != null) {
    if (typeof match.stream !== "boolean") throw new Error(`${field}.stream must be boolean`);
    result.stream = match.stream;
  }
  for (const key of ["min_litellm_version", "max_litellm_version"]) {
    const value = text(match[key], `${field}.${key}`, { optional: true, max: 32 });
    if (value != null) result[key] = value;
  }
  return result;
}

function validateOperation(operation, field) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new Error(`${field} must be an object`);
  }
  assertAllowedKeys(operation, new Set(["operator", "options"]), field);
  const operator = text(operation.operator, `${field}.operator`, { max: 96 });
  const options = operation.options == null ? {} : operation.options;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${field}.options must be an object`);
  }
  return { operator, options: structuredClone(options) };
}

export function validateCompatibilityPack(pack) {
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    throw new Error("compatibility pack must be an object");
  }
  assertAllowedKeys(pack, new Set([
    "schema", "pack_id", "revision", "channel", "min_engine_version",
    "max_engine_version", "generated_at", "expires_at", "patches",
  ]), "pack");
  if (pack.schema !== COMPATIBILITY_PACK_SCHEMA) {
    throw new Error(`unsupported compatibility pack schema '${pack.schema || ""}'`);
  }
  const packId = text(pack.pack_id, "pack_id");
  if (!Number.isSafeInteger(pack.revision) || pack.revision < 1) {
    throw new Error("revision must be a positive integer");
  }
  const minEngineVersion = text(pack.min_engine_version, "min_engine_version", { optional: true, max: 32 });
  const maxEngineVersion = text(pack.max_engine_version, "max_engine_version", { optional: true, max: 32 });
  const channel = pack.channel || "stable";
  if (!CHANNELS.has(channel)) throw new Error(`unsupported compatibility channel '${channel}'`);
  const expiresAt = text(pack.expires_at, "expires_at", { optional: true, max: 64 });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error("expires_at must be an ISO timestamp");
  if (!Array.isArray(pack.patches) || pack.patches.length > 512) {
    throw new Error("patches must be an array with at most 512 entries");
  }
  const ids = new Set();
  const patches = pack.patches.map((patch, index) => {
    const field = `patches[${index}]`;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(`${field} must be an object`);
    }
    assertAllowedKeys(patch, new Set([
      "id", "name", "description", "version", "phase", "priority", "required", "failure_mode",
      "match", "operations",
    ]), field);
    const id = text(patch.id, `${field}.id`);
    if (ids.has(id)) throw new Error(`duplicate compatibility patch id '${id}'`);
    ids.add(id);
    const version = text(patch.version, `${field}.version`, { max: 32 });
    if (!PHASES.has(patch.phase)) throw new Error(`${field}.phase is not supported`);
    const priority = patch.priority == null ? 0 : patch.priority;
    if (!Number.isSafeInteger(priority) || priority < -100000 || priority > 100000) {
      throw new Error(`${field}.priority must be an integer between -100000 and 100000`);
    }
    const failureMode = patch.failure_mode || "reject";
    if (!FAILURE_MODES.has(failureMode)) throw new Error(`${field}.failure_mode is not supported`);
    if (!Array.isArray(patch.operations) || patch.operations.length === 0 || patch.operations.length > 32) {
      throw new Error(`${field}.operations must contain between 1 and 32 operations`);
    }
    return {
      id,
      name: text(patch.name, `${field}.name`, { optional: true, max: 128 }),
      description: text(patch.description, `${field}.description`, { optional: true, max: 1024 }),
      version,
      phase: patch.phase,
      priority,
      required: patch.required === true,
      failure_mode: failureMode,
      match: validateMatch(patch.match, `${field}.match`),
      operations: patch.operations.map((operation, opIndex) => (
        validateOperation(operation, `${field}.operations[${opIndex}]`)
      )),
    };
  });
  return {
    schema: COMPATIBILITY_PACK_SCHEMA,
    pack_id: packId,
    revision: pack.revision,
    channel,
    min_engine_version: minEngineVersion,
    max_engine_version: maxEngineVersion,
    generated_at: typeof pack.generated_at === "string" ? pack.generated_at : null,
    expires_at: expiresAt,
    patches,
  };
}

export function validateSignedCompatibilityEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("signed compatibility envelope must be an object");
  }
  assertAllowedKeys(envelope, new Set([
    "schema", "key_id", "algorithm", "payload", "signature",
  ]), "envelope");
  if (envelope.schema !== COMPATIBILITY_SIGNED_ENVELOPE) {
    throw new Error(`unsupported signed compatibility envelope '${envelope.schema || ""}'`);
  }
  return {
    schema: COMPATIBILITY_SIGNED_ENVELOPE,
    key_id: text(envelope.key_id, "key_id"),
    algorithm: envelope.algorithm,
    payload: validateCompatibilityPack(envelope.payload),
    signature: text(envelope.signature, "signature", { max: 512 }),
  };
}

export function verifySignedCompatibilityPack(envelope, trustedKeys) {
  const normalized = validateSignedCompatibilityEnvelope(envelope);
  if (normalized.algorithm !== "Ed25519") {
    throw new Error(`unsupported compatibility signature algorithm '${normalized.algorithm || ""}'`);
  }
  const keyValue = trustedKeys?.[normalized.key_id];
  if (!keyValue) throw new Error(`untrusted compatibility signing key '${normalized.key_id}'`);
  const key = typeof keyValue === "string"
    ? createPublicKey(keyValue)
    : createPublicKey({ key: keyValue, format: "jwk" });
  const message = Buffer.from(
    `${COMPATIBILITY_SIGNATURE_DOMAIN}${canonicalCompatibilityJson(envelope.payload)}`,
    "utf8",
  );
  const signature = Buffer.from(normalized.signature, "base64url");
  if (!verify(null, message, key, signature)) {
    throw new Error("compatibility pack signature verification failed");
  }
  return normalized.payload;
}

export function mergeCompatibilityPacks(basePack, updatePack) {
  const base = validateCompatibilityPack(basePack);
  if (updatePack == null) return base;
  const update = validateCompatibilityPack(updatePack);
  const merged = new Map(base.patches.map((patch) => [patch.id, patch]));
  for (const patch of update.patches) merged.set(patch.id, patch);
  return {
    schema: COMPATIBILITY_PACK_SCHEMA,
    pack_id: `${base.pack_id}+${update.pack_id}`,
    revision: Math.max(base.revision, update.revision),
    channel: update.channel,
    min_engine_version: base.min_engine_version,
    max_engine_version: base.max_engine_version,
    generated_at: update.generated_at || base.generated_at,
    expires_at: update.expires_at,
    patches: [...merged.values()],
  };
}
