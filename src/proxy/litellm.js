// Stage 4: LiteLLM proxy integration.
// Stage 7: per-provider catalog-driven YAML rendering.
// Stage 7.7: catalog fidelity — secret/envVar/runtimeRequired metadata;
//            env-reference syntax; strict pin-aligned litellm_params.
//
// This module holds pure helpers (paths, YAML rendering, process args). It
// does NOT spawn processes; that lives in src/proxy/manager.js. Splitting
// pure functions from lifecycle makes the manager testable without real
// pip installs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ROUTE_AGENTS,
  ROUTE_DEFS,
  effectiveAgentRoutes,
  routeProviderForRead,
} from "../config/routes.js";
import { getLitellmProfile, paramsFor, prefixFor } from "./litellmCatalog.js";

// LiteLLM version pinned for Stage 4. Override with --version on
// `originrouter proxy install`. Pinned because LiteLLM's breaking changes
// are frequent and we want reproducible installs.
export const LITELLM_VERSION = "1.83.0";
export const LITELLM_PACKAGE = `litellm[proxy]==${LITELLM_VERSION}`;

// Stable path under the user's state dir. Symlink-free so a partial install
// is detectable. A future `originrouter proxy upgrade` would create
// `runtimes/litellm/<new-version>/` next to this one.
export function runtimeDir(stateDir, version = LITELLM_VERSION) {
  return join(stateDir, "runtimes", "litellm", version);
}

export function venvDir(stateDir, version = LITELLM_VERSION) {
  return join(runtimeDir(stateDir, version), "venv");
}

export function pythonBinaryPath(stateDir, version = LITELLM_VERSION) {
  // macOS/Linux: bin/python. Windows: Scripts/python.exe — Stage 4 is
  // macOS/Linux only per user direction, but the helper handles both.
  const venv = venvDir(stateDir, version);
  return join(venv, "bin", "python");
}

export function litellmBinaryPath(stateDir, version = LITELLM_VERSION) {
  const venv = venvDir(stateDir, version);
  return join(venv, "bin", "litellm");
}

export function pipBinaryPath(stateDir, version = LITELLM_VERSION) {
  const venv = venvDir(stateDir, version);
  return join(venv, "bin", "pip");
}

export function isInstalled(stateDir, version = LITELLM_VERSION) {
  return existsSync(pythonBinaryPath(stateDir, version)) && existsSync(litellmBinaryPath(stateDir, version));
}

// Args for `<venv>/bin/litellm --config <path> --port <port> --host <host>`.
// Stage 4 hardcodes 127.0.0.1; bind safety is enforced at start time.
export function litellmArgs(configPath, port, host = "127.0.0.1") {
  return [
    "--config", configPath,
    "--host", host,
    "--port", String(port),
  ];
}

// Backward-compatible alias for older tests/imports. The returned args are
// for the LiteLLM console script, not `python -m litellm`.
export const litellmModuleArgs = litellmArgs;

// Map a provider record to its catalog profile for YAML rendering.
//
// Core routing rule (Stage 7):
//   - type=anthropic        → NOT a LiteLLM provider; direct path. Throw.
//   - type=openai-compatible (legacy) → profile "custom_openai"
//   - type=litellm          → profile of provider.litellmProvider
//
// `type=anthropic` callers should use `buildProviderEnv` (direct env injection)
// instead of `renderLitellmConfigYaml`. This function intentionally refuses.
function resolveProviderProfile(provider) {
  if (!provider) throw new Error("renderLitellmConfigYaml: provider required");
  if (provider.type === "openai-compatible") return getLitellmProfile("custom_openai"); // legacy
  // Stage 9.0: the canonical LiteLLM-renderable shape is
  // type="proxy" + engine="litellm". The legacy type="litellm" is
  // accepted as an alias here because the renderer can be called
  // with a record that hasn't gone through normalizeProviderForRead
  // (e.g. unit tests that construct minimal records).
  if (provider.type === "litellm")           return getLitellmProfile(provider.litellmProvider);
  if (provider.type === "proxy" && provider.engine === "litellm") {
    return getLitellmProfile(provider.litellmProvider);
  }
  throw new Error(
    `renderLitellmConfigYaml: unsupported provider type '${provider.type}'. ` +
    `type=anthropic is the direct path and does not route through LiteLLM; ` +
    `use type=proxy + engine=litellm + litellmProvider=<id> to route through the proxy.`
  );
}

// Stage 7.7: env-reference regex. The only legal env-ref shape accepted in
// field values; anything else that looks env-ref-ish is rejected so the user
// gets a clear error instead of a silent YAML full of broken references.
export const ENV_REF_RE = /^os\.environ\/[A-Za-z_][A-Za-z0-9_]*$/;

// Build the ordered litellm_params map from the provider record + profile.
// Each field in `profile.fields` declares its camelCase `key` (looked up in
// the provider record) and its snake_case `litellmParam` (the YAML key).
function buildLitellmParams(provider, profile) {
  const out = new Map();
  for (const f of profile.fields) {
    const v = provider[f.key];
    if (v == null || v === "") {
      if (f.required) throw new Error(`provider '${provider.name}' missing required field '${f.key}'`);
      continue;
    }
    if (typeof v !== "string") {
      // Non-string is allowed only for hfToken mirror (handled separately in
      // providers.js). Once we reach the renderer the value should already
      // be a string.
      throw new Error(`provider '${provider.name}' field '${f.key}' must be a string`);
    }
    if (v.includes("\n") || v.includes("\0")) {
      throw new Error(`provider '${provider.name}' field '${f.key}' contains forbidden character`);
    }
    // env-ref shape validation: a string that starts with "os.environ/" MUST
    // match the regex exactly; otherwise it's malformed (spaces, multiple
    // vars, leading digit, etc.).
    if (v.startsWith("os.environ/") && !ENV_REF_RE.test(v)) {
      throw new Error(
        `provider '${provider.name}' field '${f.key}' has malformed env reference '${v}' ` +
        `(expected os.environ/VAR_NAME matching ${ENV_REF_RE.source})`,
      );
    }
    out.set(f.litellmParam, v);
  }
  return out;
}

// Render the LiteLLM proxy config.yaml for a single LiteLLM-routed provider.
//
// Stage 7 shape (catalog-driven):
//
//   model_list:
//     - model_name: <provider.name>
//       litellm_params:
//         model: <prefix>/<provider.model>
//         <litellmParam_1>: "<value_1>"
//         <litellmParam_2>: "<value_2>"
//         ...
//   litellm_settings:
//     drop_params: true
//
// `drop_params: true` lets LiteLLM drop Anthropic-only params (like
// `smallFastModel`) that the target provider doesn't understand.
export function renderLitellmConfigYaml(provider) {
  const profile = resolveProviderProfile(provider);
  if (!provider.model) throw new Error(`provider '${provider.name}' model is required`);

  // YAML escape: backslash and double-quote. We always wrap values in "..."
  // to avoid YAML surprise on values that look like booleans/numbers.
  const esc = (s) => String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

  const prefix = prefixFor(profile.id);
  const params = buildLitellmParams(provider, profile);

  const lines = [
    "# Generated by OriginRouter Stage 7.7. Do not edit by hand;",
    "# `originrouter proxy start --provider <name>` rewrites this file.",
    "model_list:",
    `  - model_name: ${esc(provider.name)}`,
    "    litellm_params:",
    `      model: ${prefix}/${esc(provider.model)}`,
  ];

  // Render params in the catalog-declared order so tests can snapshot.
  for (const litellmKey of paramsFor(profile.id)) {
    if (!params.has(litellmKey)) continue;
    lines.push(`      ${litellmKey}: "${esc(params.get(litellmKey))}"`);
  }

  lines.push("litellm_settings:");
  lines.push("  drop_params: true");
  lines.push("");
  return lines.join("\n");
}

// The placeholder API key we inject into ANTHROPIC_API_KEY when routing
// through the proxy. LiteLLM does not validate this — it only validates the
// api_key in the model_list config — but Claude Code refuses to start if
// ANTHROPIC_API_KEY is empty.
export const NOOP_ANTHROPIC_API_KEY = "sk-noop-litellm-passthrough";

// Render the LiteLLM proxy config.yaml for a route set.
//
// Stage 7.6 shape:
// Stage 7.7 adds: env-reference passthrough; omits UI-only metadata; field
// metadata comes from the catalog.
//
//   model_list:
//     - model_name: originrouter-claude-model
//       litellm_params:
//         model: <prefix>/<resolved model>
//         <litellmParam_1>: "<value_1>"
//         ...
//     - model_name: originrouter-claude-fast-model
//       litellm_params:
//         ...   (same params as main when small is missing — fallback)
//
//   litellm_settings:
//     drop_params: true
//
// `allRoutes` is the { claude: {main, small}, codex: {main} } shape from
// getAllRoutes(config). `providers` is the providers map from config. Each
// route entry must reference a real LiteLLM-renderable provider — the
// renderer re-validates this and throws on dangling routes (provider
// deleted or type changed after save).
//
// Stage 7.6: Claude always emits both aliases. When Claude.small is unset,
// the renderer duplicates `main`'s litellm_params under the fast alias
// (small → main fallback). effectiveAgentRoutes("claude", ...) handles the
// duplication; the renderer just iterates over its output.
//
// Stage 8.0: multi-agent. The renderer walks ROUTE_AGENTS, then for each
// agent walks ROUTE_DEFS[agent].slots, emitting only configured slots.
// Codex 8.0 = at most one Codex alias in the YAML. Codex has no small
// slot so it never falls back. Apply routeProviderForRead() to providers
// so legacy type=anthropic / type=openai-compatible records (which the
// validator already projects at write time) render successfully here.
export function renderLitellmRoutesConfigYaml(allRoutes, providers) {
  const esc = (s) => String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

  const lines = [
    "# Generated by OriginRouter Stage 8.0. Do not edit by hand;",
    "# `originrouter route set ...` (or `provider use <name>`) rewrites this file.",
    "model_list:",
  ];

  let emittedAny = false;
  for (const agent of ROUTE_AGENTS) {
    const agentRoutes = (allRoutes || {})[agent] || {};
    const eff = effectiveAgentRoutes(agent, agentRoutes);
    const aliases = ROUTE_DEFS[agent].aliases;
    for (const slot of ROUTE_DEFS[agent].slots) {
      const entry = eff[slot];
      if (!entry) continue;
      const rawProvider = (providers || {})[entry.provider];
      if (!rawProvider) {
        // Dangling route. Save-time validation already required the provider
        // to exist; this branch only fires if the provider was deleted after.
        throw new Error(`routes.${agent}.${slot} references a provider that no longer exists`);
      }
      const provider = routeProviderForRead(rawProvider);
      // Stage 9.0: route-renderable records are type=proxy+engine=litellm.
      // The legacy type=litellm is also accepted (in case routeProviderForRead
      // didn't project — e.g. a future profile with engine=direct_anthropic).
      const isLitellm = provider.type === "litellm"
        || (provider.type === "proxy" && provider.engine === "litellm");
      if (!isLitellm) {
        throw new Error(
          `routes.${agent}.${slot} points at provider type='${provider.type}' engine='${provider.engine}'. ` +
          `routes only accept type=litellm or type=proxy(engine=litellm) providers; re-save the route via 'route set'.`
        );
      }
      const profile = getLitellmProfile(provider.litellmProvider);
      const prefix = prefixFor(profile.id);

      lines.push(`  - model_name: ${esc(aliases[slot])}`);
      lines.push("    litellm_params:");
      lines.push(`      model: ${prefix}/${esc(entry.model)}`);

      // Stage 7.7: iterate the catalog's litellmParams[] in declared order;
      // look up values via the field's camelCase `key`. Blank optional fields
      // are omitted (omitIfBlank: true is the default; required: true throws
      // here for the few fields that have no env fallback). Env-ref strings
      // pass through verbatim. UI-only keys (inlineCreds, etc.) never reach
      // this loop because they are not in profile.litellmParams.
      for (const litellmKey of paramsFor(profile.id)) {
        const field = profile.fields.find((f) => f.litellmParam === litellmKey);
        if (!field) continue;
        const v = provider[field.key];
        if (v == null || v === "") {
          if (field.required) {
            throw new Error(`provider '${entry.provider}' missing required field '${field.key}'`);
          }
          continue;
        }
        if (typeof v !== "string") continue;
        if (v.includes("\n") || v.includes("\0")) {
          throw new Error(`provider '${entry.provider}' field '${field.key}' contains forbidden character`);
        }
        if (v.startsWith("os.environ/") && !ENV_REF_RE.test(v)) {
          throw new Error(
            `provider '${entry.provider}' field '${field.key}' has malformed env reference '${v}' ` +
            `(expected os.environ/VAR_NAME matching ${ENV_REF_RE.source})`,
          );
        }
        lines.push(`      ${litellmKey}: "${esc(v)}"`);
      }
      emittedAny = true;
    }
  }

  if (!emittedAny) {
    throw new Error("renderLitellmRoutesConfigYaml: no routes configured. Set claude.main or codex.main first.");
  }

  lines.push("litellm_settings:");
  lines.push("  drop_params: true");
  lines.push("");
  return lines.join("\n");
}
