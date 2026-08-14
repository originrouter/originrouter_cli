import path from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { atomizeApprovalRequest } from "./approvalPolicy.js";

const HARD_HIGH_ACTIONS = new Set([
  "secret.input", "fs.delete", "fs.permissions.write", "vcs.destructive",
  "vcs.remote.write", "network.transfer.upload", "db.delete",
  "db.schema.alter", "db.schema.drop", "db.admin", "system.service.manage",
  "system.identity.manage", "system.schedule.manage", "system.storage.manage",
  "infra.write", "infra.destroy", "package.publish",
]);
const AMBIGUOUS_ACTIONS = new Set([
  "fs.write", "fs.patch", "fs.copy", "fs.move", "network.http.write",
  "db.update", "package.install", "package.remove", "process.opaque",
  "code.opaque", "shell.dynamic", "tool.unknown", "fs.unknown", "db.unknown",
]);
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts|shadow|passwd)$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config\/gcloud|secrets?|credentials?)(?:\/|$)/i;
const CONTROL_PATH = /(?:^|\/)(?:\.github\/workflows|\.gitlab-ci\.yml|Jenkinsfile|Dockerfile|docker-compose[^/]*|compose\.ya?ml|terraform|k8s|kubernetes|deploy|production|prod)(?:\/|$)/i;

function safeText(value, max = 4096) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function displayCommand(value) {
  return safeText(value, 4096)
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s'\";]+/gi, "$1[redacted]")
    .replace(/\b(sk-[a-z0-9_-]{12,}|or_(?:at|rt|lk)_[a-z0-9_-]{12,})\b/gi, "[redacted]");
}

function redactContent(value, max = 4000) {
  return safeText(value, max * 2)
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gi, "[credential material redacted]")
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key|cookie)\s*[=:]\s*)[^\s'\";,]+/gi, "$1[redacted]")
    .replace(/\b(sk-[a-z0-9_-]{12,}|or_(?:at|rt|lk)_[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,})\b/gi, "[redacted]")
    .slice(0, max);
}

function resolvePath(candidate, workspace) {
  const value = safeText(candidate, 4096);
  if (!value || value.startsWith("~") || value.startsWith("$")) return "";
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(workspace, value);
}

function gitTracked(candidate, workspace) {
  if (!candidate || !isUnder(candidate, workspace)) return null;
  try {
    execFileSync("git", ["-C", workspace, "ls-files", "--error-unmatch", "--", path.relative(workspace, candidate)], {
      encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], timeout: 500,
    });
    return true;
  } catch {
    return false;
  }
}

function contentEvidence(input, resources, workspace) {
  const credentialDetected = resources.some((item) => item.class === "credential")
    || Object.keys(input || {}).some((key) => /token|secret|password|authorization|api[_-]?key|cookie/i.test(key));
  const primary = resources.find((item) => item.kind === "path")?.resolvedValue || "";
  let metadata = {};
  let readExcerpt = "";
  if (primary && existsSync(primary)) {
    try {
      const stat = lstatSync(primary);
      metadata = {
        exists: true,
        file_type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
        size_bytes: stat.size,
        git_tracked: gitTracked(primary, workspace),
      };
      if (stat.isFile() && stat.size <= 1024 * 1024 && !credentialDetected) {
        const content = readFileSync(primary, "utf8").slice(0, 16_000);
        metadata.line_count = content.split("\n").length;
        readExcerpt = redactContent(content, 1200);
      }
    } catch {
      metadata = { exists: true, metadata_unavailable: true };
    }
  } else if (primary) {
    metadata = { exists: false, git_tracked: gitTracked(primary, workspace) };
  }
  const writeSource = input?.content ?? input?.new_string ?? input?.newText ?? input?.text ?? "";
  const oldSource = input?.old_string ?? input?.oldText ?? "";
  return {
    credential_detected: credentialDetected,
    ...metadata,
    overwrite: Boolean(primary && existsSync(primary) && writeSource),
    content_omitted: credentialDetected,
    ...(!credentialDetected && writeSource ? { write_excerpt: redactContent(writeSource, 1400) } : {}),
    ...(!credentialDetected && oldSource ? { diff_excerpt: `- ${redactContent(oldSource, 650)}\n+ ${redactContent(writeSource, 650)}` } : {}),
    ...(!credentialDetected && readExcerpt ? { read_excerpt: readExcerpt } : {}),
  };
}

function operationRequest(session, event) {
  const input = event?.input && typeof event.input === "object" ? event.input : {};
  const tool = safeText(event?.tool || input.tool || "unknown", 128);
  return {
    kind: "permission",
    provider: safeText(session?.agent, 32),
    runtime: safeText(session?.runtime, 32),
    payload: {
      tool,
      cwd: safeText(input.cwd || session?.cwd, 4096),
      command: safeText(input.command, 32768),
      tool_input: input,
    },
  };
}

function isUnder(candidate, root) {
  if (!candidate || !root) return false;
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathClass(candidate, workspace) {
  const normalized = safeText(candidate, 4096);
  const base = path.basename(normalized);
  if (SENSITIVE_BASENAME.test(base) || SENSITIVE_PATH.test(normalized)) return "credential";
  if (CONTROL_PATH.test(normalized)) return "control_plane";
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")
    || normalized === "/private/tmp" || normalized.startsWith("/private/tmp/")) return "temporary";
  if (normalized === "/etc" || normalized.startsWith("/etc/")
    || normalized === "/System" || normalized.startsWith("/System/")
    || normalized === "/Library" || normalized.startsWith("/Library/")
    || normalized === "/usr" || normalized.startsWith("/usr/")) return "system";
  return isUnder(normalized, workspace) ? "workspace" : "outside_workspace";
}

function titleFor(actions, classes) {
  if (classes.includes("credential")) return "Sensitive data access";
  if (classes.includes("control_plane")) return "Deployment or automation change";
  if (classes.includes("system")) return "System-level operation";
  if (actions.some((item) => item.startsWith("db."))) return "Database operation";
  if (actions.some((item) => item.startsWith("network."))) return "Network operation";
  if (actions.includes("fs.delete")) return "Destructive file operation";
  if (actions.includes("fs.move")) return "File move";
  if (actions.some((item) => ["fs.write", "fs.patch", "fs.copy"].includes(item))) return "File change";
  return "Potentially sensitive operation";
}

export function analyzeRuntimeOperation(session, event) {
  const workspace = path.resolve(String(session?.cwd || process.cwd()));
  const input = event?.input && typeof event.input === "object" ? event.input : {};
  const normalized = atomizeApprovalRequest(operationRequest(session, event), { workspace });
  const atoms = normalized.atoms.filter((atom) => atom.action !== "process.exec");
  const actions = [...new Set(atoms.map((atom) => atom.action))];
  const resources = atoms.map((atom) => {
    const candidate = atom.resource?.path || atom.resource?.uri || "";
    return candidate ? {
      kind: atom.resource?.kind || "resource",
      role: atom.resource?.role || "",
      value: safeText(candidate, 4096),
      resolvedValue: resolvePath(candidate, normalized.context.workspace),
      class: atom.resource?.kind === "path" ? pathClass(candidate, normalized.context.workspace) : "remote",
      resolution: atom.resource?.path_resolution || "",
    } : null;
  }).filter(Boolean);
  const classes = [...new Set(resources.map((item) => item.class))];
  const unresolved = atoms.some((atom) => atom.confidence === "low")
    || resources.some((item) => item.resolution && item.resolution !== "canonical");
  // These are contextual signals for the AI reviewer, not verdicts. A path
  // that looks credential-related may contain a synthetic fixture; a /tmp
  // destination may still receive valuable data; and a write/delete may be
  // either routine or consequential depending on the actual task and effect.
  const credentialAssociated = classes.includes("credential");
  const capabilityHighSignal = actions.some((action) => HARD_HIGH_ACTIONS.has(action));
  // Only an explicitly atomized secret-input capability is an unconditional
  // floor. Filename/path heuristics must never create a hard-high decision.
  const hardHigh = actions.includes("secret.input");
  const tempOnly = resources.length > 0 && resources.every((item) => item.class === "temporary");
  const routineRead = actions.length > 0
    && resources.length > 0
    && resources.every((item) => item.class === "workspace")
    && actions.every((action) => ["fs.read", "fs.list", "fs.search", "vcs.read", "package.read"].includes(action));
  const routineWorkspace = resources.length > 0
    && resources.every((item) => item.class === "workspace")
    && actions.every((action) => ["fs.read", "fs.list", "fs.search", "fs.create", "fs.write", "fs.patch", "vcs.read", "vcs.write", "package.read"].includes(action));
  const ambiguous = unresolved
    || classes.includes("outside_workspace")
    || actions.some((action) => AMBIGUOUS_ACTIONS.has(action));
  // Every observable operation is eligible for semantic AI review. The AI
  // decides whether it belongs in the selective ledger; deterministic labels
  // only provide evidence and a conservative fallback when AI is exhausted.
  const needsAiReview = actions.length > 0;
  // This is only the no-AI / exhausted-AI fallback, not the semantic verdict.
  // Keep it conservative for strong unresolved or capability/target signals,
  // while routine workspace or temporary operations remain excluded offline.
  const shouldRecord = hardHigh
    || credentialAssociated
    || capabilityHighSignal
    || classes.some((item) => ["system", "control_plane", "outside_workspace"].includes(item))
    || unresolved;
  const risk = hardHigh
    ? "high"
    : (credentialAssociated || capabilityHighSignal || ambiguous) ? "elevated" : "normal";
  const reason = hardHigh
    ? "An explicit secret-input capability requires a conservative audit floor"
    : `Contextual semantic review is required; observed signals: ${[
      ...actions,
      ...classes,
      ...(unresolved ? ["unresolved_context"] : []),
    ].join(", ") || "none"}`;
  return {
    schemaVersion: 1,
    actions,
    tool: safeText(event?.tool, 128),
    command: displayCommand(event?.input?.command),
    resources: resources.map(({ resolvedValue: _, ...resource }) => resource),
    content_evidence: contentEvidence(input, resources, normalized.context.workspace),
    risk,
    reason,
    title: titleFor(actions, classes),
    shouldRecord,
    needsAiReview,
    confidence: unresolved ? 0.45 : hardHigh ? 0.95 : 0.7,
    deterministic: {
      hardHigh,
      tempOnly,
      routineRead,
      routineWorkspace,
      credentialAssociated,
      capabilityHighSignal,
      unresolved,
    },
  };
}
