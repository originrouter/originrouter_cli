# Changelog

All notable changes to OriginRouter CLI will be documented here. The project
uses Semantic Versioning and follows the Keep a Changelog structure.

## 0.4.9 - 2026-09-30

### Fixed

- Shell completion now describes the whole command surface instead of a
  hand-maintained subset. The candidate list is derived from a single command
  catalog, so subcommands, options, and value completions can no longer drift
  apart from the command tree they are meant to describe. Completion refreshes
  for an upgraded CLI as well: it is loaded from the installed binary on every
  shell start, so a new version's completions appear without reinstalling.
- `originrouter update` re-applies shell completion after a successful upgrade.
  Only profiles that already carry a completion block are touched, so updating
  the CLI never configures a shell that was never configured.
- `originrouter login` and `originrouter run --` can execute npm-installed
  commands again on Windows when the CLI is installed by `scripts/install.ps1`.

### Fixed (Windows)

- PowerShell completion now installs into both profiles. Windows ships two
  PowerShells that read different files — Windows PowerShell 5.1 reads
  `Documents\WindowsPowerShell\` and PowerShell 7+ reads `Documents\PowerShell\`
  — and only the 7+ path was written, so completion was installed yet never
  loaded for `powershell`. Uninstall clears both.
- Completion works when completing an empty word. PowerShell 5.1 drops a
  trailing empty argument when invoking a native command, so the CLI received
  `provider` where the user had typed `provider <TAB>` and echoed the word back
  instead of offering its subcommands. The generated script now sends a
  sentinel the CLI maps back to an empty word.

### Security

- The Codex app-server provider id is now unique per process. Codex merges its
  config layers by key, and a table merges field by field rather than replacing
  wholesale, so a `[model_providers.<id>]` block under our fixed id in the
  user's `config.toml` survived the merge and smuggled `env_http_headers`,
  `http_headers`, and `query_params` onto the request our own credential had
  authorized — sending the user's key wherever the route pointed. An empty-table
  override does not clear them; removing the merge partner does.
- Both Anthropic credential variables are pinned when a route is applied, not
  just the unused one. A route that sets `ANTHROPIC_API_KEY` previously left
  `ANTHROPIC_AUTH_TOKEN` absent, which let a stale one in
  `~/.claude/settings.json` reach the request as a `Bearer` token; Claude Code
  prefers that token, so the proxy was handed the user's stale credential and
  the user's own key left the machine.
- Command discovery no longer loses whole command families. `originrouter help`
  omitted the entire `local api` family — including `local api pair`, which had
  no other entry point — and several other subcommand lists drifted from the
  command tree they document. The help text is hand-authored by design (its
  sections are grouped by concept, not tree position), so it is checked against
  the catalog instead of generated from it, and that check now covers
  subcommands rather than only top-level names.
- Removed a completion entry for a subcommand the CLI rejects. `auth logout` was
  declared in the command catalog but never implemented: TAB offered it, and
  choosing it failed with "Unknown auth subcommand". The top-level
  `originrouter logout` already covers signing out.
- The catalog's subcommands are now checked for reachability, not just
  declaration. A name could previously be declared and offered by completion
  while no dispatch branch accepted it — the check now resolves each entry
  against the module that owns its branch, with unexplained exemptions refused.

### Fixed

- A Claude session no longer silently runs on a stale user settings file. Claude
  Code merges its own settings files *above* the subprocess environment, so a
  `~/.claude/settings.json` env block outranked the resolved route and replaced
  it. The route is now pinned through the `--settings` (flagSettings) layer,
  which outranks every filesystem settings layer except enterprise managed
  settings.
- Pin the same transport key set on every launch path. The SDK path pinned five
  env keys by hand, leaving `CLAUDE_CODE_SUBAGENT_MODEL` and the whole
  `ANTHROPIC_DEFAULT_*_MODEL` family — the keys a stale settings file is most
  likely to hold — unpinned while the PTY path pinned them.
- Report settings conflicts rather than resolving them silently. A conflicting
  layer is now named at launch and by `originrouter env print`, so a correct
  route that a settings file was overriding no longer looks like a routing
  failure.
- `originrouter env print` describes what a session will really see. It reported
  only the process environment and printed "(unset)" for keys a settings file
  was actively forcing; it now lists the settings layers above it, the transport
  keys each one sets, and whether OriginRouter overrides them. Credential *keys*
  are named, never their values, and enterprise managed settings are identified
  as outranking OriginRouter.
- A session that is online but idle no longer reports an active turn.
  `session.status` describes the long-lived CLI process — a healthy idle Agent
  sits at `running` for hours — so treating it as turn activity opened the App
  with a stop button and flickered against every refresh.
- The control snapshot and the session projection no longer disagree. The
  snapshot published the raw turn latch while the session published a gated
  projection, so the App alternated between two answers on every refresh.
- A waiting state survives an approval that expires without an event. Pending
  interactions are now the authoritative source for the waiting states, which a
  turn-event latch cannot observe.
- Re-registering a session no longer resurrects a finished turn. An Agent
  reconnecting after a turn ended while the App was away inherited the previous
  `running` latch and showed a stop button until a terminal event that never
  came.

### Validation

- The full CLI test suite passes, including new tests for the command catalog,
  completion (sentinel and dual-profile install), settings overrides, provider
  isolation, `env print` layers, and turn-state projection.
- The refresh-on-upgrade path is covered by a test that proves a failure inside
  it can never turn a successful upgrade into a failed command.
- Shell completion was exercised end to end in real Bash, Zsh, and Windows
  PowerShell 5.1 sessions.

## 0.4.8 - 2026-09-29

### Fixed

- The device directory cache is now scoped to the account instead of to a
  single sign-in. Every `originrouter login` previously started from a cold
  cache, which discarded the pinned key history and left abandoned files on
  disk holding contradictory views of the same account. Existing
  session-scoped caches are carried over once, and the superseded files are
  removed.
- A directory containing one unverifiable device no longer makes every other
  device unreachable. Each device's key chain is verified independently: the
  offending device is quarantined and reported with a specific reason, while
  the devices that verify stay usable. Invalid signatures, unsigned rotations,
  and mutated pinned keys remain fatal for the device at fault.
- A device whose key chain is served starting above version 1 can be completed
  from key history this installation already pinned, so a server-side omission
  no longer permanently prevents a session from opening. Only previously
  pinned key IDs are reused.
- Peer errors now name the actual cause, distinguishing a quarantined device
  from one that is absent or untrusted.
- The App-to-CLI local connection negotiates its authentication method
  explicitly. The superseded `legacy_hmac_v2` path has been removed from both
  ends; a client that cannot negotiate is told to update instead of falling
  back to the weaker path.

### Fixed (Windows)

- `originrouter login` no longer opens a truncated URL. The launcher used
  `cmd /c start`, and cmd splits unquoted arguments at every `&`, so the
  browser received only the first query parameter and the device code was
  lost. The URL is now opened directly, without shell parsing.
- `originrouter run --` and agent launches can execute npm-installed commands
  again. These ship as `.cmd` shims, which `CreateProcess` cannot run, so
  spawning `claude` failed outright; bare names are now resolved against
  `PATH`/`PATHEXT` and shims are routed through `cmd.exe`. The same fix
  applies to the pty executor, where node-pty reported "File not found".
- System proxy settings are detected again, so managed Python and uv can be
  downloaded from behind a proxy. The registry reader matched a single
  hardcoded value type and silently returned nothing for values of any other
  type.
- Stopping an agent now terminates the whole process tree. Windows has no
  POSIX signals, so the previous group-signal path could not reach
  descendants.
- `~/path` and `~\path` are expanded consistently in workspace, approval
  policy, audit store, autonomy policy, and agent catalog paths. Two of these
  only accepted the separator that does not appear on Windows.

### Security

- The state directory holding credentials and device keys is now restricted by
  ACL on Windows, where filesystem mode bits have no effect. Access is granted
  only to the current user and `SYSTEM`, inheritance is removed so new secret
  files are covered automatically, and principals are addressed by SID so the
  hardening works on localized systems. Best-effort: a directory that refuses
  ACL edits stays usable and warns once.

## 0.4.7 - 2026-09-28

### Fixed

- Device removal during logout now reads the current account epoch before
  signing the request and preserves the installation's device identity key.
- Agent sessions now record the resolved provider and model in lifecycle
  telemetry. Failures before provider resolution no longer raise a telemetry
  error that hides the original failure.
- `originrouter env print` now reads the existing device identity without
  starting the login-specific device setup flow.
- Workspace's active-run spinner advances correctly, and missing runtime
  references no longer interrupt the Workspace or daemon.
- Local API remote-share status uses the same payload for the dedicated
  endpoint and the local status summary. Model verification uses the
  configured probe function.

## 0.4.6 - 2026-09-28

### Fixed

- Windows login tasks now enter through the Windows Script Host GUI launcher,
  which hides PowerShell before its console is created. This prevents the
  persistent blank Windows Terminal window left by the previous launcher.
- Windows service stop waits for the owned daemon's process handle to signal
  exit instead of immediately checking a potentially stale CIM snapshot.
  Reinstalling or restarting no longer fails while the old daemon is exiting.
- Windows service failures show the actual command error in UTF-8 text,
  without dumping encoded PowerShell commands or progress XML into setup.
- The Windows installer and CLI updater stop the old service before npm
  replaces loaded native modules, preventing obsolete package directories
  from being left behind. The installer can stop older broken CLI versions
  without invoking their service commands.

## 0.4.5 - 2026-09-28

### Fixed

- Windows Local API token authentication now resolves the state directory with
  native paths, so an otherwise healthy scheduled daemon passes setup checks.
- Windows service registration now propagates the elevated child failure and
  checks the registered task action against the generated configuration.
  Service uninstall also elevates automatically if Windows denies task deletion.
- The scheduled daemon starts with a hidden console, reports its real exit
  code, and writes startup errors to the service log.
- Failed Windows service starts stop the task and its owned daemon process
  tree, even if no state file was written; scheduled retries stay suppressed
  until an explicit start. Stop, reinstall, and uninstall clean up the same
  owned processes without targeting unrelated Node applications.
- Updating an installed CLI refreshes the service configuration from the newly
  installed files, including services that were stopped before the update.
  A refresh failure is reported separately from a successful package update.
- The Windows installer now passes `setup` in unattended mode, selects a valid
  user Node runtime by numeric version, and terminates npm/setup descendants
  if a step times out. The website and package copies of the installer match.

## 0.4.4 - 2026-09-27

### Fixed

- Fixed the Windows background service never launching: the scheduled task's
  embedded PowerShell wrapper escaped embedded quotes in the Bash style
  (`\"`), which PowerShell does not honor, so the wrapper script failed to
  parse and the daemon never started — leaving the Local API permanently
  not ready with no log output. All values are now wrapped in PowerShell
  single-quote literals.

## 0.4.3 - 2026-09-27

### Fixed

- Fixed the background daemon shutting down immediately after start on
  logged-out installs: `undefined` vs `null` account-scope comparisons were
  misread as an account context change. This surfaced on Windows, where the
  scheduled task does not supervise and restart the daemon, leaving the
  Local API never ready.
- Windows service commands now switch the console to UTF-8 before capturing
  `schtasks` output, so status and error text no longer appear as mojibake,
  and `service install` reports a clear message when scheduled-task
  registration requires administrator rights instead of a garbled error. When
  registration is denied in a normal console, the installer now raises the
  Windows UAC prompt automatically (the user only clicks "Yes") instead of
  asking the user to open an elevated PowerShell themselves.

## 0.4.2 - 2026-09-27

### Added

- Python runtime and LiteLLM downloads (pip, uv, and the uv archive itself)
  now inherit the Windows system proxy automatically, so `originrouter setup`
  and `originrouter proxy install` work behind local proxies such as Clash
  without manual environment setup. `ORIGINROUTER_PROXY` overrides and
  `originrouter proxy install` work behind local proxies such as Clash without
  manual environment setup. `ORIGINROUTER_PROXY` overrides and
  `ORIGINROUTER_NO_PROXY=1` disables detection.

### Fixed

- Fixed Windows background service installation failing with
  `(35,25): Interval:PT30S` — Task Scheduler rejects sub-minute
  `RestartOnFailure` intervals; the task XML now uses the minimum `PT1M`.

## 0.4.1 - 2026-09-27

### Added

- Windows installer (`install.ps1`) now shows real-time progress for every
  download and long-running step: byte-accurate inline progress for the Node.js
  archive and release list, per-file extraction counts, and spinners for npm
  install and setup, replacing silent waits and the legacy blue progress dialog.
- The Windows installer inherits the system proxy (Windows Internet Settings,
  `ORIGINROUTER_PROXY`, or existing `HTTPS_PROXY`/`HTTP_PROXY`) so npm and
  downloads work behind local proxies such as Clash; `-NoProxy` skips this.
- The installer reuses a previously installed user-level Node.js runtime even
  when the current console has not picked up the updated user PATH, and
  resolves npm/OriginRouter commands to their `.cmd` shims explicitly.
- Agent permission configuration (autonomy profile, allowed scopes, approval
  policy, AI review policy) is now persisted per conversation with a monotonic
  revision, so every execution surface shares one consistent boundary instead
  of re-deriving policy ad hoc.
- Resuming a conversation now inherits its saved permission configuration by
  default; explicit permission arguments override it, and older sessions
  without saved state fail with a clear actionable error.

### Changed

- Claude SDK/PTY and Codex sessions capture permission state revisions for
  autonomy status updates; only a bounded display projection leaves the
  device, and full approval rules and AI review instructions stay local.
- Approval and AI review policy selections remain sticky across bridge
  reconnects within a conversation instead of being reset by partial payloads.

### Fixed

- Fixed `originrouter setup` failing with `spawn EINVAL` on Windows with
  Node.js 18.20+ (CVE-2024-27980 hardening): npm-installed `.cmd` shims are
  now routed through `cmd.exe` with strict argument quoting, and bare command
  names are resolved against `PATH`/`PATHEXT` so npm-installed CLIs are
  detected on Windows.
- Fixed npm install exit codes being unreliable on Windows PowerShell 5.1,
  which made successful installs report failure.
- A delayed permission interaction timeout or result can no longer restart a
  turn that has already completed.
- Failure output from npm install and setup is now shown in full when the
  Windows installer fails, instead of being swallowed.

### Quality

- Added regression coverage for Windows command resolution and `.cmd` shim
  routing, argument quoting, conversation permission state revisions, resume
  inheritance, external agent registry autonomy status, bridge client
  interaction stream handling, and local API autonomy routes.

## 0.4.0 - 2026-09-23

### Added

- Added account-scoped persistence with an active-account selector and
  isolated configuration, credentials, sessions, collaboration state, agent
  catalogs, budgets, audits, telemetry, and proxy state.
- Added one-time migration of legacy root-level account data after the account
  is identified from a verified credential.
- Added installation-scoped device E2EE identity management, including
  migration from older account-scoped identity files.
- Added secure local App pairing with short-lived, one-time pairing tickets,
  encrypted credential delivery, replay protection, origin checks, and rate
  limiting through `originrouter local api pair`.

### Changed

- Device identity keys now remain stable across account switches; account
  policy/session changes no longer manufacture a new installation identity.
- The daemon now detects account and authentication-session changes and
  restarts cleanly so all stores, sessions, and relay connections use the new
  account context.
- Local API port selection is persisted and automatically moves above the
  default port when it is already occupied.
- Refactored Agent Workspace, Local API, Collaboration, Bridge, Daemon, Agent
  Catalog, local sessions, and Codex app-server code into focused modules.
- Extracted shared CLI argument parsing, command output, help, transport,
  error handling, projections, schemas, and primitive layers from previously
  monolithic files.

### Fixed

- Prevented account data, credentials, routes, history, and local runtime
  state from leaking across users or accounts on the same installation.
- Improved device identity recovery and trust-directory refresh behavior for
  local and remote control flows.

### Quality

- Added focused regression coverage for account isolation, storage migration,
  device identity migration, local pairing, CLI helpers, Workspace
  projections, and Collaboration projections.
- Full regression suite, CLI smoke tests, release metadata checks, and npm
  packaging checks pass.

### Upgrade notes

- Existing `0.3.3` installations are migrated lazily after a verified account
  credential is found. Legacy account data is retained and moved into its
  account namespace; it is not deleted.
- No manual migration command is required, but users should allow the first
  post-upgrade login/daemon start to complete before launching concurrent
  sessions.

## 0.3.3 - 2026-09-15

### Changed

- Claude Code and Codex setup dependencies are now installed through npm on
  macOS, Linux, and Windows using their official packages.
- Setup refreshes npm and user-level binary paths before verification, so a
  newly installed agent is available without restarting the terminal.
- Shell completion setup now prints the exact command needed to activate
  completion in the current terminal while keeping it enabled for future
  terminals.

### Fixed

- Removed nested Claude and Codex installer flows that could fail behind
  data-center network restrictions or prompt to launch an Agent during setup.

## 0.3.1 - 2026-09-15

### Added

- The install script now installs Node.js 22 automatically when it is missing
  or outdated: system package managers (NodeSource for apt/dnf/yum, apk) when
  root or passwordless sudo is available, otherwise nvm into the user's home
  directory with no sudo at all.
- An npm global installation that fails with permission errors now retries
  under a user-level Node from nvm instead of aborting.
- Background service installation now validates the generated systemd unit
  with `systemd-analyze --user verify` before registering it, so a bad
  directive is reported with the offending line.
- Service setup failures now attach `systemctl --user status` and
  `journalctl` diagnostics to the reported error.

### Fixed

- Removed quotes from the systemd unit's `WorkingDirectory=` value; systemd
  reads the value literally, and the quoted path was rejected as
  "not absolute", preventing the service from starting.
- Service management commands now time out after 15 seconds instead of
  hanging forever when no systemd user session is available.
- Preserved the CLI device identity during key recovery.
- Stabilized collaboration reconciliation projections and archived stale
  runs.

## 0.3.0 - 2026-09-11

### Added

- Added guided cross-platform setup for Claude Code, Codex, the OriginRouter
  background service, managed Python, and the Local Proxy runtime.
- Added shell completion installation and removal for Bash, Zsh, Fish, and
  PowerShell.
- Added collaboration protocol v2 with explicit delegation boundaries, task
  lifecycle tracking, planner metadata, remote assignment support, and safer
  confirmation modes.
- Added automatic selection of the fastest healthy official Relay endpoint
  while preserving explicit Relay configuration.

### Changed

- Redesigned the Agent Workspace header, footer, history navigation, text
  selection, cursor placement, and screen redraw behavior.
- Normalized Claude and Codex events for plans, reviews, subagents, tool calls,
  lifecycle tracking, and visibility levels.
- Improved Local Proxy installation verification, recovery of broken
  environments, and Windows path handling.
- Refreshed installation guidance, architecture documentation, CLI help, and
  release assets.
- Expanded regression coverage across adapters, collaboration, setup, Relay
  selection, and Workspace interactions.
- Collaboration confirmation now defaults to `required`; use `--yes` for
  explicit always-auto confirmation.

### Fixed

- Prevented Claude `MessageDisplay` hooks from creating duplicate conversation
  entries.
- Prevented clean session exits and runtime diagnostics from being reported as
  duplicate task outcomes.
- Preserved real task failures and completions for user-facing notifications.
- Mapped Codex web-search and image-generation events to structured tool-call
  results.
- Improved handling of interrupted tasks and remote Agent execution states.

## 0.2.2 - 2026-08-24

### Added

- Added cached npm release checks and a Codex-style interactive startup prompt
  with Update now, Skip, and Skip until next version choices.
- Added `originrouter update`, `originrouter update check`, and
  `originrouter update status`, including JSON status output.
- Added `updates.mode` configuration with `prompt`, `auto`, and `off` modes.
- Added npm, pnpm, and Bun global-install detection, an inter-process update
  lock, local update status API, and idle managed-service restart support.
- Added post-install version verification, restart-required status, and
  structured update failure reporting.

### Fixed

- Bounded daemon activity inspection so an unresponsive local service cannot
  hang startup or manual updates.
- Update timeouts now terminate the complete installer process tree before the
  lock is released. A live owner or installer process also prevents an old
  lock from being reclaimed solely because of its age.

### Security

- Automatic updates never invoke `sudo`, never overwrite source or linked
  development installs, and defer while Agent sessions or collaboration runs
  are active or daemon activity cannot be verified.

## 0.2.1 - 2026-08-23

### Added

- Added `originrouter remote workspace request <path> --device <device-id>` so
  a trusted human-controlled CLI can request registration of an ordinary
  target-device folder without granting managed Agents permission to expand
  their own workspace boundary.

### Fixed

- Distinguished registered workspaces from workspaces that are actually ready
  for unattended execution across capability snapshots, automatic team
  selection, cached capabilities, and Agent Workspace device summaries.
- Protected macOS, Windows, and mounted workspaces now report that target-side
  authorization is required without implying that physical presence is always
  necessary. OS interaction is required only when the platform asks for it.
- Remote workspace registration responses now include their unattended
  readiness, update the control CLI's capability cache, and reuse an existing
  authorized registration without probing the protected path first.
- Cloud and local automatic configuration no longer select a workspace that is
  registered but currently requires target authorization or is otherwise
  unavailable for unattended execution.
- Managed Agent processes are marked explicitly and cannot invoke workspace
  request or authorization commands to expand filesystem access.

- Fixed terminating a running Codex / Claude Code session from the App: the
  `session.stop` command previously only sent a single SIGHUP to the PTY leader
  (node-pty's default), which Node CLI children often ignore, leaving the agent
  process running. Termination now sends SIGTERM to the whole process group
  (negative pid) — reaching every descendant, not just the PTY leader — and
  escalates to SIGKILL after a grace window if the process has not exited.
  Because both App-side session stops and workspace / collaboration-run stops
  funnel through the same `PtyExecutor.stop()`, this fixes both entry points.

### Changed

- GitHub Release publishing now verifies that the release tag exactly matches
  `v0.2.1` before running the npm publication, and reports an already-published
  package as an idempotent skip.
- Executors now share a single SIGTERM → SIGKILL escalation helper
  (`src/executors/processTreeKill.js`). The pipe executor also escalates to
  SIGKILL (signaling only its own pid, since a non-detached child is not a
  process-group leader); the tmux executor already tears down its whole pane
  tree via `tmux kill-session`.
- The parsed `--executor` (daemon) and `--originrouter-executor` (local session)
  options are now honored instead of being hard-coded to `pty`. The executor
  kind is validated and falls back to `pty` for any unknown value, preserving
  the existing default.

## 0.2.0 - 2026-08-16

### Added

- Added the Agent Workspace entry point for the current project. Running
  `originrouter` in an interactive terminal opens the workspace, while a
  direct objective can be submitted with `originrouter "<objective>"`.
- Added coordinator selection with `-c` / `--coordinator`, supporting Codex
  and Claude Code. Codex remains the default coordinator.
- Added workspace collaboration modes: `auto`, `solo`, `build-review`,
  `plan-build-verify`, `parallel-research`, `review-panel`, and `remote-ops`.
- Added automatic workspace-mode inference and Server Advice-backed planning,
  including resolved mode, planning source, coordinator runtime, and risk tier
  metadata on collaboration runs.
- Added completion support for workspace flags, coordinator runtimes, and all
  built-in collaboration modes.
- Added Remote Ops safety validation requiring a trusted participant on a
  different device before a run can be created.
- Added Agent Workspace and collaboration-advice tests and documentation.

### Changed

- Direct workspace objectives now use the local collaboration control plane and
  can be detached or rendered in plain/JSON output through the workspace CLI
  flags.
- Collaboration run summaries now expose workflow, workspace, coordinator,
  planning, and risk metadata for the App and CLI consumers.

### Legal

- OriginRouter CLI is licensed under the Apache License 2.0 beginning with
  version 0.2.0. Previously published versions remain available under their
  original licenses.
- Added notices covering third-party developer tools, runtime-installed
  components, direct dependencies, and trademarks.

## 0.1.1 - 2026-08-14

### Added

- Contextual bash, zsh, and fish completion.
- The `or` executable alias for every `originrouter` command.
- Task-oriented default help and an exhaustive `originrouter help all` view.
- npm release validation, package allowlist, provenance publishing workflow,
  CI, contribution guidance, security policy, and issue templates.
- Visual README cover and public command, routing, mode, and completion guides.

### Changed

- Removed an unreachable duplicate `doctor` dispatch branch.
- Excluded tests and development-only files from the npm tarball.
- Removed the retired local-console prototype and its repository coupling.
- Limited the npm package to runtime files, public schemas, and user-facing
  documentation.
- Split approval-policy code generation so this public CLI only generates its
  own JavaScript registry.
- Pinned Windows CI to the stable Visual Studio 2022 runner for native Node.js
  dependencies.
