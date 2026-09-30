// Codex resolves config from layered sources, and our `-c` overrides land in
// the SessionFlags layer (precedence 30), above a user `config.toml` (20) and a
// project `.codex` layer (25). That wins every field we set — but Codex merges
// tables field by field, so any field we do NOT set under the same provider id
// survives from the lower layer.
//
// Measured against Codex 0.156.1 with a fixed provider id: a
// `[model_providers.originrouter_proxy]` block in the user's config.toml put
// env_http_headers, http_headers and query_params onto the very request our own
// credential authorized, so the user's key left the machine for whatever
// endpoint the route pointed at. An empty-table override does not clear them —
// the merge walks the overlay's keys, so an empty overlay contributes nothing.
// Removing the merge partner (an id the user cannot have written) is the fix.

import assert from "node:assert/strict";
import {
  buildCodexModelProviderConfigArgs,
  codexModelProviderId,
} from "../src/adapters/codex/appServerClient.js";

const provider = {
  id: "originrouter_proxy",
  name: "OriginRouter Proxy",
  baseUrl: "http://127.0.0.1:40123/coding/v1",
  envKey: "OPENAI_API_KEY",
  wireApi: "responses",
};

const args = buildCodexModelProviderConfigArgs(provider);
const values = args.filter((_, index) => index % 2 === 1);

// The selected id is nonced.
const select = values[0];
assert.match(select, /^model_provider="originrouter_proxy_[a-z0-9]+"$/);
const id = select.slice('model_provider="'.length, -1);

// Every provider field we set addresses the nonced id, never the bare one a
// user could have written in their config.toml.
for (const field of ["name", "base_url", "env_key", "wire_api"]) {
  assert.ok(
    values.includes(`model_providers.${id}.${field}=${JSON.stringify(
      field === "name" ? provider.name
        : field === "base_url" ? provider.baseUrl
          : field === "env_key" ? provider.envKey
            : provider.wireApi,
    )}`),
    `${field} must be set on the nonced id`,
  );
}
assert.equal(
  values.some((v) => v.startsWith("model_providers.originrouter_proxy.")),
  false,
  "nothing may address the bare provider id — that is the merge partner we remove",
);

// The id is stable within a process: the app-server client and the PTY launch
// path both build args separately and must agree on the same provider.
assert.equal(codexModelProviderId("originrouter_proxy"), id);
assert.equal(codexModelProviderId("originrouter_proxy"), codexModelProviderId("originrouter_proxy"));

// The nonce is appended to a sanitized base, so a hostile id cannot inject
// TOML path separators or quotes into the `-c` argument.
const dirty = codexModelProviderId('evil"id.with=separators and spaces');
assert.match(dirty, /^[a-zA-Z0-9_-]+$/);
assert.equal(dirty.includes("."), false);
assert.equal(dirty.includes('"'), false);

// Distinct base ids stay distinct.
assert.notEqual(codexModelProviderId("a"), codexModelProviderId("b"));

// No provider, or one without a base URL, contributes no arguments at all:
// that is what keeps an unrouted Codex session on its native configuration.
assert.deepEqual(buildCodexModelProviderConfigArgs(null), []);
assert.deepEqual(buildCodexModelProviderConfigArgs({ id: "x" }), []);
assert.deepEqual(buildCodexModelProviderConfigArgs({ baseUrl: "http://x" }), []);

// Defaults are applied when the caller omits them.
const defaults = buildCodexModelProviderConfigArgs({ id: "p", baseUrl: "http://127.0.0.1:2/v1" })
  .filter((_, index) => index % 2 === 1);
const defaultId = defaults[0].slice('model_provider="'.length, -1);
assert.ok(defaults.includes(`model_providers.${defaultId}.env_key="OPENAI_API_KEY"`));
assert.ok(defaults.includes(`model_providers.${defaultId}.wire_api="responses"`));
assert.ok(defaults.includes(`model_providers.${defaultId}.name="OriginRouter Proxy"`));

console.log("codex provider isolation tests passed");
