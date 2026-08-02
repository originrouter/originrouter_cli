import { createPublicKey, createHash, verify } from "node:crypto";

import { validateCompatibilityWasmBytes } from "./wasmDomHost.js";

export const COMPATIBILITY_CODE_ENGINE_VERSION = "2.0.0";
export const COMPATIBILITY_CODE_BUNDLE_SCHEMA = "originrouter-compatibility-code-bundle-v1";
export const COMPATIBILITY_CODE_SIGNED_ENVELOPE = "originrouter-compatibility-code-signed-v1";
export const COMPATIBILITY_CODE_SIGNATURE_DOMAIN = "originrouter/compatibility-code-bundle/v1\n";
export const COMPATIBILITY_WASM_ABI = "originrouter-json-dom-v1";

const PHASES = new Set(["request", "response", "stream", "error"]);
const FAILURE_MODES = new Set(["reject", "passthrough"]);
const MAX_PATCHES = 128;
const MAX_MODULE_BYTES = 1024 * 1024;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || Number.isSafeInteger(value)) return value;
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalCompatibilityCodeJson(value) {
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
  assertAllowedKeys(match, allowed, field);
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

function decodeModule(module, field) {
  if (!module || typeof module !== "object" || Array.isArray(module)) {
    throw new Error(`${field} must be an object`);
  }
  assertAllowedKeys(module, new Set(["runtime", "abi", "sha256", "bytes"]), field);
  if (module.runtime !== "wasm") throw new Error(`${field}.runtime must be 'wasm'`);
  if (module.abi !== COMPATIBILITY_WASM_ABI) {
    throw new Error(`${field}.abi '${module.abi || ""}' is not supported`);
  }
  if (typeof module.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(module.sha256)) {
    throw new Error(`${field}.sha256 must be a lowercase SHA-256 digest`);
  }
  const encoded = text(module.bytes, `${field}.bytes`, { max: MAX_MODULE_BYTES * 2 });
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error(`${field}.bytes must use canonical Base64`);
  if (bytes.length === 0 || bytes.length > MAX_MODULE_BYTES) {
    throw new Error(`${field}.bytes must decode to between 1 byte and ${MAX_MODULE_BYTES} bytes`);
  }
  if (bytes.length < 8 || bytes.subarray(0, 4).toString("hex") !== "0061736d") {
    throw new Error(`${field}.bytes is not a WebAssembly module`);
  }
  try {
    validateCompatibilityWasmBytes(bytes);
  } catch (error) {
    throw new Error(`${field}.bytes violates the OriginRouter WASM sandbox: ${error.message}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== module.sha256) throw new Error(`${field}.sha256 does not match its module bytes`);
  return { runtime: "wasm", abi: COMPATIBILITY_WASM_ABI, sha256: digest, bytes: encoded };
}

export function validateCompatibilityCodeBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("compatibility code bundle must be an object");
  }
  assertAllowedKeys(bundle, new Set([
    "schema", "bundle_id", "revision", "min_engine_version", "max_engine_version",
    "generated_at", "expires_at", "complete_snapshot", "patches",
  ]), "bundle");
  if (bundle.schema !== COMPATIBILITY_CODE_BUNDLE_SCHEMA) {
    throw new Error(`unsupported compatibility code bundle '${bundle.schema || ""}'`);
  }
  const bundleId = text(bundle.bundle_id, "bundle_id");
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 1) {
    throw new Error("revision must be a positive integer");
  }
  if (bundle.complete_snapshot !== true) throw new Error("complete_snapshot must be true");
  const minEngineVersion = text(bundle.min_engine_version, "min_engine_version", { optional: true, max: 32 });
  const maxEngineVersion = text(bundle.max_engine_version, "max_engine_version", { optional: true, max: 32 });
  const expiresAt = text(bundle.expires_at, "expires_at", { optional: true, max: 64 });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error("expires_at must be an ISO timestamp");
  if (!Array.isArray(bundle.patches) || bundle.patches.length > MAX_PATCHES) {
    throw new Error(`patches must be an array with at most ${MAX_PATCHES} entries`);
  }
  const ids = new Set();
  const patches = bundle.patches.map((patch, index) => {
    const field = `patches[${index}]`;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error(`${field} must be an object`);
    }
    assertAllowedKeys(patch, new Set([
      "id", "name", "description", "version", "phase", "priority", "required", "failure_mode", "match",
      "before", "after", "conflicts_with", "module",
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
      before: stringList(patch.before, `${field}.before`) || [],
      after: stringList(patch.after, `${field}.after`) || [],
      conflicts_with: stringList(patch.conflicts_with, `${field}.conflicts_with`) || [],
      module: decodeModule(patch.module, `${field}.module`),
    };
  });
  for (const patch of patches) {
    for (const conflict of patch.conflicts_with) {
      if (ids.has(conflict)) throw new Error(`compatibility patches '${patch.id}' and '${conflict}' conflict`);
    }
  }
  return {
    schema: COMPATIBILITY_CODE_BUNDLE_SCHEMA,
    bundle_id: bundleId,
    revision: bundle.revision,
    min_engine_version: minEngineVersion,
    max_engine_version: maxEngineVersion,
    generated_at: typeof bundle.generated_at === "string" ? bundle.generated_at : null,
    expires_at: expiresAt,
    complete_snapshot: true,
    patches,
  };
}

function readyCompare(a, b) {
  return b.priority - a.priority || a.id.localeCompare(b.id);
}

export function orderCompatibilityCodePatches(patches) {
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  for (const patch of patches) {
    for (const dependency of [...patch.before, ...patch.after]) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`compatibility patch '${patch.id}' references missing patch '${dependency}'`);
      if (target.phase !== patch.phase) {
        throw new Error(`compatibility patches '${patch.id}' and '${dependency}' cannot order across phases`);
      }
    }
  }
  const result = [];
  for (const phase of PHASES) {
    const phasePatches = patches.filter((patch) => patch.phase === phase);
    const ids = new Set(phasePatches.map((patch) => patch.id));
    const outgoing = new Map(phasePatches.map((patch) => [patch.id, new Set()]));
    const indegree = new Map(phasePatches.map((patch) => [patch.id, 0]));
    const addEdge = (from, to) => {
      if (!ids.has(from) || !ids.has(to)) return;
      const edges = outgoing.get(from);
      if (edges.has(to)) return;
      edges.add(to);
      indegree.set(to, indegree.get(to) + 1);
    };
    for (const patch of phasePatches) {
      for (const before of patch.before) addEdge(patch.id, before);
      for (const after of patch.after) addEdge(after, patch.id);
    }
    const ready = phasePatches.filter((patch) => indegree.get(patch.id) === 0).sort(readyCompare);
    let emitted = 0;
    while (ready.length > 0) {
      const patch = ready.shift();
      result.push(patch);
      emitted += 1;
      for (const target of outgoing.get(patch.id)) {
        indegree.set(target, indegree.get(target) - 1);
        if (indegree.get(target) === 0) {
          ready.push(byId.get(target));
          ready.sort(readyCompare);
        }
      }
    }
    if (emitted !== phasePatches.length) {
      throw new Error(`compatibility patch dependency cycle in phase '${phase}'`);
    }
  }
  return result;
}

export function validateSignedCompatibilityCodeEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("signed compatibility code envelope must be an object");
  }
  assertAllowedKeys(envelope, new Set(["schema", "key_id", "algorithm", "payload", "signature"]), "envelope");
  if (envelope.schema !== COMPATIBILITY_CODE_SIGNED_ENVELOPE) {
    throw new Error(`unsupported signed compatibility code envelope '${envelope.schema || ""}'`);
  }
  return {
    schema: COMPATIBILITY_CODE_SIGNED_ENVELOPE,
    key_id: text(envelope.key_id, "key_id"),
    algorithm: envelope.algorithm,
    payload: validateCompatibilityCodeBundle(envelope.payload),
    signature: text(envelope.signature, "signature", { max: 512 }),
  };
}

export function verifySignedCompatibilityCodeBundle(envelope, trustedKeys) {
  const normalized = validateSignedCompatibilityCodeEnvelope(envelope);
  if (normalized.algorithm !== "Ed25519") {
    throw new Error(`unsupported compatibility signature algorithm '${normalized.algorithm || ""}'`);
  }
  const keyValue = trustedKeys?.[normalized.key_id];
  if (!keyValue) throw new Error(`untrusted compatibility signing key '${normalized.key_id}'`);
  const key = typeof keyValue === "string"
    ? createPublicKey(keyValue)
    : createPublicKey({ key: keyValue, format: "jwk" });
  const message = Buffer.from(
    `${COMPATIBILITY_CODE_SIGNATURE_DOMAIN}${canonicalCompatibilityCodeJson(envelope.payload)}`,
    "utf8",
  );
  const signature = Buffer.from(normalized.signature, "base64url");
  if (!verify(null, message, key, signature)) throw new Error("compatibility code bundle signature verification failed");
  return normalized.payload;
}
