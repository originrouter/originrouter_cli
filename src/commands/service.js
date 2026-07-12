import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { getStateDir, readDaemonState } from "../persistence/state.js";

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
  return Buffer.from(script, "utf16le").toString("base64");
}

export function buildLaunchdPlist({ nodePath, cliPath, stdoutPath, stderrPath }) {
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

export function buildSystemdUnit({ nodePath, cliPath, stdoutPath, stderrPath }) {
  return `[Unit]
Description=OriginRouter daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} daemon
Restart=on-failure
RestartSec=5
WorkingDirectory=${systemdQuote(homedir())}
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}

[Install]
WantedBy=default.target
`;
}

export function buildWindowsTaskXml({ nodePath, cliPath, stdoutPath, stderrPath }) {
  const args = `"${cliPath}" daemon`;
  const logCommand = `$p = Start-Process -FilePath ${JSON.stringify(nodePath)} -ArgumentList ${JSON.stringify(args)} -NoNewWindow -PassThru -RedirectStandardOutput ${JSON.stringify(stdoutPath)} -RedirectStandardError ${JSON.stringify(stderrPath)}; $p.WaitForExit(); exit $p.ExitCode`;
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
      <Interval>PT30S</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${windowsXmlEscape(encoded)}</Arguments>
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
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

function serviceConfigForPlatform(currentPlatform = platform()) {
  const paths = servicePaths(currentPlatform);
  const common = {
    nodePath: process.execPath,
    cliPath: cliEntryPath(),
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  };
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

async function waitForLocalApiReady({ dryRun = false, timeoutMs = 10_000 } = {}) {
  if (dryRun) return null;
  const deadline = Date.now() + timeoutMs;
  let lastUrl = null;
  while (Date.now() < deadline) {
    const state = readDaemonState();
    const baseUrl = localApiUrlFromState(state);
    if (baseUrl) {
      lastUrl = baseUrl;
      try {
        const response = await fetch(`${baseUrl}/local/status`);
        if (response.ok) return baseUrl;
      } catch {
        // Daemon may have written state before the socket is accepting.
      }
    }
    await delay(250);
  }
  throw new Error(`OriginRouter service started, but Local API was not ready within ${timeoutMs}ms${lastUrl ? ` (${lastUrl})` : ""}. Check ~/.originrouter/logs/daemon.err.log.`);
}

function installService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  const { paths, body } = serviceConfigForPlatform(currentPlatform);
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
    run("systemctl", ["--user", "daemon-reload"], { dryRun });
    run("systemctl", ["--user", "enable", SYSTEMD_UNIT], { dryRun });
    console.log(`${dryRun ? "Would install" : "Installed"} systemd user service: ${paths.configPath}`);
    console.log("Run `originrouter service start` to start it now.");
    return;
  }

  if (currentPlatform === "win32") {
    const xmlPath = dryRun ? paths.configPath : paths.configPath;
    run("schtasks.exe", ["/Create", "/TN", WINDOWS_TASK, "/XML", xmlPath, "/F"], { dryRun });
    console.log(`${dryRun ? "Would install" : "Installed"} Windows scheduled task: ${WINDOWS_TASK}`);
    console.log("Run `originrouter service start` to start it now.");
  }
}

async function startService({ dryRun = false } = {}) {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") {
    const paths = servicePaths(currentPlatform);
    if (!existsSync(paths.configPath) && !dryRun) {
      throw new Error("Service is not installed. Run `originrouter service install` first.");
    }
    const target = `gui/${userInfo().uid}`;
    tryRun("launchctl", ["bootstrap", target, paths.configPath], { dryRun });
    run("launchctl", ["kickstart", "-k", `${target}/${SERVICE_LABEL}`], { dryRun });
    const localApiUrl = await waitForLocalApiReady({ dryRun });
    console.log(`OriginRouter service started${localApiUrl ? `: ${localApiUrl}` : "."}`);
    return;
  }
  if (currentPlatform === "linux") {
    run("systemctl", ["--user", "start", SYSTEMD_UNIT], { dryRun });
    const localApiUrl = await waitForLocalApiReady({ dryRun });
    console.log(`OriginRouter service started${localApiUrl ? `: ${localApiUrl}` : "."}`);
    return;
  }
  if (currentPlatform === "win32") {
    run("schtasks.exe", ["/Run", "/TN", WINDOWS_TASK], { dryRun });
    const localApiUrl = await waitForLocalApiReady({ dryRun });
    console.log(`OriginRouter service started${localApiUrl ? `: ${localApiUrl}` : "."}`);
    return;
  }
  throw new Error(`Unsupported platform for service management: ${currentPlatform}`);
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
    run("schtasks.exe", ["/End", "/TN", WINDOWS_TASK], { dryRun });
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
    const output = run("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK, "/V", "/FO", "LIST"], { dryRun });
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
    run("schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { dryRun });
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
  if (action === "start") {
    await startService({ dryRun });
    return;
  }
  if (action === "stop") {
    stopService({ dryRun });
    return;
  }
  if (action === "restart") {
    try { stopService({ dryRun }); } catch {}
    await startService({ dryRun });
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
