import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ensureStateDir } from "../persistence/state.js";

const SCHEMA_VERSION = 1;
const MAX_DEVICES = 64;

function cachePath(stateDir) {
  return join(stateDir, "collaboration-capabilities.json");
}

function cleanText(value, maxLength = 512) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function secretMetadataKey(key) {
  return /secret|password|passphrase|api[_-]?key|authorization|cookie|credential|(^|[_-])(?:access|refresh|auth|bearer|session)?[_-]?token($|[_-])/i
    .test(String(key || ""));
}

function cleanMetadata(value, depth = 0) {
  if (depth > 6 || value == null) return value == null ? null : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return cleanText(value, 512);
  if (Array.isArray(value)) {
    return value.slice(0, 100)
      .map((item) => cleanMetadata(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value).slice(0, 100)
      .filter(([key]) => !secretMetadataKey(key))
      .map(([key, item]) => [cleanText(key, 128), cleanMetadata(item, depth + 1)])
      .filter(([key, item]) => key && item !== undefined),
  );
}

function cleanResolvedRoutes(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).slice(0, 16).map(([runtime, slots]) => [
      cleanText(runtime, 32),
      slots && typeof slots === "object"
        ? Object.fromEntries(Object.entries(slots).slice(0, 16).map(([slot, route]) => [
            cleanText(slot, 32),
            route && typeof route === "object"
              ? {
                  provider: cleanText(route.provider, 191) || null,
                  model: cleanText(route.model, 191) || null,
                }
              : null,
          ]))
        : {},
    ]).filter(([runtime]) => runtime),
  );
}

function cleanCapabilitySnapshot(input = {}) {
  const capturedAt = cleanText(
    input.captured_at || input.freshness?.captured_at,
    64,
  ) || new Date().toISOString();
  const deviceId = cleanText(input.device?.device_id, 191);
  if (!deviceId) throw new Error("Capability snapshot is missing its device id.");
  return {
    schema_version: 1,
    captured_at: capturedAt,
    freshness: {
      captured_at: capturedAt,
      stale: true,
      source: "local_cache",
    },
    device: {
      device_id: deviceId,
      name: cleanText(input.device?.name, 191) || null,
      cli_version: cleanText(input.device?.cli_version, 64) || null,
      platform: cleanText(input.device?.platform, 32) || null,
      architecture: cleanText(input.device?.architecture, 32) || null,
      default_workspace_path:
        cleanText(input.device?.default_workspace_path, 4096) || null,
    },
    runtimes: Array.isArray(input.runtimes)
      ? input.runtimes.slice(0, 16).map((runtime) => ({
          id: cleanText(runtime?.id, 32),
          available: runtime?.available === true,
          route_slots: Array.isArray(runtime?.route_slots)
            ? runtime.route_slots.slice(0, 16).map((slot) => cleanText(slot, 32))
            : [],
        })).filter((runtime) => runtime.id)
      : [],
    providers: Array.isArray(input.providers)
      ? input.providers.slice(0, 100).map((provider) => ({
          name: cleanText(provider?.name, 191),
          type: cleanText(provider?.type, 64) || null,
          engine: cleanText(provider?.engine, 64) || null,
          device_id: cleanText(provider?.device_id, 191) || null,
          models: Array.isArray(provider?.models)
            ? provider.models.slice(0, 500).map((model) => ({
                id: cleanText(model?.id, 191),
                remote_enabled: model?.remote_enabled === true,
                priced: model?.priced === true,
                ...(model?.pricing ? {
                  pricing: {
                    currency: cleanText(model.pricing.currency, 16),
                    unit: cleanText(model.pricing.unit, 64),
                  },
                } : {}),
              })).filter((model) => model.id)
            : [],
        })).filter((provider) => provider.name)
      : [],
    resolved_routes: cleanResolvedRoutes(input.resolved_routes),
    trusted_workspaces: Array.isArray(input.trusted_workspaces)
      ? input.trusted_workspaces.slice(0, 200).map((workspace) => ({
          workspace_id: cleanText(workspace?.workspace_id, 191),
          display_name: cleanText(workspace?.display_name, 191),
          canonical_path: cleanText(workspace?.canonical_path, 4096),
          repo_root: cleanText(workspace?.repo_root, 4096) || null,
          updated_at: cleanText(workspace?.updated_at, 64) || null,
        })).filter((workspace) => workspace.workspace_id && workspace.canonical_path)
      : [],
    permission_profiles: Array.isArray(input.permission_profiles)
      ? input.permission_profiles.slice(0, 32).map((profile) => ({
          id: cleanText(profile?.id, 64),
          label: cleanText(profile?.label, 191),
          description: cleanText(profile?.description, 2048),
        })).filter((profile) => profile.id)
      : [],
    defaults: {
      permission_profile: cleanText(input.defaults?.permission_profile, 64) || "guarded",
    },
    budget_policy: cleanMetadata(input.budget_policy),
    protocol_versions: cleanMetadata(input.protocol_versions) || {},
    actions: cleanMetadata(input.actions) || {},
  };
}

function readDocument(stateDir) {
  const path = cachePath(stateDir);
  if (!existsSync(path)) return { schema_version: SCHEMA_VERSION, devices: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      schema_version: SCHEMA_VERSION,
      devices: parsed?.devices && typeof parsed.devices === "object"
        ? parsed.devices
        : {},
    };
  } catch {
    return { schema_version: SCHEMA_VERSION, devices: {} };
  }
}

function writeDocument(stateDir, document) {
  const path = cachePath(stateDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function cacheCollaborationCapabilities(capabilities, {
  stateDir = ensureStateDir(),
} = {}) {
  const safe = cleanCapabilitySnapshot(capabilities);
  const document = readDocument(stateDir);
  const entries = Object.entries({
    ...document.devices,
    [safe.device.device_id]: safe,
  })
    .sort(([, left], [, right]) => (
      String(right?.captured_at || "").localeCompare(String(left?.captured_at || ""))
    ))
    .slice(0, MAX_DEVICES);
  writeDocument(stateDir, {
    schema_version: SCHEMA_VERSION,
    devices: Object.fromEntries(entries),
  });
  return safe;
}

export function getCachedCollaborationCapabilities(deviceId, {
  stateDir = ensureStateDir(),
} = {}) {
  const key = cleanText(deviceId, 191);
  const value = readDocument(stateDir).devices[key];
  if (!value) return null;
  try {
    return cleanCapabilitySnapshot(value);
  } catch {
    return null;
  }
}
