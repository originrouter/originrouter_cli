import { spawn } from "node:child_process";
import { startDaemon } from "./daemon/daemon.js";
import {
  CLAUDE_CONFIG_KEYS,
  buildAgentProviderEnv,
  maskSecret,
  remoteCodingRouteTarget,
  setClaudeConfigValue,
  summarizeClaudeConfig,
  unsetClaudeConfigValue,
  willRouteRemoteCoding,
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
  replaceAgentRoutes,
  setRoute,
} from "./config/routes.js";
import { LITELLM_VERSION } from "./proxy/litellm.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "./config/providerRoutes.js";
import { enabledProviderModelEntries } from "./config/providerModels.js";
import { ProxyManager } from "./proxy/manager.js";
import { readLocalProxySnapshot, NOOP_REMOTE_CODING_SNAPSHOT, snapshotRemoteCodingStatus, staticProxyStatusFn } from "./proxy/snapshot.js";
import { RemoteCodingProxyManager } from "./proxy/remoteCodingProxyManager.js";
import { runLocalAgentSession } from "./local/localAgentSession.js";
import { readSessions } from "./persistence/sessionLog.js";
import { AgentCatalog } from "./persistence/agentCatalog.js";
import { AgentBudgetStore } from "./agent/agentBudgetStore.js";
import { readApiToken, rotateApiToken } from "./persistence/authToken.js";
import {
  ensureStateDir,
  ensureDevice,
  getStateDir,
  readConfig,
  readDaemonState,
  readDevice,
  readLocalApiConfig,
  writeConfig,
  writeLocalApiConfig,
} from "./persistence/state.js";
import { LOOPBACK_ADDRESSES } from "./local/localApi.js";
// Stage 9.8: 集中式 CLI 错误信息产品化。所有 auth 路径的 catch
// 末尾调 formatCliError(err) — 不用手写 console.error。
import { formatCliError, reportCliError } from "./runtime/cliErrors.js";
// Stage 9.8: `originrouter doctor` 诊断命令。
import { runDoctor, printDoctorResults } from "./commands/doctor.js";
import { handleServiceCommand } from "./commands/service.js";
import { handleAuthCommand, handleLogin, handleLogout } from "./commands/auth.js";
import { handleAgentRouteSetup } from "./commands/agentRouteSetup.js";
import { handleSecurityCommand } from "./commands/security.js";
import { handleCollaborationCommand } from "./commands/collaboration.js";
import { handleAgentWorkspaceCommand } from "./commands/agentWorkspace.js";
import { handleHistoryCommand } from "./commands/history.js";
import { getCompletionCandidates, printCompletion } from "./commands/completion.js";
import {
  rollbackCompatibilityPack,
} from "./compatibility/patchStore.js";
import { checkCompatibilityPack, refreshCompatibilityPack } from "./compatibility/updater.js";
import { compatibilityPatchById, compatibilityStatus } from "./compatibility/status.js";
import {
  chooseCloudModel,
  chooseRemoteDevice,
  chooseRemoteProvider,
  loadCloudModels,
  loadCliDeviceDirectory,
  loadRemoteCliDevices,
  printCliDevices,
  printCloudModels,
  printRemoteCliDevices,
  remoteRouteEligibleDevices,
  remoteProviderName,
} from "./commands/routeSources.js";
import { runClaudeSdkSession } from "./runtime/claudeSdkSession.js";
import { runCodexAppServerSession } from "./runtime/codexAppServerSession.js";
import { runAgentGatewayMcpServer } from "./mcp/agentGatewayServer.js";
import {
  detectClaudeAgentSdkAvailability,
  detectCliAvailability,
  detectNodePtyAvailability,
  detectTmuxAvailability,
} from "./utils/detect.js";
import { DEFAULT_DEVICE_ID, DEFAULT_EXECUTOR, DEFAULT_LOCAL_API_PORT, DEFAULT_RELAY_URL, VERSION } from "./constants.js";
import {
  agentDetailDefaultFromConfig,
  setAgentDetailDefault,
} from "./runtime/agentDetailProfile.js";

function printHelp() {
  console.log(`originrouter ${VERSION}

Usage:
  originrouter
  originrouter "<objective>" [-c codex|claude] [--mode <mode>]
  originrouter --help
  originrouter --version
  originrouter completion bash|zsh|fish|powershell
  originrouter status
  originrouter doctor [provider <name>]
  originrouter sessions [--json]
  originrouter devices [--json]
  originrouter env print [--provider <name>] [--agent claude|codex]
  originrouter agent detail [set concise|standard|detailed]
  originrouter agent budget [show|set|clear] [device|claude|codex] [options]
  originrouter agent setup [--cloud|--native]
  originrouter agent history [--search <text>] [--agent claude|codex] [--device <id>] [--status <status>] [--json]
  originrouter agent history show <conversation-id> [--json]
  originrouter history [question] [--agent claude|codex] [--device <id>] [--workspace <id>] [--since <ISO>] [--until <ISO>] [--limit N] [--archived] [--json]

Agent collaboration:
  originrouter collaborate
  originrouter collaborate "<objective>" [--review|--yes] [--json]
  originrouter collaboration templates [--json]
  originrouter collaboration list [--category all|attention|active|recent] [--page N] [--page-size N] [--archived] [--json]
  originrouter collaboration drafts [--json]
  originrouter collaboration draft show|resume|delete <draft-id>
  originrouter collaboration show <run-id> [--json]
  originrouter collaboration attach <run-id> [--plain] [--verbose|--raw]
      [--participant <id>] [--task <id>]
  originrouter collaboration attention <run-id>
  originrouter collaboration resolve <run-id> <attention-id> --action <action> [--text <reply>]
  originrouter collaboration doctor <run-id> [--json]
  originrouter collaboration create --objective <text>
      --participant <id:claude|codex:device:workspace> [--participant ...]
      [--role <id=natural language responsibility>]
      [--route <id=provider:model>] [--permission <id=profile>]
      [--preference <text>] [--template <id>]
      [--coordination-prompt <text>] [--concurrency <n>]
      [--token-limit <n>] [--amount-limit <decimal>] [--currency <ISO-4217>]
      [--yes] [--detach] [--no-wait] [--timeout <seconds>]
  originrouter collaboration create "<objective>" [--review|--yes] [--json]
  originrouter collaboration create --spec <collaboration.json> [--yes]
  originrouter collaboration create --draft <draft-id>
  originrouter collaboration confirm <run-id>
  originrouter collaboration revise <run-id> [--feedback <text>]
  originrouter collaboration pause <run-id>
  originrouter collaboration resume <run-id>
  originrouter collaboration retry <run-id> [--task <task-id>]
  originrouter collaboration cancel <run-id>
  originrouter collaboration archive <run-id>
  originrouter collaboration delete <run-id> [--yes]
  originrouter collaboration export <run-id> [--format json|markdown]

Local LiteLLM provider management:
  originrouter provider add <name> [--type proxy] [--base-url <u>] [--model <m>]
                                   [--engine <e>] [--litellm-provider <id>] [--api-key <k>] [--auth-token <k>]
                                   [--organization <o>] [--small-fast-model <m> [legacy]] [--api-version <v>]
                                   [--aws-region <r>] [--aws-access-key-id <id>] [--aws-secret-access-key <k>]
                                   [--aws-session-token <t>] [--aws-profile-name <p>]
                                   [--aws-bedrock-runtime-endpoint <u>] [--aws-role-name <r>] [--aws-session-name <n>]
                                   [--aws-web-identity-token <t>] [--aws-sts-endpoint <u>] [--sagemaker-base-url <u>]
                                   [--vertex-project <id>] [--vertex-location <loc>] [--vertex-credentials <json>]
                                   [--google-application-credentials <path>] [--azure-ad-token <t>] [--hf-token <t>]

  --type proxy         Local LiteLLM proxy. Use --engine litellm (default) + --litellm-provider <id>.
                        --type litellm is accepted as an alias and persisted as proxy(engine=litellm).
  OriginRouter Cloud and remote devices are login-backed route sources, not local providers.

originrouter provider update <name> [same flags as add]
  originrouter provider list
  originrouter provider show <name>
  originrouter provider use <name> [--agent claude|codex] [--force]
  originrouter provider remove <name>

Model routes:
  originrouter route list
  originrouter route show [claude|codex]
  originrouter route set claude --provider <name> --main-model <m> --small-model <m>
  originrouter route clear claude
  originrouter route set <agent>.<slot> --provider <name> [--model <m>]
                                 claude slots: main, small; codex slot: main
  originrouter route clear <agent>.<slot>
  originrouter route cloud models
  originrouter route cloud set <agent>.<slot> [--model <id>]
  originrouter route remote devices
  originrouter route remote set <agent>.<slot> [--device <id>] [--model <id>]
  Aliases are fixed: originrouter-claude-model, originrouter-claude-fast-model, and gpt-5.4.

LiteLLM proxy:
  originrouter proxy install [--version <v>]      default version 1.83.0
  originrouter proxy start --port <p>            routes mode (default; reads routes.claude)
  originrouter proxy start --provider <name> --port <p>   legacy / debug — NOT for use with originrouter claude
  originrouter proxy stop
  originrouter proxy restart [--port <p>]         restart in routes mode using current port
  originrouter proxy switch   [--port <p>]        alias for proxy restart
  originrouter proxy status

Model compatibility patches:
  originrouter compatibility status [--json]
  originrouter compatibility list [--json]
  originrouter compatibility inspect <patch-id> [--json]
  originrouter compatibility check [--json]
  originrouter compatibility update [--json]
  originrouter compatibility refresh [--json]       alias for update
  originrouter compatibility rollback

Provider field metadata:
  Every --flag maps to a catalog field for the chosen --litellm-provider.
  Unknown flags are rejected. Fields can be literal values or env references
  (e.g. --api-key os.environ/DEEPSEEK_API_KEY). Secret fields are masked in
  all CLI / API output.

Local API auth:
  originrouter token show                            Print the current token + Local API URL
  originrouter token rotate                          Mint a new token (invalidates existing clients)
  originrouter local key show                        Alias for token show
  originrouter local key rotate                      Alias for token rotate
  originrouter local config show                     Print persisted local API bind/port settings
  originrouter local config set [--port <p>] [--bind <addr>] [--allow-lan on|off] [--relay-mode auto|cloud|local|custom] [--relay-url <url>]

Legacy config commands (deprecated, prefer 'originrouter provider add'):
  originrouter config show
  originrouter config set claude.<key> <value>
  originrouter config unset claude.<key>
  originrouter claude-config --base-url <url> --api-key <key> --model <model> --small-fast-model <model> [legacy]

Other:
  originrouter daemon [--relay https://app.easytransnote.com] [--relay-mode auto|cloud|local|custom] [--device <device-id>] [--local-port <p>]
                      [--bind 127.0.0.1|0.0.0.0] [--allow-lan]
  originrouter daemon-port                           Print the running daemon's local API URL (reads daemon.state.json)
  originrouter service install|start|stop|restart|status|uninstall
  originrouter run -- <command> [args...]
  originrouter claude [args...]                   Start native Claude Code TUI with remote control
  originrouter codex [args...]                    Start native Codex TUI with remote control
  originrouter claude-terminal [args...]          Start managed Claude Agent SDK session
  originrouter codex-terminal [args...]           Start managed Codex app-server session
  originrouter claude-sdk [args...]               Alias for managed Claude session
  originrouter codex-app-server [args...]         Alias for managed Codex session
  --originrouter-autonomy <profile>                manual|guarded|ai_review|unrestricted|custom
  --originrouter-policy <id-or-path>               Approval policy ID or JSON file for custom mode

Examples:
  originrouter run -- bash
  # Proxy provider (LiteLLM via local proxy). The --type litellm
  # alias and --engine litellm are equivalent to the canonical --type proxy.
  originrouter provider add minimax --type proxy --engine litellm --litellm-provider anthropic --base-url https://api.easytransnote.com/coding --api-key sk-v1-xxx --model MiniMax-M3 --small-fast-model MiniMax-M2.7
  # Login-backed source selectors: Cloud presents the available models; Remote
  # presents the authorized CLI devices for the current account.
  originrouter route cloud set claude.main
  originrouter route remote set codex.main
  originrouter provider use minimax
  originrouter env print
  originrouter claude
  originrouter route set claude.main --provider minimax --model MiniMax-M3
  originrouter claude-config --base-url https://x --api-key sk-y --model m   # legacy: writes config.claude
  originrouter claude-sdk --model MiniMax-M3
  originrouter codex --model gpt-5-codex
  originrouter sessions
  originrouter sessions --json
  # Provider fields can be env references. The shell var name is
  # stored verbatim; LiteLLM reads the env itself at startup.
  originrouter provider add bedrock-irsa --type proxy --engine litellm --litellm-provider bedrock \
    --aws-region os.environ/AWS_REGION_NAME \
    --aws-role-name arn:aws:iam::123456789012:role/MyBedrockRole \
    --aws-web-identity-token os.environ/AWS_WEB_IDENTITY_TOKEN_FILE \
    --model anthropic.claude-3-5-sonnet-20241022-v2:0

OriginRouter OAuth login:
  originrouter login [status] [--surety-url <url>] [--login-url <url>]
                     [--device-name <name>]
                     [--no-browser]
                     [--configure-agents|--keep-agent-routes|--no-agent-setup]
  originrouter logout [--remove-device]
  originrouter auth status|verify
  originrouter security status|rotate

  Login uses RFC 8628 Device Authorization Grant directly with Surety. It prints
  an 8-character user code + verification URL, opens the browser
  (unless --no-browser), and polls Surety until you approve
  on the browser authorization page. Works for SSH, Docker, CI, or any environment
  where the CLI cannot receive a browser redirect.

  --no-browser     Do not auto-open the browser; only print the
                   URL + code. Use this in headless / SSH / Docker
                   / CI environments.
  --surety-url     Surety OAuth base URL. Defaults to SURETY_BASE_URL
                   or https://surety.easytransnote.com.
  --login-url      Browser authorization page base URL.
  --configure-agents  Apply OriginRouter Cloud recommended Claude/Codex models after login.
  --keep-agent-routes Keep Agent routes unchanged, including private Provider routes.
  --no-agent-setup    Alias for --keep-agent-routes; useful in scripts and CI.

  The CLI stores one rotating Refresh Token and separate short-lived
  Access Tokens for Control, AI, Coding, and Relay. The installation
  device ID is random, persisted locally, and never derived from MAC,
  serial number, machine-id, or other hardware identifiers.

OriginRouter wrapper options for claude/codex:
  --provider <name>                              Deprecated for claude; use 'originrouter route set'. Reserved for legacy/debug paths.
  --originrouter-relay https://app.easytransnote.com
  --originrouter-relay-mode auto|cloud|local|custom  auto uses authenticated cloud when signed in, otherwise local-only
  --originrouter-device <device-id>
  --originrouter-session session-id
  --originrouter-autonomy manual|guarded|ai_review|unrestricted|custom
  --originrouter-detail concise|standard|detailed  Override this session's installed default
  --originrouter-auto-approve                    Alias for --originrouter-autonomy guarded
  --originrouter-auto-allow <scope[,scope...]>   Use a custom unattended allow-list; repeatable
                                                 scopes: plan_continue, explicit_continue_questions, read_tools,
                                                 workspace_edits, workspace_commands, additional_permissions,
                                                 destructive_commands, elevated_commands, network_mutations,
                                                 outside_workspace, unknown_tools
  --originrouter-native-config                   Native TUI only: use the installed Claude/Codex auth, model, environment, and config; keep OriginRouter remote control only
  --originrouter-native                          Alias for --originrouter-native-config
`);
}

function printSummaryHelp() {
  console.log(`originrouter ${VERSION} — local control plane for Claude Code and Codex

Usage:
  originrouter                       Open Agent Workspace in the current folder
  originrouter "<objective>"         Run an objective with an auto-managed team
  originrouter -c codex|claude       Choose the default coordinator
  originrouter --mode <mode>         auto, solo, build-review, plan-build-verify,
                                    parallel-research, review-panel, or remote-ops
  originrouter <command> [options]
  originrouter claude [native Claude Code args...]
  originrouter codex [native Codex args...]

Start here:
  doctor                 Check dependencies, account, relay, and providers
  service                Install, start, stop, or inspect the background service
  agent setup            Choose native configuration or an OriginRouter route
  claude | codex         Launch a native agent with remote control

Models and routing:
  provider               Add, update, inspect, and remove local providers
  route                  Assign local, cloud, or remote models to agent slots
  route list             Show every configured Agent route
  route set <agent.slot> Assign a Provider and model to one route slot
  proxy                  Install and manage the local LiteLLM proxy
  compatibility          Inspect signed protocol compatibility updates

  Route aliases: originrouter-claude-model, originrouter-claude-fast-model,
                 and gpt-5.4

Sessions and control:
  sessions | devices     Inspect local sessions or authorized devices
  history                Query display-safe Agent history
  collaborate            Start a guided multi-agent collaboration
  collaboration          Inspect and control collaboration runs
  local | security       Manage the Local API and device security

Account:
  originrouter login [--no-browser]
  originrouter logout
  originrouter auth status|verify

Discoverability:
  originrouter completion bash|zsh|fish|powershell
  originrouter help all              Show the exhaustive command reference
  https://originrouter.com/docs/originrouter-cli/commands
`);
}

export function resolveAgentCommand(command, args = []) {
  if (command === "claude") {
    return {
      agent: "claude",
      runtime: "native-pty",
      args: args.includes("--terminal")
        ? args.filter((arg) => arg !== "--terminal")
        : args.slice(),
    };
  }
  if (command === "codex") {
    return { agent: "codex", runtime: "native-pty", args: args.slice() };
  }
  if (command === "claude-sdk" || command === "claude-terminal") {
    return { agent: "claude", runtime: "claude-sdk", args: args.slice() };
  }
  if (command === "codex-terminal" || command === "codex-app-server") {
    return { agent: "codex", runtime: "codex-app-server", args: args.slice() };
  }
  return null;
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

function printAgentHistory(records) {
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

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function handleAgentSettings(args) {
  const [section, action, value] = args;
  if (section === "setup") {
    await handleAgentRouteSetup(args.slice(1), { stateDir: ensureStateDir() });
    return;
  }
  if (section === "history") {
    const catalog = new AgentCatalog({ stateDir: ensureStateDir() });
    try {
      catalog.migrateLegacySessions(readSessions());
      if (action === "show") {
        if (!value) {
          throw new Error("Usage: originrouter agent history show <conversation-id> [--json]");
        }
        const conversation = catalog.getConversation(value);
        if (!conversation) throw new Error(`Agent conversation not found: ${value}`);
        if (args.includes("--json")) console.log(JSON.stringify(conversation, null, 2));
        else printAgentHistory([conversation]);
        return;
      }
      const records = catalog.listConversations({
        search: argumentValue(args, "--search") || "",
        agent: argumentValue(args, "--agent") || "",
        deviceId: argumentValue(args, "--device") || "",
        workspaceId: argumentValue(args, "--workspace") || "",
        status: argumentValue(args, "--status") || "",
        limit: argumentValue(args, "--limit") || 50,
        includeArchived: args.includes("--archived"),
      });
      if (args.includes("--json")) console.log(JSON.stringify(records, null, 2));
      else printAgentHistory(records);
    } finally {
      catalog.close();
    }
    return;
  }
  if (section === "budget") {
    const store = new AgentBudgetStore({ stateDir: ensureStateDir() });
    try {
      const snapshot = store.snapshot();
      if (!action || action === "show") {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      const scope = value;
      if (!["device", "claude", "codex"].includes(scope)) {
        throw new Error(
          "Usage: originrouter agent budget set|clear device|claude|codex [options]",
        );
      }
      const policies = {
        device: snapshot.device.policy,
        agents: {
          claude: snapshot.agents.claude.policy,
          codex: snapshot.agents.codex.policy,
        },
      };
      const target = action === "clear"
        ? {}
        : {
            daily_token_limit: argumentValue(args, "--daily-tokens"),
            weekly_token_limit: argumentValue(args, "--weekly-tokens"),
            daily_amount_limit_micros: amountMicros(
              argumentValue(args, "--daily-amount"),
            ),
            weekly_amount_limit_micros: amountMicros(
              argumentValue(args, "--weekly-amount"),
            ),
            currency: argumentValue(args, "--currency") || "USD",
            enforcement: argumentValue(args, "--enforcement") || "block",
          };
      if (action !== "set" && action !== "clear") {
        throw new Error(
          "Usage: originrouter agent budget show|set|clear device|claude|codex",
        );
      }
      if (scope === "device") policies.device = target;
      else policies.agents[scope] = target;
      console.log(JSON.stringify(store.setPolicies(policies), null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (section !== "detail") {
    throw new Error(
      "Usage: originrouter agent setup [--cloud|--native] | " +
      "originrouter agent detail [set concise|standard|detailed] | " +
      "originrouter agent budget [show|set|clear] | " +
      "originrouter agent history [options]",
    );
  }
  if (!action || action === "show") {
    console.log(agentDetailDefaultFromConfig(readConfig()));
    return;
  }
  if (action !== "set" || !value) {
    throw new Error("Usage: originrouter agent detail set concise|standard|detailed");
  }
  const next = setAgentDetailDefault(readConfig(), value);
  writeConfig(next);
  console.log(`Agent detail default: ${agentDetailDefaultFromConfig(next)}`);
}

function amountMicros(value) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Agent budget amount must be a positive number");
  }
  return Math.round(amount * 1_000_000);
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
      "Usage: originrouter provider add <name> [--type litellm] [--base-url <u>] [--model <m>] " +
      "[--engine <e>] [--litellm-provider <id>] [--api-key <k>] [--auth-token <k>] " +
      "[--organization <o>] [--small-fast-model <m>] [--api-version <v>] [--aws-region <r>] " +
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
  //
  // Manual provider writes are local LiteLLM-only. Cloud and remote records
  // are generated by their login-backed route commands.
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

  // Remote and OriginRouter Cloud records are generated by their route
  // commands. Manual provider writes remain local LiteLLM-only.
  if (opts["--device-id"] != null && opts["--device-id"] !== "") {
    out.deviceId = opts["--device-id"];
  }
  if (opts["--target"] != null && opts["--target"] !== "") {
    if (opts["--target"] !== "proxy" && opts["--target"] !== "agent") {
      throw new Error(`--target must be 'proxy' or 'agent' (got '${opts["--target"]}')`);
    }
    out.target = opts["--target"];
  }
  if (opts["--engine"] != null && opts["--engine"] !== "") {
    if (opts["--engine"] !== "litellm") {
      throw new Error(`--engine must be 'litellm' in Stage 9.0 (got '${opts["--engine"]}')`);
    }
    out.engine = opts["--engine"];
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
    assertManualProviderWriteIsLocalProxy(config, opts, "add");
    const next = addProviderFromFlags(config, opts);
    writeConfig(next);
    maybeNoteLegacySmallFastModel(opts);
    return printProviderShow(cliProviderForShow(readConfig(), opts.name));
  }

  if (action === "update") {
    if (!name) throw new Error("Usage: originrouter provider update <name> [flags...]");
    const opts = parseProviderAddOptions([name, ...rest]);
    assertManualProviderWriteIsLocalProxy(config, opts, "update");
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
      // Claude is one grouped routing profile: main and small always share
      // the selected Provider. Model selection can still differ later.
      const { next } = setClaudeRouteFromProvider(config, name);
      writeConfig(next);
      const updated = getRoutes(next);
      console.log("Claude routes updated:");
      console.log(`  model ${MAIN_ALIAS.padEnd(28)} -> ${updated.main.provider} / ${updated.main.model}`);
      console.log(`  fast  ${SMALL_ALIAS.padEnd(28)} -> ${updated.small.provider} / ${updated.small.model}`);
      return;
    }

    // Stage 8.0: codex is route-mode only. `provider use <name> --agent codex`
    // writes routes.codex.main = { provider: name, model: provider.model }.
    // Codex 8.0 has no small/fast slot. Codex never falls back to Claude.
    if (agent === "codex") {
      const model = enabledProviderModelEntries(target)[0]?.id;
      if (!model) throw new Error(`provider '${name}' has no enabled model`);
      const next = setRoute(config, "codex", "main", { provider: name, model });
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

/// A manually created Provider always represents this machine's LiteLLM
/// configuration. Cloud and remote records carry account-scoped grants and
/// must be created by the login-backed route selectors below.
function assertManualProviderWriteIsLocalProxy(config, opts, action) {
  const requestedType = opts.type || "proxy";
  if (requestedType === "openai-compatible") {
    throw new Error(
      "type 'openai-compatible' is no longer supported. " +
      "Use --type proxy --litellm-provider custom_openai instead.",
    );
  }
  if (requestedType !== "proxy" && requestedType !== "litellm") {
    throw new Error(
      `provider ${action} only supports local LiteLLM proxy providers. ` +
      "Use `originrouter route cloud set <agent>.<slot>` for OriginRouter Cloud " +
      "or `originrouter route remote set <agent>.<slot>` for an authorized device.",
    );
  }
  if (opts.auth || opts.deviceId || opts.target) {
    throw new Error(
      "Login-backed provider fields are not accepted here. Use `originrouter route cloud` or `originrouter route remote`.",
    );
  }
  if (action === "update") {
    const current = (config.providers || {})[opts.name];
    if (!current) throw new Error(`unknown provider '${opts.name}'`);
    if (normalizeProviderForRead(current).type !== "proxy") {
      throw new Error(
        `provider '${opts.name}' is login-backed and cannot be edited manually. ` +
        "Choose its model or device through `originrouter route cloud` / `originrouter route remote`.",
      );
    }
  }
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

async function handleRoute(args) {
  const [action, ...rest] = args;

  if (action === "cloud") return handleCloudRouteSource(rest);
  if (action === "remote") return handleRemoteRouteSource(rest);

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
    if (target === "claude") {
      const mainModel = opts["--main-model"] || opts["--model"];
      const smallModel = opts["--small-model"] || mainModel;
      if (!mainModel || !smallModel) {
        throw new Error(
          "Usage: originrouter route set claude --provider <name> " +
          "--main-model <model> [--small-model <model>]",
        );
      }
      const provider = opts["--provider"];
      const next = replaceAgentRoutes(config, "claude", {
        main: { provider, model: mainModel },
        small: { provider, model: smallModel },
      });
      writeConfig(next);
      console.log("Claude routes set.");
      printRouteShow(next, "claude");
      return;
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
    if (target === "claude") {
      const next = replaceAgentRoutes(config, "claude", {});
      writeConfig(next);
      console.log("Cleared Claude routes. Claude Code will use its environment or Anthropic login.");
      return;
    }
    const { agent, slot } = parseRouteTarget(target);
    const next = clearRoute(config, agent, slot);
    writeConfig(next);
    console.log(`Cleared route ${target}.`);
    return;
  }
  throw new Error(`Unknown route action: ${action}`);
}

async function handleCloudRouteSource(args) {
  const [action, ...rest] = args;
  const stateDir = ensureStateDir();
  const models = await loadCloudModels({ stateDir });

  if (action === "models") {
    printCloudModels(models);
    return;
  }
  if (action !== "set") {
    throw new Error(
      "Usage: originrouter route cloud models | set <agent>.<slot> [--model <id>]",
    );
  }

  const target = rest[0];
  const options = parseOptionArgs(rest.slice(1));
  const { agent, slot } = parseRouteTarget(target);
  const selectedModel = await chooseCloudModel(models, options["--model"]);
  const config = readConfig();
  const providers = config.providers || {};
  const existing = Object.values(providers).find(
    (provider) => normalizeProviderForRead(provider).type === "originrouter",
  );
  let next = config;
  let providerName;
  if (existing) {
    providerName = existing.name;
  } else {
    if (providers["originrouter-cloud"]) {
      throw new Error(
        "Provider name 'originrouter-cloud' is reserved for the login-backed Cloud route source.",
      );
    }
    providerName = "originrouter-cloud";
    next = addProvider(next, {
      name: providerName,
      type: "originrouter",
      model: selectedModel.id,
      auth: { type: "oauth" },
    });
  }
  next = setRoute(next, agent, slot, {
    provider: providerName,
    model: selectedModel.id,
  });
  writeConfig(next);
  console.log(`Route ${target} now uses OriginRouter Cloud: ${selectedModel.id}.`);
}

async function handleRemoteRouteSource(args) {
  const [action, ...rest] = args;
  const stateDir = ensureStateDir();
  const allDevices = await loadRemoteCliDevices({
    stateDir,
    env: deviceDirectoryEnvironment(),
  });
  const devices = remoteRouteEligibleDevices(allDevices);

  if (action === "devices") {
    printRemoteCliDevices(devices, console.log, { allDevices });
    return;
  }
  if (action !== "set") {
    throw new Error(
      "Usage: originrouter route remote devices | set <agent>.<slot> [--device <id>] [--model <id>]",
    );
  }

  const target = rest[0];
  const options = parseOptionArgs(rest.slice(1));
  const { agent, slot } = parseRouteTarget(target);
  const device = await chooseRemoteDevice(devices, options["--device"]);
  const selected = await chooseRemoteProvider(device, options["--model"]);
  const selectedModel = selected.provider;
  const config = readConfig();
  const providers = config.providers || {};
  const existing = Object.values(providers).find((provider) =>
    normalizeProviderForRead(provider).type === "remote" &&
      provider.target === "proxy" &&
      provider.deviceId === device.deviceId,
  );
  let next = config;
  let providerName;
  if (existing) {
    providerName = existing.name;
  } else {
    providerName = remoteProviderName(device.deviceId);
    if (providers[providerName]) {
      throw new Error(
        `Provider name '${providerName}' is reserved for remote device '${device.deviceId}'.`,
      );
    }
    next = addProvider(next, {
      name: providerName,
      type: "remote",
      deviceId: device.deviceId,
      target: "proxy",
      auth: { type: "oauth" },
      model: selectedModel,
    });
  }
  next = setRoute(next, agent, slot, {
    provider: providerName,
    model: selectedModel,
  });
  writeConfig(next);
  console.log(`Route ${target} now uses remote CLI device: ${device.deviceName || device.deviceId}.`);
}

async function handleDevices(args) {
  const unsupported = args.filter((item) => item !== "--json");
  if (unsupported.length > 0) {
    throw new Error("Usage: originrouter devices [--json]");
  }
  const devices = await loadCliDeviceDirectory({
    stateDir: ensureStateDir(),
    env: deviceDirectoryEnvironment(),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }
  printCliDevices(devices);
}

function deviceDirectoryEnvironment() {
  if (process.env.ORIGINROUTER_CONTROL_BASE_URL || process.env.ORIGINROUTER_API_BASE_URL) {
    return process.env;
  }
  const relayUrl = readDaemonState()?.relayUrl;
  return {
    ...process.env,
    ORIGINROUTER_CONTROL_BASE_URL:
      typeof relayUrl === "string" && relayUrl.trim()
        ? relayUrl.trim()
        : DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
  };
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

async function handleCompatibility(args) {
  const [action = "status", ...rest] = args;
  const stateDir = ensureStateDir();
  const json = rest.includes("--json");
  const printJson = (value) => console.log(JSON.stringify(value, null, 2));
  if (action === "status") {
    const status = compatibilityStatus(stateDir);
    if (json) return printJson(status);
    console.log(`Compatibility engine: ${status.engine_version}`);
    console.log(`Active bundle: ${status.bundle_id} revision ${status.revision} (${status.source})`);
    console.log(`Patches: ${status.patches.length}`);
    console.log(`Automatic updates: ${status.automatic_updates ? "enabled" : "disabled"}`);
    if (status.last_checked_at) console.log(`Last update check: ${status.last_checked_at}`);
    if (status.update_available) console.log(`Update available: revision ${status.latest_revision}`);
    return;
  }
  if (action === "list") {
    const status = compatibilityStatus(stateDir);
    if (json) return printJson(status.patches);
    if (status.patches.length === 0) {
      console.log("No compatibility patches are active.");
      return;
    }
    for (const patch of status.patches) {
      console.log(`${patch.id}  ${patch.version}  ${patch.phase}`);
      console.log(`  ${patch.name}`);
      if (patch.description) console.log(`  ${patch.description}`);
    }
    return;
  }
  if (action === "inspect") {
    const patchId = rest.find((item) => !item.startsWith("--"));
    if (!patchId) throw new Error("Usage: originrouter compatibility inspect <patch-id> [--json]");
    const patch = compatibilityPatchById(stateDir, patchId);
    if (!patch) throw new Error(`Compatibility patch '${patchId}' is not active.`);
    if (json) return printJson(patch);
    console.log(`${patch.name} (${patch.id})`);
    console.log(`Version: ${patch.version}`);
    console.log(`Phase: ${patch.phase}`);
    console.log(`Required: ${patch.required ? "yes" : "no"}`);
    console.log(`Failure mode: ${patch.failure_mode}`);
    if (patch.description) console.log(`Description: ${patch.description}`);
    console.log(`Match: ${JSON.stringify(patch.match)}`);
    return;
  }
  if (action === "check") {
    const result = await checkCompatibilityPack({ stateDir });
    const status = compatibilityStatus(stateDir);
    if (json) return printJson({ result: {
      update_available: result.update_available,
      latest_revision: result.latest_revision,
      reason: result.reason || null,
    }, status });
    console.log(result.update_available
      ? `Compatibility update available: revision ${result.latest_revision}.`
      : "Compatibility patches are current.");
    return;
  }
  if (action === "refresh" || action === "update") {
    const result = await refreshCompatibilityPack({ stateDir });
    if (result.skipped) {
      console.error(
        "Compatibility update skipped: no trusted signing keys are configured for this CLI build.",
      );
      process.exitCode = 1;
      return;
    }
    if (json) return printJson({ result: {
      installed: result.installed === true,
      reason: result.reason || null,
    }, status: compatibilityStatus(stateDir) });
    console.log(result.installed
      ? `Installed ${result.pack.bundle_id || result.pack.pack_id} revision ${result.pack.revision}. Running gateways reload it automatically.`
      : `Compatibility patches are current (${result.reason || "unchanged"}).`);
    return;
  }
  if (action === "rollback") {
    const result = rollbackCompatibilityPack(stateDir);
    if (!result.rolledBack) {
      console.error("No previous compatibility pack is available.");
      process.exitCode = 1;
      return;
    }
    if (json) return printJson({ rolled_back: true, status: compatibilityStatus(stateDir) });
    console.log(
      `Rolled back to ${result.pack.bundle_id || result.pack.pack_id} revision ${result.pack.revision}. Running gateways reload it automatically.`,
    );
    return;
  }
  throw new Error("Usage: originrouter compatibility status|list|inspect|check|update|refresh|rollback");
}

// ---------- token (Stage 6) ----------

// Builds the canonical Local API URL. Reads the daemon port from
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
  let host = "127.0.0.1";
  try {
    const state = readDaemonState();
    const bind = state?.localApiBindAddress;
    if (bind && bind !== "0.0.0.0") host = bind;
  } catch {}
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  if (!port) {
    // Best-effort: the user can still paste the token into a manually-built URL.
    return `http://${urlHost}:<port>/?daemon=${urlHost}:<port>&token=${token}`;
  }
  return `http://${urlHost}:${port}/?daemon=${urlHost}:${port}&token=${token}`;
}

function handleTokenCommand(args) {
  const stateDir = ensureStateDir();
  const [action] = args;
  if (action === "rotate") {
    const token = rotateApiToken(stateDir);
    console.log("Token rotated.");
    console.log(`Token file: ${stateDir}/local-api.token`);
    console.log(`Default local API port: ${DEFAULT_LOCAL_API_PORT}`);
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
    console.log(`Default local API port: ${DEFAULT_LOCAL_API_PORT}`);
    console.log(`API URL: ${buildApiUrl(stateDir, token)}`);
    return;
  }
  throw new Error(`Unknown token action: ${action}`);
}

function parseLocalConfigPort(raw) {
  if (raw == null || raw === "") return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`--port must be an integer in [0, 65535] (got '${raw}')`);
  }
  return parsed;
}

function parseOnOff(raw, flag) {
  if (raw == null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${flag} must be on|off`);
}

function handleLocalConfigCommand(args) {
  const stateDir = ensureStateDir();
  const [action] = args;
  if (!action || action === "show") {
    const config = readLocalApiConfig();
    const state = readDaemonState();
    console.log(`Config file: ${stateDir}/local-api.json`);
    console.log(`Token file:  ${stateDir}/local-api.token`);
    console.log(`port:        ${config.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${config.bindAddress || "127.0.0.1"}`);
    console.log(`allowLan:    ${config.allowLan === true ? "on" : "off"}`);
    console.log(`relayMode:   ${config.relayMode || "auto"}`);
    console.log(`relayUrl:    ${config.relayUrl || DEFAULT_RELAY_URL}`);
    if (state?.localApiPort) {
      console.log(`running:     ${state.localApiBaseUrl || `http://127.0.0.1:${state.localApiPort}`}`);
    }
    return;
  }
  if (action === "set") {
    const port = parseLocalConfigPort(_parseFlag(args, "port"));
    const bindAddress = _parseFlag(args, "bind");
    const allowLan = parseOnOff(_parseFlag(args, "allow-lan"), "--allow-lan");
    const relayModeRaw = _parseFlag(args, "relay-mode");
    const relayUrl = _parseFlag(args, "relay-url");
    const relayMode = relayModeRaw
      ? String(relayModeRaw).trim().toLowerCase()
      : undefined;
    if (
      relayMode &&
      !["auto", "cloud", "local", "custom"].includes(relayMode)
    ) {
      throw new Error("--relay-mode must be auto|cloud|local|custom");
    }
    const patch = {};
    if (port !== undefined) patch.port = port;
    if (bindAddress) patch.bindAddress = bindAddress;
    if (allowLan !== undefined) patch.allowLan = allowLan;
    if (relayMode) patch.relayMode = relayMode;
    if (relayUrl) patch.relayUrl = relayUrl;
    if (Object.keys(patch).length === 0) {
      throw new Error("Usage: originrouter local config set [--port <p>] [--bind <addr>] [--allow-lan on|off] [--relay-mode auto|cloud|local|custom] [--relay-url <url>]");
    }
    const next = writeLocalApiConfig(patch);
    console.log("Local API config updated.");
    console.log(`port:        ${next.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${next.bindAddress || "127.0.0.1"}`);
    console.log(`allowLan:    ${next.allowLan === true ? "on" : "off"}`);
    console.log(`relayMode:   ${next.relayMode || "auto"}`);
    console.log(`relayUrl:    ${next.relayUrl || DEFAULT_RELAY_URL}`);
    console.log("Restart `originrouter daemon` for changes to take effect.");
    return;
  }
  throw new Error("Usage: originrouter local config show|set");
}

// Stage L: `local api status | set-host | set-port`.
//
// `local config` keeps its existing show/set semantics; the new `api`
// subnamespace groups status / set-host / set-port for users who
// reach Proxy Control from the App and need to copy / rotate the
// daemon bearer key on demand. We never echo the token value —
// `tokenSet: yes|no` only.
function handleLocalApiCommand(args) {
  const stateDir = ensureStateDir();
  const [sub, ...rest] = args;
  if (!sub || sub === "status") {
    const config = readLocalApiConfig();
    const state = readDaemonState();
    const tokenSet = Boolean(readApiToken(stateDir));
    console.log(`Config file: ${stateDir}/local-api.json`);
    console.log(`port:        ${config.port ?? DEFAULT_LOCAL_API_PORT}`);
    console.log(`bindAddress: ${config.bindAddress || "127.0.0.1"}`);
    console.log(`allowLan:    ${config.allowLan === true ? "on" : "off"}`);
    console.log(`tokenSet:    ${tokenSet ? "yes" : "no"}`);
    if (state?.localApiPort) {
      console.log(
        `running:     ${state.localApiBaseUrl || `http://127.0.0.1:${state.localApiPort}`}`,
      );
    } else {
      console.log(`running:     no`);
    }
    return;
  }
  if (sub === "set-host") {
    const host = rest[0];
    if (!host) {
      throw new Error("Usage: originrouter local api set-host <address> [--allow-lan on]");
    }
    const trimmed = String(host).trim();
    const allowLanFlag = parseOnOff(_parseFlag(args, "allow-lan"), "--allow-lan");
    const existing = readLocalApiConfig();
    const allowLan = allowLanFlag !== undefined
      ? allowLanFlag
      : (existing.allowLan === true);
    const isLoopback = LOOPBACK_ADDRESSES.has(trimmed.toLowerCase());
    if (!isLoopback) {
      // Non-loopback bind MUST have a token in the store, otherwise
      // remote clients can connect anonymously. Refuse before
      // persisting so the user has to mint one first.
      if (!readApiToken(stateDir)) {
        throw new Error(
          `Refusing to bind "${trimmed}" without a bearer token. ` +
          `Run \`originrouter daemon\` first to mint one, then retry.`,
        );
      }
      if (!allowLan) {
        throw new Error(
          `Refusing to bind "${trimmed}" without --allow-lan on.`,
        );
      }
    }
    writeLocalApiConfig({ bindAddress: trimmed, allowLan });
    console.log(`bindAddress: ${trimmed}`);
    console.log(`tokenSet:    ${readApiToken(stateDir) ? "yes" : "no"}`);
    console.log("Restart `originrouter daemon` for the change to take effect.");
    return;
  }
  if (sub === "set-port") {
    const port = parseLocalConfigPort(rest[0]);
    if (port === undefined) {
      throw new Error("Usage: originrouter local api set-port <int>");
    }
    writeLocalApiConfig({ port });
    const existingState = readDaemonState();
    console.log(`port: ${port}`);
    if (existingState?.localApiPort && existingState.localApiPort !== port) {
      console.log(
        `WARNING: daemon is currently bound to port ${existingState.localApiPort}. ` +
          `Restart \`originrouter daemon\` to apply.`,
      );
    } else {
      console.log("Restart `originrouter daemon` for the change to take effect.");
    }
    return;
  }
  throw new Error("Usage: originrouter local api status|set-host <addr>|set-port <int>");
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
    // Stage 9.0: originrouter / remote shape.
    "auth", "deviceId", "target", "engine",
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

const ANTHROPIC_ENV_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"];
// Stage 9.1B: Codex uses OPENAI_* env vars, not ANTHROPIC_*.
const OPENAI_ENV_VARS    = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"];
function envVarsFor(agent) {
  return agent === "codex" ? OPENAI_ENV_VARS : ANTHROPIC_ENV_VARS;
}

async function handleEnvPrint(args) {
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
      console.log("  (unset — existing Codex login and environment are preserved)");
    }
    if (flagName) {
      console.log(`\nNote: --provider ${flagName} is deprecated for codex in Stage 8.0. Routes are the source of truth.`);
    }
  } else {
    throw new Error(`--agent must be 'claude' or 'codex' (got '${agent}')`);
  }

  let providerResult = null;
  let providerError = null;
  // Stage 9.2: when the resolved route is type=remote, target=proxy,
  // env print starts a temporary RemoteCodingProxyManager in this
  // process so the printed ANTHROPIC_BASE_URL / OPENAI_BASE_URL shows
  // the real ephemeral port the runtime would use. The manager is
  // torn down before this function returns. This matches the
  // `localAgentSession.js` lifecycle exactly so the env print and
  // the runtime see the same `Source: remote-coding` and the same port.
  let remoteCodingProxyManager = null;
  let remoteCodingStatus = staticProxyStatusFn(NOOP_REMOTE_CODING_SNAPSHOT);
  if (willRouteRemoteCoding(config, agent)) {
    try {
      const stateDir = (() => {
        try { return ensureStateDir(); }
        catch { return null; }
      })();
      const device = (() => {
        try { return ensureDeviceForLogin(); }
        catch { return { deviceId: DEFAULT_DEVICE_ID }; }
      })();
      const relayUrl = process.env.ORIGINROUTER_RELAY || DEFAULT_RELAY_URL;
      if (stateDir) {
        remoteCodingProxyManager = new RemoteCodingProxyManager({
          stateDir,
          relayUrl,
          deviceId: device.deviceId,
          targetDeviceId: remoteCodingRouteTarget(config, agent),
        });
        const startResult = await remoteCodingProxyManager.start();
        if (startResult.ok) {
          const snap = await snapshotRemoteCodingStatus(remoteCodingProxyManager);
          remoteCodingStatus = staticProxyStatusFn(snap);
        } else {
          remoteCodingProxyManager = null;
        }
      }
    } catch (err) {
      // Best-effort: if we can't start the manager, the env builder
      // will throw PROVIDER_UNSUPPORTED with a clear message, which
      // the existing error path below handles.
      if (remoteCodingProxyManager) {
        try { await remoteCodingProxyManager.stop(); } catch {}
        remoteCodingProxyManager = null;
      }
    }
  }
  try {
    providerResult = await buildAgentProviderEnv(agent, config, {
      provider: flagName,
      proxyStatus: staticProxyStatusFn(readLocalProxySnapshot()),
      remoteCodingStatus,
    });
  } catch (err) {
    providerError = err;
  } finally {
    if (remoteCodingProxyManager) {
      try { await remoteCodingProxyManager.stop(); } catch {}
      remoteCodingProxyManager = null;
    }
  }
  const providerEnv = { ...(providerResult?.env || {}) };
  if (providerResult?.source === "originrouter-coding") {
    if (agent === "claude") {
      providerEnv.ANTHROPIC_API_KEY = "";
      providerEnv.ANTHROPIC_BASE_URL = "http://127.0.0.1:<session-port>/coding";
      providerEnv.ANTHROPIC_AUTH_TOKEN = "or_local_<session-capability>";
    } else {
      providerEnv.OPENAI_BASE_URL = "http://127.0.0.1:<session-port>/coding/v1";
      providerEnv.OPENAI_API_KEY = "or_local_<session-capability>";
    }
  }

  // Stage 9.1B: print `Source: <transport>` on success only. On failure
  // there is no source to advertise — skip the line. The "Effective env"
  // header is always printed (current behavior preserved), with the
  // agent name interpolated so codex output does not lie about "claude".
  if (providerResult?.source) {
    console.log(`\nSource: ${providerResult.source}`);
  }

  console.log(`\nEffective env (what ${agent} will see):`);
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
  for (const key of envVarsFor(agent)) {
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
// Stage 9.1B: also mask OPENAI_API_KEY (Codex direct branch).
function formatEnvValue(key, value) {
  if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN" || key === "OPENAI_API_KEY") return maskSecret(value, true);
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

  // Stage 9.8: 接入 auth / relay / connectivity 检查。
  // 不打印 banner 重复（已经在文件顶部），只追加新 section。
  console.log("");
  let checks;
  try {
    checks = await runDoctor({ config });
  } catch (err) {
    console.log(`  ! connectivity check failed: ${err.message || err}`);
    process.exitCode = 1;
    return;
  }
  const verdict = printDoctorResults(checks, { skipBanner: true });
  if (verdict === "fail") {
    process.exitCode = 1;
  }
}

export async function main(argv) {
  const [command, ...args] = argv;

  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) await handleAgentWorkspaceCommand([]);
    else printSummaryHelp();
    return;
  }

  if (command === "--help" || command === "-h") {
    printSummaryHelp();
    return;
  }

  if ([
    "-c", "--coordinator", "-m", "--mode", "--team",
    "--detach", "--json", "--no-wait", "--plain", "--raw", "--review",
    "--verbose", "--yes", "--cloud-advice", "--timeout",
  ].some((option) => (
    command === option || command.startsWith(`${option}=`)
  ))) {
    await handleAgentWorkspaceCommand([command, ...args]);
    return;
  }

  if (command === "help") {
    args[0] === "all" ? printHelp() : printSummaryHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "__complete") {
    console.log(getCompletionCandidates(args).join("\n"));
    return;
  }

  if (command === "completion") {
    printCompletion(args[0]);
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

  if (command === "devices") {
    await handleDevices(args);
    return;
  }

  if (command === "provider") {
    handleProvider(args);
    return;
  }

  if (command === "route") {
    await handleRoute(args);
    return;
  }

  if (command === "proxy") {
    await handleProxy(args);
    return;
  }

  if (command === "compatibility") {
    await handleCompatibility(args);
    return;
  }

  if (command === "config") {
    handleConfig(args);
    return;
  }

  if (command === "agent") {
    await handleAgentSettings(args);
    return;
  }

  if (command === "history") {
    await handleHistoryCommand(args);
    return;
  }

  if (command === "collaboration" || command === "collaborate") {
    await handleCollaborationCommand(command === "collaborate" ? ["create", ...args] : args);
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
    const bind = state.localApiBindAddress || "127.0.0.1";
    const host = bind === "0.0.0.0" ? "127.0.0.1" : bind;
    const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    console.log(`http://${urlHost}:${state.localApiPort}`);
    return;
  }

  if (command === "service" || command === "services") {
    await handleServiceCommand(args);
    return;
  }

  if (command === "token") {
    handleTokenCommand(args);
    return;
  }

  if (command === "local") {
    const [sub, action] = args;
    if (sub === "key" || sub === "token") {
      handleTokenCommand([action].filter(Boolean));
      return;
    }
    if (sub === "config") {
      handleLocalConfigCommand(args.slice(1));
      return;
    }
    if (sub === "api") {
      handleLocalApiCommand(args.slice(1));
      return;
    }
    throw new Error(
      "Usage: originrouter local {key|token} show|rotate | " +
      "originrouter local config show|set | " +
      "originrouter local api status|set-host <addr>|set-port <int>",
    );
  }

  if (command === "run") {
    const runArgs = parseRunArgs(args);
    runCommand(runArgs[0], runArgs.slice(1));
    return;
  }

  if (command === "login") {
    if (args[0] === "status") {
      await handleAuthCommand(["status"]);
      return;
    }
    await handleLogin(args);
    return;
  }

  if (command === "logout") {
    await handleLogout(args);
    return;
  }

  if (command === "auth") {
    await handleAuthCommand(args);
    return;
  }

  if (command === "security") {
    await handleSecurityCommand(args);
    return;
  }

  if (command === "agent-mcp-server") {
    await runAgentGatewayMcpServer(args);
    return;
  }

  const agentCommand = resolveAgentCommand(command, args);
  if (agentCommand?.runtime === "claude-sdk") {
    await runClaudeSdkSession(agentCommand.args);
    return;
  }
  if (agentCommand?.runtime === "codex-app-server") {
    await runCodexAppServerSession(agentCommand.args);
    return;
  }
  if (agentCommand?.runtime === "native-pty") {
    await runLocalAgentSession(agentCommand.agent, agentCommand.args);
    return;
  }
  await handleAgentWorkspaceCommand([command, ...args]);
}

function _parseFlag(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}
