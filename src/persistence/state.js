import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { VERSION } from "../constants.js";
import { migrateLegacyConfig } from "../config/migration.js";

export function getStateDir() {
  return process.env.ORIGINROUTER_HOME || join(homedir(), ".originrouter");
}

export function ensureStateDir() {
  const root = getStateDir();
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  return root;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writePrivateJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Stage 9.7: a deviceId is "stale" if any of:
 *   - missing
 *   - the legacy daemon default `local-dev` / `local-dev-XXX`
 *     (DEFAULT_DEVICE_ID in pre-9.7)
 *   - a pre-WP33 randomUUID() id (8-4-4-4-12 hex with dashes).
 *     Those are per-process, not per-machine — Stage 9.7+
 *     uses a SHA-256 machine fingerprint instead so the same
 *     physical host always gets the same id.
 *
 * In every case we drop the on-disk file and regenerate a fresh
 * fingerprint via `_machineFingerprint()`.
 */
function _isStaleDeviceId(id) {
  if (!id) return true;
  if (id === "local-dev" || id.startsWith("local-dev-")) return true;
  // Pre-WP33 randomUUID shape: `device-<8>-4-4-4-<12>` (8-4-4-4-12 hex).
  // The new SHA-256 shape is `device-<32 lowercase hex chars>`.
  const uuidShape = /^device-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidShape.test(id)) return true;
  return false;
}

/**
 * Stage 9.7: derive a stable machine fingerprint. Hashes the OS
 * platform + hostname + a per-OS hardware UUID (IOPlatformUUID on
 * macOS, /etc/machine-id on Linux, MachineGuid on Windows). The
 * first 32 hex chars of SHA-256 are appended to `device-` so the
 * id is globally unique to this physical host. Re-installing the
 * OS, re-imaging the machine, or swapping the motherboard changes
 * the fingerprint — that's the desired semantics (the device is a
 * new device from the server's perspective).
 *
 * Falls back to `randomUUID()` when the platform-specific probe
 * fails (containers, restricted sandboxes, missing /etc/machine-id)
 * so we ALWAYS produce a usable id rather than throwing.
 */
function _machineFingerprint() {
  const parts = [platform(), hostname()];
  let probe = null;
  try {
    if (process.platform === "darwin") {
      // IOPlatformUUID is the per-machine hardware UUID; stable
      // across OS reinstalls if the motherboard isn't swapped.
      probe = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/{print $3}'",
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } else if (process.platform === "linux") {
      // /etc/machine-id is populated by systemd at first boot;
      // per-installation, not per-user.
      probe = readFileSync("/etc/machine-id", "utf8").trim();
    } else if (process.platform === "win32") {
      // HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid — Windows'
      // per-installation hardware identifier.
      probe = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
      ).split("\n").pop().split("REG_SZ").pop().trim();
    }
  } catch { /* ignore: probe unavailable on this host */ }
  if (probe) parts.push(probe);
  const hex = createHash("sha256").update(parts.join("|")).digest("hex");
  return `device-${hex.slice(0, 32)}`;
}

export function readDevice() {
  return readJson(join(ensureStateDir(), "device.json"));
}

/**
 * Stage 9.7: regenerate the device record if the on-disk id is
 * missing or matches a known stale default. The new id is a
 * SHA-256-based machine fingerprint (see `_machineFingerprint()`)
 * so the same physical host always gets the same id, but a
 * different host always gets a different one. Falls back to a
 * random UUID if the platform probe fails.
 *
 * Per the operator's directive, we also delete the on-disk
 * `device.json` whenever we detect a stale id so the next
 * `originrouter login` always sees a freshly-minted record
 * (visible to the operator as `rm` of the stale file).
 */
export function ensureDevice(defaultDeviceId) {
  const path = join(ensureStateDir(), "device.json");
  const existing = readJson(path);
  if (existing?.deviceId && !_isStaleDeviceId(existing.deviceId)) {
    return existing;
  }
  if (existing) {
    // Stale device.json — drop it before regenerating.
    try { unlinkSync(path); }
    catch { /* ignore: missing or permission denied */ }
  }

  const device = {
    deviceId: defaultDeviceId || _machineFingerprint() || `device-${randomUUID()}`,
    host: hostname(),
    platform: platform(),
    createdAt: new Date().toISOString(),
  };
  writeJson(path, device);
  return device;
}

export function writeDaemonState(state) {
  writeJson(join(ensureStateDir(), "daemon.state.json"), {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    ...state,
  });
}

export function readDaemonState() {
  return readJson(join(ensureStateDir(), "daemon.state.json")) || null;
}

export function readLocalApiConfig() {
  return readJson(join(ensureStateDir(), "local-api.json")) || {};
}

export function writeLocalApiConfig(config) {
  const next = {
    ...readLocalApiConfig(),
    ...config,
  };
  writePrivateJson(join(ensureStateDir(), "local-api.json"), {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    ...next,
  });
  return next;
}

export function writeProxyState(state) {
  writeJson(join(ensureStateDir(), "proxy.state.json"), {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    ...state,
  });
}

export function readProxyState() {
  return readJson(join(ensureStateDir(), "proxy.state.json")) || null;
}

export function clearProxyState() {
  // Removes the proxy.state.json file if present. Used by `proxy stop` and
  // by the manager when a started process is found to be already dead.
  const path = join(ensureStateDir(), "proxy.state.json");
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
}

export function readConfig() {
  const raw = readJson(join(ensureStateDir(), "config.json")) || {};
  const migrated = migrateLegacyConfig(raw);
  // Self-healing write-back: first read after Stage 1 lands rewrites the file
  // with `providers.default-claude` + `currentProvider.claude`. migrateLegacyConfig
  // returns the same reference when there's nothing to migrate, so this `!==`
  // check is a strict no-op on subsequent reads.
  if (migrated !== raw) writeConfig(migrated);
  return migrated;
}

export function writeConfig(config) {
  writePrivateJson(join(ensureStateDir(), "config.json"), {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    ...config,
  });
}
