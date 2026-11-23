# Antigravity integration

OriginRouter controls an official account-native agy process. Google login, inference and quota
remain in official agy. There is no OriginRouter Provider injection, Google token reader or
third-party Google OAuth client.

## Install and launch

```sh
originrouter setup --with-agy
originrouter agy
originrouter agy --conversation=<exact-native-conversation-id>
```

Installation is optional, defaults to No when offered, and uses the official platform installer.
`setup --yes` does not implicitly select agy. Existing installations are reused; no agy npm
package is installed. Proxy environment variables win; absent those, supported static system
proxy settings are inherited by this process and download/agent children. Shell profiles are
not changed. See [network proxy limits](network-proxy.md).

`originrouter agy` implicitly uses native configuration. `--provider` and an alternate native
`modelProvider` are rejected without rewriting the user's settings. Informational subcommands
and explicit print invocations remain direct official calls; interactive sessions use the
OriginRouter owner and controlled PTY.

## One native controller for terminal and App

Terminal and App-created agy both run the official TUI through **the same AgyAdapter and PTY
owner**. A local terminal is an input/output attachment; background startup uses a virtual PTY.
The App prepares the same trust, policy, identity, Hook and message controls before launch.
Initial input is queued until the native editor is ready; it is not sent through `--prompt`,
which is official print mode. Exact resume uses `--conversation`, not a guessed native --resume flag.

Recorded `agy-acp` conversations retain that runtime. Explicit `originrouter agy-acp` remains
available for structured integrations. It has no native TUI and does not attach to a running
TUI. App startup and recovery never silently choose ACP to conceal a native limitation.

Existing OriginRouter local API, E2EE relay, workspace/device trust, pending interaction
registry, permission policy, audit and conversation catalog remain the business boundary.
Native Google IDs are separate from OriginRouter session/run/conversation IDs. Claude/Codex
SDK/app-server mappings and gateway model routing are unchanged.

## Controls and side effects

The native integration provides local/App tool approvals, structured native choices and
single-choice write-in, durable message intents, actual transcript/history, bounded text/image
attachments and session-bound device MCP. Questions use tool/step/result correlation rather
than PTY echo. A real terminal buffer handles redraws and modal state. Unknown panels are not
guessed; local drafts are protected.

Native models come from `agy models`. Model/effort/mode setters wait for fully idle state, stop
the old child and resume the exact conversation with session flags, then observe the native
configuration. PID and physical PTY change while the logical conversation stays. The App
explains this behavior and retains the old selection until the native setting is observed.
Only verified account model variants supply reasoning levels. Remote settings do not run the
persisting native `/model` or `/effort` menus. Official agy may still normalize settings or save
workspace trust, and the user can still change their own defaults locally.

Independent named entries are merged into `~/.gemini/config/hooks.json` and
`~/.gemini/config/mcp_config.json`; stable forwarders live under the OriginRouter subdirectory.
Unrelated entries are preserved. Only controlled child environments activate the broker or
device MCP tools. Bare agy has no OR control endpoint and the inactive MCP server has no tools.

```sh
originrouter agy-integration install
originrouter agy-integration uninstall
# Hooks only, retained for compatibility:
originrouter agy-hooks install
originrouter agy-hooks uninstall
```

Starting another controlled session reinstalls its integration. Invalid JSON or a conflicting
user-owned name is not overwritten. MCP setup failure disables only that optional capability;
Hook setup failure is a controlled-session startup failure.

## Capabilities and validation

[The current matrix](antigravity-feature-parity.md) distinguishes native controls from retained
ACP controls and lists exact limits. Generic native MCP forms/URL authorization, fork/background
management, independent terminal attach/detach and automatic interrupt-and-continue are not
advertised. Multi-agent/scheduled agy launches remain deferred.

Native menu drivers are version-gated to the tested agy 1.5.13. The validation evidence covers
macOS ARM64 and isolated native/local API executions. It does not claim deployed phone/relay
or Windows/Linux acceptance. See [sanitized results](fixtures/agy-unified-runtime-live-2026-11-20.json)
and the three agents' launch comparisons in the English/Chinese README.

```sh
node scripts/test-agy-live.mjs --live --parity  # consumes official quota
npm run test:agy                             # isolated protocol/regression tests
```

No npm publication, service deployment or global CLI replacement is performed by this source change.
