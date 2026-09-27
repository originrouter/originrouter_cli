import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apiTokenPath, ensureApiToken } from "../src/persistence/authToken.js";
import { requireAuth } from "../src/local/localApiHttp.js";

test("Local API reads the bearer token from an absolute native path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "用户 O'Brien & state");
  const token = ensureApiToken(stateDir);
  const ctx = { apiTokenPath: apiTokenPath(stateDir) };
  const req = { method: "GET", url: "/local/status", headers: { authorization: `Bearer ${token}` } };
  // On Windows this path contains backslashes. A slash-only dirname reader
  // searches the current directory and incorrectly returns HTTP 503.
  assert.deepEqual(requireAuth(req, ctx), { ok: true });
  assert.deepEqual(requireAuth({ ...req, method: "POST", url: "/local/pair/tickets" }, ctx), { ok: true });
  assert.equal(requireAuth({ ...req, headers: {} }, ctx).status, 401);
  assert.equal(requireAuth({ ...req, headers: { authorization: `Bearer ${'f'.repeat(64)}` } }, ctx).status, 401);
  assert.equal(requireAuth(req, { apiTokenPath: apiTokenPath(join(root, "missing")) }).status, 503);
});
