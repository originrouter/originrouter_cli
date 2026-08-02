import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMPATIBILITY_CODE_BUNDLE_SCHEMA,
  COMPATIBILITY_CODE_ENGINE_VERSION,
  COMPATIBILITY_CODE_SIGNED_ENVELOPE,
  validateCompatibilityCodeBundle,
  verifySignedCompatibilityCodeBundle,
} from "./codeBundle.js";
import { COMPATIBILITY_ENGINE_VERSION, validateCompatibilityPack, verifySignedCompatibilityPack } from "./patchPack.js";

function directory(stateDir) {
  return join(stateDir, "compatibility");
}

function paths(stateDir) {
  const dir = directory(stateDir);
  return {
    dir,
    active: join(dir, "active-pack.json"),
    previous: join(dir, "previous-pack.json"),
    metadata: join(dir, "update-metadata.json"),
    preferences: join(dir, "patch-preferences.json"),
  };
}

function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function parseVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertCompatibilityEngineRange(
  pack,
  engineVersion = pack?.schema === COMPATIBILITY_CODE_BUNDLE_SCHEMA
    ? COMPATIBILITY_CODE_ENGINE_VERSION
    : COMPATIBILITY_ENGINE_VERSION,
  now = new Date(),
) {
  if (pack.min_engine_version && compareVersion(engineVersion, pack.min_engine_version) === -1) {
    throw new Error(`compatibility pack requires engine ${pack.min_engine_version} or newer`);
  }
  if (pack.max_engine_version && compareVersion(engineVersion, pack.max_engine_version) === 1) {
    throw new Error(`compatibility pack supports engine ${pack.max_engine_version} or older`);
  }
  if (pack.expires_at && Date.parse(pack.expires_at) <= now.getTime()) {
    throw new Error(`compatibility pack expired at ${pack.expires_at}`);
  }
}

function validateCompatibilityArtifact(value) {
  return value?.schema === COMPATIBILITY_CODE_BUNDLE_SCHEMA
    ? validateCompatibilityCodeBundle(value)
    : validateCompatibilityPack(value);
}

export function verifySignedCompatibilityArtifact(envelope, trustedKeys) {
  return envelope?.schema === COMPATIBILITY_CODE_SIGNED_ENVELOPE
    ? verifySignedCompatibilityCodeBundle(envelope, trustedKeys)
    : verifySignedCompatibilityPack(envelope, trustedKeys);
}

export function canRollbackCompatibilityPack(stateDir) {
  const file = paths(stateDir).previous;
  if (!existsSync(file)) return false;
  try {
    const pack = validateCompatibilityArtifact(JSON.parse(readFileSync(file, "utf8")));
    assertCompatibilityEngineRange(pack);
    return true;
  } catch {
    return false;
  }
}

export function loadActiveCompatibilityPack(stateDir) {
  const file = paths(stateDir).active;
  if (!existsSync(file)) return null;
  try {
    const pack = validateCompatibilityArtifact(JSON.parse(readFileSync(file, "utf8")));
    assertCompatibilityEngineRange(pack);
    return pack;
  } catch {
    return null;
  }
}

export function readCompatibilityUpdateMetadata(stateDir) {
  const file = paths(stateDir).metadata;
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function writeCompatibilityUpdateMetadata(stateDir, metadata) {
  const target = paths(stateDir);
  mkdirSync(target.dir, { recursive: true, mode: 0o700 });
  atomicWrite(target.metadata, metadata);
}

export function compatibilityPatchPreferencesPath(stateDir) {
  return paths(stateDir).preferences;
}

export function readCompatibilityPatchPreferences(stateDir) {
  const file = paths(stateDir).preferences;
  if (!existsSync(file)) return { disabled_patch_ids: [] };
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    const disabled = Array.isArray(value?.disabled_patch_ids)
      ? value.disabled_patch_ids
        .map((item) => String(item || "").trim())
        .filter(Boolean)
      : [];
    return { disabled_patch_ids: [...new Set(disabled)].sort() };
  } catch {
    return { disabled_patch_ids: [] };
  }
}

export function setCompatibilityPatchEnabled(stateDir, patchId, enabled) {
  const normalized = String(patchId || "").trim();
  if (!normalized) throw new Error("compatibility patch id is required");
  const target = paths(stateDir);
  const preferences = readCompatibilityPatchPreferences(stateDir);
  const disabled = new Set(preferences.disabled_patch_ids);
  if (enabled) disabled.delete(normalized);
  else disabled.add(normalized);
  mkdirSync(target.dir, { recursive: true, mode: 0o700 });
  atomicWrite(target.preferences, {
    schema: "originrouter-compatibility-patch-preferences-v1",
    disabled_patch_ids: [...disabled].sort(),
  });
  return { patch_id: normalized, enabled: Boolean(enabled) };
}

export function installSignedCompatibilityPack(stateDir, envelope, trustedKeys) {
  const pack = verifySignedCompatibilityArtifact(envelope, trustedKeys);
  assertCompatibilityEngineRange(pack);
  const target = paths(stateDir);
  mkdirSync(target.dir, { recursive: true, mode: 0o700 });
  const current = loadActiveCompatibilityPack(stateDir);
  if (current && current.revision >= pack.revision) {
    return { installed: false, reason: "not_newer", pack: current };
  }
  if (existsSync(target.active)) {
    atomicWrite(target.previous, JSON.parse(readFileSync(target.active, "utf8")));
  }
  atomicWrite(target.active, pack);
  return { installed: true, pack };
}

export function rollbackCompatibilityPack(stateDir) {
  const target = paths(stateDir);
  if (!existsSync(target.previous)) return { rolledBack: false, reason: "no_previous_pack" };
  const previous = validateCompatibilityArtifact(JSON.parse(readFileSync(target.previous, "utf8")));
  assertCompatibilityEngineRange(previous);
  const current = existsSync(target.active) ? JSON.parse(readFileSync(target.active, "utf8")) : null;
  atomicWrite(target.active, previous);
  if (current) atomicWrite(target.previous, current);
  return { rolledBack: true, pack: previous };
}
