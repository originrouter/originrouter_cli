import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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

export function readDevice() {
  return readJson(join(ensureStateDir(), "device.json"));
}

export function ensureDevice(defaultDeviceId) {
  const path = join(ensureStateDir(), "device.json");
  const existing = readJson(path);
  if (existing?.deviceId) return existing;

  const device = {
    deviceId: defaultDeviceId || `device-${randomUUID()}`,
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
