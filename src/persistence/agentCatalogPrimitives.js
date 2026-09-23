import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

const SCHEMA_VERSION = 5;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function iso(value = null) {
  const parsed = value == null ? new Date() : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function canonicalPath(value) {
  const path = safeText(value, 4096);
  if (!path) return "";
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

// Keep the canonical path intact for identity and launch/recovery. This is
// presentation-only and intentionally collapses *only this device's* home,
// never an arbitrary /Users/<name> or /home/<name> prefix.
export function workspaceDisplayPath(value) {
  const path = safeText(value, 4096);
  if (!path || path === "~" || path.startsWith("~/")) return path;
  const home = canonicalPath(homedir());
  const candidate = canonicalPath(path);
  if (!home || !candidate) return path;
  const insensitive = process.platform === "win32";
  const same = (left, right) => insensitive
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  if (same(candidate, home)) return "~";
  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  const startsWithinHome = insensitive
    ? candidate.toLowerCase().startsWith(homePrefix.toLowerCase())
    : candidate.startsWith(homePrefix);
  return startsWithinHome ? `~${candidate.slice(home.length)}` : path;
}

export {
  assertTrustableWorkspacePath,
  canonicalPath,
  collectArtifactPaths,
  eventText,
  iso,
  isWithinPath,
  normalizeStatus,
  publicConversation,
  repositoryRoot,
  safeText,
  stableId,
  workspaceTrustError,
};

export { DEFAULT_LIMIT, MAX_LIMIT, SCHEMA_VERSION };

function repositoryRoot(cwd) {
  let current = canonicalPath(cwd);
  if (!current) return "";
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function stableId(prefix, ...parts) {
  const hash = createHash("sha256")
    .update(parts.map((part) => safeText(part, 4096)).join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${hash}`;
}

function workspaceTrustError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithinPath(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function assertTrustableWorkspacePath(value) {
  const requested = safeText(value, 4096);
  if (!requested) {
    throw workspaceTrustError("WORKSPACE_NOT_FOUND", "workspace path is required");
  }
  const absolute = resolve(requested);
  let canonical;
  let info;
  try {
    canonical = realpathSync.native(absolute);
    info = statSync(canonical);
  } catch {
    throw workspaceTrustError("WORKSPACE_NOT_FOUND", "workspace directory does not exist");
  }
  if (!info.isDirectory()) {
    throw workspaceTrustError("WORKSPACE_NOT_DIRECTORY", "workspace path is not a directory");
  }
  if (canonical === parse(canonical).root) {
    throw workspaceTrustError("WORKSPACE_UNSAFE", "filesystem root cannot be trusted as a workspace");
  }
  const systemRoots = process.platform === "win32"
    ? [join(parse(canonical).root, "Windows"), join(parse(canonical).root, "Program Files")]
    : ["/bin", "/dev", "/etc", "/proc", "/sbin", "/sys", "/System", "/usr"];
  if (systemRoots.some((root) => isWithinPath(canonical, root))) {
    throw workspaceTrustError(
      "WORKSPACE_UNSAFE",
      "system directories cannot be trusted as Agent workspaces",
    );
  }
  return canonical;
}

function normalizeStatus(value, fallback = "running") {
  const status = safeText(value, 32).toLowerCase();
  return status || fallback;
}

function eventText(event) {
  return safeText(
    event?.text || event?.detail || event?.summary || event?.result || event?.reason,
    4096,
  );
}

function collectArtifactPaths(value, key = "", result = []) {
  if (result.length >= 64 || value == null) return result;
  if (Array.isArray(value)) {
    for (const child of value) collectArtifactPaths(child, key, result);
    return result;
  }
  if (typeof value !== "object") {
    if (/^(?:file_?path|path|target|destination)$/i.test(key)) {
      const path = safeText(value, 4096);
      if (path) result.push(path);
    }
    return result;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectArtifactPaths(child, childKey, result);
  }
  return result;
}

function publicConversation(row) {
  if (!row) return null;
  return {
    conversation_id: row.conversation_id,
    agent_type: row.agent_type,
    native_session_id: row.native_session_id || "",
    title: row.title,
    title_is_custom: Boolean(row.title_is_custom),
    summary: row.summary || "",
    first_prompt_preview: row.first_prompt_preview || "",
    last_message_preview: row.last_message_preview || "",
    transcript_available: Boolean(row.transcript_locator),
    workspace_id: row.workspace_id || "",
    workspace_name: row.workspace_name || "",
    workspace_path: row.workspace_path || "",
    workspace_display_path: workspaceDisplayPath(row.workspace_path),
    repo_root: row.repo_root || "",
    device_id: row.device_id || "",
    runtime: row.runtime || "",
    provider: row.provider || "",
    model: row.model || "",
    permission_profile: row.permission_profile || "",
    status: row.status || "stopped",
    started_at: row.started_at || null,
    exited_at: row.exited_at || null,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    archived_at: row.archived_at || null,
    restored_at: row.restored_at || null,
    artifact_count: Number(row.artifact_count || 0),
  };
}
