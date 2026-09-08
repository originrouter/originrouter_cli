import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runCapture } from "../utils/detect.js";

export const MANAGED_PYTHON_VERSION = "3.12.13";
export const UV_VERSION = "0.12.9";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: options.stdio || "inherit",
      shell: false,
      env: options.env || process.env,
    });
    child.once("error", (error) => resolve({ ok: false, error }));
    child.once("exit", (code, signal) => resolve({ ok: code === 0, code, signal }));
  });
}

function isMusl() {
  if (platform() !== "linux") return false;
  if (!process.report?.getReport) return false;
  return !process.report.getReport().header?.glibcVersionRuntime;
}

function uvTarget() {
  const cpu = arch();
  const os = platform();
  if (os === "darwin" && cpu === "arm64") return { target: "aarch64-apple-darwin", ext: "tar.gz" };
  if (os === "darwin" && cpu === "x64") return { target: "x86_64-apple-darwin", ext: "tar.gz" };
  if (os === "linux" && cpu === "arm64") return { target: `aarch64-unknown-linux-${isMusl() ? "musl" : "gnu"}`, ext: "tar.gz" };
  if (os === "linux" && cpu === "x64") return { target: `x86_64-unknown-linux-${isMusl() ? "musl" : "gnu"}`, ext: "tar.gz" };
  if (os === "win32" && cpu === "arm64") return { target: "aarch64-pc-windows-msvc", ext: "zip" };
  if (os === "win32" && cpu === "x64") return { target: "x86_64-pc-windows-msvc", ext: "zip" };
  throw new Error(`Managed Python is not available for ${os}/${cpu}.`);
}

function findFile(root, names, depth = 5) {
  if (!root || !existsSync(root) || depth < 0) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && names.includes(entry.name)) return path;
  }
  if (depth === 0) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findFile(join(root, entry.name), names, depth - 1);
    if (found) return found;
  }
  return null;
}

export function managedPythonRoot(stateDir) {
  return join(stateDir, "runtimes", "python");
}

export function managedUvRoot(stateDir) {
  return join(stateDir, "runtimes", "uv", UV_VERSION);
}

export function findManagedPython(stateDir) {
  const names = platform() === "win32"
    ? ["python.exe"]
    : [`python${MANAGED_PYTHON_VERSION.split(".").slice(0, 2).join(".")}`, "python3", "python"];
  return findFile(managedPythonRoot(stateDir), names, 5);
}

async function validManagedPython(stateDir) {
  const path = findManagedPython(stateDir);
  if (!path) return null;
  const result = await runCapture(path, ["--version"], { timeoutMs: 5000 });
  const expected = MANAGED_PYTHON_VERSION.split(".").slice(0, 2).join(".");
  return result.ok && result.output.startsWith(`Python ${expected}.`) ? path : null;
}

async function download(url, destination) {
  if (platform() === "win32") {
    const script = [
      "$ProgressPreference='SilentlyContinue'",
      `$u=${JSON.stringify(url)}`,
      `$o=${JSON.stringify(destination)}`,
      "Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $o",
    ].join("; ");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    if (!result.ok) throw new Error(`Download failed: ${url}`);
    return;
  }
  const result = await run("curl", [
    "-fsSL", "--retry", "3", "--connect-timeout", "10", "--max-time", "300",
    "-o", destination, url,
  ]);
  if (!result.ok) throw new Error(`Download failed: ${url}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function installManagedUv(stateDir) {
  const root = managedUvRoot(stateDir);
  const existing = findFile(root, platform() === "win32" ? ["uv.exe"] : ["uv"], 3);
  if (existing) return existing;

  const { target, ext } = uvTarget();
  const asset = `uv-${target}.${ext}`;
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  const temp = mkdtempSync(join(tmpdir(), "originrouter-uv-"));
  const archive = join(temp, asset);
  const checksum = `${archive}.sha256`;
  const stage = `${root}.staging-${process.pid}`;
  try {
    await download(`${base}/${asset}`, archive);
    await download(`${base}/${asset}.sha256`, checksum);
    const expected = readFileSync(checksum, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256(archive) !== expected) {
      throw new Error("Managed Python bootstrap checksum verification failed.");
    }
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    const extracted = platform() === "win32"
      ? await run("powershell.exe", [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
          `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(stage)} -Force`,
        ])
      : await run("tar", ["-xzf", archive, "-C", stage]);
    if (!extracted.ok) throw new Error(`Unable to extract ${asset}.`);
    const uv = findFile(stage, platform() === "win32" ? ["uv.exe"] : ["uv"], 3);
    if (!uv) throw new Error(`Downloaded ${asset} did not contain the uv executable.`);
    if (platform() !== "win32") chmodSync(uv, 0o755);
    mkdirSync(dirname(root), { recursive: true });
    rmSync(root, { recursive: true, force: true });
    renameSync(stage, root);
    const relative = uv.slice(stage.length + 1);
    return join(root, relative);
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function ensureManagedPython(stateDir, { dryRun = false } = {}) {
  const existing = await validManagedPython(stateDir);
  if (existing) return { ok: true, path: existing, version: MANAGED_PYTHON_VERSION, alreadyInstalled: true };
  if (dryRun) {
    return {
      ok: true,
      path: join(managedPythonRoot(stateDir), `<python-${MANAGED_PYTHON_VERSION}>`),
      version: MANAGED_PYTHON_VERSION,
      dryRun: true,
    };
  }

  const uv = await installManagedUv(stateDir);
  mkdirSync(managedPythonRoot(stateDir), { recursive: true });
  const args = [
    "python", "install", MANAGED_PYTHON_VERSION,
    "--install-dir", managedPythonRoot(stateDir),
    "--no-bin", "--no-registry", "--managed-python",
  ];
  if (existsSync(managedPythonRoot(stateDir)) && readdirSync(managedPythonRoot(stateDir)).length > 0) {
    args.push("--reinstall");
  }
  const result = await run(uv, args, {
    env: {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: managedPythonRoot(stateDir),
      UV_CACHE_DIR: join(stateDir, "cache", "uv"),
    },
  });
  if (!result.ok) throw new Error(`Managed Python ${MANAGED_PYTHON_VERSION} installation failed.`);
  const path = await validManagedPython(stateDir);
  if (!path) throw new Error(`Managed Python ${MANAGED_PYTHON_VERSION} was installed but could not be verified.`);
  return { ok: true, path, version: MANAGED_PYTHON_VERSION, alreadyInstalled: false };
}

export async function managedPythonStatus(stateDir) {
  const path = await validManagedPython(stateDir);
  if (!path) return { available: false, path: null, version: MANAGED_PYTHON_VERSION };
  const stats = statSync(path);
  return { available: stats.isFile(), path, version: MANAGED_PYTHON_VERSION };
}
