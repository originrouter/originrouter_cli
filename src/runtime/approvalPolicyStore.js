import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { ensureStateDir } from "../persistence/state.js";
import {
  approvalPolicyRevision,
  compileApprovalPolicy,
  protectedApprovalPolicy,
} from "./approvalPolicy.js";

const POLICY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function approvalPolicyDirectory(stateDir = ensureStateDir()) {
  return path.join(stateDir, "policies");
}

function safePolicyId(value) {
  const id = String(value || "").trim();
  if (!POLICY_ID.test(id)) {
    const error = new Error("invalid approval policy id");
    error.code = "APPROVAL_POLICY_ID_INVALID";
    throw error;
  }
  return id;
}

export function approvalPolicyPath(policyId, stateDir = ensureStateDir()) {
  return path.join(approvalPolicyDirectory(stateDir), `${safePolicyId(policyId)}.json`);
}

function approvalPolicyHistoryDirectory(policyId, stateDir = ensureStateDir()) {
  return path.join(approvalPolicyDirectory(stateDir), ".history", safePolicyId(policyId));
}

function persistApprovalPolicyRevision(compiled, stateDir) {
  const directory = approvalPolicyHistoryDirectory(compiled.policy.id, stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filePath = path.join(directory, `${compiled.revision}.json`);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `${JSON.stringify(compiled.policy, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(filePath, 0o600);
  }
  const entries = readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => ({
      name,
      modifiedAt: statSync(path.join(directory, name)).mtimeMs,
    }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const entry of entries.slice(20)) unlinkSync(path.join(directory, entry.name));
}

export function listApprovalPolicyRevisions(policyId, {
  stateDir = ensureStateDir(),
} = {}) {
  const id = safePolicyId(policyId);
  const directory = approvalPolicyHistoryDirectory(id, stateDir);
  if (!existsSync(directory)) return [];
  let currentRevision = null;
  const currentPath = approvalPolicyPath(id, stateDir);
  if (existsSync(currentPath)) {
    try {
      currentRevision = approvalPolicyRevision(readJson(currentPath));
    } catch {}
  }
  return readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      const filePath = path.join(directory, name);
      const compiled = compileApprovalPolicy(readJson(filePath));
      return {
        ...summary(compiled, "history", filePath),
        modifiedAt: new Date(statSync(filePath).mtimeMs).toISOString(),
        current: compiled.revision === currentRevision,
      };
    })
    .sort((left, right) => (
      Number(right.current) - Number(left.current)
      || right.modifiedAt.localeCompare(left.modifiedAt)
    ));
}

export function rollbackApprovalPolicy(policyId, revision, {
  stateDir = ensureStateDir(),
  expectedRevision = null,
} = {}) {
  const id = safePolicyId(policyId);
  const normalizedRevision = String(revision || "").replace(/^sha256:/, "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalizedRevision)) {
    const error = new Error("invalid approval policy revision");
    error.code = "APPROVAL_POLICY_REVISION_INVALID";
    throw error;
  }
  const filePath = path.join(
    approvalPolicyHistoryDirectory(id, stateDir),
    `${normalizedRevision}.json`,
  );
  if (!existsSync(filePath)) {
    const error = new Error("approval policy revision does not exist");
    error.code = "APPROVAL_POLICY_REVISION_NOT_FOUND";
    throw error;
  }
  const policy = readJson(filePath);
  if (policy.id !== id) {
    const error = new Error("approval policy history id mismatch");
    error.code = "APPROVAL_POLICY_ID_MISMATCH";
    throw error;
  }
  return saveApprovalPolicy(policy, { stateDir, expectedRevision });
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const wrapped = new Error(`could not read approval policy: ${error.message}`);
    wrapped.code = "APPROVAL_POLICY_READ_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

function summary(compiled, source, filePath = null) {
  const policy = compiled.policy;
  return {
    id: policy.id,
    name: policy.name || policy.id,
    description: policy.description || "",
    version: policy.version,
    revision: compiled.revision,
    ruleCount: policy.rules.length,
    declarationCount: policy.declarations.length,
    source,
    path: filePath,
  };
}

export function readApprovalPolicy(policyId, {
  stateDir = ensureStateDir(),
} = {}) {
  const id = safePolicyId(policyId);
  if (id === "protected") {
    const compiled = compileApprovalPolicy(protectedApprovalPolicy());
    return { ...compiled, summary: summary(compiled, "builtin") };
  }
  const filePath = approvalPolicyPath(id, stateDir);
  if (!existsSync(filePath)) {
    const error = new Error(`approval policy ${id} does not exist`);
    error.code = "APPROVAL_POLICY_NOT_FOUND";
    throw error;
  }
  const compiled = compileApprovalPolicy(readJson(filePath));
  if (compiled.policy.id !== id) {
    const error = new Error(`approval policy id ${compiled.policy.id} does not match file ${id}`);
    error.code = "APPROVAL_POLICY_ID_MISMATCH";
    throw error;
  }
  return { ...compiled, summary: summary(compiled, "device", filePath) };
}

export function readApprovalPolicyReference(reference, {
  stateDir = ensureStateDir(),
} = {}) {
  const value = String(reference || "").trim();
  if (!value) return null;
  if (POLICY_ID.test(value)) return readApprovalPolicy(value, { stateDir });
  const filePath = path.resolve(value);
  if (!existsSync(filePath)) {
    const error = new Error(`approval policy file does not exist: ${filePath}`);
    error.code = "APPROVAL_POLICY_NOT_FOUND";
    throw error;
  }
  const compiled = compileApprovalPolicy(readJson(filePath));
  return { ...compiled, summary: summary(compiled, "file", filePath) };
}

export function deployApprovalPolicyBundle(bundle, {
  stateDir = ensureStateDir(),
} = {}) {
  const value = bundle?.content || bundle?.policy || bundle;
  const compiled = compileApprovalPolicy(value);
  const claimedId = String(bundle?.id || bundle?.policyId || bundle?.policy_id || "").trim();
  if (claimedId && claimedId !== compiled.policy.id) {
    const error = new Error("deployed approval policy id does not match its content");
    error.code = "APPROVAL_POLICY_ID_MISMATCH";
    throw error;
  }
  const claimedRevision = String(bundle?.revision || bundle?.policyRevision || bundle?.policy_revision || "").replace(/^sha256:/, "").trim();
  if (claimedRevision && claimedRevision !== compiled.revision) {
    const error = new Error("deployed approval policy revision does not match its content");
    error.code = "APPROVAL_POLICY_REVISION_MISMATCH";
    throw error;
  }
  return saveApprovalPolicy(compiled.policy, {
    stateDir,
    expectedRevision: bundle?.expectedRevision || bundle?.expected_revision || null,
  });
}

export function resolveApprovalPolicySelection(payload = {}, {
  stateDir = ensureStateDir(),
  current = null,
} = {}) {
  const bundle = payload.policyBundle || payload.policy_bundle;
  let selected = bundle ? deployApprovalPolicyBundle(bundle, { stateDir }) : null;
  const policyId = String(payload.policyId || payload.policy_id || "").trim();
  if (!selected && policyId) selected = readApprovalPolicy(policyId, { stateDir });
  if (!selected && payload.policyReference) {
    selected = readApprovalPolicyReference(payload.policyReference, { stateDir });
  }
  if (!selected) selected = current;
  const expectedRevision = String(payload.policyRevision || payload.policy_revision || "").replace(/^sha256:/, "").trim();
  if (selected && expectedRevision && selected.revision !== expectedRevision) {
    const error = new Error("approval policy revision is not installed on this device");
    error.code = "APPROVAL_POLICY_REVISION_NOT_FOUND";
    error.currentRevision = selected.revision;
    throw error;
  }
  return selected;
}

export function listApprovalPolicies({ stateDir = ensureStateDir() } = {}) {
  const result = [readApprovalPolicy("protected", { stateDir }).summary];
  const directory = approvalPolicyDirectory(stateDir);
  if (!existsSync(directory)) return result;
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try {
      result.push(readApprovalPolicy(id, { stateDir }).summary);
    } catch (error) {
      result.push({
        id,
        name: id,
        description: "",
        version: null,
        revision: null,
        ruleCount: 0,
        declarationCount: 0,
        source: "invalid",
        path: path.join(directory, name),
        error: error.message,
      });
    }
  }
  return result;
}

export function saveApprovalPolicy(rawPolicy, {
  stateDir = ensureStateDir(),
  expectedRevision = null,
} = {}) {
  const compiled = compileApprovalPolicy(rawPolicy);
  const id = safePolicyId(compiled.policy.id);
  if (id === "protected") {
    const error = new Error("the built-in protected policy cannot be overwritten");
    error.code = "APPROVAL_POLICY_READ_ONLY";
    throw error;
  }
  const directory = approvalPolicyDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filePath = approvalPolicyPath(id, stateDir);
  if (expectedRevision != null && existsSync(filePath)) {
    const current = approvalPolicyRevision(readJson(filePath));
    if (current !== expectedRevision) {
      const error = new Error("approval policy changed on the device");
      error.code = "APPROVAL_POLICY_REVISION_CONFLICT";
      error.currentRevision = current;
      throw error;
    }
  }
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(compiled.policy, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
    persistApprovalPolicyRevision(compiled, stateDir);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { ...compiled, summary: summary(compiled, "device", filePath) };
}

export function deleteApprovalPolicy(policyId, {
  stateDir = ensureStateDir(),
  expectedRevision = null,
} = {}) {
  const id = safePolicyId(policyId);
  if (id === "protected") {
    const error = new Error("the built-in protected policy cannot be deleted");
    error.code = "APPROVAL_POLICY_READ_ONLY";
    throw error;
  }
  const filePath = approvalPolicyPath(id, stateDir);
  if (!existsSync(filePath)) return false;
  if (expectedRevision != null) {
    const current = approvalPolicyRevision(readJson(filePath));
    if (current !== expectedRevision) {
      const error = new Error("approval policy changed on the device");
      error.code = "APPROVAL_POLICY_REVISION_CONFLICT";
      error.currentRevision = current;
      throw error;
    }
  }
  unlinkSync(filePath);
  return true;
}

export function readWorkspaceApprovalPolicy(workspace, {
  trustedRevision = null,
} = {}) {
  const filePath = path.join(path.resolve(workspace), ".originrouter", "approval-policy.json");
  if (!existsSync(filePath)) return null;
  const compiled = compileApprovalPolicy(readJson(filePath));
  const trusted = trustedRevision != null && trustedRevision === compiled.revision;
  return {
    ...compiled,
    restrictionOnly: !trusted,
    summary: {
      ...summary(compiled, trusted ? "workspace_trusted" : "workspace_restriction", filePath),
      trusted,
    },
  };
}

export function readWorkspaceApprovalPolicySafe(workspace, options = {}) {
  try {
    return readWorkspaceApprovalPolicy(workspace, options);
  } catch (error) {
    const compiled = compileApprovalPolicy({
      version: 2,
      id: "invalid-workspace-policy",
      name: "Invalid workspace policy",
      defaults: { unmatched: "ask", parse_error: "ask", unknown: "ask" },
      rules: [{
        id: "ask-until-workspace-policy-is-fixed",
        effect: "ask",
        actions: ["*"],
        reason: "The workspace approval policy could not be validated.",
      }],
    });
    return {
      ...compiled,
      restrictionOnly: false,
      summary: {
        ...summary(compiled, "workspace_invalid"),
        trusted: false,
        error: error.message,
      },
    };
  }
}

export function combineApprovalPolicyEffects(results) {
  const entries = results.filter(Boolean);
  if (!entries.length) return "ask";
  if (entries.some((item) => item.effect === "deny")) return "deny";
  if (entries.some((item) => item.effect === "ask")) return "ask";
  return "allow";
}

export function restrictWorkspacePolicyResult(result) {
  if (!result) return result;
  if (result.effect !== "allow") return result;
  return {
    ...result,
    effect: "neutral",
    restrictionOnly: true,
  };
}
