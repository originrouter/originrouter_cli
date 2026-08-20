# Changelog

All notable changes to OriginRouter CLI will be documented here. The project
uses Semantic Versioning and follows the Keep a Changelog structure.

## Unreleased

### Fixed

- Fixed terminating a running Codex / Claude Code session from the App: the
  `session.stop` command previously only sent a single SIGHUP to the PTY leader
  (node-pty's default), which Node CLI children often ignore, leaving the agent
  process running. Termination now sends SIGTERM to the whole process group
  (negative pid) — reaching every descendant, not just the PTY leader — and
  escalates to SIGKILL after a grace window if the process has not exited.
  Because both App-side session stops and workspace / collaboration-run stops
  funnel through the same `PtyExecutor.stop()`, this fixes both entry points.

### Changed

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
