// Stage 9.0: provider route resolver tests.
//
// Covers resolveRoute() in src/config/providerRoutes.js.
// Verifies:
//   - originrouter Claude -> /coding/v1/messages + real model id
//   - originrouter Codex -> /coding/v1/responses + real model id
//   - originrouter with no runtime -> defaults to /coding/v1/messages
//   - proxy Claude / Claude SDK -> /v1/messages + originrouter-claude-model
//   - proxy Claude fast -> /v1/messages + originrouter-claude-fast-model
//   - proxy Codex / Codex app-server -> /v1/responses + originrouter-codex-model
//   - remote requires deviceId
//   - remote target defaults to "proxy", can be set to "agent"
//   - unknown providerType throws
//   - DEFAULT_ORIGINROUTER_BASE_URL exported
//   - /coding prefix appears in every originrouter endpoint, never in proxy

import assert from "node:assert/strict";
import {
  DEFAULT_ORIGINROUTER_BASE_URL,
  resolveRoute,
} from "../src/config/providerRoutes.js";

const cases = [];

cases.push({
  name: "originrouter claude -> /coding/v1/messages + real model id",
  run: () => {
    const r = resolveRoute({ providerType: "originrouter", runtime: "claude", model: "claude-sonnet-4-6" });
    assert.deepEqual(r, { transport: "originrouter-coding", endpoint: "/coding/v1/messages", model: "claude-sonnet-4-6" });
  },
});

cases.push({
  name: "originrouter codex -> /coding/v1/responses + real model id",
  run: () => {
    const r = resolveRoute({ providerType: "originrouter", runtime: "codex", model: "gpt-5.1-codex" });
    assert.deepEqual(r, { transport: "originrouter-coding", endpoint: "/coding/v1/responses", model: "gpt-5.1-codex" });
  },
});

cases.push({
  name: "originrouter no runtime -> defaults to /coding/v1/messages",
  run: () => {
    const r = resolveRoute({ providerType: "originrouter" });
    assert.equal(r.transport, "originrouter-coding");
    assert.equal(r.endpoint, "/coding/v1/messages");
    assert.equal(r.model, null);
  },
});

cases.push({
  name: "originrouter codex-app-server -> /coding/v1/responses",
  run: () => {
    const r = resolveRoute({ providerType: "originrouter", runtime: "codex-app-server", model: "gpt-5-codex" });
    assert.equal(r.transport, "originrouter-coding");
    assert.equal(r.endpoint, "/coding/v1/responses");
  },
});

cases.push({
  name: "proxy claude-sdk -> /v1/messages + originrouter-claude-model",
  run: () => {
    const r = resolveRoute({ providerType: "proxy", runtime: "claude-sdk" });
    assert.deepEqual(r, { transport: "proxy", endpoint: "/v1/messages", model: "originrouter-claude-model" });
  },
});

cases.push({
  name: "proxy codex-app-server -> /v1/responses + originrouter-codex-model",
  run: () => {
    const r = resolveRoute({ providerType: "proxy", runtime: "codex-app-server" });
    assert.deepEqual(r, { transport: "proxy", endpoint: "/v1/responses", model: "originrouter-codex-model" });
  },
});

cases.push({
  name: "proxy claude-fast -> /v1/messages + originrouter-claude-fast-model",
  run: () => {
    const r = resolveRoute({ providerType: "proxy", runtime: "claude-fast" });
    assert.equal(r.endpoint, "/v1/messages");
    assert.equal(r.model, "originrouter-claude-fast-model");
  },
});

cases.push({
  name: "proxy with explicit model overrides the alias",
  run: () => {
    const r = resolveRoute({ providerType: "proxy", runtime: "claude", model: "custom-model" });
    assert.equal(r.model, "custom-model");
  },
});

cases.push({
  name: "remote with deviceId -> transport=remote, target=proxy default",
  run: () => {
    const r = resolveRoute({ providerType: "remote", deviceId: "d1" });
    assert.deepEqual(r, { transport: "remote", endpoint: null, model: null, deviceId: "d1", target: "proxy" });
  },
});

cases.push({
  name: "remote without deviceId throws",
  run: () => {
    assert.throws(
      () => resolveRoute({ providerType: "remote" }),
      /type=remote requires deviceId/,
    );
  },
});

cases.push({
  name: "remote with target=agent",
  run: () => {
    const r = resolveRoute({ providerType: "remote", deviceId: "d1", target: "agent" });
    assert.equal(r.target, "agent");
  },
});

cases.push({
  name: "unknown providerType throws",
  run: () => {
    assert.throws(
      () => resolveRoute({ providerType: "unknown" }),
      /unknown providerType/,
    );
  },
});

cases.push({
  name: "DEFAULT_ORIGINROUTER_BASE_URL is the official server",
  run: () => {
    assert.equal(DEFAULT_ORIGINROUTER_BASE_URL, "https://server.originrouter.com");
  },
});

cases.push({
  name: "/coding prefix appears in every originrouter endpoint, never in proxy",
  run: () => {
    const origins = [
      resolveRoute({ providerType: "originrouter", runtime: "claude" }),
      resolveRoute({ providerType: "originrouter", runtime: "claude-sdk" }),
      resolveRoute({ providerType: "originrouter", runtime: "codex" }),
      resolveRoute({ providerType: "originrouter", runtime: "codex-app-server" }),
      resolveRoute({ providerType: "originrouter" }),
    ];
    for (const o of origins) {
      assert.ok(o.endpoint.startsWith("/coding"),
        `originrouter endpoint must start with /coding, got ${o.endpoint}`);
    }
    const proxies = [
      resolveRoute({ providerType: "proxy", runtime: "claude-sdk" }),
      resolveRoute({ providerType: "proxy", runtime: "claude-fast" }),
      resolveRoute({ providerType: "proxy", runtime: "codex-app-server" }),
    ];
    for (const p of proxies) {
      assert.ok(!p.endpoint.startsWith("/coding"),
        `proxy endpoint must NOT start with /coding, got ${p.endpoint}`);
      assert.ok(p.endpoint.startsWith("/v1/"),
        `proxy endpoint must start with /v1/, got ${p.endpoint}`);
    }
  },
});

let failures = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`  ok: ${c.name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL: ${c.name}`);
    console.log(`    ${e.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

console.log("provider route resolution tests ok");
