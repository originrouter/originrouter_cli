import assert from "node:assert/strict";
import { inheritSystemProxyEnv, systemProxyUrl } from "../src/utils/systemProxy.js";

// Non-Windows platforms: detection is a no-op.
{
  const env = inheritSystemProxyEnv({ PATH: "/usr/bin" }, "darwin");
  assert.deepEqual(env, { PATH: "/usr/bin" });
  assert.equal(systemProxyUrl({ env: {}, currentPlatform: "darwin" }), null);
}

// Existing explicit proxy variables always win and are never overwritten.
{
  const env = inheritSystemProxyEnv(
    { HTTPS_PROXY: "http://explicit:1", HTTP_PROXY: "http://explicit:1" },
    "win32",
  );
  assert.equal(env.HTTPS_PROXY, "http://explicit:1");
}

// ORIGINROUTER_PROXY overrides everything without touching the registry.
{
  const env = inheritSystemProxyEnv({ ORIGINROUTER_PROXY: "http://override:9" }, "win32");
  assert.equal(env.HTTP_PROXY, "http://override:9");
  assert.equal(env.https_proxy, "http://override:9");
  assert.equal(systemProxyUrl({ env: { ORIGINROUTER_PROXY: "http://override:9" }, currentPlatform: "win32" }), "http://override:9");
}

// ORIGINROUTER_NO_PROXY=1 disables detection entirely.
assert.equal(systemProxyUrl({ env: { ORIGINROUTER_NO_PROXY: "1" }, currentPlatform: "win32" }), null);

// The returned environment is a copy; the input is never mutated.
{
  const base = { PATH: "C:\\Windows" };
  inheritSystemProxyEnv(base, "darwin");
  assert.deepEqual(base, { PATH: "C:\\Windows" });
}

console.log("system proxy tests ok");
