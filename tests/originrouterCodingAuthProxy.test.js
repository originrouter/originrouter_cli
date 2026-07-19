import assert from "node:assert/strict";
import test from "node:test";

import {
  OriginRouterCodingAuthProxy,
  protectOriginrouterCodingEnv,
} from "../src/runtime/originrouterCodingAuthProxy.js";

function credential(token) {
  return {
    kind: "oauth",
    clientId: "originrouter_cli",
    source: "originrouter_cli",
    deviceId: "device-test",
    sessionId: "or_ses_test",
    refreshToken: "or_rt_test",
    refreshExpiresAt: Date.now() + 60_000,
    tokenEndpoint: "https://surety.example/api/oauth/token",
    revocationEndpoint: "https://surety.example/api/oauth/revoke",
    accessTokens: {
      coding: {
        token,
        expiresAt: Date.now() + 600_000,
        scopes: ["coding.invoke"],
      },
    },
  };
}

async function localRequest(proxy, path, { method = "POST", body = "{}", token } = {}) {
  const status = proxy.status();
  return fetch(`http://${status.host}:${status.port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token || status.localToken}`,
    },
    body: method === "GET" ? undefined : body,
  });
}

test("coding auth proxy forwards all supported routes with a managed token", async () => {
  const calls = [];
  const proxy = new OriginRouterCodingAuthProxy({
    stateDir: "/tmp/originrouter-test",
    ensureFreshAccessTokenFn: async () => credential("or_at_managed"),
    fetchFn: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await proxy.start();
  try {
    for (const path of [
      "/coding/v1/messages",
      "/coding/v1/chat/completions",
      "/coding/v1/responses",
    ]) {
      const response = await localRequest(proxy, path);
      assert.equal(response.status, 200);
    }
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.easytransnote.com/coding/v1/messages",
      "https://api.easytransnote.com/coding/v1/chat/completions",
      "https://api.easytransnote.com/coding/v1/responses",
    ]);
    for (const call of calls) {
      assert.equal(call.options.headers.Authorization, "Bearer or_at_managed");
      assert.equal(call.options.headers["x-api-key"], undefined);
      assert.ok(!JSON.stringify(call.options.headers).includes(proxy.localToken));
    }
  } finally {
    await proxy.stop();
  }
});

test("coding auth proxy rejects callers without the per-session credential", async () => {
  let upstreamCalls = 0;
  const proxy = new OriginRouterCodingAuthProxy({
    stateDir: "/tmp/originrouter-test",
    ensureFreshAccessTokenFn: async () => credential("or_at_managed"),
    fetchFn: async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });
  await proxy.start();
  try {
    const response = await localRequest(proxy, "/coding/v1/messages", {
      token: "or_local_wrong",
    });
    assert.equal(response.status, 401);
    assert.equal(upstreamCalls, 0);
  } finally {
    await proxy.stop();
  }
});

test("coding auth proxy refreshes once and retries an upstream 401", async () => {
  const refreshOptions = [];
  const upstreamTokens = [];
  let upstreamCalls = 0;
  const proxy = new OriginRouterCodingAuthProxy({
    stateDir: "/tmp/originrouter-test",
    ensureFreshAccessTokenFn: async (options) => {
      refreshOptions.push(options);
      return credential(options.forceRefresh ? "or_at_second" : "or_at_first");
    },
    fetchFn: async (_url, options) => {
      upstreamCalls += 1;
      upstreamTokens.push(options.headers.Authorization);
      return new Response('{"ok":true}', {
        status: upstreamCalls === 1 ? 401 : 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await proxy.start();
  try {
    const response = await localRequest(proxy, "/coding/v1/messages");
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamTokens, ["Bearer or_at_first", "Bearer or_at_second"]);
    const forced = refreshOptions.filter((options) => options.forceRefresh);
    assert.equal(forced.length, 1);
    assert.equal(forced[0].staleToken, "or_at_first");
  } finally {
    await proxy.stop();
  }
});

test("a long-running session resolves a fresh token before every turn", async () => {
  let phase = "before-expiry";
  const upstreamTokens = [];
  const proxy = new OriginRouterCodingAuthProxy({
    stateDir: "/tmp/originrouter-test",
    ensureFreshAccessTokenFn: async () => credential(
      phase === "before-expiry" ? "or_at_before_expiry" : "or_at_after_refresh"
    ),
    fetchFn: async (_url, options) => {
      upstreamTokens.push(options.headers.Authorization);
      return new Response("{}", { status: 200 });
    },
  });
  await proxy.start();
  try {
    let response = await localRequest(proxy, "/coding/v1/messages");
    assert.equal(response.status, 200);
    phase = "after-expiry";
    response = await localRequest(proxy, "/coding/v1/messages");
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamTokens, [
      "Bearer or_at_before_expiry",
      "Bearer or_at_after_refresh",
    ]);
  } finally {
    await proxy.stop();
  }
});

test("runtime env exposes only a loopback capability, never the OAuth token", async () => {
  const fakeProxy = {
    async start() {
      return {
        state: "running",
        host: "127.0.0.1",
        port: 43123,
        localToken: "or_local_capability",
      };
    },
    async stop() {},
  };
  const base = {
    source: "originrouter-coding",
    provider: { type: "originrouter" },
    env: {
      ANTHROPIC_BASE_URL: "https://api.easytransnote.com/coding",
      ANTHROPIC_API_KEY: "or_at_must_not_escape",
      ANTHROPIC_MODEL: "model-a",
    },
  };
  const claude = await protectOriginrouterCodingEnv("claude", base, {
    stateDir: "/tmp/originrouter-test",
    proxyFactory: () => fakeProxy,
  });
  assert.equal(claude.providerResult.env.ANTHROPIC_API_KEY, "");
  assert.equal(claude.providerResult.env.ANTHROPIC_AUTH_TOKEN, "or_local_capability");
  assert.equal(claude.providerResult.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43123/coding");
  assert.ok(!JSON.stringify(claude.providerResult.env).includes("or_at_must_not_escape"));
  const childEnv = {
    ANTHROPIC_API_KEY: "sk-ant-stale-shell-key",
    ...claude.providerResult.env,
  };
  assert.equal(childEnv.ANTHROPIC_API_KEY, "");

  const codex = await protectOriginrouterCodingEnv("codex", {
    ...base,
    env: {
      OPENAI_BASE_URL: "https://api.easytransnote.com/coding/v1",
      OPENAI_API_KEY: "or_at_must_not_escape",
      OPENAI_MODEL: "model-b",
    },
  }, {
    stateDir: "/tmp/originrouter-test",
    proxyFactory: () => fakeProxy,
  });
  assert.equal(codex.providerResult.env.OPENAI_API_KEY, "or_local_capability");
  assert.equal(codex.providerResult.env.OPENAI_BASE_URL, "http://127.0.0.1:43123/coding/v1");
  assert.ok(!JSON.stringify(codex.providerResult.env).includes("or_at_must_not_escape"));
});
