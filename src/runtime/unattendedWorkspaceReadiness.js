import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform as currentPlatform } from "node:os";
import { join, posix as posixPath, win32 as win32Path } from "node:path";

// Remote Agents must never discover an OS privacy prompt only after their
// process has been detached. This module is deliberately conservative: an
// unsupported location is a configuration error, not a best-effort launch.

function normalized(value, pathApi, { foldCase = false } = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  const result = pathApi.normalize(text);
  return foldCase ? result.toLowerCase() : result;
}

function within(path, parent, pathApi, options) {
  const value = normalized(path, pathApi, options);
  const root = normalized(parent, pathApi, options);
  return Boolean(value && root && (value === root || value.startsWith(`${root}${pathApi.sep}`)));
}

function blocked({ platform, code, summary, action }) {
  return {
    status: "blocked",
    remote_eligible: false,
    platform,
    code,
    summary,
    action,
  };
}

function ready(platform) {
  return {
    status: "ready",
    remote_eligible: true,
    platform,
    code: null,
    summary: "The workspace is suitable for unattended Agent launches.",
    action: null,
  };
}

function authorizationRequired({ platform, code, summary, action }) {
  return {
    status: "requires_local_authorization",
    remote_eligible: false,
    platform,
    code,
    summary,
    action,
  };
}

function macosReadiness(path, home) {
  const protectedRoots = [
    ["Desktop", "Desktop"],
    ["Documents", "Documents"],
    ["Downloads", "Downloads"],
    ["Library/Mobile Documents", "iCloud Drive"],
    ["Library/CloudStorage", "a cloud-storage provider folder"],
  ];
  for (const [relative, label] of protectedRoots) {
    if (within(path, posixPath.join(home, relative), posixPath)) {
      return authorizationRequired({
        platform: "darwin",
        code: "MACOS_TCC_PROTECTED_WORKSPACE",
        summary: `This workspace is in ${label}, where macOS can show a TCC privacy prompt for node.`,
        action: "Run `originrouter remote workspace authorize <path>` once on this Mac while a user can answer the macOS prompt, then remote launches may use this workspace.",
      });
    }
  }
  if (within(path, "/Volumes", posixPath) || within(path, "/Network", posixPath)) {
    return authorizationRequired({
      platform: "darwin",
      code: "MACOS_UNATTENDED_MOUNT_WORKSPACE",
      summary: "This workspace is on a mounted or network location that can require macOS access or credentials.",
      action: "Use a local development workspace, or enroll this mounted location with non-interactive credentials before remote execution.",
    });
  }
  return null;
}

function windowsReadiness(path, home, env) {
  const options = { foldCase: true };
  const protectedRoots = [
    [win32Path.join(home, "Desktop"), "Desktop"],
    [win32Path.join(home, "Documents"), "Documents"],
    [win32Path.join(home, "Downloads"), "Downloads"],
    [win32Path.join(home, "OneDrive"), "OneDrive"],
    [env.OneDrive, "OneDrive"],
    [env.OneDriveConsumer, "OneDrive"],
    [env.OneDriveCommercial, "OneDrive"],
  ].filter(([root]) => String(root || "").trim());
  for (const [root, label] of protectedRoots) {
    if (within(path, root, win32Path, options)) {
      return authorizationRequired({
        platform: "win32",
        code: "WINDOWS_PROTECTED_OR_SYNCED_WORKSPACE",
        summary: `This workspace is in ${label}, where Controlled Folder Access or cloud sync can block an unattended node process.`,
        action: "Allow the OriginRouter Node runtime in the applicable Windows security policy, then run `originrouter remote workspace authorize <path>` locally.",
      });
    }
  }
  const normalizedPath = normalized(path, win32Path, options);
  if (normalizedPath.startsWith("\\\\")) {
    return authorizationRequired({
      platform: "win32",
      code: "WINDOWS_NETWORK_WORKSPACE",
      summary: "This workspace is on a network share, which can require Windows credentials or become unavailable during a remote run.",
      action: "Use a local workspace, or ensure the share has non-interactive credentials and authorize it locally before remote execution.",
    });
  }
  return null;
}

function linuxReadiness(path) {
  for (const root of ["/run/user", "/media", "/run/media", "/mnt", "/net"]) {
    if (within(path, root, posixPath)) {
      return authorizationRequired({
        platform: "linux",
        code: "LINUX_INTERACTIVE_MOUNT_WORKSPACE",
        summary: "This workspace is on a desktop, removable, or network mount that can require credentials or disappear during an unattended run.",
        action: "Use a stable local workspace, or ensure this mount has non-interactive credentials and authorize it locally before remote execution.",
      });
    }
  }
  return null;
}

/**
 * Determine whether a workspace is safe for a detached, remotely controlled
 * Agent. It does not attempt to obtain OS permission: doing that would itself
 * create exactly the invisible prompt this guard is meant to prevent.
 */
export function assessUnattendedWorkspace(path, {
  platformName = currentPlatform(),
  homeDirectory = homedir(),
  env = process.env,
  checkAccess = true,
  access = accessSync,
  allowProtectedPaths = false,
} = {}) {
  const platform = String(platformName || "").toLowerCase();
  const workspacePath = String(path || "").trim();
  if (!workspacePath) {
    return blocked({
      platform,
      code: "WORKSPACE_PATH_REQUIRED",
      summary: "A workspace path is required for unattended execution.",
      action: "Select a local workspace and trust it before starting the Agent.",
    });
  }

  const platformBlock = platform === "darwin"
    ? macosReadiness(workspacePath, homeDirectory)
    : platform === "win32"
      ? windowsReadiness(workspacePath, homeDirectory, env)
      : platform === "linux"
        ? linuxReadiness(workspacePath)
        : null;
  if (platformBlock && !allowProtectedPaths) {
    return { ...platformBlock, workspace_path: workspacePath };
  }

  if (checkAccess) {
    try {
      access(workspacePath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    } catch (error) {
      return {
        ...blocked({
          platform,
          code: "WORKSPACE_ACCESS_UNAVAILABLE",
          summary: "The current OS account cannot read, write, and enter this workspace without additional access.",
          action: "Grant the account access during device setup, or move the workspace to a local directory owned by this account.",
        }),
        workspace_path: workspacePath,
        os_error: error?.code || null,
      };
    }
  }
  return { ...ready(platform), workspace_path: workspacePath };
}

export function requireUnattendedWorkspace(path, options = {}) {
  const readiness = assessUnattendedWorkspace(path, options);
  if (readiness.remote_eligible) return readiness;
  const error = new Error(`${readiness.summary} ${readiness.action}`);
  error.code = readiness.code;
  error.readiness = readiness;
  throw error;
}

/**
 * Verify the exact filesystem operations a managed Agent needs. This is used
 * only by the explicit local authorization flow; it intentionally creates a
 * short-lived private directory so Windows Controlled Folder Access, TCC, and
 * mount credential policies are exercised while someone can respond locally.
 */
export function preflightUnattendedWorkspaceAuthorization(path) {
  const workspacePath = String(path || "").trim();
  let temporaryDirectory = "";
  try {
    temporaryDirectory = mkdtempSync(join(workspacePath, ".originrouter-access-"));
    writeFileSync(join(temporaryDirectory, "write-check"), "originrouter preflight\n", {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (cause) {
    const error = new Error(
      "OriginRouter could not create and write a temporary preflight file in this workspace. "
      + "Grant the daemon runtime access locally, then try authorization again.",
    );
    error.code = "WORKSPACE_UNATTENDED_PREFLIGHT_FAILED";
    error.cause = cause;
    throw error;
  } finally {
    if (temporaryDirectory) {
      try {
        rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // A failed cleanup does not invalidate successful authorization. The
        // directory is uniquely named and contains no user data.
      }
    }
  }
}

/**
 * Guard a filesystem request that arrived from another device. Unlike a local
 * authorization flow, this must not access the path at all when it is a
 * location known to surface an interactive OS or mount prompt. The explicit
 * local `remote workspace authorize` command is the only route that may
 * perform that preflight.
 */
export function requireRemoteWorkspacePathPreflight(path, options = {}) {
  const workspacePath = String(path || "").trim();
  // An empty browse path means "show the home directory", which is not a
  // protected folder itself and is how the picker starts.
  if (!workspacePath) return ready(String(options.platformName || currentPlatform()).toLowerCase());
  const readiness = assessUnattendedWorkspace(workspacePath, {
    ...options,
    checkAccess: false,
    allowProtectedPaths: false,
  });
  if (readiness.remote_eligible) return readiness;
  const error = new Error(`${readiness.summary} ${readiness.action}`);
  error.code = readiness.code;
  error.readiness = readiness;
  throw error;
}

export function assessRegisteredWorkspaceForUnattended(record, {
  subject = process.execPath,
  ...options
} = {}) {
  const authorized = Boolean(
    String(record?.unattended_authorized_at || "").trim()
    && String(record?.unattended_authorization_subject || "") === String(subject || ""),
  );
  return assessUnattendedWorkspace(record?.canonical_path || record?.path, {
    ...options,
    allowProtectedPaths: authorized,
  });
}
