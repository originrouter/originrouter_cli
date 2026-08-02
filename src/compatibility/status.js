import { BUILTIN_COMPATIBILITY_PACK } from "./builtinPack.js";
import { COMPATIBILITY_CODE_ENGINE_VERSION } from "./codeBundle.js";
import {
  canRollbackCompatibilityPack,
  loadActiveCompatibilityPack,
  readCompatibilityPatchPreferences,
  readCompatibilityUpdateMetadata,
} from "./patchStore.js";

function patchSummary(patch, disabledPatchIds) {
  return {
    id: patch.id,
    name: patch.name || patch.id,
    description: patch.description || "",
    version: patch.version,
    phase: patch.phase,
    priority: patch.priority || 0,
    required: patch.required === true,
    failure_mode: patch.failure_mode || "reject",
    match: patch.match || {},
    enabled: !disabledPatchIds.has(patch.id),
  };
}

export function compatibilityStatus(stateDir, {
  automaticUpdates = process.env.ORIGINROUTER_COMPATIBILITY_UPDATES !== "off",
  lastOperation = null,
} = {}) {
  const active = loadActiveCompatibilityPack(stateDir);
  const effective = active || BUILTIN_COMPATIBILITY_PACK;
  const metadata = readCompatibilityUpdateMetadata(stateDir);
  const preferences = readCompatibilityPatchPreferences(stateDir);
  const disabledPatchIds = new Set(preferences.disabled_patch_ids);
  const latestRevision = Number(metadata.latest_revision || metadata.revision || 0) || null;
  const patches = effective.patches.map((patch) => patchSummary(patch, disabledPatchIds));
  return {
    engine_version: COMPATIBILITY_CODE_ENGINE_VERSION,
    source: active ? "remote" : "builtin",
    bundle_id: effective.bundle_id || effective.pack_id,
    revision: effective.revision,
    generated_at: effective.generated_at || null,
    automatic_updates: automaticUpdates,
    last_checked_at: metadata.checked_at || null,
    latest_revision: latestRevision,
    update_available: Boolean(latestRevision && latestRevision > effective.revision),
    can_rollback: canRollbackCompatibilityPack(stateDir),
    enabled_patch_count: patches.filter((patch) => patch.enabled).length,
    patches,
    last_operation: lastOperation,
  };
}

export function compatibilityPatchById(stateDir, patchId, options = {}) {
  return compatibilityStatus(stateDir, options).patches.find((patch) => patch.id === patchId) || null;
}
