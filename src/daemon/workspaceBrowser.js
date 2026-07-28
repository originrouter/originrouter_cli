import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;

function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function expandHome(value) {
  const text = safeText(value);
  if (!text || text === "~") return homedir();
  if (text.startsWith(`~${sep}`)) return join(homedir(), text.slice(2));
  return text;
}

async function canonicalDirectory(value) {
  const absolute = isAbsolute(value) ? value : resolve(value);
  const info = await stat(absolute);
  if (!info.isDirectory()) {
    const error = new Error("workspace path is not a directory");
    error.code = "WORKSPACE_NOT_DIRECTORY";
    throw error;
  }
  return realpath(absolute);
}

async function resolveBrowseLocation(rawPath, rawQuery) {
  const requested = expandHome(rawPath);
  const query = safeText(rawQuery, 256);
  if (!requested) {
    return { currentPath: await canonicalDirectory(homedir()), prefix: query };
  }
  try {
    return { currentPath: await canonicalDirectory(requested), prefix: query };
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    return {
      currentPath: await canonicalDirectory(dirname(requested)),
      prefix: query || basename(requested),
    };
  }
}

function publicWorkspace(workspace) {
  if (!workspace) return null;
  return {
    workspace_id: workspace.workspace_id || "",
    device_id: workspace.device_id || "",
    display_name: workspace.display_name || "",
    path: workspace.canonical_path || "",
    canonical_path: workspace.canonical_path || "",
    repo_root: workspace.repo_root || "",
    trusted: workspace.trusted === true,
  };
}

export async function browseAgentWorkspaces({
  path = "",
  query = "",
  limit = DEFAULT_LIMIT,
  catalog = null,
  deviceId = "",
} = {}) {
  const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const location = await resolveBrowseLocation(path, query);
  const prefix = location.prefix.toLocaleLowerCase();
  const showHidden = prefix.startsWith(".");
  const children = await readdir(location.currentPath, { withFileTypes: true });
  const entries = [];
  for (const child of children) {
    if (!showHidden && child.name.startsWith(".")) continue;
    if (prefix && !child.name.toLocaleLowerCase().startsWith(prefix)) continue;
    const candidate = join(location.currentPath, child.name);
    try {
      if (!child.isDirectory()) {
        const info = await stat(candidate);
        if (!info.isDirectory()) continue;
      }
      const canonicalPath = await realpath(candidate);
      const workspace = catalog?.getWorkspace(canonicalPath, { deviceId });
      entries.push({
        name: child.name,
        path: canonicalPath,
        trusted: workspace?.trusted === true,
        workspace_id: workspace?.workspace_id || "",
        repo_root: workspace?.repo_root || "",
      });
    } catch {
      // A single unreadable or disappearing child must not break the page.
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
  const currentWorkspace = catalog?.getWorkspace(location.currentPath, { deviceId });
  const parent = dirname(location.currentPath);
  const pageEntries = entries.slice(0, normalizedLimit);
  // Bridge control messages are capped at 128 KiB. Very deep paths can make
  // an otherwise small directory page exceed that limit, so trim whole rows
  // rather than truncating paths into unusable values.
  while (
    pageEntries.length > 1
    && Buffer.byteLength(JSON.stringify(pageEntries), "utf8") > 96 * 1024
  ) {
    pageEntries.pop();
  }
  return {
    current_path: location.currentPath,
    parent_path: parent === location.currentPath ? "" : parent,
    query: location.prefix,
    current_workspace: publicWorkspace(currentWorkspace),
    entries: pageEntries,
    truncated: entries.length > pageEntries.length,
  };
}
