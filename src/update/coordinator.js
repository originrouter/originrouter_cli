import { spawn, spawnSync } from "node:child_process";
import { readApiToken } from "../persistence/authToken.js";
import { getStateDir, readDaemonState } from "../persistence/state.js";
import { isServiceInstalled, restartService } from "../commands/service.js";
import { VERSION } from "../constants.js";
import { cachedUpdateStatus, checkForUpdate } from "./checker.js";
import { detectInstallContext, readInstalledVersion } from "./installContext.js";
import { compareSemver, parseSemver } from "./semver.js";
import { acquireUpdateLock, writeUpdateState } from "./state.js";

const ACTIVE_RUN_STATES = new Set(["designing", "planning", "executing", "running"]);
const TERMINAL_SESSION_STATES = new Set(["completed", "failed", "cancelled", "stopped", "exited"]);

function localApiBaseUrl(state) {
  if (!state?.localApiPort) return null;
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formatted}:${state.localApiPort}`;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function localApiJson(path, { fetchFn, state, token, signal }) {
  const baseUrl = localApiBaseUrl(state);
  if (!baseUrl || !token) return null;
  const response = await fetchFn(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`Local API returned ${response.status}`);
  const payload = await response.json();
  return payload?.data || payload;
}

export async function inspectUpdateActivity({
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  timeoutMs = 3_000,
} = {}) {
  const state = readDaemonState(stateDir);
  const token = readApiToken(stateDir);
  if (!localApiBaseUrl(state) || !token || !processIsAlive(Number(state?.pid))) {
    return { daemon_running: false, active: false, reason: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [sessions, agents, collaborations] = await Promise.all([
      localApiJson("/sessions", { fetchFn, state, token, signal: controller.signal }),
      localApiJson("/agent/local/sessions", { fetchFn, state, token, signal: controller.signal }),
      localApiJson("/collaboration/local/runs?limit=200", { fetchFn, state, token, signal: controller.signal }),
    ]);
    const activeSession = (sessions?.sessions || []).find(
      (item) => !TERMINAL_SESSION_STATES.has(String(item?.status || "").toLowerCase()),
    );
    if (activeSession) {
      return { daemon_running: true, active: true, reason: "active_agent_session" };
    }
    const activeAgent = (agents?.sessions || []).find(
      (item) => !TERMINAL_SESSION_STATES.has(String(item?.status || "").toLowerCase()),
    );
    if (activeAgent) {
      return { daemon_running: true, active: true, reason: "active_managed_agent" };
    }
    const activeRun = (collaborations?.runs || []).find((item) =>
      ACTIVE_RUN_STATES.has(String(item?.state || "").toLowerCase()));
    if (activeRun) {
      return { daemon_running: true, active: true, reason: "active_collaboration" };
    }
    return { daemon_running: true, active: false, reason: null };
  } catch {
    return { daemon_running: true, active: true, reason: "daemon_activity_unknown" };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyUpdateFailure(error) {
  const detail = `${error?.message || ""}\n${error?.install_stderr || ""}`;
  if (error?.code === "UPDATE_LOCKED") return "lock_contention";
  if (error?.code === "UPDATE_TIMEOUT") return "install_timeout";
  if (error?.code === "UPDATE_POST_INSTALL_VERSION_MISMATCH") return "post_install_version_mismatch";
  if (error?.code === "UPDATE_CHECK_FAILED") return "registry_unavailable";
  if (["EACCES", "EPERM"].includes(error?.code) || /not writable|permission denied|EACCES/i.test(detail)) {
    return "no_permissions";
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"].includes(error?.code)
    || /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network/i.test(detail)) return "network";
  return "install_failed";
}

function signalInstaller(child, signal) {
  if (process.platform === "win32" && Number.isInteger(child?.pid) && child.pid > 0) {
    const args = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    if (result.status === 0 || result.status === 128) return true;
  }
  if (process.platform !== "win32" && Number.isInteger(child?.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
    }
  }
  try {
    return child?.kill?.(signal) !== false;
  } catch {
    return false;
  }
}

function forceKillInstaller(child) {
  return signalInstaller(child, "SIGKILL");
}

export function runInstaller(command, args, {
  spawnFn = spawn,
  stdio = ["inherit", "inherit", "pipe"],
  timeoutMs = 5 * 60_000,
  killGraceMs = 2_000,
  forceKillWaitMs = 2_000,
  onSpawn = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      stdio,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
      env: { ...process.env, npm_config_yes: "true" },
    });
    onSpawn(child);
    let stderrTail = "";
    child.stderr?.on?.("data", (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      stderrTail = `${stderrTail}${text}`.slice(-8_192);
    });
    let exited = false;
    let timingOut = false;
    const exitWaiters = new Set();
    const markExited = () => {
      exited = true;
      for (const waiter of exitWaiters) waiter();
      exitWaiters.clear();
    };
    const waitForExit = (durationMs) => {
      if (exited) return Promise.resolve(true);
      return new Promise((done) => {
        let waitTimer;
        const finish = () => {
          clearTimeout(waitTimer);
          exitWaiters.delete(finish);
          done(exited);
        };
        waitTimer = setTimeout(finish, durationMs);
        exitWaiters.add(finish);
      });
    };
    const timer = setTimeout(async () => {
      timingOut = true;
      signalInstaller(child, "SIGTERM");
      if (!await waitForExit(killGraceMs)) {
        forceKillInstaller(child);
        await waitForExit(forceKillWaitMs);
      }
      const error = new Error("OriginRouter update timed out; the installer was terminated.");
      error.code = "UPDATE_TIMEOUT";
      error.termination_confirmed = exited;
      error.keep_update_lock = !exited;
      reject(error);
    }, timeoutMs);
    child.once("error", (error) => {
      markExited();
      clearTimeout(timer);
      if (!timingOut) reject(error);
    });
    child.once("exit", (code, signal) => {
      markExited();
      clearTimeout(timer);
      if (timingOut) return;
      if (code === 0) resolve({ code, signal });
      else {
        const error = new Error(
          `Update command failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
        );
        error.code = "UPDATE_INSTALL_FAILED";
        error.install_stderr = stderrTail;
        reject(error);
      }
    });
  });
}

export async function installLatestVersion({
  stateDir = getStateDir(),
  config = {},
  installContext = detectInstallContext(),
  fetchFn = globalThis.fetch,
  spawnFn = spawn,
  restartServiceFn = restartService,
  serviceInstalledFn = isServiceInstalled,
  readInstalledVersionFn = readInstalledVersion,
  installerTimeoutMs,
  installerKillGraceMs,
  installerForceKillWaitMs,
  forceCheck = true,
  automatic = false,
} = {}) {
  const checked = forceCheck
    ? await checkForUpdate({ stateDir, config, fetchFn, force: true, installContext })
    : cachedUpdateStatus({ stateDir, config, installContext });
  if (!checked.update_available) return { updated: false, reason: "already_current", status: checked };
  if (!installContext.command) {
    const error = new Error(
      "This OriginRouter CLI is running from a source checkout or unsupported installation. Update it with the tool that installed it.",
    );
    error.code = "UPDATE_INSTALL_METHOD_UNSUPPORTED";
    writeUpdateState(stateDir, {
      last_attempt_at: new Date().toISOString(),
      last_result: "failed",
      last_error: error.message,
      last_failure_kind: "unsupported_install_method",
    });
    throw error;
  }
  if (automatic && !installContext.writable) {
    return { updated: false, reason: "install_directory_not_writable", status: checked };
  }
  if (!installContext.writable) {
    const error = new Error(
      `The global ${installContext.method || "package manager"} install directory is not writable. OriginRouter will not invoke sudo; configure a user-writable global prefix, then run ${installContext.command_string || "the package-manager update command"}.`,
    );
    error.code = "EACCES";
    writeUpdateState(stateDir, {
      last_attempt_at: new Date().toISOString(),
      last_result: "failed",
      last_error: error.message,
      last_failure_kind: "no_permissions",
    });
    throw error;
  }
  const activity = await inspectUpdateActivity({ stateDir, fetchFn });
  if (activity.active) {
    return { updated: false, reason: activity.reason, status: checked };
  }

  let lock;
  try {
    lock = acquireUpdateLock(stateDir);
  } catch (error) {
    writeUpdateState(stateDir, {
      last_attempt_at: new Date().toISOString(),
      last_result: "failed",
      last_error: String(error?.message || error),
      last_failure_kind: classifyUpdateFailure(error),
    });
    throw error;
  }
  let releaseLock = true;
  try {
    writeUpdateState(stateDir, {
      last_attempt_at: new Date().toISOString(),
      last_result: "installing",
      last_error: null,
      last_failure_kind: null,
    });
    const installArgs = installContext.args.map((arg) =>
      arg === "@originrouter/cli@latest" ? `@originrouter/cli@${checked.latest_version}` : arg);
    await runInstaller(installContext.command, installArgs, {
      spawnFn,
      timeoutMs: installerTimeoutMs,
      killGraceMs: installerKillGraceMs,
      forceKillWaitMs: installerForceKillWaitMs,
      onSpawn: (child) => lock.setInstallerPid(child?.pid),
    });
    const installedVersion = readInstalledVersionFn(installContext);
    if (!parseSemver(installedVersion) || compareSemver(installedVersion, checked.latest_version) < 0) {
      const error = new Error(
        `The update command completed, but ${checked.latest_version} could not be verified at ${installContext.package_json_path || installContext.package_root}.`,
      );
      error.code = "UPDATE_POST_INSTALL_VERSION_MISMATCH";
      throw error;
    }
    let service_restarted = false;
    let service_restart_error = null;
    if (activity.daemon_running && serviceInstalledFn()) {
      try {
        await restartServiceFn();
        service_restarted = true;
      } catch (error) {
        service_restart_error = String(error?.message || error);
      }
    }
    const state = writeUpdateState(stateDir, {
      latest_version: checked.latest_version,
      last_result: "updated",
      last_error: null,
      installed_version: installedVersion,
      installed_at: new Date().toISOString(),
      dismissed_version: null,
      service_restart_error,
    });
    return {
      updated: true,
      from_version: VERSION,
      to_version: checked.latest_version,
      daemon_was_running: activity.daemon_running,
      service_restarted,
      service_restart_error,
      restart_required: compareSemver(installedVersion, VERSION) > 0,
      status: cachedUpdateStatus({ stateDir, config, installContext }),
      state,
    };
  } catch (error) {
    if (error?.keep_update_lock) releaseLock = false;
    writeUpdateState(stateDir, {
      last_result: "failed",
      last_error: String(error?.message || error),
      last_failure_kind: classifyUpdateFailure(error),
    });
    throw error;
  } finally {
    if (releaseLock) lock.release();
  }
}
