import { BUILTIN_COMPATIBILITY_PACK } from "./builtinPack.js";
import {
  COMPATIBILITY_CODE_BUNDLE_SCHEMA,
  orderCompatibilityCodePatches,
  validateCompatibilityCodeBundle,
} from "./codeBundle.js";
import { COMPATIBILITY_OPERATORS } from "./operators.js";
import { mergeCompatibilityPacks, validateCompatibilityPack } from "./patchPack.js";
import { WasmPatchExecutor } from "./wasmExecutor.js";

function normalizedPath(path) {
  const raw = String(path || "/");
  const query = raw.indexOf("?");
  return query >= 0 ? raw.slice(0, query) : raw;
}

function includes(list, value, { upper = false } = {}) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const target = upper ? String(value || "").toUpperCase() : String(value || "");
  return list.some((item) => (upper ? item.toUpperCase() : item) === target);
}

function compareSemver(left, right) {
  const parse = (value) => {
    const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function compatibilityPatchMatches(patch, context) {
  const match = patch.match || {};
  if (!includes(match.methods, context.method, { upper: true })) return false;
  if (!includes(match.paths, normalizedPath(context.path))) return false;
  if (!includes(match.protocols, context.protocol)) return false;
  if (!includes(match.runtimes, context.runtime)) return false;
  if (!includes(match.providers, context.provider)) return false;
  if (!includes(match.provider_families, context.providerFamily)) return false;
  if (Array.isArray(match.exclude_provider_families)
      && match.exclude_provider_families.includes(context.providerFamily)) return false;
  if (!includes(match.models, context.model)) return false;
  if (typeof match.stream === "boolean" && match.stream !== Boolean(context.stream)) return false;
  if (match.min_litellm_version) {
    const comparison = compareSemver(context.litellmVersion, match.min_litellm_version);
    if (comparison == null || comparison === -1) return false;
  }
  if (match.max_litellm_version) {
    const comparison = compareSemver(context.litellmVersion, match.max_litellm_version);
    if (comparison == null || comparison === 1) return false;
  }
  return true;
}

export class CompatibilityPatchError extends Error {
  constructor(message, { patchId = null, operator = null, cause = null } = {}) {
    super(message, { cause });
    this.name = "CompatibilityPatchError";
    this.code = "originrouter_compatibility_patch_failed";
    this.patchId = patchId;
    this.operator = operator;
  }
}

export class CompatibilityEngine {
  constructor({
    updatePack = null,
    operators = COMPATIBILITY_OPERATORS,
    wasmExecutorFactory = (bytes) => new WasmPatchExecutor(bytes),
    disabledPatchIds = [],
  } = {}) {
    this.operators = operators;
    this.executors = new Map();
    const disabled = new Set(disabledPatchIds);
    if (updatePack?.schema === COMPATIBILITY_CODE_BUNDLE_SCHEMA) {
      this.pack = validateCompatibilityCodeBundle(updatePack);
      this.patches = orderCompatibilityCodePatches(this.pack.patches)
        .filter((patch) => !disabled.has(patch.id));
      for (const patch of this.patches) {
        this.executors.set(patch.id, wasmExecutorFactory(Buffer.from(patch.module.bytes, "base64"), patch));
      }
      this.runtime = "wasm";
    } else {
      this.pack = mergeCompatibilityPacks(BUILTIN_COMPATIBILITY_PACK, updatePack);
      this.patches = [...validateCompatibilityPack(this.pack).patches]
        .filter((patch) => !disabled.has(patch.id))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
      this.runtime = "builtin";
    }
  }

  async apply(phase, context, document, executionState = {}) {
    let current = document;
    const applied = [];
    const failures = [];
    for (const patch of this.patches) {
      if (patch.phase !== phase || !compatibilityPatchMatches(patch, context)) continue;
      const operations = [];
      try {
        if (patch.module) {
          const executor = this.executors.get(patch.id);
          if (!executor) throw new Error(`WASM compatibility patch '${patch.id}' is not loaded`);
          const patchState = executionState[patch.id] || {};
          const result = await executor.execute(current, context, patchState);
          current = result?.document ?? current;
          executionState[patch.id] = result?.state || patchState;
          if (result?.changed) {
            operations.push({
              operator: "wasm",
              metadata: { abi: patch.module.abi, sha256: patch.module.sha256 },
            });
          }
        } else {
          for (const operation of patch.operations) {
            const handler = this.operators[operation.operator];
            if (typeof handler !== "function") {
              throw new Error(`compatibility operator '${operation.operator}' is not installed`);
            }
            const result = handler(current, operation.options, context, executionState);
            current = result?.document ?? current;
            if (result?.changed) {
              operations.push({ operator: operation.operator, metadata: result.metadata || null });
            }
          }
        }
        if (operations.length > 0) {
          applied.push({ id: patch.id, version: patch.version, operations });
        }
      } catch (error) {
        failures.push({
          id: patch.id,
          operator: patch.module ? "wasm" : operations.at(-1)?.operator || null,
          message: error.message,
        });
        if (patch.failure_mode === "reject" || patch.required) {
          throw new CompatibilityPatchError(
            `Compatibility patch '${patch.id}' failed: ${error.message}`,
            { patchId: patch.id, operator: patch.module ? "wasm" : null, cause: error },
          );
        }
      }
    }
    return { document: current, applied, failures };
  }

  matchingPatches(phase, context) {
    return this.patches.filter((patch) => (
      patch.phase === phase && compatibilityPatchMatches(patch, context)
    ));
  }

  close() {
    for (const executor of this.executors.values()) executor.close?.();
    this.executors.clear();
  }
}

export function protocolForRequest(path) {
  const clean = normalizedPath(path);
  if (clean === "/v1/responses") return "openai.responses";
  if (clean === "/v1/messages") return "anthropic.messages";
  if (clean === "/v1/chat/completions") return "openai.chat_completions";
  return "http.unknown";
}
