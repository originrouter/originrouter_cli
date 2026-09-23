import { VERSION } from "../constants.js";

export function printHelp() {
  console.log(`originrouter ${VERSION}

Usage:
  originrouter
  originrouter "<objective>" [-c codex|claude] [--mode <mode>]
  originrouter --help
  originrouter --version
  originrouter update [status|check|install] [--json]
  originrouter completion <shell>
  originrouter completion install [--shell <shell>] [--dry-run]
  originrouter completion uninstall [--shell <shell>] [--dry-run]
  originrouter status
  originrouter doctor [provider <name>]
  originrouter setup [--no-proxy] [--yes] [--dry-run]
  originrouter setup --verify [--no-proxy]
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
  Confirmation defaults to required (review before Team/plan execution); --yes enables always_auto.

Local Proxy provider management:
  originrouter provider add <name> [--type proxy] [--base-url <u>] [--model <m>]
                                   [--engine <e>] [--litellm-provider <id>] [--api-key <k>] [--auth-token <k>]
                                   [--organization <o>] [--small-fast-model <m> [legacy]] [--api-version <v>]
                                   [--aws-region <r>] [--aws-access-key-id <id>] [--aws-secret-access-key <k>]
                                   [--aws-session-token <t>] [--aws-profile-name <p>]
                                   [--aws-bedrock-runtime-endpoint <u>] [--aws-role-name <r>] [--aws-session-name <n>]
                                   [--aws-web-identity-token <t>] [--aws-sts-endpoint <u>] [--sagemaker-base-url <u>]
                                   [--vertex-project <id>] [--vertex-location <loc>] [--vertex-credentials <json>]
                                   [--google-application-credentials <path>] [--azure-ad-token <t>] [--hf-token <t>]

  --type proxy         Local Proxy. Use --engine litellm (default) + --litellm-provider <id>.
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
  originrouter remote setup [--workspace <path>] [--providers <name[,name...]>] [--port <p>]
  originrouter remote status
  originrouter remote share status|start|stop|restart [--providers <name[,name...]>] [--port <p>]
  originrouter remote workspace list|authorize <path>
  originrouter remote workspace request <path> --device <device-id>
  Aliases are fixed: originrouter-claude-model, originrouter-claude-fast-model,
                     and originrouter-codex-model.

Proxy runtime:
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
  Every --flag maps to a catalog field for the chosen Provider adapter.
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

Configuration:
  originrouter config show
  originrouter config set updates.mode prompt|auto|off
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
  # Proxy provider (via the local runtime). The --type litellm
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
  # stored verbatim; the Proxy runtime reads the env itself at startup.
  originrouter provider add bedrock-irsa --type proxy --engine litellm --litellm-provider bedrock \
    --aws-region os.environ/AWS_REGION_NAME \
    --aws-role-name arn:aws:iam::123456789012:role/MyBedrockRole \
    --aws-web-identity-token os.environ/AWS_WEB_IDENTITY_TOKEN_FILE \
    --model anthropic.claude-3-5-sonnet-20241022-v2:0

OriginRouter OAuth login:
  originrouter login [status] [--surety-url <url>] [--login-url <url>]
                     [--device-name <name>]
                     [--no-browser]
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
  --native-config                                Use the installed Claude/Codex auth, model, environment, and config; keep OriginRouter remote control only
`);
}

export function printSummaryHelp() {
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
  setup                  Install Agent runtimes, local Proxy, and configure this device
  service                Install, start, stop, or inspect the background service
  agent setup            Choose native configuration or an OriginRouter route
  claude | codex         Launch a native agent with remote control

Models and routing:
  provider               Add, update, inspect, and remove local providers
  route                  Assign local, cloud, or remote models to agent slots
  route list             Show every configured Agent route
  route set <agent.slot> Assign a Provider and model to one route slot
  proxy                  Install and manage the local Proxy runtime
  compatibility          Inspect signed protocol compatibility updates
  update                 Check for and install OriginRouter CLI updates

  Route aliases: originrouter-claude-model, originrouter-claude-fast-model,
                 and originrouter-codex-model

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
