# Antigravity integration

Antigravity is an account-native Agent runtime. OriginRouter forwards messages and controls the local official process; Google authentication, model requests and quota remain inside official `agy`. Antigravity is not an OriginRouter Provider and has no gateway route slots.

## Installation and launch

```sh
originrouter setup --with-agy
originrouter agy
originrouter agy --conversation=<native-conversation-id>
```

Antigravity installation is optional. Interactive setup offers it with a default of **No** when missing; `setup --yes` does not select it. `--with-agy` selects Google's official platform installer. Unix bootstrap accepts the same flag; the PowerShell bootstrap uses `-WithAgy`. Existing installations are reused and setup can verify `agy acp --help`.

Existing network proxy environment variables win; otherwise the supported static system proxy is copied into this launch and its children. No shell profile is changed. The official installer's nested download processes inherit the same environment. See [network proxy support and platform limits](network-proxy.md).

`originrouter agy` preserves the native TUI and implicitly uses native configuration. `--provider` is rejected. An alternate `modelProvider` in official agy settings is also rejected, without modifying the file. Complete login in the official CLI. OriginRouter never opens Google credential files or substitutes Google tokens into a model API.

Informational/native subcommands and print invocations remain direct official-process calls. Interactive invocations register through the existing OriginRouter PTY/session-control path. The internal App launcher uses `agy-acp`, not a second ACP process attached to a live TUI.

## Runtime ownership

| Launch | Controller | Model ownership |
| --- | --- | --- |
| `originrouter agy` | Existing PTY wrapper, official Hooks, native transcript | Official TUI; structured model/effort changes remain unsupported |
| App new/resumed agy session | Official `agy acp` over JSON-RPC stdio, wrapped by the existing session registry/control lifecycle | Official ACP config options and native account catalog |
| Claude/Codex gateway session | Existing SDK/app-server or PTY gateway path | Fixed Agent model alias; actual model switch stays in OriginRouter's gateway |
| Claude/Codex explicit `--native-config` managed session | Official SDK/app-server | Official native catalog and model/effort APIs |
| Claude/Codex explicit `--native-config` TUI | Existing native PTY | Unsupported controls stay disabled; existing verified Claude effort control remains available |

The runtime list and model route list remain separate. Collaboration's runtime list stays Claude/Codex; a distinct `agent_runtimes` capability advertises optional agy for ordinary Agent sessions. Multi-agent and scheduled-task support is intentionally not enabled.

App, device trust, workspace trust, E2EE relay, delivery acknowledgements, session identity, permission profiles, audit and conversation history retain their existing responsibilities. The agy adapters emit the existing event and interaction contracts and reuse LocalAgentBridgeClient. Native conversation IDs remain separate from OriginRouter run/session IDs.

The local catalog records native configuration per run so reopening a recorded native conversation does not silently switch it onto a gateway. This adds a defaulted local SQLite column (`native_config`, catalog schema 7), without changing model route records. Existing catalog migrations remain additive.

## Control and history

See the [current feature matrix](antigravity-feature-parity.md) for steering,
forms, attachments, dynamic commands, device MCP, recovery and evidence levels.

ACP supports initial/follow-up messages, official permission requests, cancellation, process stop, resume, native history, and acknowledged model/thinking settings. Model/effort controls use `session/set_config_option`; the updated official config response determines acceptance. Changing model replaces the effort choices with those reported for that model. Unsupported client filesystem/terminal methods are not advertised.

ACP manual approval handles requests actually raised by the official permission engine. A normal workspace file read may be permitted without a request; this is not a guarantee that every tool invocation generates an approval. Existing OriginRouter permission profiles process the requests the adapter receives; unknown tools remain conservatively classified.

For native TUI sessions, PreToolUse waits on a loopback-only broker authenticated with a per-launch token. A user approval returns `auto_approve`, a rejection returns `deny`; native explicit deny rules remain effective. The broker expires unanswered requests before the native Hook deadline. Native disconnect, interrupt, process exit and expiry cancel pending requests, so a stale approval cannot release a later operation. The existing interaction timeout applies, subject to the native Hook upper bound.

The native transcript supplies content/history with stable conversation-plus-step IDs. USER_REQUEST metadata is stripped from user text, tool failures are retained, and old history is not replayed as a new turn. A TUI interruption does not reliably emit Stop, so the local interrupt action also ends the turn and closes pending Hooks. Message input is refused when a detected login/trust/model modal or a local draft owns the terminal.

OriginRouter installs only its named `originrouter-cli-v1` global Hook configuration.
The standalone forwarder is copied into `~/.gemini/config/originrouter/`,
so the global Hook does not depend on a movable development checkout or an
old npm version directory. Unrelated Hook entries are preserved. Outside an OriginRouter-owned launch, the forwarder delegates to the normal agy permission engine and has no control endpoint.

```sh
originrouter agy-hooks install
originrouter agy-hooks uninstall
```

Uninstall removes only the owned Hook entry. Invalid existing JSON or an occupied unrelated entry is reported instead of overwritten. The package includes the forwarder; `node-pty` and the current Node runtime are reused.

## App model controls

Native model catalogs are live facts from the running official process. They travel through existing session events/control snapshots, including daemon reconnect replay, without becoming an OriginRouter Provider catalog or a static cloud model list. Gateway sessions keep their existing device/provider catalog behavior.

The App uses native options only for `source: native`. It sends no gateway Provider key with native selections, and it does not label unknown native models as a gateway's default. Unsupported model and effort rows remain visible and grey, with environment/device/workspace information still accessible. agy usage is not mapped to Codex's OriginRouter budget.

## Verification

Real macOS agy 1.5.13 runs passed the existing local API paths for ACP new, messages, account model changes, thinking changes, permission approval, stop, resume, native history and post-resume responses. The registered native TUI passed messages, Hooks approvals, explicit-deny precedence, stop and same-conversation resume. User model defaults remained unchanged. See [live evidence](fixtures/agy-integration-live-2026-11-20.json).

Real Claude SDK and Codex app-server native catalog/model/effort controls were acknowledged without inference. Gateway isolation, catalog identity, approval handling and App model/history tests remain part of the regression checks.

The opt-in live ACP test consumes official agy quota and uses an isolated daemon/workspace:

```sh
node scripts/test-agy-live.mjs --live
```

`npm run test:agy` uses protocol fixtures, isolated settings and a fake executable; it does not use Google quota. `scripts/probe-agy-native.mjs --live` is the interactive single-session probe documented in [native TUI validation](agy-native-tui-validation.md).

Windows/Linux runtime behavior and the physical mobile App over the production public relay still require platform/deployment acceptance. This change does not publish npm packages, deploy the backend or replace the global installed CLI. Official authentication expiry is reported through the existing session error/status channel; local availability does not guarantee account eligibility or Google service availability.


### Expanded regression limits

The full CLI `npm test` chain passed. Backend launch/permission/model tests:
18 passed. The expanded App workspace suite reported 1408 passed, 5 skipped
and 2 failed UI assertions: an audit empty-search text mismatch and an
ambiguous tap finder matching two `最新对话` labels. They reproduce when run
alone; the associated product layouts were not changed for this integration.
Focused model/control/history/launch tests pass. Full-project App analysis
also reports an existing undefined `BridgedAuditClient.listRecentEvents`
call in `tool/smoke_control_bridge.dart`; analysis of the changed model/control
files has no errors (existing style infos remain).
