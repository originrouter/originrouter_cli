import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPROVAL_POLICY_ACTIONS,
  approvalPolicyRevision,
  atomizeApprovalRequest,
  compileApprovalPolicy,
  evaluateApprovalCondition,
  evaluateApprovalRequest,
  matchesApprovalGlob,
  protectedApprovalPolicy,
  validateApprovalPolicy,
} from "../src/runtime/approvalPolicy.js";
import {
  deleteApprovalPolicy,
  listApprovalPolicies,
  readApprovalPolicy,
  readWorkspaceApprovalPolicy,
  saveApprovalPolicy,
} from "../src/runtime/approvalPolicyStore.js";

const permission = (tool, payload = {}, extra = {}) => ({
  provider: "claude",
  runtime: "claude-sdk",
  source: "hook",
  kind: "permission",
  payload: { tool, ...payload },
  containsSecret: false,
  ...extra,
});

function policy(rules, extra = {}) {
  return {
    version: 1,
    id: "test-policy",
    defaults: { unmatched: "ask", parse_error: "ask", unknown: "ask" },
    rules,
    ...extra,
  };
}

test("approval policy revisions use recursive canonical JSON", () => {
  const first = compileApprovalPolicy({
    rules: [
      { actions: ["fs.read"], effect: "allow", id: "read" },
      { id: "disabled", effect: "deny", actions: ["fs.delete"], enabled: false },
    ],
    id: "parity-policy",
    version: 1,
  });
  assert.equal(
    first.revision,
    "be0ffcab1cbe29917dd40d5e8d2280700128d95aecb3cfb412756b41a5f97a4b",
  );
  assert.equal(
    approvalPolicyRevision({ b: { d: 2, c: 1 }, a: true }),
    approvalPolicyRevision({ a: true, b: { c: 1, d: 2 } }),
  );
});

test("published schema contains the complete CLI atomic action registry", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../schemas/approval-policy-v1.schema.json", import.meta.url),
    "utf8",
  ));
  const schemaActions = schema.$defs.atom.properties.action.enum;
  assert.deepEqual(schemaActions.slice().sort(), APPROVAL_POLICY_ACTIONS.slice().sort());
});

test("approval policy validation rejects typos and unsafe expression shapes", () => {
  const invalid = validateApprovalPolicy({
    version: 1,
    id: "Bad ID",
    defaults: { unmatched: "maybe", typo: "ask" },
    rules: [{ id: "allow", effect: "allow", when: { field: "command.raw", op: "regex", value: ".*" } }],
    surprise: true,
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((item) => item.path === "$.id"));
  assert.ok(invalid.errors.some((item) => item.path === "$.rules[0].when.op"));
  assert.ok(invalid.errors.some((item) => item.path === "$.surprise"));
});

test("glob and boolean conditions are deterministic", () => {
  assert.equal(matchesApprovalGlob("fs.write", "fs.*"), true);
  assert.equal(matchesApprovalGlob("src/nested/app.js", "src/**"), true);
  assert.equal(matchesApprovalGlob("src/nested/app.js", "src/*"), false);
  const atom = {
    action: "process.exec",
    command: { executable: "npm", argv: ["run", "test"], cwd: "/tmp/project" },
  };
  assert.equal(evaluateApprovalCondition({
    all: [
      { field: "command.executable", op: "eq", value: "npm" },
      { field: "command.argv", op: "contains_all", value: ["run", "test"] },
      { not: { field: "command.raw", op: "contains", value: "sudo" } },
    ],
  }, atom, { workspace: "/tmp/project" }), true);
});

test("compound shell requests require every atom to be allowed", () => {
  const result = evaluateApprovalRequest(
    permission("Bash", { command: "cat app.log | grep ERROR > report.txt", cwd: "/tmp/project" }),
    policy([
      { id: "allow-process", effect: "allow", actions: ["process.exec"] },
      { id: "allow-read", effect: "allow", actions: ["fs.read", "fs.search"] },
    ]),
    { workspace: "/tmp/project" },
  );
  assert.equal(result.effect, "ask", "unmatched output write must ask");
  assert.ok(result.atoms.some((atom) => atom.action === "fs.write"));
});

test("deny rules override allows", () => {
  const result = evaluateApprovalRequest(
    permission("Bash", { command: "rm -rf build", cwd: "/tmp/project" }),
    policy([
      { id: "allow-process", effect: "allow", actions: ["process.exec", "fs.*"] },
      { id: "deny-delete", effect: "deny", actions: ["fs.delete"] },
    ]),
    { workspace: "/tmp/project" },
  );
  assert.equal(result.effect, "deny");
  assert.ok(result.decisions.some((item) => item.matchedRules.some((rule) => rule.id === "deny-delete")));
});

test("SQL statements are decomposed and unknown statements ask", () => {
  const request = permission("sql", {
    query: "SELECT * FROM users; DELETE FROM sessions WHERE expired = 1",
    engine: "postgres",
    database: "app",
  });
  const normalized = atomizeApprovalRequest(request, { workspace: "/tmp/project" });
  assert.deepEqual(normalized.atoms.map((atom) => atom.action), ["db.read", "db.delete"]);
  const result = evaluateApprovalRequest(request, policy([
    { id: "allow-read", effect: "allow", actions: ["db.read"] },
    { id: "deny-delete", effect: "deny", actions: ["db.delete"] },
  ]), { workspace: "/tmp/project" });
  assert.equal(result.effect, "deny");
});

test("opaque Python requires a matching declaration before it can be fully allowed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "originrouter-policy-python-"));
  try {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "report.py"), "print('report')\n");
    const request = permission("Bash", { command: "python scripts/report.py", cwd: root });
    const withoutDeclaration = evaluateApprovalRequest(request, policy([
      { id: "allow-process", effect: "allow", actions: ["process.exec", "code.python.execute"] },
    ]), { workspace: root });
    assert.equal(withoutDeclaration.effect, "ask");
    const hash = atomizeApprovalRequest(request, { workspace: root }).atoms
      .find((atom) => atom.action === "code.python.execute").code.sha256;
    const withDeclaration = evaluateApprovalRequest(request, policy([
      { id: "allow-process", effect: "allow", actions: ["process.exec", "code.python.execute", "fs.read", "fs.write"] },
    ], {
      declarations: [{
        id: "report-script",
        replaces_opaque: true,
        match: {
          all: [
            { field: "code.script", op: "path_equals", value: "${workspace}/scripts/report.py" },
            { field: "code.sha256", op: "eq", value: hash },
          ],
        },
        emits: [
          { action: "fs.read", resource: { kind: "path", path: "${workspace}/data" } },
          { action: "fs.write", resource: { kind: "path", path: "${workspace}/reports" } },
        ],
      }],
    }), { workspace: root });
    assert.equal(withDeclaration.effect, "allow");
    assert.deepEqual(withDeclaration.declarations, ["report-script"]);
    assert.equal(withDeclaration.atoms.some((atom) => atom.action === "code.opaque"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected policy permits routine workspace access but asks for deletes", () => {
  const compiled = compileApprovalPolicy(protectedApprovalPolicy());
  assert.equal(evaluateApprovalRequest(permission("Read", { tool_input: { file_path: "src/app.js" } }), compiled, { workspace: "/tmp/project" }).effect, "allow");
  assert.equal(evaluateApprovalRequest(permission("Bash", { command: "rm -rf build", cwd: "/tmp/project" }), compiled, { workspace: "/tmp/project" }).effect, "ask");
});

test("policy store uses private files, revisions, and restriction-only workspace policies", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "originrouter-policy-store-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "originrouter-policy-workspace-"));
  try {
    const saved = saveApprovalPolicy(policy([{ id: "allow-read", effect: "allow", actions: ["fs.read"] }]), { stateDir });
    assert.equal(saved.summary.source, "device");
    assert.equal(readApprovalPolicy("test-policy", { stateDir }).revision, saved.revision);
    assert.ok(listApprovalPolicies({ stateDir }).some((item) => item.id === "protected"));
    assert.throws(() => saveApprovalPolicy({ ...policy([]), name: "changed" }, {
      stateDir,
      expectedRevision: "stale",
    }), (error) => error.code === "APPROVAL_POLICY_REVISION_CONFLICT");
    mkdirSync(path.join(workspace, ".originrouter"));
    writeFileSync(path.join(workspace, ".originrouter", "approval-policy.json"), JSON.stringify(policy([
      { id: "deny-push", effect: "deny", actions: ["vcs.remote.write"] },
    ])));
    const workspacePolicy = readWorkspaceApprovalPolicy(workspace);
    assert.equal(workspacePolicy.restrictionOnly, true);
    assert.equal(deleteApprovalPolicy("test-policy", { stateDir, expectedRevision: saved.revision }), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
