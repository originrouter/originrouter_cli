import { maskSecret, summarizeClaudeConfig } from "../config/claudeConfig.js";
import {
  MAIN_ALIAS,
  ROUTE_AGENTS,
  ROUTE_DEFS,
  SMALL_ALIAS,
  effectiveRoutes,
  getAgentRoutes,
  getAllRoutes,
  getRoutes,
  hashRoutes,
} from "../config/routes.js";
import {
  listProviders,
  normalizeProviderForRead,
  secretFieldKeysFor,
} from "../config/providers.js";

export function printClaudeConfig(config) {
  const summary = summarizeClaudeConfig(config);
  console.log("Claude config");
  console.log(`  baseUrl:        ${summary.baseUrl}`);
  console.log(`  apiKey:         ${summary.apiKey}`);
  console.log(`  model:          ${summary.model}`);
  console.log(`  smallFastModel: ${summary.smallFastModel}`);
}

export function pad(value, width) {
  const text = value == null ? "" : String(value);
  if (text.length >= width) return text.slice(0, width);
  return `${text}${" ".repeat(width - text.length)}`;
}

export function formatTimestamp(iso) {
  if (!iso) return "-";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function printSessions(records) {
  if (records.length === 0) {
    console.log("(no sessions recorded yet)");
    return;
  }
  const sorted = [...records].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  const header = ["SESSION ID", "AGENT", "STATUS", "STARTED", "EXITED", "CWD"].map((label, i) =>
    pad(label, i === 0 ? 28 : i === 5 ? 40 : 16)
  );
  console.log(header.join(""));
  for (const record of sorted) {
    const cells = [
      pad(record.sessionId, 28),
      pad(record.agent || record.command || "-", 16),
      pad(record.status || "-", 16),
      pad(formatTimestamp(record.startedAt), 16),
      pad(formatTimestamp(record.exitedAt), 16),
      pad(record.cwd || "-", 40),
    ];
    console.log(cells.join(""));
  }
}

export function printAgentHistory(records) {
  if (records.length === 0) {
    console.log("(no Agent history recorded yet)");
    return;
  }
  console.log([
    pad("CONVERSATION", 26),
    pad("AGENT", 10),
    pad("STATUS", 14),
    pad("UPDATED", 21),
    pad("WORKSPACE", 24),
    "TITLE",
  ].join(""));
  for (const item of records) {
    console.log([
      pad(item.conversation_id, 26),
      pad(item.agent_type, 10),
      pad(item.status, 14),
      pad(formatTimestamp(item.last_activity_at), 21),
      pad(item.workspace_name || "-", 24),
      item.title || "-",
    ].join(""));
  }
}

export function printProviderList(config) {
  const providers = listProviders(config).reduce((acc, p) => {
    acc[p.name] = p;
    return acc;
  }, {});
  const current = config.currentProvider || {};
  const names = Object.keys(providers).sort();
  const routes = effectiveRoutes(getRoutes(config));
  if (names.length === 0) {
    console.log("(no providers configured)");
    console.log("Run `originrouter provider add <name> --litellm-provider <id> --api-key <k> --model <m>` to add one.");
    return;
  }
  const rows = names.map((name) => {
    const p = providers[name];
    const sFast = p.smallFastModel ? `, ${p.smallFastModel}` : "";
    const marker = routes.main?.provider === name || current.codex === name ? "*" : " ";
    return {
      marker,
      name,
      type: p.type,
      model: `${p.model}${sFast}`,
      apiKey: maskSecret(p.apiKey),
      baseUrl: p.baseUrl,
    };
  });
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    model: Math.max(5, ...rows.map((r) => r.model.length)),
    apiKey: Math.max(6, ...rows.map((r) => r.apiKey.length)),
  };
  const header = `${"".padEnd(1)} ${"NAME".padEnd(widths.name)}  ${"TYPE".padEnd(widths.type)}  ${"MODEL".padEnd(widths.model)}  ${"APIKEY".padEnd(widths.apiKey)}  BASEURL`;
  console.log(header);
  for (const r of rows) {
    console.log(`${r.marker} ${r.name.padEnd(widths.name)}  ${r.type.padEnd(widths.type)}  ${r.model.padEnd(widths.model)}  ${r.apiKey.padEnd(widths.apiKey)}  ${r.baseUrl}`);
  }
  if (routes.main) {
    console.log("\nClaude routes:");
    console.log(`  model ${MAIN_ALIAS.padEnd(30)} -> ${routes.main.provider} / ${routes.main.model}`);
    console.log(`  fast  ${SMALL_ALIAS.padEnd(30)} -> ${routes.small.provider} / ${routes.small.model}${routes.small._fallback ? " (falls back to main)" : ""}`);
  } else {
    console.log("\nClaude routes: (unset)");
  }
  if (current.codex) console.log(`Current provider (codex):  ${current.codex}`);
}

export function printProviderShow(provider) {
  const value = (x) => x == null || x === "" ? "(unset)" : String(x);
  const masked = (x) => x ? maskSecret(x) : "(unset)";
  const secrets = (() => {
    try { return secretFieldKeysFor(provider); }
    catch { return new Set(); }
  })();
  const mask = (key, item) => {
    if (item == null || item === "") return "(unset)";
    return secrets.has(key) ? maskSecret(item) : item;
  };
  console.log(`Provider: ${provider.name}`);
  console.log(`  type:           ${value(provider.type)}`);
  console.log(`  baseUrl:        ${value(provider.baseUrl)}`);
  console.log(`  apiKey:         ${mask("apiKey", provider.apiKey)}`);
  console.log(`  authToken:      ${mask("authToken", provider.authToken)}`);
  console.log(`  organization:   ${value(provider.organization)}`);
  console.log(`  apiVersion:     ${value(provider.apiVersion)}`);
  console.log(`  azureAdToken:   ${mask("azureAdToken", provider.azureAdToken)}`);
  console.log(`  model:          ${value(provider.model)}`);
  console.log(`  smallFastModel: ${value(provider.smallFastModel)}${provider.smallFastModel ? "  (legacy; routes.claude.small is source of truth)" : ""}`);
  if (provider.litellmProvider) console.log(`  litellmProvider: ${provider.litellmProvider}`);
  if (provider.awsRegion) console.log(`  awsRegion:       ${provider.awsRegion}`);
  if (provider.awsAccessKeyId) console.log(`  awsAccessKeyId:  ${provider.awsAccessKeyId}`);
  if (provider.awsSecretAccessKey) console.log(`  awsSecretAccessKey: ${masked(provider.awsSecretAccessKey)}`);
  if (provider.awsSessionToken) console.log(`  awsSessionToken: ${masked(provider.awsSessionToken)}`);
  if (provider.awsProfileName) console.log(`  awsProfileName:  ${provider.awsProfileName}`);
  if (provider.awsBedrockRuntimeEndpoint) console.log(`  awsBedrockRuntimeEndpoint: ${provider.awsBedrockRuntimeEndpoint}`);
  if (provider.awsRoleName) console.log(`  awsRoleName:     ${provider.awsRoleName}`);
  if (provider.awsSessionName) console.log(`  awsSessionName:  ${provider.awsSessionName}`);
  if (provider.awsWebIdentityToken) console.log(`  awsWebIdentityToken: ${masked(provider.awsWebIdentityToken)}`);
  if (provider.awsStsEndpoint) console.log(`  awsStsEndpoint:  ${provider.awsStsEndpoint}`);
  if (provider.sagemakerBaseUrl) console.log(`  sagemakerBaseUrl: ${provider.sagemakerBaseUrl}`);
  if (provider.vertexProject) console.log(`  vertexProject:   ${provider.vertexProject}`);
  if (provider.vertexLocation) console.log(`  vertexLocation:  ${provider.vertexLocation}`);
  if (provider.vertexCredentials) console.log(`  vertexCredentials: ${masked(provider.vertexCredentials)}`);
  if (provider.googleApplicationCredentials) console.log(`  googleApplicationCredentials: ${masked(provider.googleApplicationCredentials)}`);
  if (provider.hfToken) console.log(`  hfToken:         ${masked(provider.hfToken)}`);
}

export function printRouteList(config) {
  const allRoutes = getAllRoutes(config);
  const hasAny = ROUTE_AGENTS.some((agent) => ROUTE_DEFS[agent].slots.some((slot) => allRoutes[agent][slot]));
  if (!hasAny) {
    console.log("(no routes configured)");
    console.log(`Run \`originrouter route set ${ROUTE_AGENTS[0]}.main --provider <proxy-name> --model <model>\` to start.`);
    return;
  }
  for (const agent of ROUTE_AGENTS) {
    const slots = ROUTE_DEFS[agent].slots;
    const hasAnyForAgent = slots.some((slot) => allRoutes[agent][slot]);
    console.log(`${agent}:`);
    if (!hasAnyForAgent) {
      console.log("  (no routes)");
      continue;
    }
    for (const slot of slots) {
      const entry = allRoutes[agent][slot];
      if (!entry) continue;
      const alias = ROUTE_DEFS[agent].aliases[slot];
      console.log(`  ${slot.padEnd(5)} (alias ${alias.padEnd(24)})  → ${entry.provider} / ${entry.model}`);
    }
  }
}

export function printRouteShow(config, agent) {
  if (!ROUTE_AGENTS.includes(agent)) {
    throw new Error(`unknown route agent '${agent}'; must be one of: ${ROUTE_AGENTS.join(", ")}`);
  }
  const agentRoutes = getAgentRoutes(config, agent);
  const allRoutes = getAllRoutes(config);
  console.log(`Routes for ${agent}:`);
  for (const slot of ROUTE_DEFS[agent].slots) {
    const entry = agentRoutes[slot];
    const alias = ROUTE_DEFS[agent].aliases[slot];
    if (entry) {
      console.log(`  ${slot} (alias ${alias}):`);
      console.log(`    provider: ${entry.provider}`);
      console.log(`    model:    ${entry.model}`);
    } else {
      console.log(`  ${slot}: (unset; alias ${alias} will not be emitted)`);
    }
  }
  console.log(`  routesHash: ${hashRoutes(allRoutes)}`);
}

export function cliProviderForShow(config, name) {
  const provider = (config.providers || {})[name];
  if (!provider) throw new Error(`unknown provider '${name}'`);
  return normalizeProviderForRead(provider);
}
