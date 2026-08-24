import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const STATE_FILENAME = "update-state.json";
const LOCK_FILENAME = "update.lock";
const LOCK_STALE_MS = 15 * 60_000;

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function updateStatePath(stateDir) {
  return join(stateDir, STATE_FILENAME);
}

export function readUpdateState(stateDir) {
  const value = readJson(updateStatePath(stateDir));
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function writeUpdateState(stateDir, patch) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const next = {
    ...readUpdateState(stateDir),
    ...patch,
  };
  atomicWriteJson(updateStatePath(stateDir), next);
  return next;
}

export function dismissUpdateVersion(stateDir, version) {
  return writeUpdateState(stateDir, { dismissed_version: String(version || "") || null });
}

function processStatus(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "invalid";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "EPERM") return "alive";
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function lockIsStale(value, nowMs, staleMs) {
  const ownerStatus = processStatus(Number(value?.pid));
  const installerStatus = processStatus(Number(value?.installer_pid));
  if (ownerStatus === "alive" || installerStatus === "alive") return false;
  if (ownerStatus === "dead" && ["dead", "invalid"].includes(installerStatus)) return true;
  const createdAt = Date.parse(value?.created_at || "");
  return !Number.isFinite(createdAt) || nowMs - createdAt > staleMs;
}

export function acquireUpdateLock(stateDir, {
  now = new Date(),
  staleMs = LOCK_STALE_MS,
} = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, LOCK_FILENAME);
  const token = randomBytes(16).toString("hex");
  const payload = {
    pid: process.pid,
    token,
    created_at: now.toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${JSON.stringify(payload)}\n`);
      closeSync(fd);
      return {
        path,
        token,
        setInstallerPid(pid) {
          try {
            const current = readJson(path);
            if (current?.token !== token) return false;
            payload.installer_pid = Number.isInteger(pid) && pid > 0 ? pid : null;
            payload.updated_at = new Date().toISOString();
            atomicWriteJson(path, payload);
            return true;
          } catch {
            return false;
          }
        },
        release() {
          const current = readJson(path);
          if (current?.token === token && existsSync(path)) unlinkSync(path);
        },
      };
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = readJson(path);
      if (attempt === 0 && lockIsStale(existing, now.getTime(), staleMs)) {
        try { unlinkSync(path); } catch {}
        continue;
      }
      const lockError = new Error("Another OriginRouter update is already running.");
      lockError.code = "UPDATE_LOCKED";
      throw lockError;
    }
  }
  throw new Error("Could not acquire the OriginRouter update lock.");
}
