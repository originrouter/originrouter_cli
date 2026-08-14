import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeRuntimeOperation } from "../src/runtime/operationRisk.js";

const session = { sessionId: "risk-1", cwd: "/workspace/project", agent: "claude" };
const operation = (tool, input) => analyzeRuntimeOperation(session, {
  type: "agent.tool_call.start", callId: `${tool}-1`, tool, input,
});

const tempMove = operation("Bash", { command: "mv /tmp/a /tmp/b", cwd: session.cwd });
assert.equal(tempMove.shouldRecord, false);
assert.equal(tempMove.needsAiReview, true);
assert.equal(tempMove.deterministic.tempOnly, true);

const secretRead = operation("Read", { file_path: "/Users/alice/.ssh/id_ed25519" });
assert.equal(secretRead.needsAiReview, true);
assert.equal(secretRead.shouldRecord, true);
assert.equal(secretRead.risk, "elevated");
assert.equal(secretRead.deterministic.credentialAssociated, true);

const tempWrite = operation("Write", { file_path: "/tmp/build.log", content: "ok" });
assert.equal(tempWrite.shouldRecord, false);
assert.equal(tempWrite.needsAiReview, true);

const workflowWrite = operation("Write", {
  file_path: "/workspace/project/.github/workflows/deploy.yml",
  content: "deploy",
});
assert.equal(workflowWrite.needsAiReview, true);
assert.equal(workflowWrite.shouldRecord, true);
assert.equal(workflowWrite.risk, "elevated");

const outsideRead = operation("Read", { file_path: "/Users/alice/Documents/private.txt" });
assert.equal(outsideRead.needsAiReview, true);

const evidenceRoot = mkdtempSync(join(tmpdir(), "originrouter-risk-evidence-"));
mkdirSync(join(evidenceRoot, "src"));
writeFileSync(join(evidenceRoot, "src", "config.js"), "const token = 'secret-value';\nexport const mode = 'prod';\n");
const evidenceSession = { ...session, cwd: evidenceRoot };
const writeEvidence = analyzeRuntimeOperation(evidenceSession, {
  type: "agent.tool_call.start", callId: "write-evidence", tool: "Write",
  input: { file_path: join(evidenceRoot, "src", "config.js"), content: "api_key=abcd1234\nmode=test" },
});
assert.equal(writeEvidence.content_evidence.exists, true);
assert.equal(writeEvidence.content_evidence.overwrite, true);
assert.match(writeEvidence.content_evidence.write_excerpt, /\[redacted\]/);
assert.ok(writeEvidence.content_evidence.write_excerpt.length <= 1400);

const secretEvidence = analyzeRuntimeOperation(evidenceSession, {
  type: "agent.tool_call.start", callId: "secret-evidence", tool: "Read",
  input: { file_path: "/Users/alice/.ssh/id_ed25519" },
});
assert.equal(secretEvidence.content_evidence.credential_detected, true);
assert.equal(secretEvidence.content_evidence.content_omitted, true);
assert.equal(secretEvidence.content_evidence.read_excerpt, undefined);

console.log("operation risk tests passed");
