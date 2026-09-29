// Single source of truth for the OriginRouter CLI command tree, used by shell
// completion.
//
// The upstream convention is Cobra's: the shell script is a thin stub that
// calls the binary back on every TAB, and the binary answers from this tree,
// so completion cannot drift from the real dispatch in `src/index.js`.
//
// `help.js` is deliberately NOT generated from here. It is hand-authored prose
// grouped by concept ("Agent collaboration", "Model routes", ...), and those
// sections cut across tree position; deriving them would mean smearing
// presentation metadata through this data. The drift test instead asserts that
// every command `help` documents resolves here, which catches the real failure
// (help naming a command that no longer exists) without owning the prose.
//
// `tests/commandCatalog.test.js` checks both directions against `src/index.js`
// dispatch and the help text, so a command added in one place and forgotten in
// another fails the suite instead of silently going missing.
//
// Shape:
//   { name, summary, children?, options?, valuesFor?, positional?, passthrough?, hidden? }
//     children    -- subcommands, keyed by their own name (recursive)
//     options     -- flags accepted at this level
//     valuesFor   -- fixed candidate values keyed by the flag that consumes
//                    them, or "(positional)" for a bare argument. Values that
//                    come from live state (provider names) are registered in
//                    `src/commands/completion.js` instead, so the catalog
//                    stays pure data.
//     positional  -- a bare-argument placeholder such as "<name>", used by the
//                    drift test to know the command takes an argument
//     passthrough -- the command forwards the rest of its argv to another
//                    program (`run -- cmd`, `claude <args>`), so completion
//                    must stop offering OriginRouter's own flags after it
//     hidden      -- runnable, but absent from completion

const AGENT_NAMES = ["claude", "codex"];
const SHELLS = ["bash", "zsh", "fish", "powershell"];
const TEAM_MODES = [
  "auto", "solo", "build-review", "plan-build-verify",
  "parallel-research", "review-panel", "remote-ops",
];
const AUTONOMY_PROFILES = ["manual", "guarded", "ai_review", "unrestricted", "custom"];
const DETAIL_LEVELS = ["concise", "standard", "detailed"];
const ROUTE_SLOTS = ["claude.main", "claude.small", "codex.main"];

// Flags accepted by the bare-objective entry point (`originrouter "..."`),
// also used as completions on an empty command line.
export const WORKSPACE_OPTIONS = [
  "-c", "--coordinator", "-m", "--mode", "--team", "--review", "--yes", "--detach",
];

const PROVIDER_FIELD_OPTIONS = [
  "--type", "--engine", "--litellm-provider", "--base-url", "--api-key",
  "--auth-token", "--model", "--small-fast-model", "--agent", "--force",
];

const COLLABORATION_OPTIONS = [
  "--objective", "--participant", "--role", "--route", "--permission",
  "--preference", "--template", "--coordination-prompt", "--concurrency",
  "--token-limit", "--amount-limit", "--currency", "--yes", "--detach",
  "--no-wait", "--timeout", "--review", "--json",
];

const AGENT_WRAPPER_OPTIONS = [
  "--native-config", "--originrouter-autonomy", "--originrouter-policy",
  "--originrouter-detail",
];

function leaf(name, summary, extra = {}) {
  return { name, summary, ...extra };
}

export const COMMAND_CATALOG = [
  leaf("status", "Show the installed CLI, state directory, and default device", {
    options: ["--json"],
  }),
  leaf("doctor", "Check dependencies, account, relay, and providers", {
    options: ["--json"],
    children: [
      leaf("provider", "Check one configured Provider", { positional: ["<name>"] }),
    ],
  }),
  leaf("setup", "Install agent runtimes, local Proxy, and configure this device", {
    options: ["--no-proxy", "--noproxy", "--proxy", "--yes", "--dry-run", "--verify"],
  }),
  leaf("sessions", "Inspect local agent sessions", { options: ["--json"] }),
  leaf("devices", "Inspect devices authorized for this account", { options: ["--json"] }),
  leaf("env", "Print the environment a given agent would run with", {
    children: [
      leaf("print", "Print environment variables for an agent", {
        options: ["--provider", "--agent"],
      }),
    ],
  }),
  leaf("agent", "Configure agent defaults, budgets, and history", {
    children: [
      leaf("setup", "Choose native configuration or an OriginRouter route", {
        options: ["--cloud", "--native"],
      }),
      leaf("detail", "Set the installed detail level default", {
        children: [
          leaf("set", "Set the detail level", {
            valuesFor: { "(positional)": DETAIL_LEVELS },
          }),
        ],
      }),
      leaf("budget", "Inspect or change agent spend limits", {
        children: [
          leaf("show", "Print the current budget snapshot"),
          leaf("set", "Set a budget for a scope"),
          leaf("clear", "Clear a budget for a scope"),
        ],
      }),
      leaf("history", "Query display-safe agent history", {
        options: ["--search", "--agent", "--device", "--workspace", "--status", "--limit", "--archived", "--json"],
        children: [leaf("show", "Show one conversation", { options: ["--json"] })],
      }),
    ],
  }),
  leaf("history", "Query display-safe agent history", {
    options: ["--agent", "--device", "--workspace", "--since", "--until", "--limit", "--archived", "--json"],
  }),
  leaf("remote", "Set up and control remote device access", {
    options: ["--device", "--workspace", "--providers", "--port"],
    children: [
      leaf("setup", "Configure this device for remote access", {
        options: ["--workspace", "--providers", "--port"],
      }),
      leaf("status", "Print remote access status"),
      leaf("share", "Control the remote share service", {
        options: ["--providers", "--port"],
        children: [
          leaf("status", "Print remote share status"),
          leaf("start", "Start remote sharing", { options: ["--providers", "--port"] }),
          leaf("stop", "Stop remote sharing"),
          leaf("restart", "Restart remote sharing", { options: ["--providers", "--port"] }),
        ],
      }),
      leaf("workspace", "Manage authorized remote workspaces", {
        children: [
          leaf("list", "List remote workspaces"),
          leaf("authorize", "Authorize a workspace path", { positional: ["<path>"] }),
          leaf("request", "Request access to a remote workspace", {
            positional: ["<path>"],
            options: ["--device"],
          }),
        ],
      }),
    ],
  }),
  leaf("collaborate", "Start a guided multi-agent collaboration", {
    options: ["--review", "--yes", "--json", ...COLLABORATION_OPTIONS],
  }),
  leaf("collaboration", "Inspect and control collaboration runs", {
    options: COLLABORATION_OPTIONS,
    children: [
      leaf("templates", "List built-in collaboration templates"),
      leaf("list", "List collaboration runs", {
        options: ["--category", "--page", "--page-size", "--archived", "--json"],
        valuesFor: { "--category": ["all", "attention", "active", "recent"] },
      }),
      leaf("drafts", "List draft collaborations", { options: ["--json"] }),
      leaf("draft", "Work with one draft", {
        children: [
          leaf("show", "Show a draft", { positional: ["<draft-id>"] }),
          leaf("resume", "Resume a draft", { positional: ["<draft-id>"] }),
          leaf("delete", "Delete a draft", { positional: ["<draft-id>"] }),
        ],
      }),
      leaf("show", "Show a run", { positional: ["<run-id>"], options: ["--json"] }),
      leaf("attach", "Attach to a running collaboration", {
        positional: ["<run-id>"],
        options: ["--plain", "--verbose", "--raw", "--participant", "--task"],
      }),
      leaf("attention", "List items needing attention", { positional: ["<run-id>"] }),
      leaf("resolve", "Resolve an attention item", {
        positional: ["<run-id>", "<attention-id>"],
        options: ["--action", "--text"],
      }),
      leaf("doctor", "Diagnose a collaboration run", { positional: ["<run-id>"], options: ["--json"] }),
      leaf("create", "Create a collaboration", {
        options: [...COLLABORATION_OPTIONS, "--spec", "--draft"],
      }),
      leaf("confirm", "Confirm a planned collaboration", { positional: ["<run-id>"] }),
      leaf("revise", "Revise a collaboration plan", {
        positional: ["<run-id>"],
        options: ["--feedback"],
      }),
      leaf("pause", "Pause a collaboration", { positional: ["<run-id>"] }),
      leaf("resume", "Resume a collaboration", { positional: ["<run-id>"] }),
      leaf("retry", "Retry failed tasks", { positional: ["<run-id>"], options: ["--task"] }),
      leaf("cancel", "Cancel a collaboration", { positional: ["<run-id>"] }),
      leaf("archive", "Archive a collaboration", { positional: ["<run-id>"] }),
      leaf("delete", "Delete a collaboration", { positional: ["<run-id>"], options: ["--yes"] }),
      leaf("export", "Export a collaboration", {
        positional: ["<run-id>"],
        options: ["--format"],
        valuesFor: { "--format": ["json", "markdown"] },
      }),
    ],
  }),
  leaf("provider", "Add, update, inspect, and remove local providers", {
    options: PROVIDER_FIELD_OPTIONS,
    children: [
      leaf("add", "Add a Provider", { positional: ["<name>"], options: PROVIDER_FIELD_OPTIONS, valuesFor: { "--type": ["proxy", "litellm"], "--engine": ["litellm"], "--agent": AGENT_NAMES } }),
      leaf("update", "Update a Provider", { positional: ["<name>"], options: PROVIDER_FIELD_OPTIONS, valuesFor: { "--type": ["proxy", "litellm"], "--engine": ["litellm"], "--agent": AGENT_NAMES } }),
      leaf("list", "List configured Providers"),
      leaf("show", "Show one Provider", { positional: ["<name>"], options: ["--json"] }),
      leaf("use", "Point agent routes at a Provider", {
        positional: ["<name>"],
        options: ["--agent", "--force"],
        valuesFor: { "--agent": AGENT_NAMES },
      }),
      leaf("remove", "Remove a Provider", { positional: ["<name>"] }),
    ],
  }),
  leaf("route", "Assign local, cloud, or remote models to agent slots", {
    options: ["--provider", "--model", "--main-model", "--small-model", "--device"],
    children: [
      leaf("list", "Show every configured agent route"),
      leaf("show", "Show routes for one agent", {
        valuesFor: { "(positional)": AGENT_NAMES },
        options: ["--json"],
      }),
      leaf("set", "Assign a Provider and model to a route slot", {
        valuesFor: { "(positional)": ROUTE_SLOTS },
        options: ["--provider", "--model", "--main-model", "--small-model"],
      }),
      leaf("clear", "Clear a route slot", { valuesFor: { "(positional)": ROUTE_SLOTS } }),
      leaf("cloud", "Use login-backed OriginRouter Cloud models", {
        children: [
          leaf("models", "List available Cloud models"),
          leaf("set", "Assign a Cloud model to a slot", {
            valuesFor: { "(positional)": ROUTE_SLOTS },
            options: ["--model"],
          }),
        ],
      }),
      leaf("remote", "Use models served by another authorized device", {
        children: [
          leaf("devices", "List devices offering models"),
          leaf("set", "Assign a remote model to a slot", {
            valuesFor: { "(positional)": ROUTE_SLOTS },
            options: ["--device", "--model"],
          }),
        ],
      }),
    ],
  }),
  leaf("proxy", "Install and manage the local Proxy runtime", {
    options: ["--provider", "--port", "--version"],
    children: [
      leaf("install", "Install the Proxy runtime", { options: ["--version"] }),
      leaf("start", "Start the Proxy", { options: ["--provider", "--port"] }),
      leaf("stop", "Stop the Proxy"),
      leaf("restart", "Restart the Proxy", { options: ["--port"] }),
      leaf("switch", "Alias for restart", { options: ["--port"] }),
      leaf("status", "Print Proxy status"),
    ],
  }),
  leaf("compatibility", "Inspect signed protocol compatibility updates", {
    options: ["--json"],
    children: [
      leaf("status", "Show compatibility status"),
      leaf("list", "List known patches"),
      leaf("inspect", "Inspect one patch", { positional: ["<patch-id>"] }),
      leaf("check", "Check for compatibility updates"),
      leaf("update", "Apply compatibility updates"),
      leaf("refresh", "Alias for update"),
      leaf("rollback", "Roll back the last applied patch"),
    ],
  }),
  leaf("login", "Sign in with the RFC 8628 device authorization grant", {
    options: ["--no-browser", "--surety-url", "--login-url", "--device-name"],
    children: [leaf("status", "Show sign-in status")],
  }),
  leaf("logout", "Sign out of this device", { options: ["--remove-device"] }),
  leaf("auth", "Inspect and manage this device's authorization", {
    children: [
      leaf("status", "Show authorization status"),
      leaf("verify", "Verify the stored credentials"),
      leaf("logout", "Sign out"),
    ],
  }),
  leaf("security", "Manage device identity and key rotation", {
    children: [
      leaf("status", "Show device security status"),
      leaf("verify", "Verify device trust"),
      leaf("rotate", "Rotate device keys"),
    ],
  }),
  leaf("service", "Install, start, stop, or inspect the background service", {
    children: [
      leaf("install", "Install the background service"),
      leaf("start", "Start the background service"),
      leaf("stop", "Stop the background service"),
      leaf("restart", "Restart the background service"),
      leaf("status", "Print background service status"),
      leaf("uninstall", "Remove the background service"),
    ],
  }),
  leaf("services", "Alias for service", {
    children: [
      leaf("install", "Install the background service"),
      leaf("start", "Start the background service"),
      leaf("stop", "Stop the background service"),
      leaf("restart", "Restart the background service"),
      leaf("status", "Print background service status"),
      leaf("uninstall", "Remove the background service"),
    ],
  }),
  leaf("token", "Print or rotate the Local API token", {
    children: [
      leaf("show", "Print the current token and Local API URL"),
      leaf("rotate", "Mint a new token (invalidates existing clients)"),
    ],
  }),
  leaf("local", "Manage the Local API and its credentials", {
    children: [
      leaf("key", "Alias for token", {
        children: [
          leaf("show", "Print the current key"),
          leaf("rotate", "Mint a new key"),
        ],
      }),
      leaf("token", "Alias for token", {
        children: [
          leaf("show", "Print the current token"),
          leaf("rotate", "Mint a new token"),
        ],
      }),
      leaf("config", "Persisted Local API bind and port settings", {
        children: [
          leaf("show", "Print persisted bind and port"),
          leaf("set", "Change bind, port, or relay settings", {
            options: ["--port", "--bind", "--allow-lan", "--relay-mode", "--relay-url"],
            valuesFor: {
              "--allow-lan": ["on", "off"],
              "--relay-mode": ["auto", "cloud", "local", "custom"],
            },
          }),
        ],
      }),
      leaf("api", "Inspect or pair the Local API", {
        children: [
          leaf("status", "Print Local API status"),
          leaf("pair", "Pair a client with this Local API"),
          leaf("connect", "Alias for pair"),
          leaf("set-host", "Change the Local API bind address", { positional: ["<addr>"] }),
          leaf("set-port", "Change the Local API port", { positional: ["<int>"] }),
        ],
      }),
    ],
  }),
  leaf("config", "Read and write CLI configuration", {
    children: [
      leaf("show", "Print the current configuration"),
      leaf("set", "Set a configuration value", {
        positional: ["<key>", "<value>"],
        valuesFor: { "(positional)": ["updates.mode"] },
      }),
      leaf("unset", "Remove a configuration value", { positional: ["<key>"] }),
    ],
  }),
  leaf("completion", "Print or install shell completion", {
    options: ["--shell", "--dry-run"],
    valuesFor: { "(positional)": SHELLS, "--shell": SHELLS },
    children: [
      leaf("install", "Install completion into the shell profile", {
        options: ["--shell", "--dry-run"],
        valuesFor: { "--shell": SHELLS },
      }),
      leaf("uninstall", "Remove managed completion from the shell profile", {
        options: ["--shell", "--dry-run"],
        valuesFor: { "--shell": SHELLS },
      }),
      ...SHELLS.map((shell) => leaf(shell, `Print the ${shell} completion script`)),
    ],
  }),
  leaf("help", "Show help", {
    children: [leaf("all", "Show the exhaustive command reference")],
  }),
  leaf("update", "Check for and install OriginRouter CLI updates", {
    options: ["--json"],
    children: [
      leaf("status", "Show update status"),
      leaf("check", "Check for a newer version"),
      leaf("install", "Install the available update"),
    ],
  }),
  leaf("run", "Run a command with the resolved agent environment", {
    positional: ["--", "<command>", "[args...]"],
    passthrough: true,
  }),
  leaf("daemon", "Run the local daemon in the foreground", {
    options: [
      "--relay", "--relay-mode", "--device", "--local-port",
      "--bind", "--allow-lan",
    ],
    valuesFor: { "--relay-mode": ["auto", "cloud", "local", "custom"] },
  }),
  leaf("daemon-port", "Print the running daemon's Local API URL"),
  leaf("claude", "Start the native Claude Code TUI with remote control", {
    options: AGENT_WRAPPER_OPTIONS,
    passthrough: true,
  }),
  leaf("codex", "Start the native Codex TUI with remote control", {
    options: AGENT_WRAPPER_OPTIONS,
    passthrough: true,
  }),
  leaf("claude-terminal", "Start a managed Claude Agent SDK session", {
    options: AGENT_WRAPPER_OPTIONS,
    passthrough: true,
  }),
  leaf("claude-sdk", "Alias for claude-terminal", {
    options: AGENT_WRAPPER_OPTIONS,
    passthrough: true,
  }),
  leaf("codex-terminal", "Start a managed Codex app-server session", {
    options: AGENT_WRAPPER_OPTIONS,
    passthrough: true,
  }),
  leaf("codex-app-server", "Alias for codex-terminal", {
    options: AGENT_WRAPPER_OPTIONS,
    passthrough: true,
  }),
  leaf("claude-config", "Write legacy config.claude values", {
    options: ["--base-url", "--api-key", "--model", "--small-fast-model"],
  }),
  leaf("agent-mcp-server", "Run the MCP gateway server (internal)", {
    hidden: true,
  }),
];

const BY_NAME = new Map(COMMAND_CATALOG.map((entry) => [entry.name, entry]));

export function topLevelCommands({ includeHidden = false } = {}) {
  return COMMAND_CATALOG.filter((entry) => includeHidden || !entry.hidden);
}

// Walk the catalog along an already-typed prefix. `words` excludes the
// program name and the word currently being completed.
export function resolveCommand(words = []) {
  let node = null;
  let children = COMMAND_CATALOG;
  for (const word of words) {
    const next = children.find((entry) => entry.name === word);
    if (!next) return { node: null, children: [] };
    node = next;
    children = next.children || [];
  }
  return { node, children };
}

// Every command name the CLI accepts, including nested ones, as
// space-separated paths ("remote share start"). Used by the drift test that
// checks the catalog against the real dispatch.
export function allCommandPaths(entries = COMMAND_CATALOG, prefix = []) {
  const paths = [];
  for (const entry of entries) {
    const path = [...prefix, entry.name];
    paths.push(path);
    if (entry.children?.length) paths.push(...allCommandPaths(entry.children, path));
  }
  return paths;
}

export function findCommand(name) {
  return BY_NAME.get(name) || null;
}

// Flags that consume the following word as their value. Completion needs this
// to tell `remote --port 8080 <TAB>` (still on the `remote` command) apart
// from `remote status <TAB>` (a subcommand). Boolean flags are deliberately
// absent: they never swallow the next word.
export const VALUE_FLAGS = new Set([
  "--action", "--agent", "--allow-lan", "--amount-limit", "--api-key",
  "--auth-token", "--base-url", "--bind", "--category", "--concurrency",
  "--coordination-prompt", "--currency", "--currency", "--device",
  "--device-name", "--draft", "--engine", "--feedback", "--format", "--limit",
  "--litellm-provider", "--local-port", "--login-url", "--main-model",
  "--model", "--objective", "--originrouter-autonomy",
  "--originrouter-detail", "--originrouter-policy", "--page", "--page-size",
  "--participant", "--permission", "--port", "--preference", "--provider",
  "--providers", "--relay", "--relay-mode", "--relay-url", "--role", "--route",
  "--search", "--shell", "--since", "--small-fast-model", "--small-model",
  "--spec", "--status", "--surety-url", "--task", "--template", "--text",
  "--timeout", "--token-limit", "--type", "--until", "--version",
  "--workspace",
  "-c", "-m",
]);

export const COMPLETION_VALUES = {
  "-c": AGENT_NAMES,
  "--coordinator": AGENT_NAMES,
  "-m": TEAM_MODES,
  "--mode": TEAM_MODES,
  "--team": TEAM_MODES,
  "--agent": AGENT_NAMES,
  "--engine": ["litellm"],
  "--touched": [],
  "--originrouter-autonomy": AUTONOMY_PROFILES,
  "--originrouter-detail": DETAIL_LEVELS,
  "--relay-mode": ["auto", "cloud", "local", "custom"],
  "--allow-lan": ["on", "off"],
  "--format": ["json", "markdown"],
  "--shell": SHELLS,
  "updates.mode": ["prompt", "auto", "off"],
};
