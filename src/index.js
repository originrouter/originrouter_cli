import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startDaemon } from "./daemon/daemon.js";
import {
  CLAUDE_CONFIG_KEYS,
  buildAgentProviderEnv,
  maskSecret,
  setClaudeConfigValue,
  summarizeClaudeConfig,
  unsetClaudeConfigValue,
} from "./config/claudeConfig.js";
import {
  addProvider,
  applyProviderUpdate,
  buildProviderEnv,
  doctorProvider,
  listProviders,
  normalizeProviderForRead,
  removeProvider,
  secretFieldKeysFor,
  setClaudeRouteFromProvider,
  setCurrentProvider,
  takeUpdateWarnings,
} from "./config/providers.js";
import {
  CODEX_MAIN_ALIAS,
  MAIN_ALIAS,
  ROUTE_AGENTS,
  ROUTE_DEFS,
  SMALL_ALIAS,
  clearRoute,
  effectiveRoutes,
  getAgentRoutes,
  getAllRoutes,
  getRoutes,
  hashRoutes,
  setRoute,
} from "./config/routes.js";
import { LITELLM_VERSION } from "./proxy/litellm.js";
import { ProxyManager } from "./proxy/manager.js";
import { readLocalProxySnapshot, staticProxyStatusFn } from "./proxy/snapshot.js";
import { runLocalAgentSession } from "./local/localAgentSession.js";
import { readSessions } from "./persistence/sessionLog.js";
import { readApiToken, rotateApiToken } from "./persistence/authToken.js";
import { ensureStateDir, getStateDir, readConfig, readDaemonState, readDevice, writeConfig } from "./persistence/state.js";
import { runClaudeSdkSession } from "./runtime/claudeSdkSession.js";
import {
  detectClaudeAgentSdkAvailability,
  detectCliAvailability,
  detectNodePtyAvailability,
  detectTmuxAvailability,
} from "./utils/detect.js";
import { DEFAULT_DEVICE_ID, DEFAULT_EXECUTOR, DEFAULT_RELAY_URL, VERSION } from "./constants.js";

function printHelp() {
  console.log(`originrouter ${VERSION}

Usage:
  originrouter --help
  originrouter --version
  originrouter status
  originrouter doctor [provider <name>]
  originrouter sessions [--json]
  originrouter env print [--provider <name>] [--agent claude|codex]

Provider management:
  originrouter provider add <name> [--type litellm] --litellm-provider <id> [--base-url <u>] [--api-key <k>] [--auth-token <k>] [--organization <o>] [--model <m>] [--small-fast-model <m> [legacy]] [--api-version <v>] [--aws-region <r>] [--aws-access-key-id <id>] [--aws-secret-access-key <k>] [--aws-session-token <t>] [--aws-profile-name <p>] [--aws-bedrock-runtime-endpoint <u>] [--aws-role-name <r>] [--aws-session-name <n>] [--aws-web-identity-token <t>] [--aws-sts-endpoint <u>] [--sagemaker-base-url <u>] [--vertex-project <id>] [--vertex-location <loc>] [--vertex-credentials <json>] [--google-application-credentials <path>] [--azure-ad-token <t>] [--hf-token <t>]
originrouter provider update <name> [same flags as add]
  originrouter provider list
  originrouter provider show <name>
  originrouter provider use <name> [--agent claude|codex] [--force]
  originrouter provider remove <name>

Model routes (Stage 7.5 / 7.6):
  originrouter route list
  originrouter route show [claude]
  originrouter route set <agent>.<slot> --provider <name> [--model <m>]
                                 agent ∈ { claude }   slot ∈ { main, small }
  originrouter route clear <agent>.<slot>
  Aliases are fixed: originrouter-claude-model (main) and originrouter-claude-fast-model (small).

LiteLLM proxy (Stage 4 + Stage 7.5 + 7.6 + 7.7):
  originrouter proxy install [--version <v>]      default version 1.83.0
  originrouter proxy start --port <p>            routes mode (default; reads routes.claude)
  originrouter proxy start --provider <name> --port <p>   legacy / debug — NOT for use with originrouter claude
  originrouter proxy stop
  originrouter proxy restart [--port <p>]         restart in routes mode using current port
  originrouter proxy switch   [--port <p>]        alias for proxy restart
  originrouter proxy status

Provider field metadata (Stage 7.7):
  Every --flag maps to a catalog field for the chosen --litellm-provider.
  Unknown flags are rejected. Fields can be literal values or env references
  (e.g. --api-key os.environ/DEEPSEEK_API_KEY). Secret fields are masked in
  all CLI / API output.

Local API auth (Stage 6):
  originrouter token show                            Print the current token + browser URL
  originrouter token rotate                          Mint a new token (invalidates all open browser tabs)

Legacy config commands (deprecated, prefer 'originrouter provider add'):
  originrouter config show
  originrouter config set claude.<key> <value>
  originrouter config unset claude.<key>
  originrouter claude-config --base-url <url> --api-key <key> --model <model> --small-fast-model <model> [legacy]

Other:
  originrouter daemon [--relay http://localhost:8787] [--device local-dev] [--local-port <p>]
  originrouter daemon-port                           Print the running daemon's local API URL (reads daemon.state.json)
  originrouter run -- <command> [args...]
  originrouter claude [args...]                  Start local Claude Code session (PTY) — uses resolved provider env
  originrouter claude --terminal [args...]      Alias for 'claude' (flag is a no-op)
  originrouter claude-terminal [args...]         Alias for 'claude' (PTY route)
  originrouter claude-sdk [args...]              Start Claude through the Agent SDK runtime
  originrouter codex [args...]                   Start local Codex session and expose it for remote control (PTY)

Examples:
  originrouter run -- bash
  originrouter provider add minimax --litellm-provider anthropic --base-url https://api.easytransnote.com/coding --api-key sk-v1-xxx --model MiniMax-M3 --small-fast-model MiniMax-M2.7
  originrouter provider use minimax
  originrouter env print
  originrouter claude
  originrouter route set claude.main --provider deepseek --model deepseek-chat
  originrouter claude-config --base-url https://x --api-key sk-y --model m   # legacy: writes config.claude
  originrouter claude-sdk --model MiniMax-M3
  originrouter codex --model gpt-5-codex
  originrouter sessions
  originrouter sessions --json
  # Stage 7.7: provider fields can be env references. The shell var name is
  # stored verbatim; LiteLLM reads the env itself at startup.
  originrouter provider add bedrock-irsa --litellm-provider bedrock \
    --aws-region os.environ/AWS_REGION_NAME \
    --aws-role-name arn:aws:iam::123456789012:role/MyBedrockRole \
    --aws-web-identity-token os.environ/AWS_WEB_IDENTITY_TOKEN_FILE \
    --model anthropic.claude-3-5-sonnet-20241022-v2:0

OriginRouter wrapper options for claude/codex:
  --provider <name>                              Deprecated for claude; use 'originrouter route set'. Reserved for legacy/debug paths.
  --originrouter-relay http://localhost:8787
  --originrouter-device local-dev
  --originrouter-session session-id
`);
}

function parseRunArgs(args) {
  if (args[0] === "--") return args.slice(1);
  return args;
}

function runCommand(command, args) {
  if (!command) {
    console.error("Missing command.");
    process.exitCode = 1;
    return;
  }

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (error) => {
    console.error(error.code === "ENOENT" ? `Command not found: ${command}` : error.message);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Command terminated by signal: ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 0;
  });
}

function parseOptionArgs(args, { booleanFlags = [] } = {}) {
  const options = {};
  const booleans = new Set(booleanFlags);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      if (booleans.has(key)) {
        options[key] = true;
        continue;
      }
      throw new Error(`Missing value for ${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function printClaudeConfig(config) {
  const summary = summarizeClaudeConfig(config);
  console.log("Claude config");
  console.log(`  baseUrl:        ${summary.baseUrl}`);
  console.log(`  apiKey:         ${summary.apiKey}`);
  console.log(`  model:          ${summary.model}`);
  console.log(`  smallFastModel: ${summary.smallFastModel}`);
}

function parseClaudePath(path) {
  const [section, key] = path.split(".");
  if (section !== "claude" || !CLAUDE_CONFIG_KEYS.includes(key)) {
    throw new Error(`Unsupported config key: ${path}`);
  }
  return key;
}

function pad(value, width) {
  const text = value == null ? "" : String(value);
  if (text.length >= width) return text.slice(0, width);
  return `${text}${" ".repeat(width - text.length)}`;
}

function formatTimestamp(iso) {
  if (!iso) return "-";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function printSessions(records) {
  if (records.length === 0) {
    console.log("(no sessions recorded yet)");
    return;
  }

  // newest first
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

function handleConfig(args) {
  const [action, path, value] = args;
  const config = readConfig();

  if (!action || action === "show") {
    printClaudeConfig(config);
    return;
  }

  if (action === "set") {
    if (!path || value === undefined) {
      throw new Error("Usage: originrouter config set claude.<key> <value>");
    }
    const key = parseClaudePath(path);
    writeConfig(setClaudeConfigValue(config, key, value));
    printClaudeConfig(readConfig());
    return;
  }

  if (action === "unset") {
    if (!path) {
      throw new Error("Usage: originrouter config unset claude.<key>");
    }
    const key = parseClaudePath(path);
    writeConfig(unsetClaudeConfigValue(config, key));
    printClaudeConfig(readConfig());
    return;
  }

  throw new Error(`Unknown config action: ${action}`);
}

function handleClaudeConfig(args) {
  const options = parseOptionArgs(args);
  let config = readConfig();

  const updates = {
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--model": "model",
    "--small-fast-model": "smallFastModel",
  };

  for (const [option, key] of Object.entries(updates)) {
    if (options[option]) {
      config = setClaudeConfigValue(config, key, options[option]);
    }
  }

  writeConfig(config);
  printClaudeConfig(readConfig());
}

// ---------- provider ----------

function printProviderList(config) {
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

function printProviderShow(provider) {
  const v = (x) => x == null || x === "" ? "(unset)" : String(x);
  const m = (x) => x ? maskSecret(x) : "(unset)";
  // Stage 7.7: derive the set of secret keys from the catalog (imported at
  // top of file). Static fallbacks below preserve backward-compatible
  // output for legacy providers without a litellmProvider.
  const secrets = (function () {
    try { return secretFieldKeysFor(provider); }
    catch { return new Set(); }
  })();
  const mask = (key, value) => {
    if (value == null || value === "") return "(unset)";
    return secrets.has(key) ? maskSecret(value) : value;
  };
  console.log(`Provider: ${provider.name}`);
  console.log(`  type:           ${v(provider.type)}`);
  console.log(`  baseUrl:        ${v(provider.baseUrl)}`);
  console.log(`  apiKey:         ${mask("apiKey", provider.apiKey)}`);
  console.log(`  authToken:      ${mask("authToken", provider.authToken)}`);
  console.log(`  organization:   ${v(provider.organization)}`);
  console.log(`  apiVersion:     ${v(provider.apiVersion)}`);
  console.log(`  azureAdToken:   ${mask("azureAdToken", provider.azureAdToken)}`);
  console.log(`  model:          ${v(provider.model)}`);
  console.log(`  smallFastModel: ${v(provider.smallFastModel)}${provider.smallFastModel ? "  (legacy; routes.claude.small is source of truth)" : ""}`);
  if (provider.litellmProvider) {
    console.log(`  litellmProvider: ${provider.litellmProvider}`);
  }
  if (provider.awsRegion)       console.log(`  awsRegion:       ${provider.awsRegion}`);
  if (provider.awsAccessKeyId)  console.log(`  awsAccessKeyId:  ${provider.awsAccessKeyId}`);
  if (provider.awsSecretAccessKey) console.log(`  awsSecretAccessKey: ${m(provider.awsSecretAccessKey)}`);
  if (provider.awsSessionToken) console.log(`  awsSessionToken: ${m(provider.awsSessionToken)}`);
  if (provider.awsProfileName)  console.log(`  awsProfileName:  ${provider.awsProfileName}`);
  if (provider.awsBedrockRuntimeEndpoint) console.log(`  awsBedrockRuntimeEndpoint: ${provider.awsBedrockRuntimeEndpoint}`);
  if (provider.awsRoleName)     console.log(`  awsRoleName:     ${provider.awsRoleName}`);
  if (provider.awsSessionName)  console.log(`  awsSessionName:  ${provider.awsSessionName}`);
  if (provider.awsWebIdentityToken) console.log(`  awsWebIdentityToken: ${m(provider.awsWebIdentityToken)}`);
  if (provider.awsStsEndpoint)  console.log(`  awsStsEndpoint:  ${provider.awsStsEndpoint}`);
  if (provider.sagemakerBaseUrl) console.log(`  sagemakerBaseUrl: ${provider.sagemakerBaseUrl}`);
  if (provider.vertexProject)   console.log(`  vertexProject:   ${provider.vertexProject}`);
  if (provider.vertexLocation)  console.log(`  vertexLocation:  ${provider.vertexLocation}`);
  if (provider.vertexCredentials) console.log(`  vertexCredentials: ${m(provider.vertexCredentials)}`);
  if (provider.googleApplicationCredentials) console.log(`  googleApplicationCredentials: ${m(provider.googleApplicationCredentials)}`);
  if (provider.hfToken)         console.log(`  hfToken:         ${m(provider.hfToken)}`);
}

function cliProviderForShow(config, name) {
  const p = (config.providers || {})[name];
  if (!p) throw new Error(`unknown provider '${name}'`);
  return normalizeProviderForRead(p);
}

function parseProviderAddOptions(rest) {
  // parseOptionArgs can't handle a positional <name>, so consume the first
  // remaining arg manually and pass the rest through parseOptionArgs.
  const name = rest[0];
  const opts = parseOptionArgs(rest.slice(1));
  if (!name) {
    throw new Error(
      "Usage: originrouter provider add <name> [--type litellm] --litellm-provider <id> " +
      "[--base-url <u>] [--api-key <k>] [--auth-token <k>] " +
      "[--organization <o>] [--model <m>] " +
      "[--small-fast-model <m>] [--api-version <v>] [--aws-region <r>] " +
      "[--aws-access-key-id <id>] [--aws-secret-access-key <k>] " +
      "[--aws-session-token <t>] [--aws-profile-name <p>] " +
      "[--aws-bedrock-runtime-endpoint <u>] [--aws-role-name <r>] " +
      "[--aws-session-name <n>] [--aws-web-identity-token <t>] " +
      "[--aws-sts-endpoint <u>] [--sagemaker-base-url <u>] " +
      "[--vertex-project <id>] [--vertex-location <loc>] " +
      "[--vertex-credentials <json>] " +
      "[--google-application-credentials <path>] " +
      "[--azure-ad-token <t>] [--hf-token <t>]",
    );
  }
  // Stage 7.7: only include a key when its CLI flag was explicitly provided.
// Otherwise addProvider's strict unknown-field check sees every flag in the
// catalog and rejects (e.g. a `provider add custom_openai --api-key k --model m`
// invocation should not send `awsRegion`, `vertexProject`, etc.).
  const out = { name, type: opts["--type"], litellmProvider: opts["--litellm-provider"] };
  const flagMap = {
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--auth-token": "authToken",
    "--organization": "organization",
    "--model": "model",
    "--small-fast-model": "smallFastModel",
    "--api-version": "apiVersion",
    "--aws-region": "awsRegion",
    "--aws-access-key-id": "awsAccessKeyId",
    "--aws-secret-access-key": "awsSecretAccessKey",
    "--aws-session-token": "awsSessionToken",
    "--aws-profile-name": "awsProfileName",
    "--aws-bedrock-runtime-endpoint": "awsBedrockRuntimeEndpoint",
    "--aws-role-name": "awsRoleName",
    "--aws-session-name": "awsSessionName",
    "--aws-web-identity-token": "awsWebIdentityToken",
    "--aws-sts-endpoint": "awsStsEndpoint",
    "--sagemaker-base-url": "sagemakerBaseUrl",
    "--vertex-project": "vertexProject",
    "--vertex-location": "vertexLocation",
    "--vertex-credentials": "vertexCredentials",
    "--google-application-credentials": "googleApplicationCredentials",
    "--azure-ad-token": "azureAdToken",
    "--hf-token": "hfToken",
  };
  for (const [flag, key] of Object.entries(flagMap)) {
    if (opts[flag] !== undefined && opts[flag] !== "") out[key] = opts[flag];
  }
  return out;
}

function handleProvider(args) {
  const [action, name, ...rest] = args;
  let config = readConfig();

  if (!action || action === "list") return printProviderList(config);

  if (action === "show") {
    if (!name) throw new Error("Usage: originrouter provider show <name>");
    return printProviderShow(cliProviderForShow(config, name));
  }

  if (action === "add") {
    const opts = parseProviderAddOptions([name, ...rest]);
    if (opts.type === "openai-compatible") {
      throw new Error(
        `type 'openai-compatible' is no longer supported. ` +
        `Use --type litellm --litellm-provider custom_openai instead.`,
      );
    }
    const next = addProviderFromFlags(config, opts);
    writeConfig(next);
    maybeNoteLegacySmallFastModel(opts);
    return printProviderShow(cliProviderForShow(readConfig(), opts.name));
  }

  if (action === "update") {
    if (!name) throw new Error("Usage: originrouter provider update <name> [flags...]");
    const opts = parseProviderAddOptions([name, ...rest]);
    if (opts.type === "openai-compatible") {
      throw new Error(
        `type 'openai-compatible' is no longer supported. ` +
        `Use --type litellm --litellm-provider custom_openai instead.`,
      );
    }
    const result = updateProviderFromFlags(config, name, opts);
    const warnings = takeUpdateWarnings(result);
    writeConfig(result);
    printProviderShow(cliProviderForShow(readConfig(), name));
    maybeNoteLegacySmallFastModel(opts);
    if (warnings.length > 0) {
      console.error("\nWarnings:");
      for (const w of warnings) console.error(`  - ${w.field}: ${w.message}`);
    }
    return;
  }

  if (action === "use") {
    if (!name) throw new Error("Usage: originrouter provider use <name> [--agent claude|codex] [--force]");
    // Stage 7.6: --force is silently accepted (no-op) for backward compat
    // with stage-7.5-era scripts. The "warn-but-allow" gate from Stage 7.5
    // is gone — every provider goes through routes now.
    const opts = parseOptionArgs(rest, { booleanFlags: ["--force"] });
    const agent = opts["--agent"] || "claude";
    if (agent !== "claude" && agent !== "codex") {
      throw new Error(`--agent must be 'claude' or 'codex' (got '${agent}')`);
    }
    const providers = config.providers || {};
    const target = providers[name];
    if (!target) throw new Error(`unknown provider '${name}'`);

    if (agent === "claude") {
      // Stage 7.8: writes ONLY routes.claude.main. fast is owned by the
      // routes layer and is preserved across provider use calls. Output:
      // main row always; fast row only when small is set; canonical hint
      // pointing at `originrouter route set claude.small --provider <name>`.
      const { next } = setClaudeRouteFromProvider(config, name);
      writeConfig(next);
      const updated = getRoutes(next);
      console.log("Claude main route updated:");
      console.log(`  model ${MAIN_ALIAS.padEnd(28)} -> ${updated.main.provider} / ${updated.main.model}`);
      if (updated.small) {
        console.log(`  fast  ${SMALL_ALIAS.padEnd(28)} -> ${updated.small.provider} / ${updated.small.model}`);
      } else {
        console.log("  fast  (unset; the fast alias will fall back to main)");
      }
      console.log(`To set fast route: \`originrouter route set claude.small --provider ${name}\``);
      return;
    }

    // Stage 8.0: codex is route-mode only. `provider use <name> --agent codex`
    // writes routes.codex.main = { provider: name, model: provider.model }.
    // Codex 8.0 has no small/fast slot. Codex never falls back to Claude.
    if (agent === "codex") {
      const next = setRoute(config, "codex", "main", { provider: name, model: target.model });
      writeConfig(next);
      const updated = getAgentRoutes(next, "codex");
      console.log("Codex main route updated:");
      console.log(`  model ${CODEX_MAIN_ALIAS.padEnd(28)} -> ${updated.main.provider} / ${updated.main.model}`);
      console.log("Codex 8.0 has no small/fast slot; Codex does not fall back to Claude.");
      return;
    }
  }

  if (action === "remove") {
    if (!name) throw new Error("Usage: originrouter provider remove <name>");
    const providers = config.providers || {};
    if (!providers[name]) throw new Error(`unknown provider '${name}'`);
    const current = config.currentProvider || {};
    const clearedAgents = Object.entries(current).filter(([, n]) => n === name).map(([agent]) => agent);
    // Stage 8.0: per-agent route cleanup. If the removed provider is the
    // target of any configured route (claude.main, claude.small, codex.main,
    // future slots), clear those slots. The CLI does NOT auto-restart the
    // proxy (matches `route set` / `route clear`).
    const allRoutes = getAllRoutes(config);
    let next = removeProvider(config, name);
    const clearedSlots = [];
    for (const agent of ROUTE_AGENTS) {
      for (const slot of ROUTE_DEFS[agent].slots) {
        if (allRoutes[agent][slot]?.provider === name) {
          next = clearRoute(next, agent, slot);
          clearedSlots.push(`${agent}.${slot}`);
        }
      }
    }
    for (const agent of clearedAgents) next = setCurrentProvider(next, agent, null);
    writeConfig(next);
    const parts = [];
    if (clearedAgents.length) parts.push(`cleared currentProvider for: ${clearedAgents.join(", ")}`);
    if (clearedSlots.length)  parts.push(`cleared routes.${clearedSlots.join(", routes.")}`);
    if (parts.length) console.log(`Removed provider '${name}' (${parts.join("; ")}).`);
    else              console.log(`Removed provider '${name}'.`);
    return;
  }

  throw new Error(`Unknown provider action: ${action}`);
}

// ---------- route ----------

function parseRouteTarget(target) {
  if (!target || typeof target !== "string") {
    throw new Error("route target must be '<agent>.<slot>' (e.g. 'claude.main' or 'claude.small')");
  }
  const [agent, slot] = target.split(".");
  if (!ROUTE_AGENTS.includes(agent)) {
    throw new Error(`unknown route agent '${agent}'; must be one of: ${ROUTE_AGENTS.join(", ")}`);
  }
  if (!ROUTE_DEFS[agent].slots.includes(slot)) {
    throw new Error(
      `unknown route slot '${slot}' for agent '${agent}' ` +
      `(allowed: ${ROUTE_DEFS[agent].slots.join(", ")})`,
    );
  }
  return { agent, slot };
}

function printRouteList(config) {
  const allRoutes = getAllRoutes(config);
  // Stage 8.0: walk all configured agents (Claude and Codex). Each agent
  // shows only the slots defined for it.
  const hasAny = ROUTE_AGENTS.some((agent) =>
    ROUTE_DEFS[agent].slots.some((slot) => allRoutes[agent][slot]),
  );
  if (!hasAny) {
    console.log("(no routes configured)");
    console.log(`Run \`originrouter route set ${ROUTE_AGENTS[0]}.main --provider <litellm-name> --model <model>\` to start.`);
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

function printRouteShow(config, agent) {
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

function handleRoute(args) {
  const [action, ...rest] = args;
  const config = readConfig();

  if (!action || action === "list") {
    return printRouteList(config);
  }
  if (action === "show") {
    const agent = rest[0] || "claude";
    return printRouteShow(config, agent);
  }
  if (action === "set") {
    const target = rest[0];
    const opts = parseOptionArgs(rest.slice(1));
    if (!opts["--provider"]) {
      throw new Error("Usage: originrouter route set <agent>.<slot> --provider <name> [--model <model>]");
    }
    const { agent, slot } = parseRouteTarget(target);
    const entry = { provider: opts["--provider"] };
    if (opts["--model"]) entry.model = opts["--model"];
    const next = setRoute(config, agent, slot, entry);
    writeConfig(next);
    console.log(`Route ${target} set.`);
    printRouteShow(next, agent);
    return;
  }
  if (action === "clear") {
    const target = rest[0];
    if (!target) throw new Error("Usage: originrouter route clear <agent>.<slot>");
    const { agent, slot } = parseRouteTarget(target);
    const next = clearRoute(config, agent, slot);
    writeConfig(next);
    console.log(`Cleared route ${target}.`);
    return;
  }
  throw new Error(`Unknown route action: ${action}`);
}

// ---------- proxy ----------

async function handleProxy(args) {
  const [action, ...rest] = args;
  const opts = parseOptionArgs(rest);
  const stateDir = ensureStateDir();
  const proxy = new ProxyManager({ stateDir });

  if (!action || action === "status") {
    const s = await proxy.status();
    if (s.state === "not-installed") {
      console.log("not-installed. Run `originrouter proxy install`.");
      process.exitCode = 1;
      return;
    }
    if (s.state === "stopped") {
      console.log(`stopped. provider=${s.currentProvider ?? "-"}, version=${s.version ?? "-"}.`);
      return;
    }
    console.log(
      `running. port=${s.port}, pid=${s.pid}, provider=${s.currentProvider}, version=${s.version}, startedAt=${s.startedAt}.`,
    );
    return;
  }

  if (action === "install") {
    const { detectPythonAvailability } = await import("./utils/detect.js");
    const py = await detectPythonAvailability();
    if (!py.available) {
      console.error(py.error || "Python 3.10+ not found on PATH.");
      process.exitCode = 1;
      return;
    }
    const version = opts["--version"] || LITELLM_VERSION;
    process.stdout.write(`[proxy] python ${py.version} detected at ${py.path}\n`);
    process.stdout.write(`[proxy] creating venv at ~/.originrouter/runtimes/litellm/${version}/venv ...\n`);
    try {
      const result = await proxy.install({ version });
      process.stdout.write(`[proxy] installed. python=${result.pythonPath}\n`);
    } catch (err) {
      console.error(`[proxy] install failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === "start" || action === "restart" || action === "switch") {
    const providerName = opts["--provider"];
    const portArg = opts["--port"];
    const port = portArg != null ? Number.parseInt(portArg, 10) : undefined;

    // Stage 7.5: mode dispatch.
    //   --provider X  ->  legacy provider-mode boot (debug)
    //   no --provider ->  routes mode (default; reads routes.claude)
    let mode = providerName ? "provider" : "route";

    // `switch` is an alias for `restart` in routes mode.
    if (action === "switch") {
      mode = "route";
    }

    if (mode === "provider" && !providerName) {
      // Defensive: the dispatch above guarantees this branch is unreachable,
      // but keep the guard so a future refactor doesn't regress.
      console.error("Usage: originrouter proxy start --provider <name> --port <p>");
      process.exitCode = 1;
      return;
    }
    if (port != null && (!Number.isFinite(port) || port < 1024 || port > 65535)) {
      console.error("--port must be an integer in [1024, 65535]");
      process.exitCode = 1;
      return;
    }
    if (action === "start" && port == null) {
      console.error("Usage: originrouter proxy start --port <p>  (route mode; reads routes.claude)");
      console.error("       originrouter proxy start --provider <name> --port <p>  (legacy / debug)");
      process.exitCode = 1;
      return;
    }
    if (action === "restart" && port == null) {
      // Reuse the running port when the proxy is already running.
      const cur = await proxy.status();
      if (cur.state === "running" && cur.port) {
        try {
          const result = await proxy.restart({ mode, providerName, port: cur.port });
          if (!result.ok) {
            console.error(`[proxy] restart failed: ${result.error}`);
            process.exitCode = 1;
            return;
          }
          console.log(`[proxy] restarted. port=${result.port}, pid=${result.pid}, mode=${result.mode || "provider"}`);
        } catch (err) {
          console.error(`[proxy] restart failed: ${err.message}`);
          process.exitCode = 1;
        }
        return;
      }
      console.error("Usage: originrouter proxy restart --port <p>  (proxy is stopped; explicit port required)");
      process.exitCode = 1;
      return;
    }

    const fn = action === "start" ? proxy.start.bind(proxy) : (action === "switch" ? proxy.restart.bind(proxy) : proxy.restart.bind(proxy));
    try {
      const result = await fn({ providerName, mode, port });
      if (!result.ok) {
        console.error(`[proxy] ${action} failed: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      const modeLabel = result.mode || (providerName ? "provider" : "route");
      const providerLabel = providerName || (mode === "route" ? "routes" : "-");
      console.log(`[proxy] ${action === "start" ? "started" : (action === "switch" ? "switched" : "restarted")}. port=${result.port}, pid=${result.pid}, mode=${modeLabel}, ${mode === "route" ? "routes" : "provider"}Hash/Name=${providerLabel}`);
    } catch (err) {
      console.error(`[proxy] ${action} failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === "stop") {
    try {
      const result = await proxy.stop();
      process.stdout.write(`[proxy] stopped.\n`);
    } catch (err) {
      console.error(`[proxy] stop failed: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown proxy action: ${action}`);
}

// ---------- token (Stage 6) ----------

// Builds the canonical browser URL. Reads the daemon port from
// daemon.state.json; falls back to the configured local-port flag if the
// daemon isn't running yet (e.g. immediately after `token rotate` while
// the user is about to (re)start the daemon).
function resolveDaemonPort(portOverride) {
  let port = portOverride;
  if (!port) {
    try {
      const s = readDaemonState();
      if (s && s.localApiPort) port = s.localApiPort;
    } catch {}
  }
  return port || null;
}

function buildApiUrl(stateDir, token, portOverride) {
  const port = resolveDaemonPort(portOverride);
  if (!port) {
    // Best-effort: the user can still paste the token into a manually-built URL.
    return `http://127.0.0.1:<port>/?daemon=127.0.0.1:<port>&token=${token}`;
  }
  return `http://127.0.0.1:${port}/?daemon=127.0.0.1:${port}&token=${token}`;
}

function buildConsoleUrl(stateDir, token, portOverride) {
  const port = resolveDaemonPort(portOverride) || "<port>";
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(here);
  const consolePath = resolve(repoRoot, "..", "originrouter-test", "local-console.html");
  if (!existsSync(consolePath)) return buildApiUrl(stateDir, token, portOverride);
  const url = new URL(pathToFileURL(consolePath).toString());
  url.searchParams.set("daemon", `127.0.0.1:${port}`);
  url.searchParams.set("token", token);
  return url.toString();
}

function handleTokenCommand(args) {
  const stateDir = ensureStateDir();
  const [action] = args;
  if (action === "rotate") {
    const token = rotateApiToken(stateDir);
    console.log("Token rotated.");
    console.log(`Token file: ${stateDir}/local-api.token`);
    console.log(`URL: ${buildConsoleUrl(stateDir, token)}`);
    console.log(`API URL: ${buildApiUrl(stateDir, token)}`);
    return;
  }
  if (action === "show" || !action) {
    const token = readApiToken(stateDir);
    if (!token) {
      console.error("No API token on disk. Run `originrouter daemon` first to mint one.");
      process.exitCode = 1;
      return;
    }
    console.log(`Token file: ${stateDir}/local-api.token`);
    console.log(`URL: ${buildConsoleUrl(stateDir, token)}`);
    console.log(`API URL: ${buildApiUrl(stateDir, token)}`);
    return;
  }
  throw new Error(`Unknown token action: ${action}`);
}

// `addProvider` / `applyProviderUpdate` from providers.js own validation.
// These wrappers only adapt the CLI flag shape (strings + naming) into a
// structured payload, picking the add-vs-update variant.
//
// Stage 7.7: only include a key when its source option was explicitly set
// (not undefined / not empty string). Otherwise applyProviderUpdate's strict
// unknown-field check would reject the patch.
function flagsToProviderPayload(opts) {
  const out = {};
  const keys = [
    "name", "type", "litellmProvider",
    "baseUrl", "apiKey", "authToken", "organization",
    "model", "smallFastModel", "apiVersion",
    "awsRegion", "awsAccessKeyId", "awsSecretAccessKey",
    "awsSessionToken", "awsProfileName",
    "awsBedrockRuntimeEndpoint", "awsRoleName", "awsSessionName",
    "awsWebIdentityToken", "awsStsEndpoint",
    "sagemakerBaseUrl",
    "vertexProject", "vertexLocation", "vertexCredentials",
    "googleApplicationCredentials", "azureAdToken", "hfToken",
  ];
  for (const k of keys) {
    if (opts[k] !== undefined && opts[k] !== "") out[k] = opts[k];
  }
  return out;
}

function addProviderFromFlags(config, opts) {
  return addProvider(config, flagsToProviderPayload(opts));
}

function updateProviderFromFlags(config, name, opts) {
  const payload = flagsToProviderPayload({ ...opts, name });
  // For update, all fields except name are patch fields. The provider
  // record is preserved for any field not in the patch.
  const { name: _ignored, ...patch } = payload;
  return applyProviderUpdate(config, name, patch);
}

// Stage 7.8: --small-fast-model is [legacy]. Still accepted on add and
// update (the field round-trips on disk) but no longer seeds
// routes.claude.small. Print a one-line note so the user sees the
// canonical way to set fast.
function maybeNoteLegacySmallFastModel(opts) {
  if (opts && opts.smallFastModel) {
    console.log("Note: --small-fast-model is [legacy]; use `originrouter route set claude.small --provider <name>` instead.");
  }
}

// ---------- env print ----------

const ANTHROPIC_ENV_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];

function handleEnvPrint(args) {
  // `env print` has its own positional subcommand; don't run args through
  // parseOptionArgs which expects `--flag value` pairs exclusively.
  const [subcommand, ...flagArgs] = args;
  if (subcommand !== "print") {
    throw new Error("Usage: originrouter env print [--agent claude|codex]");
  }
  const opts = parseOptionArgs(flagArgs);
  const agent = opts["--agent"] || "claude";
  // Stage 7.6: --provider is deprecated for claude. We still print a route
  // table for human readability and then call buildAgentProviderEnv (which
  // ignores the flag for claude).
  const flagName = opts["--provider"] || null;
  const config = readConfig();

  if (agent === "claude") {
    // Print the route table (the new source of truth for claude).
    const routes = getRoutes(config);
    const eff = effectiveRoutes(routes);
    console.log("Claude routes:");
    if (eff.main)  console.log(`  model ${MAIN_ALIAS.padEnd(28)} -> ${eff.main.provider} / ${eff.main.model}`);
    if (eff.small) console.log(`  fast  ${SMALL_ALIAS.padEnd(28)} -> ${eff.small.provider} / ${eff.small.model}${eff.small._fallback ? " (falls back to main)" : ""}`);
    if (!eff.main) console.log("  (no routes — run `originrouter route set claude.main --provider <name> --model <model>`)");
    if (flagName) {
      console.log(`\nNote: --provider ${flagName} is deprecated for claude. Routes are the source of truth.`);
    }
  } else if (agent === "codex") {
    // Stage 8.0: codex is route-mode only. No legacy currentProvider lookup.
    const codexRoutes = getAgentRoutes(config, "codex");
    console.log("Codex routes:");
    if (codexRoutes.main) {
      console.log(`  model ${CODEX_MAIN_ALIAS.padEnd(28)} -> ${codexRoutes.main.provider} / ${codexRoutes.main.model}`);
      console.log("  (Codex 8.0 has no small/fast slot; Codex does not fall back to Claude.)");
    } else {
      console.log("  (no routes — Codex requires routes.codex.main)");
      console.log(`  Run \`originrouter route set codex.main --provider <name> --model <model>\`.`);
    }
    if (flagName) {
      console.log(`\nNote: --provider ${flagName} is deprecated for codex in Stage 8.0. Routes are the source of truth.`);
    }
  } else {
    throw new Error(`--agent must be 'claude' or 'codex' (got '${agent}')`);
  }

  let providerEnv = {};
  let providerError = null;
  try {
    providerEnv = buildAgentProviderEnv(agent, config, {
      provider: flagName,
      proxyStatus: staticProxyStatusFn(readLocalProxySnapshot()),
    }).env;
  } catch (err) {
    providerError = err;
  }

  console.log("\nEffective env (what claude will see):");
  const providerKeys = Object.keys(providerEnv);
  if (providerKeys.length === 0) {
    if (providerError) {
      console.log(`  ${providerError.message}`);
      process.exitCode = 1;
    } else {
      console.log("  (none — no provider selected; system env applies)");
    }
  } else {
    for (const key of providerKeys) {
      console.log(`  ${key}=${formatEnvValue(key, providerEnv[key])}`);
    }
  }

  console.log("\nSystem env (overridden by providerEnv when both present):");
  for (const key of ANTHROPIC_ENV_VARS) {
    const inProvider = Object.prototype.hasOwnProperty.call(providerEnv, key);
    const sysVal = process.env[key];
    if (inProvider) {
      console.log(`  ${key}  ...overridden by provider (system value was ${sysVal ? formatEnvValue(key, sysVal) : "(unset)"})`);
    } else if (sysVal) {
      console.log(`  ${key}=${formatEnvValue(key, sysVal)}`);
    } else {
      console.log(`  ${key}  (unset)`);
    }
  }
}

// Only API keys are sensitive; model names and base URLs are shown in full.
function formatEnvValue(key, value) {
  if (key === "ANTHROPIC_API_KEY") return maskSecret(value, true);
  return value;
}

// ---------- doctor (extended) ----------

async function printDoctor(args = []) {
  if (args[0] === "provider") {
    const name = args[1];
    if (!name) throw new Error("Usage: originrouter doctor provider <name>");
    const config = readConfig();
    const provider = (config.providers || {})[name];
    if (!provider) {
      console.log(`Doctor provider: '${name}' not found.`);
      process.exitCode = 1;
      return;
    }
    const result = doctorProvider(provider);
    console.log(`Doctor provider '${name}':`);
    if (result.ok) {
      console.log("  ok: true");
    } else {
      console.log("  ok: false");
      for (const e of result.errors) console.log(`  error:   ${e}`);
      process.exitCode = 1;
    }
    for (const w of result.warnings) console.log(`  warning: ${w}`);
    return;
  }

  const [claude, codex, nodePty, claudeSdk, tmux] = await Promise.all([
    detectCliAvailability("claude"),
    detectCliAvailability("codex"),
    detectNodePtyAvailability(),
    detectClaudeAgentSdkAvailability(),
    detectTmuxAvailability(),
  ]);

  console.log("OriginRouter doctor");
  console.log(`  claude:   ${claude.available ? claude.version || "found" : "not found"}`);
  console.log(`  codex:    ${codex.available ? codex.version || "found" : "not found"}`);
  console.log(`  node-pty: ${nodePty.available ? "available" : "not installed"}`);
  console.log(`  claude-agent-sdk: ${claudeSdk.available ? "available" : "not installed"}`);
  console.log(`  tmux:     ${tmux.available ? tmux.version || "found" : "not found"}`);
  printClaudeConfig(readConfig());
  const config = readConfig();
  const cur = config.currentProvider || {};
  if (cur.claude) console.log(`Default provider (claude): ${cur.claude}`);
}

export async function main(argv) {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "status") {
    const stateDir = ensureStateDir();
    const device = readDevice();
    console.log("originrouter-cli is installed.");
    console.log(`State dir: ${stateDir}`);
    console.log(`Default relay: ${DEFAULT_RELAY_URL}`);
    console.log(`Default device: ${device?.deviceId || DEFAULT_DEVICE_ID}`);
    console.log(`Default executor: ${DEFAULT_EXECUTOR}`);
    return;
  }

  if (command === "doctor") {
    await printDoctor(args);
    return;
  }

  if (command === "sessions") {
    const records = readSessions();
    if (args.includes("--json")) {
      console.log(JSON.stringify(records, null, 2));
    } else {
      printSessions(records);
    }
    return;
  }

  if (command === "env") {
    handleEnvPrint(args);
    return;
  }

  if (command === "provider") {
    handleProvider(args);
    return;
  }

  if (command === "route") {
    handleRoute(args);
    return;
  }

  if (command === "proxy") {
    await handleProxy(args);
    return;
  }

  if (command === "config") {
    handleConfig(args);
    return;
  }

  if (command === "claude-config") {
    handleClaudeConfig(args);
    return;
  }

  if (command === "daemon") {
    await startDaemon(args);
    return;
  }

  if (command === "daemon-port") {
    ensureStateDir();
    const state = readDaemonState();
    if (!state || !state.localApiPort) {
      console.error("No running daemon found (no localApiPort in ~/.originrouter/daemon.state.json).");
      console.error(`Hint: run \`originrouter daemon\` in another terminal.`);
      process.exitCode = 1;
      return;
    }
    console.log(`http://127.0.0.1:${state.localApiPort}`);
    return;
  }

  if (command === "token") {
    handleTokenCommand(args);
    return;
  }

  if (command === "run") {
    const runArgs = parseRunArgs(args);
    runCommand(runArgs[0], runArgs.slice(1));
    return;
  }

  if (command === "claude-sdk") {
    await runClaudeSdkSession(args);
    return;
  }

  if (command === "claude-terminal") {
    await runLocalAgentSession("claude", args);
    return;
  }

  if (command === "claude" || command === "codex") {
    // `claude --terminal [args...]` is accepted as a no-op alias for the
    // default PTY path; the flag is stripped before forwarding. The PTY
    // route is the default for both `claude` and `codex`. To use the
    // structured SDK path, run `claude-sdk` instead.
    const forwardedArgs = command === "claude" && args.includes("--terminal")
      ? args.filter((arg) => arg !== "--terminal")
      : args;
    await runLocalAgentSession(command, forwardedArgs);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run `originrouter --help` for usage.");
  process.exitCode = 1;
}
