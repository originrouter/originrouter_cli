import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, posix as posixPath, resolve, win32 as win32Path } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { readApiToken } from "../persistence/authToken.js";
import { liveDaemonPid } from "../daemon/daemonPrimitives.js";
import { getStateDir, readDaemonState, readLocalApiConfig } from "../persistence/state.js";
import { quoteWindowsArgument } from "../utils/spawn.js";

const SERVICE_LABEL = "com.originrouter.daemon";
const SYSTEMD_UNIT = "originrouter.service";
const WINDOWS_TASK = "OriginRouterDaemon";

function parseServiceArgs(args) {
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((arg) => arg !== "--dry-run");
  return { action: rest[0], dryRun };
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function cliEntryPath() {
  return resolve(process.argv[1]);
}

function logPaths() {
  const stateDir = getStateDir();
  const logsDir = join(stateDir, "logs");
  return {
    logsDir,
    stdout: join(logsDir, "daemon.out.log"),
    stderr: join(logsDir, "daemon.err.log"),
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsXmlEscape(value) {
  return xmlEscape(value);
}

function powershellEncodedCommand(script) {
  const prelude = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ";
  return Buffer.from(prelude + script, "utf16le").toString("base64");
}

export function buildServiceEnvironmentPath({
  nodePath,
  cliPath,
  inheritedPath = process.env.PATH,
  currentPlatform = platform(),
} = {}) {
  const pathApi = currentPlatform === "win32" ? win32Path : posixPath;
  const separator = pathApi.delimiter;
  const inherited = String(inheritedPath || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
  const fallbacks = currentPlatform === "win32"
    ? []
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        join(homedir(), ".local", "bin"),
        join(homedir(), ".npm-global", "bin"),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];
  return [...new Set([
    nodePath ? pathApi.dirname(nodePath) : "",
    cliPath ? pathApi.dirname(cliPath) : "",
    ...inherited,
    ...fallbacks,
  ].filter(Boolean))].join(separator);
}

export function buildLaunchdPlist({
  nodePath,
  cliPath,
  stdoutPath,
  stderrPath,
  environmentPath = buildServiceEnvironmentPath({ nodePath, cliPath, currentPlatform: "darwin" }),
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(environmentPath)}</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(homedir())}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit({
  nodePath,
  cliPath,
  stdoutPath,
  stderrPath,
  environmentPath = buildServiceEnvironmentPath({ nodePath, cliPath, currentPlatform: "linux" }),
}) {
  return `[Unit]
Description=OriginRouter daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} daemon
Environment=${systemdQuote(`PATH=${environmentPath}`)}
Restart=on-failure
RestartSec=5
WorkingDirectory=${homedir()}
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}

[Install]
WantedBy=default.target
`;
}

export function buildWindowsTaskXml({
  nodePath,
  cliPath,
  stdoutPath,
  stderrPath,
  stateDir = win32Path.dirname(win32Path.dirname(stderrPath)),
  launcherPath = win32Path.join(win32Path.dirname(cliPath), "originrouter-windows-service.js"),
  environmentPath = buildServiceEnvironmentPath({ nodePath, cliPath, currentPlatform: "win32" }),
}) {
  // Wrap every value in PowerShell single quotes. JSON.stringify-style
  // escaping produces backslash-escaped quotes, which PowerShell does not
  // honor — the encoded script failed to parse there and the daemon never
  // launched. Single-quoted strings are literal in PowerShell; the embedded
  // double quotes around cliPath stay intact.
  const args = psSingleQuote(`"${cliPath}" daemon --originrouter-service-home "${stateDir}"`);
  const logCommand = [
    "$ErrorActionPreference = 'Stop'",
    `if (Test-Path -LiteralPath ${psSingleQuote(win32Path.join(stateDir, "service-start-failed"))}) { exit 0 }`,
    `$env:PATH = ${psSingleQuote(environmentPath)}`,
    `$env:ORIGINROUTER_HOME = ${psSingleQuote(stateDir)}`,
    // The GUI launcher hides PowerShell before Windows creates its console.
    // Hidden applies to the redirected Node child as well. A
    // redirected console still creates a blank Terminal window otherwise.
    // With a quickly exiting redirected child, WaitForExit on the returned
    // Process can leave ExitCode null in PowerShell 5.1. Start-Process -Wait
    // retains the exit code; otherwise a daemon crash is reported as success.
    `try { $p = Start-Process -FilePath ${psSingleQuote(nodePath)} -ArgumentList ${args} -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput ${psSingleQuote(stdoutPath)} -RedirectStandardError ${psSingleQuote(stderrPath)}; exit $p.ExitCode } catch { [IO.File]::AppendAllText(${psSingleQuote(stderrPath)}, ($_ | Out-String)); exit 1 }`,
  ].join("; ");
  const encoded = powershellEncodedCommand(logCommand);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OriginRouter daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${windowsXmlEscape(win32Path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"))}</Command>
      <Arguments>//B //NoLogo //E:JScript ${windowsXmlEscape(`"${launcherPath}"`)} --encoded-command ${windowsXmlEscape(encoded)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function run(cmd, args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`$ ${[cmd, ...args].join(" ")}`);
    return "";
  }
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    if (error?.signal === "SIGTERM") {
      if (platform() === "win32") {
        throw new Error(`${win32Path.basename(cmd)} timed out after 15s while managing the background service.`, { cause: error });
      }
      throw new Error(
        `\`${cmd} ${args.join(" ")}\` timed out after 15s. If this machine has no usable systemd user session, run \`originrouter service uninstall\` or reinstall with the service step disabled.`
      );
    }
    if (platform() === "win32") {
      // Encoded PowerShell commands can be thousands of characters long.
      // Report the actual error rather than dumping that command into setup.
      const detail = String(error?.stderr || error?.stdout || error?.code || "Unknown error").trim();
      throw new Error(`${win32Path.basename(cmd)} failed${Number.isInteger(error?.status) ? ` (exit ${error.status})` : ""}: ${detail}`, { cause: error });
    }
    throw error;
  }
}

// Windows may deny scheduled-task registration to standard shells. Instead
// of telling the user to open an elevated console themselves, relaunch this
// exact command through a UAC prompt: the user only clicks "Yes". The
// elevated child runs in its own window and its exit code is relayed here.
const ELEVATION_FLAG = "--originrouter-elevated";

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildWindowsElevationCommand({ nodePath, cliPath, action = "install" }) {
  if (action !== "install" && action !== "uninstall") {
    throw new Error(`Cannot elevate unsupported service action: ${action}`);
  }
  const inner = [
    quoteWindowsArgument(cliPath),
    "service", action, ELEVATION_FLAG,
  ].join(" ");
  return "$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath " + psSingleQuote(nodePath)
    + " -ArgumentList " + psSingleQuote(inner)
    + " -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
}

function runElevatedServiceAction(action) {
  const command = buildWindowsElevationCommand({ nodePath: process.execPath, cliPath: cliEntryPath(), action });
  console.log(`Administrator approval is needed to ${action} the background service.`);
  console.log(">>> Click \"Yes\" on the Windows permission prompt to continue. <<<");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(command)], {
      stdio: "inherit",
      timeout: 180_000,
      windowsHide: false,
    });
  } catch (error) {
    if (error?.signal === "SIGTERM") {
      throw new Error("Timed out waiting for the UAC approval prompt.");
    }
    throw new Error(
      `Administrator approval was declined or failed, so the background service could not be ${action}ed. `
      + `Re-run \`originrouter service ${action}\` and click "Yes" on the permission prompt.`
    );
  }
}

// schtasks prints in the local ANSI code page (GBK on zh-CN systems), which
// Node's utf8 decode renders as mojibake. Switch the console to UTF-8 first
// so captured output and error messages are readable.
function runSchtasks(args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`$ schtasks.exe ${args.join(" ")}`);
    return "";
  }
  const commandLine = `chcp 65001 >nul & schtasks.exe ${args.map(quoteWindowsArgument).join(" ")}`;
  try {
    return execFileSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  } catch (error) {
    const text = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
    const elevatedAction = args[0] === "/Create" ? "install" : args[0] === "/Delete" ? "uninstall" : null;
    if (/Access is denied|拒绝访问/i.test(text) && elevatedAction
        && !process.argv.includes(ELEVATION_FLAG)) {
      // Task registration or deletion was denied: let Windows ask the user
      // directly, then relay the elevated child's exit code.
      runElevatedServiceAction(elevatedAction);
      return "";
    }
    if (/Access is denied|拒绝访问/i.test(text)) {
      throw new Error(
        "Changing the background service requires administrator rights on this machine. "
        + `Open an elevated PowerShell and run \`originrouter service ${elevatedAction || "install"}\` there.`
      );
    }
    throw error;
  }
}

function tryRun(cmd, args, { dryRun = false } = {}) {
  try {
    return run(cmd, args, { dryRun });
  } catch {
    return "";
  }
}

function servicePaths(currentPlatform = platform()) {
  const logs = logPaths();
  if (currentPlatform === "darwin") {
    return {
      ...logs,
      configPath: join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    };
  }
  if (currentPlatform === "linux") {
    return {
      ...logs,
      configPath: join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT),
    };
  }
  if (currentPlatform === "win32") {
    return {
      ...logs,
      configPath: join(getStateDir(), "originrouter-task.xml"),
    };
  }
  return { ...logs, configPath: null };
}

export function isServiceInstalled(currentPlatform = platform()) {
  const paths = servicePaths(currentPlatform);
  return Boolean(paths.configPath && existsSync(paths.configPath));
}

function serviceConfigForPlatform(currentPlatform = platform()) {
  const paths = servicePaths(currentPlatform);
  const common = {
    nodePath: process.execPath,
    cliPath: cliEntryPath(),
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    stateDir: getStateDir(),
  };
  common.environmentPath = buildServiceEnvironmentPath({
    nodePath: common.nodePath,
    cliPath: common.cliPath,
    currentPlatform,
  });
  if (currentPlatform === "darwin") {
    return { paths, body: buildLaunchdPlist(common) };
  }
  if (currentPlatform === "linux") {
    return { paths, body: buildSystemdUnit(common) };
  }
  if (currentPlatform === "win32") {
    return { paths, body: buildWindowsTaskXml(common) };
  }
  throw new Error(`Unsupported platform for service management: ${currentPlatform}`);
}

function localApiUrlFromState(state) {
  if (!state?.localApiPort) return null;
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${state.localApiPort}`;
}

export async function waitForLocalApiReady({
  dryRun = false,
  timeoutMs = platform() === "win32" ? 30_000 : 10_000,
  readState = readDaemonState,
  readToken = () => readApiToken(getStateDir()),
  fetchFn = globalThis.fetch,
  sleep = delay,
} = {}) {
  if (dryRun) return null;
  const deadline = Date.now() + timeoutMs;
  let lastUrl = null;
  while (Date.now() < deadline) {
    const state = readState();
    const baseUrl = localApiUrlFromState(state);
    if (baseUrl) {
      lastUrl = baseUrl;
      try {
        // The Local API protects /local/status even on loopback. Re-read the
        // token on every attempt because the daemon may create it while this
        // readiness loop is already running.
        const token = readToken();
        const response = await fetchFn(`${baseUrl}/local/status`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (response.ok) {
          const payload = await response.json();
          const apiPid = Number(payload?.daemon?.pid);
          if (Number.isInteger(apiPid) && apiPid > 0
            && (!Number.isInteger(state?.pid) || state.pid === apiPid)) return baseUrl;
        }
      } catch {
        // Daemon may have written state before the socket is accepting.
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(250, remaining));
  }
  throw new Error(`OriginRouter Local API was not ready within ${timeoutMs}ms${lastUrl ? ` (${lastUrl})` : ""}. Check ${logPaths().stderr}.`);
}

function installService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  const { paths, body } = serviceConfigForPlatform(currentPlatform);
  const previousConfig = !dryRun && existsSync(paths.configPath) ? readFileSync(paths.configPath) : null;
  if (currentPlatform === "win32") {
    run("cscript.exe", ["//B", "//NoLogo", "//E:JScript", join(dirname(cliEntryPath()), "originrouter-windows-service.js"), "--check"], { dryRun });
    // Reinstalling must release the old wrapper and daemon before replacing
    // the task. Otherwise IgnoreNew can leave the old CLI running after an
    // upgrade, and the new setup still probes its broken API.
    stopService({ dryRun });
  }
  if (dryRun) {
    console.log(`# would write ${paths.configPath}`);
    console.log(body.trimEnd());
  } else {
    ensureDir(paths.logsDir);
    ensureDir(dirname(paths.configPath));
    if (currentPlatform === "win32") {
      writeFileSync(paths.configPath, Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(body, "utf16le"),
      ]));
    } else {
      writeFileSync(paths.configPath, body, "utf8");
    }
    if (currentPlatform !== "win32") chmodSync(paths.configPath, 0o644);
  }

  if (currentPlatform === "darwin") {
    console.log(`${dryRun ? "Would install" : "Installed"} launchd service: ${paths.configPath}`);
    console.log("Run `originrouter service start` to start it now.");
    return;
  }

  if (currentPlatform === "linux") {
    // Validate the unit before registering it so a bad directive is reported
    // with the offending line instead of a generic start failure later.
    if (tryRun("systemd-analyze", ["--version"])) {
      let verifyOutput = "";
      try {
        verifyOutput = run("systemd-analyze", ["--user", "verify", paths.configPath], { dryRun });
      } catch (error) {
        // Non-zero exit means verification found problems; the details are in
        // stdout/stderr. Anything else (timeout, missing command) is skipped.
        verifyOutput = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
        if (!verifyOutput) throw error;
      }
      if (verifyOutput.trim()) {
        throw new Error(`The generated systemd unit failed validation:\n${verifyOutput.trim()}`);
      }
    }
    run("systemctl", ["--user", "daemon-reload"], { dryRun });
    run("systemctl", ["--user", "enable", SYSTEMD_UNIT], { dryRun });
    console.log(`${dryRun ? "Would install" : "Installed"} systemd user service: ${paths.configPath}`);
    console.log("Run `originrouter service start` to start it now.");
    return;
  }

  if (currentPlatform === "win32") {
    try {
      runSchtasks(["/Create", "/TN", WINDOWS_TASK, "/XML", paths.configPath, "/F"], { dryRun });
      // The elevated child can regenerate PATH. Compare the registered
      // action with the final file on disk, not the parent's earlier XML.
      const verify = `$ErrorActionPreference = 'Stop'; $scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect(); $task = $scheduler.GetFolder('\\').GetTask(${psSingleQuote(WINDOWS_TASK)}); [xml]$expected = Get-Content -LiteralPath ${psSingleQuote(paths.configPath)} -Raw; [xml]$actual = $task.Xml; if ($expected.Task.Actions.Exec.Command -cne $actual.Task.Actions.Exec.Command -or $expected.Task.Actions.Exec.Arguments -cne $actual.Task.Actions.Exec.Arguments) { throw 'The registered service action differs from its configuration file.' }`;
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", powershellEncodedCommand(verify)], { dryRun });
    } catch (error) {
      if (!dryRun) {
        if (previousConfig) writeFileSync(paths.configPath, previousConfig);
        else if (existsSync(paths.configPath)) unlinkSync(paths.configPath);
      }
      throw error;
    }
    console.log(`${dryRun ? "Would install" : "Installed"} Windows scheduled task: ${WINDOWS_TASK}`);
    console.log("Run `originrouter service start` to start it now.");
  }
}

/**
 * Report when the daemon came up on a different port than the one it was asked
 * for.
 *
 * The daemon writes this warning into its own log, which nobody sees: under a
 * service manager the process is detached, so its stderr goes to
 * `logs/daemon.err.log` and the terminal is long gone. But the port is exactly
 * what the operator needs to hear about — a paired App or a saved direct address
 * is still pointed at the old number — so the shift has to be reported by
 * whichever command the user actually ran.
 *
 * `expected` is the port from the config the daemon read on the way in, before
 * it wrote back where it landed.
 */
export function warnIfLocalApiPortMoved(expectedPort, localApiUrl) {
  const actualPort = Number(localApiUrl?.split(":").pop());
  if (!Number.isInteger(expectedPort) || !Number.isInteger(actualPort)) return;
  if (actualPort === expectedPort) return;
  console.warn([
    `WARNING: local API port ${expectedPort} was in use; the daemon is on ${actualPort} instead.`,
    `The Local API address has changed, so anything configured for port ${expectedPort}`,
    "— a paired App, a saved direct address — will not reach this daemon until it",
    "is updated.",
    `To pin a port, stop the daemon and run: originrouter local api set-port <port>`,
  ].join("\n"));
}

async function startService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  // Read before the daemon can rewrite it, so the comparison is against the port
  // that was actually requested rather than the one it ended up on.
  const expectedPort = dryRun ? null : readLocalApiConfig().port;
  if (currentPlatform === "darwin") {
    const paths = servicePaths(currentPlatform);
    if (!existsSync(paths.configPath) && !dryRun) {
      throw new Error("Service is not installed. Run `originrouter service install` first.");
    }
    const target = `gui/${userInfo().uid}`;
    tryRun("launchctl", ["bootstrap", target, paths.configPath], { dryRun });
    run("launchctl", ["kickstart", "-k", `${target}/${SERVICE_LABEL}`], { dryRun });
    const localApiUrl = await waitForLocalApiReady({ dryRun });
    warnIfLocalApiPortMoved(expectedPort, localApiUrl);
    console.log(`OriginRouter service started${localApiUrl ? `: ${localApiUrl}` : "."}`);
    return;
  }
  if (currentPlatform === "linux") {
    run("systemctl", ["--user", "start", SYSTEMD_UNIT], { dryRun });
    const localApiUrl = await waitForLocalApiReady({ dryRun });
    warnIfLocalApiPortMoved(expectedPort, localApiUrl);
    console.log(`OriginRouter service started${localApiUrl ? `: ${localApiUrl}` : "."}`);
    return;
  }
  if (currentPlatform === "win32") {
    let localApiUrl;
    try {
      const failedPath = join(getStateDir(), "service-start-failed");
      if (!dryRun && existsSync(failedPath)) unlinkSync(failedPath);
      runSchtasks(["/Run", "/TN", WINDOWS_TASK], { dryRun });
      localApiUrl = await waitForLocalApiReady({ dryRun });
    } catch (error) {
      const diagnostics = windowsServiceDiagnostics();
      let cleanupError = null;
      try {
        // Scheduled retries must not resurrect a start that we reported as
        // failed. A deliberate subsequent start clears this marker.
        writeFileSync(join(getStateDir(), "service-start-failed"), String(error.message));
        stopService({ dryRun });
      } catch (failure) {
        cleanupError = failure;
      }
      throw new Error(`${error.message}\n${cleanupError ? `Service cleanup failed: ${cleanupError.message}` : "The failed service was stopped."}\n${diagnostics}`, { cause: error });
    }
    warnIfLocalApiPortMoved(expectedPort, localApiUrl);
    console.log(`OriginRouter service started${localApiUrl ? `: ${localApiUrl}` : "."}`);
    return;
  }
  throw new Error(`Unsupported platform for service management: ${currentPlatform}`);
}

function readLogTail(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, bytesRead).toString("utf8").trim() || "(empty)";
  } catch (error) {
    return error.code === "ENOENT" ? "(not created)" : `(cannot read: ${error.message})`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function windowsServiceDiagnostics() {
  const paths = servicePaths("win32");
  const details = [];
  try {
    details.push(`Scheduled task:\n${runSchtasks(["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"]).trim()}`);
  } catch (error) {
    details.push(`Scheduled task query failed: ${error.message}`);
  }
  for (const path of [paths.stdout, paths.stderr]) {
    details.push(`${path}:\n${readLogTail(path)}`);
  }
  return details.join("\n");
}

/**
 * Refuse a foreground start when a daemon is already running.
 *
 * `originrouter daemon` is a legitimate command — it is how you pass `--relay`,
 * `--device` or `--local-port` for one run, and it is what the supervisor itself
 * executes, so this must never block that path. What is never legitimate is a
 * *second* daemon beside a running one. That is a silent trap rather than a
 * feature: it cannot bind the API port, drifts to the next free one, sits on the
 * terminal looking stuck, and rewrites the port App pairing reads.
 *
 * The test is the recorded daemon actually being alive, not a service definition
 * existing. An installed service means a daemon is *usually* running, but the
 * supervisor may be between restarts, and refusing then would leave the machine
 * depending on launchd's retry to come back — so a stale or absent PID lets the
 * start proceed.
 */
export function assertNoRunningDaemon({
  state = readDaemonState(),
  isAlive = liveDaemonPid,
} = {}) {
  const pid = isAlive(state);
  if (pid == null) return;
  throw new Error(
    [
      `A daemon is already running (pid ${pid}).`,
      "A second, unmanaged instance would fail to bind the API port, drift to",
      "another one, and rewrite the port App pairing reads.",
      "",
      "  originrouter service status     see it",
      "  originrouter service restart    restart it",
      "  originrouter service stop       stop it, then run a foreground daemon",
    ].join("\n"),
  );
}

export async function restartService({ dryRun = false } = {}) {
  if (platform() === "win32") stopService({ dryRun });
  else try { stopService({ dryRun }); } catch {}
  if (platform() === "darwin" && !dryRun) {
    await waitForLaunchdUnloaded();
  }
  await startService({ dryRun });
}

export async function waitForLaunchdUnloaded({
  timeoutMs = 5_000,
  isLoaded = () => {
    const target = `gui/${userInfo().uid}/${SERVICE_LABEL}`;
    try {
      run("launchctl", ["print", target]);
      return true;
    } catch {
      return false;
    }
  },
  sleep = delay,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLoaded()) return;
    await sleep(100);
  }
  throw new Error(`OriginRouter service did not finish stopping within ${timeoutMs}ms.`);
}

export function buildWindowsStopCommand({ cliPath, stateDir, pid = null, taskName = WINDOWS_TASK, taskkillPath = "taskkill.exe" }) {
  // New daemons identify the managed state directory on their command line,
  // so they can be found even if startup failed before writing daemon.state.
  // Legacy daemons are eligible only at the recorded PID and exact CLI path.
  const marker = `--originrouter-service-home "${stateDir}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$scheduler = New-Object -ComObject 'Schedule.Service'; $scheduler.Connect()",
    `$task = $null; try { $task = $scheduler.GetFolder('\\').GetTask(${psSingleQuote(taskName)}) } catch { $exception = $_.Exception; while ($exception.InnerException) { $exception = $exception.InnerException }; if ($exception.HResult -ne -2147024894) { throw } }`,
    "if ($task) { $task.Stop(0) }",
    `$marker = ${psSingleQuote(marker)}; $cli = ${psSingleQuote(`"${cliPath}"`)}; $legacyPid = ${Number.isInteger(pid) && pid > 0 ? pid : 0}`,
    "$owned = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match '(?:^|\\s)daemon(?:\\s|$)' -and (($_.CommandLine.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.ProcessId -eq $legacyPid -and $_.CommandLine.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -ge 0)) })",
    // taskkill and Task.Stop return before Windows finishes tearing down a
    // process. CIM can also still return that exiting process. Wait on its
    // process handle instead of treating an immediate CIM snapshot as final.
    "foreach ($item in $owned) { $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.ProcessId); if (-not $current -or $current.CreationDate -ne $item.CreationDate) { continue }; $process = $null; try { $process = [Diagnostics.Process]::GetProcessById([int]$item.ProcessId); if ($process.HasExited) { continue }; $savedPreference = $ErrorActionPreference; try { $ErrorActionPreference = 'Continue'; & " + psSingleQuote(taskkillPath) + " /PID $item.ProcessId /T /F 2>&1 | Out-Null } finally { $ErrorActionPreference = $savedPreference }; if (-not $process.WaitForExit(5000)) { throw ('Daemon PID ' + $item.ProcessId + ' did not exit within 5000ms') } } catch [ArgumentException] { } finally { if ($process) { $process.Dispose() } } }",
  ].join("; ");
}

function stopService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    const paths = servicePaths(currentPlatform);
    const target = `gui/${userInfo().uid}`;
    tryRun("launchctl", ["bootout", target, paths.configPath], { dryRun });
    console.log("OriginRouter service stopped. Autostart file remains installed.");
    return;
  }
  if (currentPlatform === "linux") {
    run("systemctl", ["--user", "stop", SYSTEMD_UNIT], { dryRun });
    console.log("OriginRouter service stopped. Autostart remains enabled.");
    return;
  }
  if (currentPlatform === "win32") {
    let state = null;
    try { state = readDaemonState(); } catch { /* Recover a corrupt state file too. */ }
    const command = buildWindowsStopCommand({ cliPath: cliEntryPath(), stateDir: getStateDir(), pid: state?.pid });
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(command)], { dryRun });
    const statePath = join(getStateDir(), "daemon.state.json");
    if (!dryRun && existsSync(statePath)) unlinkSync(statePath);
    console.log("OriginRouter service stopped. Autostart task remains installed.");
    return;
  }
  throw new Error(`Unsupported platform for service management: ${currentPlatform}`);
}

function statusService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    const target = `gui/${userInfo().uid}/${SERVICE_LABEL}`;
    const output = run("launchctl", ["print", target], { dryRun });
    if (output) console.log(output.trimEnd());
  } else if (currentPlatform === "linux") {
    const output = run("systemctl", ["--user", "status", SYSTEMD_UNIT, "--no-pager"], { dryRun });
    if (output) console.log(output.trimEnd());
  } else if (currentPlatform === "win32") {
    const output = runSchtasks(["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"], { dryRun });
    if (output) console.log(output.trimEnd());
  } else {
    throw new Error(`Unsupported platform for service management: ${currentPlatform}`);
  }

  const state = readDaemonState();
  if (state?.localApiPort) {
    const bind = state.localApiBindAddress || "127.0.0.1";
    const host = bind === "0.0.0.0" ? "127.0.0.1" : bind;
    console.log(`Local API: http://${host}:${state.localApiPort}`);
    console.log(`Daemon state: ${state.status || "unknown"} updatedAt=${state.updatedAt || "unknown"}`);
  }
}

function uninstallService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  const paths = servicePaths(currentPlatform);
  if (currentPlatform === "darwin") {
    try { stopService({ dryRun }); } catch {}
    if (dryRun) console.log(`$ rm ${paths.configPath}`);
    else if (existsSync(paths.configPath)) unlinkSync(paths.configPath);
    console.log("OriginRouter service uninstalled.");
    return;
  }
  if (currentPlatform === "linux") {
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { dryRun });
    run("systemctl", ["--user", "daemon-reload"], { dryRun });
    if (dryRun) console.log(`$ rm ${paths.configPath}`);
    else if (existsSync(paths.configPath)) unlinkSync(paths.configPath);
    run("systemctl", ["--user", "daemon-reload"], { dryRun });
    console.log("OriginRouter service uninstalled.");
    return;
  }
  if (currentPlatform === "win32") {
    stopService({ dryRun });
    runSchtasks(["/Delete", "/TN", WINDOWS_TASK, "/F"], { dryRun });
    if (dryRun) console.log(`$ rm ${paths.configPath}`);
    else if (existsSync(paths.configPath)) unlinkSync(paths.configPath);
    console.log("OriginRouter service uninstalled.");
    return;
  }
  throw new Error(`Unsupported platform for service management: ${currentPlatform}`);
}

export function printServiceUsage() {
  console.log(`Usage:
  originrouter service install [--dry-run]
  originrouter service start [--dry-run]
  originrouter service stop [--dry-run]
  originrouter service restart [--dry-run]
  originrouter service status [--dry-run]
  originrouter service uninstall [--dry-run]`);
}

/**
 * Which `daemon` verbs are really service-manager verbs.
 *
 * `originrouter daemon` on its own starts a foreground daemon. Once
 * `service install` has run, the daemon belongs to launchd / systemd / the
 * scheduled task, and those supervisors restart it whenever it exits — so an
 * unmanaged second instance cannot take over. It fails to bind the API port,
 * drifts to the next free one, prints a startup banner, and then sits there
 * forever. Reporting that as a successful restart is worse than refusing, so
 * these verbs are routed to the component that actually owns the process.
 */
export function daemonServiceAction(args) {
  const action = args.find((arg) => !arg.startsWith("-"));
  // `start` belongs here for a different reason than the other three.
  //
  // stop / restart / status do not exist in `daemon`'s own grammar at all — a
  // bare `originrouter daemon` is the foreground command, and there is nothing
  // to stop or restart from inside it — so a user typing one can only mean the
  // service. `start`, by contrast, is exactly what a bare `daemon` already does,
  // so on its own it selects nothing; routing it to the supervisor is what makes
  // it mean anything, and matches `service start` elsewhere.
  return action === "stop" || action === "restart" || action === "status" ||
    action === "start"
    ? action
    : null;
}

export async function handleServiceCommand(args) {
  const { action, dryRun } = parseServiceArgs(args);
  if (!action || action === "--help" || action === "-h") {
    printServiceUsage();
    return;
  }
  if (action === "install") {
    installService({ dryRun });
    return;
  }
  if (action === "refresh") {
    // Called in a fresh CLI process after updating the installed package.
    // Rebuild the task/unit with the new implementation and executable paths.
    if (platform() !== "win32") stopService({ dryRun });
    installService({ dryRun });
    if (args.includes("--start")) await startService({ dryRun });
    return;
  }
  if (action === "start") {
    await startService({ dryRun });
    return;
  }
  if (action === "stop") {
    stopService({ dryRun });
    return;
  }
  if (action === "restart") {
    await restartService({ dryRun });
    return;
  }
  if (action === "status") {
    statusService({ dryRun });
    return;
  }
  if (action === "uninstall") {
    uninstallService({ dryRun });
    return;
  }
  throw new Error("Usage: originrouter service install|start|stop|restart|status|uninstall");
}
