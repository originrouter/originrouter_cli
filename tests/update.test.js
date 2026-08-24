import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cachedUpdateStatus, checkForUpdate, updateCheckIsDue } from "../src/update/checker.js";
import { inspectUpdateActivity, installLatestVersion, runInstaller } from "../src/update/coordinator.js";
import { writeApiToken } from "../src/persistence/authToken.js";
import { detectInstallContext } from "../src/update/installContext.js";
import { renderUpdatePrompt, updateSelectionForKey } from "../src/update/prompt.js";
import { compareSemver, isNewerVersion } from "../src/update/semver.js";
import { setUpdateMode, updateModeFromConfig } from "../src/update/settings.js";
import {
  acquireUpdateLock,
  dismissUpdateVersion,
  readUpdateState,
  writeUpdateState,
} from "../src/update/state.js";
import { handleStartupUpdate } from "../src/commands/update.js";

const root = mkdtempSync(join(tmpdir(), "originrouter-update-test-"));

try {
  assert.equal(compareSemver("0.2.1", "0.2.0"), 1);
  assert.equal(compareSemver("0.2.1-beta.1", "0.2.1"), -1);
  assert.equal(compareSemver("v1.0.0", "1.0.0"), 0);
  assert.equal(isNewerVersion("0.3.0", "0.2.9"), true);
  assert.equal(compareSemver("invalid", "0.2.1"), null);

  assert.equal(updateModeFromConfig({}), "prompt");
  assert.equal(updateModeFromConfig(setUpdateMode({}, "auto")), "auto");
  assert.throws(() => setUpdateMode({}, "sometimes"), /prompt, auto, or off/);

  const stateDir = join(root, "state");
  writeUpdateState(stateDir, { latest_version: "0.2.2" });
  assert.equal(readUpdateState(stateDir).latest_version, "0.2.2");
  dismissUpdateVersion(stateDir, "0.2.2");
  assert.equal(readUpdateState(stateDir).dismissed_version, "0.2.2");

  const lock = acquireUpdateLock(stateDir);
  assert.throws(() => acquireUpdateLock(stateDir), (error) => error.code === "UPDATE_LOCKED");
  lock.release();
  const secondLock = acquireUpdateLock(stateDir);
  secondLock.release();
  const oldLiveLock = acquireUpdateLock(stateDir, {
    now: new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.throws(
    () => acquireUpdateLock(stateDir, {
      now: new Date("2026-08-02T00:00:00.000Z"),
      staleMs: 1_000,
    }),
    (error) => error.code === "UPDATE_LOCKED",
  );
  oldLiveLock.release();

  const npmRoot = join(root, "global", "node_modules", "@originrouter", "cli");
  mkdirSync(npmRoot, { recursive: true });
  const npmContext = detectInstallContext({
    packageRoot: npmRoot,
    entryPath: join(npmRoot, "bin", "originrouter.js"),
  });
  assert.equal(npmContext.method, "npm");
  assert.deepEqual(npmContext.args, ["install", "--global", "@originrouter/cli@latest"]);

  const sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, ".git"), { recursive: true });
  const sourceContext = detectInstallContext({
    packageRoot: sourceRoot,
    entryPath: join(sourceRoot, "bin", "originrouter.js"),
  });
  assert.equal(sourceContext.method, "source");
  assert.equal(sourceContext.command, null);

  const checkedAt = new Date("2026-08-23T10:00:00.000Z");
  const checkDir = join(root, "check");
  const checked = await checkForUpdate({
    stateDir: checkDir,
    currentVersion: "0.2.1",
    installContext: npmContext,
    now: checkedAt,
    force: true,
    fetchFn: async () => ({ ok: true, json: async () => ({ version: "0.2.2" }) }),
  });
  assert.equal(checked.update_available, true);
  assert.equal(checked.latest_version, "0.2.2");
  assert.equal(updateCheckIsDue(readUpdateState(checkDir), {
    now: new Date("2026-08-23T11:00:00.000Z"),
  }), false);

  const failureDir = join(root, "failure");
  await assert.rejects(
    () => checkForUpdate({
      stateDir: failureDir,
      force: true,
      fetchFn: async () => ({ ok: false, status: 503 }),
    }),
    (error) => error.code === "UPDATE_CHECK_FAILED",
  );
  assert.equal(readUpdateState(failureDir).last_checked_at, undefined);
  assert.equal(updateCheckIsDue(readUpdateState(failureDir)), true);

  assert.match(
    renderUpdatePrompt({ currentVersion: "0.2.1", latestVersion: "0.2.2" }),
    /Skip until next version/,
  );
  assert.deepEqual(updateSelectionForKey("update", { name: "down" }), {
    done: false,
    selection: "skip",
  });
  assert.deepEqual(updateSelectionForKey("skip", { name: "return" }), {
    done: true,
    selection: "skip",
  });
  assert.deepEqual(updateSelectionForKey("update", {}, "3"), {
    done: true,
    selection: "dismiss",
  });

  const startupDir = join(root, "startup");
  writeUpdateState(startupDir, {
    latest_version: "0.2.3",
    last_checked_at: checkedAt.toISOString(),
  });
  const dismissed = await handleStartupUpdate({
    stateDir: startupDir,
    config: { updates: { mode: "prompt" } },
    installContext: npmContext,
    promptFn: async () => "dismiss",
  });
  assert.equal(dismissed.continue, true);
  assert.equal(readUpdateState(startupDir).dismissed_version, "0.2.3");

  const failedStartupDir = join(root, "failed-startup");
  writeUpdateState(failedStartupDir, {
    latest_version: "0.2.3",
    last_checked_at: checkedAt.toISOString(),
  });
  const originalLog = console.log;
  console.log = () => {};
  let failedStartup;
  try {
    failedStartup = await handleStartupUpdate({
      stateDir: failedStartupDir,
      config: { updates: { mode: "prompt" } },
      installContext: npmContext,
      promptFn: async () => "update",
      installFn: async () => { throw new Error("simulated install failure"); },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(failedStartup.continue, true);
  assert.match(failedStartup.error.message, /simulated install failure/);

  const installDir = join(root, "install");
  writeUpdateState(installDir, {
    latest_version: "0.2.3",
    last_checked_at: checkedAt.toISOString(),
  });
  const oldHome = process.env.ORIGINROUTER_HOME;
  process.env.ORIGINROUTER_HOME = installDir;
  const daemonState = join(installDir, "daemon.state.json");
  writeFileSync(daemonState, JSON.stringify({ pid: 99999999, localApiPort: 7437 }));
  let spawned;
  const result = await installLatestVersion({
    stateDir: installDir,
    config: { updates: { mode: "prompt" } },
    installContext: { ...npmContext, writable: true },
    forceCheck: false,
    serviceInstalledFn: () => false,
    readInstalledVersionFn: () => "0.2.3",
    spawnFn: (command, args) => {
      spawned = { command, args };
      const child = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(result.updated, true);
  assert.equal(spawned.command, "npm");
  assert.deepEqual(spawned.args, ["install", "--global", "@originrouter/cli@0.2.3"]);
  assert.equal(result.restart_required, true);
  assert.equal(result.status.restart_required, true);
  assert.equal(result.status.update_available, false);
  assert.equal(readUpdateState(installDir).last_result, "updated");
  assert.equal(JSON.parse(readFileSync(daemonState, "utf8")).localApiPort, 7437);

  writeApiToken(installDir, "a".repeat(64));
  writeFileSync(daemonState, JSON.stringify({ pid: process.pid, localApiPort: 7437 }));
  const responseFor = (payload) => ({ ok: true, json: async () => payload });
  const active = await inspectUpdateActivity({
    stateDir: installDir,
    fetchFn: async (url) => {
      if (url.includes("/agent/local/sessions")) return responseFor({ sessions: [] });
      if (url.includes("/sessions")) return responseFor({ sessions: [] });
      return responseFor({ runs: [{ state: "executing" }] });
    },
  });
  assert.deepEqual(active, {
    daemon_running: true,
    active: true,
    reason: "active_collaboration",
  });
  const idle = await inspectUpdateActivity({
    stateDir: installDir,
    fetchFn: async (url) => {
      if (url.includes("/agent/local/sessions")) {
        return responseFor({ sessions: [{ status: "stopped" }] });
      }
      if (url.includes("/sessions")) return responseFor({ sessions: [{ status: "exited" }] });
      return responseFor({ runs: [{ state: "paused" }] });
    },
  });
  assert.deepEqual(idle, { daemon_running: true, active: false, reason: null });
  const unknown = await inspectUpdateActivity({
    stateDir: installDir,
    timeoutMs: 5,
    fetchFn: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ), { once: true });
    }),
  });
  assert.deepEqual(unknown, {
    daemon_running: true,
    active: true,
    reason: "daemon_activity_unknown",
  });

  if (oldHome === undefined) delete process.env.ORIGINROUTER_HOME;
  else process.env.ORIGINROUTER_HOME = oldHome;

  const status = cachedUpdateStatus({
    stateDir: checkDir,
    config: { updates: { mode: "auto" } },
    currentVersion: "0.2.1",
    installContext: npmContext,
  });
  assert.equal(status.mode, "auto");
  assert.equal(status.update_available, true);

  const mismatchDir = join(root, "mismatch");
  writeUpdateState(mismatchDir, {
    latest_version: "0.2.3",
    last_checked_at: checkedAt.toISOString(),
  });
  await assert.rejects(
    () => installLatestVersion({
      stateDir: mismatchDir,
      installContext: { ...npmContext, writable: true },
      forceCheck: false,
      serviceInstalledFn: () => false,
      readInstalledVersionFn: () => "0.2.1",
      spawnFn: () => {
        const child = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    }),
    (error) => error.code === "UPDATE_POST_INSTALL_VERSION_MISMATCH",
  );
  assert.equal(readUpdateState(mismatchDir).last_failure_kind, "post_install_version_mismatch");

  const permissionDir = join(root, "permission");
  writeUpdateState(permissionDir, {
    latest_version: "0.2.3",
    last_checked_at: checkedAt.toISOString(),
  });
  await assert.rejects(
    () => installLatestVersion({
      stateDir: permissionDir,
      installContext: { ...npmContext, writable: false },
      forceCheck: false,
    }),
    (error) => error.code === "EACCES" && /will not invoke sudo/.test(error.message),
  );
  assert.equal(readUpdateState(permissionDir).last_failure_kind, "no_permissions");

  const timeoutSignals = [];
  await assert.rejects(
    () => runInstaller("npm", ["install"], {
      timeoutMs: 5,
      killGraceMs: 5,
      forceKillWaitMs: 20,
      spawnFn: () => {
        const child = new EventEmitter();
        child.kill = (signal) => {
          timeoutSignals.push(signal);
          if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, signal));
          return true;
        };
        return child;
      },
    }),
    (error) => error.code === "UPDATE_TIMEOUT" && error.termination_confirmed === true,
  );
  assert.deepEqual(timeoutSignals, ["SIGTERM", "SIGKILL"]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("update tests ok");
