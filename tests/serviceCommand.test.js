import assert from "node:assert/strict";

import {
  assertNoRunningDaemon,
  buildLaunchdPlist,
  buildServiceEnvironmentPath,
  buildSystemdUnit,
  buildWindowsTaskXml,
  buildWindowsElevationCommand,
  daemonServiceAction,
  waitForLocalApiReady,
  waitForLaunchdUnloaded,
  warnIfLocalApiPortMoved,
} from "../src/commands/service.js";
import { liveDaemonPid } from "../src/daemon/daemonPrimitives.js";

const common = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/opt/originrouter/bin/originrouter.js",
  stdoutPath: "/tmp/originrouter.out.log",
  stderrPath: "/tmp/originrouter.err.log",
  environmentPath: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
};

{
  const value = buildServiceEnvironmentPath({
    nodePath: "/opt/custom-node/bin/node",
    cliPath: "/opt/originrouter/bin/originrouter.js",
    inheritedPath: "/custom/bin:/usr/bin:/custom/bin",
    currentPlatform: "darwin",
  });
  const entries = value.split(":");
  assert.equal(entries[0], "/opt/custom-node/bin");
  assert.equal(entries[1], "/opt/originrouter/bin");
  assert.equal(entries.filter((item) => item === "/custom/bin").length, 1);
  assert.ok(entries.includes("/usr/local/bin"));
  assert.ok(entries.includes("/opt/homebrew/bin"));
}

{
  const value = buildServiceEnvironmentPath({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@originrouter\\cli\\bin\\originrouter.js",
    inheritedPath: "C:\\custom;C:\\Windows\\System32;C:\\custom",
    currentPlatform: "win32",
  });
  const entries = value.split(";");
  assert.equal(entries[0], "C:\\Program Files\\nodejs");
  assert.equal(entries[1], "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@originrouter\\cli\\bin");
  assert.equal(entries.filter((item) => item === "C:\\custom").length, 1);
  assert.ok(entries.includes("C:\\Windows\\System32"));
}

{
  const plist = buildLaunchdPlist(common);
  assert.match(plist, /<string>com\.originrouter\.daemon<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<string>daemon<\/string>/);
}

{
  const unit = buildSystemdUnit(common);
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/originrouter\/bin\/originrouter\.js" daemon/);
  assert.match(unit, /Environment="PATH=\/usr\/local\/bin:/);
  // systemd does not parse quotes on WorkingDirectory=; a quoted value is read
  // literally and rejected as "path is not absolute". The value is os.homedir(),
  // which may be a Unix path (/home/...) or a Windows drive path (C:\Users\...)
  // depending on the CI runner — both are valid absolute paths to systemd.
  assert.doesNotMatch(unit, /WorkingDirectory="/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /WantedBy=default\.target/);
}

{
  const task = buildWindowsTaskXml({
    ...common,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\originrouter-cli\\bin\\originrouter.js",
    environmentPath: "C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm",
  });
  assert.match(task, /<LogonTrigger>/);
  assert.match(task, /<RestartOnFailure>/);
  assert.match(task, /<Count>3<\/Count>/);
  // Task Scheduler rejects sub-minute RestartOnFailure intervals (schtasks
  // reports "(35,25): Interval:PT30S" as out of range); PT1M is the minimum.
  assert.match(task, /<Interval>PT1M<\/Interval>/);
  assert.doesNotMatch(task, /<Interval>PT0?S<\/Interval>/);
  assert.doesNotMatch(task, /<Interval>PT\d+S<\/Interval>/);
  assert.match(task, /wscript\.exe<\/Command>/);
  assert.match(task, /originrouter-windows-service\.js/);
  const encoded = task.match(/--encoded-command ([^<]+)<\/Arguments>/)?.[1];
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /\$env:PATH =/);
  // The wrapper must use PowerShell single-quote literals. JSON.stringify
  // escaping emits backslash-escaped quotes, which PowerShell does not honor,
  // so the encoded script failed to parse and the daemon never launched.
  assert.doesNotMatch(decoded, /\\"/);
  assert.match(decoded, /-ArgumentList '[^']* daemon --originrouter-service-home /);
  assert.match(task, /\/\/B \/\/NoLogo \/\/E:JScript/);
  assert.match(decoded, /Program Files\\nodejs/);
}

{
  const command = buildWindowsElevationCommand({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\O'Brien\\Origin Router\\originrouter.js",
  });
  assert.match(command, /-FilePath 'C:\\Program Files\\nodejs\\node.exe'/);
  assert.match(command, /-ArgumentList '"C:\\Users\\O''Brien\\Origin Router\\originrouter.js" service install --originrouter-elevated'/);
  assert.match(command, /-Wait -PassThru; exit \$p.ExitCode/);
  const uninstall = buildWindowsElevationCommand({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\O'Brien\\Origin Router\\originrouter.js",
    action: "uninstall",
  });
  assert.match(uninstall, /service uninstall --originrouter-elevated/);
  assert.throws(() => buildWindowsElevationCommand({ nodePath: "node", cliPath: "cli", action: "stop" }), /unsupported/);
}

{
  const requests = [];
  let tokenReads = 0;
  const url = await waitForLocalApiReady({
    timeoutMs: 1_000,
    readState: () => ({
      localApiPort: 7437,
      localApiBindAddress: "127.0.0.1",
    }),
    readToken: () => {
      tokenReads += 1;
      return tokenReads === 1 ? null : "test-token";
    },
    fetchFn: async (requestUrl, options) => {
      requests.push({ requestUrl, options });
      return { ok: requests.length === 2, json: async () => ({ daemon: { pid: 1234 } }) };
    },
    sleep: async () => {},
  });

  assert.equal(url, "http://127.0.0.1:7437");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].options.headers, {});
  assert.deepEqual(requests[1].options.headers, {
    Authorization: "Bearer test-token",
  });
}

{
  let attempts = 0;
  const ready = await waitForLocalApiReady({
    timeoutMs: 1000,
    readState: () => ({ pid: 1234, localApiPort: 7437 }),
    readToken: () => "test-token",
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ daemon: { pid: ++attempts === 1 ? 9999 : 1234 } }),
    }),
    sleep: async () => {},
  });
  assert.equal(ready, "http://127.0.0.1:7437");
  assert.equal(attempts, 2, "a stale daemon must not satisfy readiness");
}

{
  let checks = 0;
  let sleeps = 0;
  await waitForLaunchdUnloaded({
    timeoutMs: 1_000,
    isLoaded: () => {
      checks += 1;
      return checks < 3;
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(checks, 3);
  assert.equal(sleeps, 2);
}

{
  const startedAt = Date.now();
  await assert.rejects(waitForLocalApiReady({
    timeoutMs: 40,
    readState: () => ({ localApiPort: 7437 }),
    readToken: () => "test-token",
    fetchFn: async (_url, { signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test hung without abort")), 1_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
  }), /not ready within 40ms/);
  assert.ok(Date.now() - startedAt < 500, "a stalled HTTP request must respect the readiness deadline");
}

// `originrouter daemon stop|restart|status` must reach the service manager.
// Left as plain `startDaemon` they start a second, unmanaged instance that
// cannot bind the port, drifts to the next one and hangs — which reads as a
// successful restart while the real daemon keeps running the old code.
{
  assert.equal(daemonServiceAction(["restart"]), "restart");
  assert.equal(daemonServiceAction(["stop"]), "stop");
  assert.equal(daemonServiceAction(["status"]), "status");
  assert.equal(daemonServiceAction(["restart", "--dry-run"]), "restart");
  assert.equal(daemonServiceAction(["--dry-run", "stop"]), "stop");

  // `daemon start` selects nothing on its own — a bare `daemon` already starts
  // one in the foreground — so it routes to the supervisor and means what
  // `service start` means everywhere else.
  assert.equal(daemonServiceAction(["start"]), "start");
  assert.equal(daemonServiceAction(["start", "--dry-run"]), "start");

  // A bare `originrouter daemon` still starts a foreground daemon, and daemon
  // flags that merely resemble verbs must not be hijacked.
  assert.equal(daemonServiceAction([]), null);
  assert.equal(daemonServiceAction(["--relay", "https://example.test"]), null);
  assert.equal(daemonServiceAction(["--executor", "pty"]), null);
}

// A foreground `daemon` beside a running one is the trap the delegation above
// exists to avoid — it cannot bind the port, drifts, and rewrites pairing state.
// The guard keys on the recorded daemon being alive, never on a service merely
// being installed: the supervisor may be between restarts, and refusing then
// would leave the machine waiting on launchd instead of starting.
{
  const dead = { pid: 999_999 };
  const stale = () => { const error = new Error("kill ESRCH"); error.code = "ESRCH"; throw error; };

  // No recorded daemon, or one that is gone: a start is legitimate.
  assert.doesNotThrow(() => assertNoRunningDaemon({ state: null, isAlive: liveDaemonPid }));
  assert.doesNotThrow(() => assertNoRunningDaemon({ state: {}, isAlive: liveDaemonPid }));
  assert.doesNotThrow(() => assertNoRunningDaemon({ state: { pid: 0 }, isAlive: liveDaemonPid }));
  assert.doesNotThrow(() => assertNoRunningDaemon({ state: { pid: "nope" }, isAlive: liveDaemonPid }));
  assert.doesNotThrow(
    () => assertNoRunningDaemon({ state: dead, isAlive: (_s, kill) => liveDaemonPid(_s, kill) }),
    "a stale record must not block a foreground start",
  );

  // A live daemon: refuse, and name the pid so the message is actionable.
  assert.throws(
    () => assertNoRunningDaemon({ state: { pid: 1234 }, isAlive: () => 1234 }),
    /already running \(pid 1234\)/,
  );
}

// `liveDaemonPid` probes with signal 0 so it never disturbs the daemon the
// service manager owns — a stray signal would stop it.
{
  const calls = [];
  const probe = (pid, signal) => {
    calls.push([pid, signal]);
    const error = new Error("ESRCH");
    error.code = "ESRCH";
    throw error;
  };

  assert.equal(liveDaemonPid({ pid: 4321 }, probe), null);
  assert.deepEqual(calls, [[4321, 0]], "must probe with signal 0, not a real signal");

  // EPERM means the process exists under another user; that still counts.
  const eperm = () => { const error = new Error("EPERM"); error.code = "EPERM"; throw error; };
  assert.equal(liveDaemonPid({ pid: 4321 }, eperm), 4321);

  assert.equal(liveDaemonPid(null, probe), null);
  assert.equal(liveDaemonPid({}, probe), null);
  assert.equal(liveDaemonPid({ pid: -1 }, probe), null);
}

// A port that moved must be reported by the command the user ran. The daemon
// writes the same warning into its own log, but under a service manager that log
// is the only place it would exist — the process is detached and the terminal is
// gone — so a shift has to surface here instead.
{
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(" "));
  try {
    // No shift: silent. A correct restart must not cry wolf.
    warnIfLocalApiPortMoved(7437, "http://127.0.0.1:7437");

    // Unparseable inputs must not produce a bogus warning either.
    warnIfLocalApiPortMoved(null, "http://127.0.0.1:7437");
    warnIfLocalApiPortMoved(7437, null);
    warnIfLocalApiPortMoved(undefined, undefined);

    assert.equal(captured.length, 0, "a normal start warns about nothing");

    // A shift: exactly one message, naming both ports and the pinning command.
    warnIfLocalApiPortMoved(7438, "http://127.0.0.1:7437");
    assert.equal(captured.length, 1);
    const message = captured[0];
    assert.match(message, /port 7438 was in use/);
    assert.match(message, /daemon is on 7437/);
    assert.match(message, /originrouter local api set-port/);
  } finally {
    console.warn = originalWarn;
  }
}

console.log("service command tests ok");
