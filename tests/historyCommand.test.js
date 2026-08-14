import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { printHistoryResult, queryAccountHistory } from "../src/commands/history.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

test("account history uses the Memory audience and forwards cross-device scope", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-history-"));
  const previousBase = process.env.ORIGINROUTER_MEMORY_BASE_URL;
  try {
    process.env.ORIGINROUTER_MEMORY_BASE_URL = "https://memory.example.test";
    writeCodingAuth(stateDir, makeOAuthCredential());
    let request;
    const bundle = await queryAccountHistory({
      query: "Which task changed the login callback?",
      scope: { device_ids: ["device-remote"], agent_types: ["codex"] },
      topK: 5,
      stateDir,
      fetchFn: async (url, init) => {
        request = { url: String(url), init };
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              code: "ok",
              data: {
                evidence_bundle: {
                  domain: "agent_activity",
                  evidence: [{ source_id: "conversation-1" }],
                },
              },
            };
          },
        };
      },
    });

    assert.equal(request.url, "https://memory.example.test/v2/inquiries/agent-activity/query");
    assert.equal(request.init.headers.Authorization, "Bearer or_at_memory_test");
    const body = JSON.parse(request.init.body);
    assert.equal(body.query, "Which task changed the login callback?");
    assert.deepEqual(body.scope, {
      device_ids: ["device-remote"],
      agent_types: ["codex"],
    });
    assert.equal(body.top_k, 5);
    assert.equal(bundle.evidence[0].source_id, "conversation-1");
  } finally {
    if (previousBase == null) delete process.env.ORIGINROUTER_MEMORY_BASE_URL;
    else process.env.ORIGINROUTER_MEMORY_BASE_URL = previousBase;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("account history lazily acquires a missing Memory audience token", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-history-legacy-"));
  const previousBase = process.env.ORIGINROUTER_MEMORY_BASE_URL;
  try {
    process.env.ORIGINROUTER_MEMORY_BASE_URL = "https://memory.example.test";
    const legacy = makeOAuthCredential();
    delete legacy.accessTokens.memory;
    writeCodingAuth(stateDir, legacy);
    const calls = [];
    await queryAccountHistory({
      query: "provider reconnect",
      stateDir,
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).includes("/api/oauth/token")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                access_token: "or_at_memory_fresh",
                refresh_token: "or_rt_memory_rotated",
                expires_in: 600,
                refresh_expires_in: 2592000,
                scope: "memory.read",
              };
            },
          };
        }
        assert.equal(init.headers.Authorization, "Bearer or_at_memory_fresh");
        return {
          ok: true,
          status: 200,
          async json() {
            return { code: "ok", data: { evidence_bundle: { evidence: [] } } };
          },
        };
      },
    });
    const refreshBody = new URLSearchParams(calls[0].init.body);
    assert.equal(refreshBody.get("resource"), "originrouter.memory");
    assert.equal(calls.length, 2);
  } finally {
    if (previousBase == null) delete process.env.ORIGINROUTER_MEMORY_BASE_URL;
    else process.env.ORIGINROUTER_MEMORY_BASE_URL = previousBase;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("history display uses calibrated confidence labels instead of raw percentages", () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    printHistoryResult("provider overlay", {
      evidence: [{
        title: "Provider button styling",
        occurred_at: "2026-08-12T00:00:00Z",
        source_id: "conversation-1",
        metadata: {
          confidence_level: "high",
          matched_excerpt: "Provider button overlay",
        },
      }],
    });
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((line) => line.includes("high confidence")));
  assert.ok(lines.every((line) => !line.includes("%")));
});
