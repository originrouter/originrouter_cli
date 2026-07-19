import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCodingAuth, writeCodingAuth } from "../src/persistence/codingAuth.js";
import { ensureFreshAccessToken } from "../src/runtime/oauthTokenRefresher.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

function expiredCodingCredential(overrides = {}) {
  return makeOAuthCredential({
    ...overrides,
    accessTokens: {
      coding: {
        token: "or_at_coding_expired",
        expiresAt: Date.now() - 1_000,
        scopes: ["coding.invoke"],
      },
      ...(overrides.accessTokens || {}),
    },
  });
}

test("refresh rotates RT and replaces only the requested audience token", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential());
    let body;
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      fetchFn: async (_url, init) => {
        body = new URLSearchParams(init.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "or_at_coding_fresh",
              refresh_token: "or_rt_rotated",
              expires_in: 600,
              refresh_expires_in: 2_592_000,
              scope: "coding.invoke",
            };
          },
        };
      },
    });
    assert.equal(body.get("refresh_token"), "or_rt_test_refresh");
    assert.equal(body.get("resource"), "originrouter.coding");
    assert.equal(updated.refreshToken, "or_rt_rotated");
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_fresh");
    assert.equal(updated.accessTokens.control.token, "or_at_control_test");
    assert.equal(readCodingAuth(stateDir).refreshToken, "or_rt_rotated");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("refresh lock prevents concurrent RT reuse", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-race-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential());
    let refreshCalls = 0;
    const fetchFn = async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "or_at_coding_once",
            refresh_token: "or_rt_once",
            expires_in: 600,
            refresh_expires_in: 2_592_000,
            scope: "coding.invoke",
          };
        },
      };
    };
    const [first, second] = await Promise.all([
      ensureFreshAccessToken({ stateDir, resource: "originrouter.coding", fetchFn }),
      ensureFreshAccessToken({ stateDir, resource: "originrouter.coding", fetchFn }),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.refreshToken, "or_rt_once");
    assert.equal(second.refreshToken, "or_rt_once");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("expired refresh session is rejected before network access", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-expired-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential({
      refreshExpiresAt: Date.now() - 1,
    }));
    let fetched = false;
    await assert.rejects(
      () => ensureFreshAccessToken({
        stateDir,
        resource: "originrouter.coding",
        fetchFn: async () => { fetched = true; },
      }),
      (error) => error.code === "OAUTH_REFRESH_EXPIRED",
    );
    assert.equal(fetched, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("custom headroom refreshes a token before a long-running request starts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-headroom-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential({
      accessTokens: {
        coding: {
          token: "or_at_coding_near_expiry",
          expiresAt: Date.now() + 90_000,
          scopes: ["coding.invoke"],
        },
      },
    }));
    let refreshCalls = 0;
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      headroomMs: 120_000,
      fetchFn: async () => {
        refreshCalls += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "or_at_coding_headroom_fresh",
              refresh_token: "or_rt_headroom_rotated",
              expires_in: 600,
              refresh_expires_in: 2_592_000,
              scope: "coding.invoke",
            };
          },
        };
      },
    });
    assert.equal(refreshCalls, 1);
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_headroom_fresh");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("forced refresh reuses a token already rotated by another request", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-stale-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential({
      accessTokens: {
        coding: {
          token: "or_at_coding_already_rotated",
          expiresAt: Date.now() + 600_000,
          scopes: ["coding.invoke"],
        },
      },
    }));
    let refreshCalls = 0;
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      forceRefresh: true,
      staleToken: "or_at_coding_previous",
      fetchFn: async () => {
        refreshCalls += 1;
        throw new Error("must not refresh twice");
      },
    });
    assert.equal(refreshCalls, 0);
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_already_rotated");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
