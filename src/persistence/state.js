import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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

export function isStaleDeviceId(id) {
  if (!id) return true;
  if (id === "local-dev" || id.startsWith("local-dev-")) return true;
  return false;
}

function _newInstallDeviceId() {
  return `device-${randomBytes(16).toString("hex")}`;
}

function _deviceCandidateValue({ displayName } = {}) {
  return {
    deviceId: _newInstallDeviceId(),
    host: hostname(),
    displayName: displayName || defaultDeviceDisplayName(),
    platform: platform(),
    createdAt: new Date().toISOString(),
  };
}

export function createDeviceCandidate(stateDir = ensureStateDir(), options = {}) {
  const path = join(stateDir, "device.pending.json");
  if (existsSync(path)) unlinkSync(path);
  const candidate = {
    ..._deviceCandidateValue(options),
    verificationStatus: "invalid",
  };
  writePrivateJson(path, candidate);
  return candidate;
}

export function commitDeviceCandidate(device, stateDir = ensureStateDir()) {
  if (!device?.deviceId || isStaleDeviceId(device.deviceId)) {
    throw new Error("invalid OriginRouter device candidate");
  }
  const pendingPath = join(stateDir, "device.pending.json");
  const pending = readJson(pendingPath);
  if (pending?.verificationStatus !== "invalid"
      || pending?.deviceId !== device.deviceId) {
    throw new Error("pending OriginRouter device does not match");
  }
  const verified = { ...device, verificationStatus: "verified" };
  writePrivateJson(join(stateDir, "device.json"), verified);
  unlinkSync(pendingPath);
  return verified;
}

export function discardDeviceCandidate(stateDir = ensureStateDir()) {
  const path = join(stateDir, "device.pending.json");
  if (existsSync(path)) unlinkSync(path);
}

export function invalidateDevice(stateDir = ensureStateDir()) {
  for (const name of ["device.json", "device.pending.json"]) {
    const path = join(stateDir, name);
    if (existsSync(path)) unlinkSync(path);
  }
}

export function readDevice() {
  const path = join(ensureStateDir(), "device.json");
  const existing = readJson(path);
  if (!existing?.deviceId) return existing;
  const rawDisplayName = String(existing.displayName || "").trim();
  const legacyHost = normalizedDeviceName(existing.host);
  const legacyAutomaticName = !rawDisplayName
    || rawDisplayName === "OriginRouter CLI"
    || (/^[^@]+@.+$/.test(rawDisplayName)
      && (!legacyHost || rawDisplayName.endsWith(`@${legacyHost}`)
        || isIP(rawDisplayName.slice(rawDisplayName.lastIndexOf("@") + 1))));
  const nextDisplayName = legacyAutomaticName
    ? defaultDeviceDisplayName()
    : cliDeviceDisplayName(rawDisplayName);
  if (nextDisplayName !== existing.displayName) {
    const migrated = { ...existing, displayName: nextDisplayName };
    writePrivateJson(path, migrated);
    return migrated;
  }
  return existing;
}

function normalizedDeviceName(value) {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.local$/i, "");
  if (!normalized || ["localhost", "localhost.localdomain", "unknown"]
    .includes(normalized.toLowerCase()) || isIP(normalized)) return "";
  return normalized;
}

function commandValue(runCommand, command, args) {
  try {
    return normalizedDeviceName(runCommand(command, args));
  } catch {
    return "";
  }
}

function linuxPrettyHostname(readText) {
  try {
    const content = String(readText("/etc/machine-info") || "");
    const match = content.match(/^PRETTY_HOSTNAME=(.*)$/m);
    if (!match) return "";
    const raw = match[1].trim();
    const unquoted = raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1).replace(/\\([\\"$`])/g, "$1")
      : raw;
    return normalizedDeviceName(unquoted);
  } catch {
    return "";
  }
}

export function cliDeviceDisplayName(value) {
  const base = normalizedDeviceName(value) || "OriginRouter device";
  if (/·\s*CLI$/i.test(base)) return base;
  const maxBaseLength = 191 - " · CLI".length;
  const truncated = base.length <= maxBaseLength
    ? base
    : base.slice(0, maxBaseLength).trimEnd();
  return `${truncated} · CLI`;
}

export function defaultDeviceDisplayName({
  platformName = platform(),
  hostnameValue = hostname(),
  env = process.env,
  readText = (path) => readFileSync(path, "utf8"),
  runCommand = (command, args) => execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  }),
} = {}) {
  const host = normalizedDeviceName(hostnameValue);
  let base = "";
  if (platformName === "darwin") {
    base = commandValue(runCommand, "scutil", ["--get", "ComputerName"])
      || commandValue(runCommand, "scutil", ["--get", "LocalHostName"])
      || host;
  } else if (platformName === "win32") {
    base = normalizedDeviceName(env.COMPUTERNAME) || host;
  } else if (platformName === "linux") {
    base = linuxPrettyHostname(readText)
      || commandValue(runCommand, "hostnamectl", ["--static"])
      || host;
  } else {
    base = host;
  }
  return cliDeviceDisplayName(base);
}

export function updateDeviceDisplayName(
  displayName,
  stateDir = ensureStateDir(),
) {
  const path = join(stateDir, "device.json");
  const existing = readJson(path);
  if (!existing?.deviceId) return null;
  const updated = { ...existing, displayName: cliDeviceDisplayName(displayName) };
  writePrivateJson(path, updated);
  return updated;
}

// Device identity is installation/config identity, never a hardware
// fingerprint. Generate once with a CSPRNG and persist it across logins.
export function ensureDevice(defaultDeviceId) {
  const path = join(ensureStateDir(), "device.json");
  const existing = readDevice();
  if (existing?.deviceId && !isStaleDeviceId(existing.deviceId)) {
    if (typeof existing.displayName === "string" && existing.displayName.trim()) {
      return existing;
    }
    const migrated = {
      ...existing,
      displayName: defaultDeviceDisplayName(),
    };
    writePrivateJson(path, migrated);
    return migrated;
  }
  if (existing) {
    // Stale device.json — drop it before regenerating.
    try { unlinkSync(path); }
    catch { /* ignore: missing or permission denied */ }
  }

  const device = {
    ..._deviceCandidateValue(),
    deviceId: defaultDeviceId && !isStaleDeviceId(defaultDeviceId)
      ? defaultDeviceId
      : _newInstallDeviceId(),
  };
  writePrivateJson(path, device);
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

function proxyStatePath(stateKey = "proxy") {
  const safeKey = String(stateKey || "proxy").replace(/[^a-z0-9_-]/gi, "-");
  return join(ensureStateDir(), `${safeKey}.state.json`);
}

export function writeProxyState(state, stateKey = "proxy") {
  writeJson(proxyStatePath(stateKey), {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    ...state,
  });
}

export function readProxyState(stateKey = "proxy") {
  return readJson(proxyStatePath(stateKey)) || null;
}

export function clearProxyState(stateKey = "proxy") {
  // Removes the proxy.state.json file if present. Used by `proxy stop` and
  // by the manager when a started process is found to be already dead.
  const path = proxyStatePath(stateKey);
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
