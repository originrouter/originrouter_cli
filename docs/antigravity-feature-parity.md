# agy capability and validation matrix

Source integration checked on 2026-11-20 with official **agy 1.5.13 / macOS ARM64**.
This supersedes the earlier matrix that automatically selected ACP for App-created sessions.
“Implemented” refers to this source version, not a published npm release or deployed App.

## Runtime ownership

| Launch | Runtime | Local interface |
| --- | --- | --- |
| `originrouter agy` | Official native TUI + PTY + Hooks, `agy-pty` | Attached terminal |
| App new/resume of a native agy conversation | The same `agy-pty` controller | Background virtual PTY |
| Resume a recorded `agy-acp` conversation | Its recorded official ACP controller | App, no native TUI |
| Explicit `originrouter agy-acp` | Official ACP stdio | Structured integration, no native TUI |

Startup source does not select the agent protocol. Existing ACP conversations are not
silently migrated. Authentication, model requests and quota stay inside official agy;
OriginRouter never reads Google credential stores or injects a model Provider.
Claude/Codex gateway routes, fixed native aliases and native-config boundaries are unchanged.

## Current capabilities

The two native launch methods have the same agent controls. Login, workspace trust and
whether a local input/output terminal is attached can affect how startup is completed.

| Capability | Both native launch methods | Recorded/explicit ACP |
| --- | --- | --- |
| Optional official install; env-first/system-static proxy | Yes | Yes |
| New, messages, history, stop and exact resume | Yes | Yes |
| Busy input | Durable unsent queue; actual native input receipts; drafts/modals protected | Official concurrent-prompt steering |
| Interrupt and stale interaction handling | PTY interrupt and Hook/request cancellation | Structured ACP cancel completion |
| Tool policies and approvals | Existing OR policy; local OR prompt and App share one resolver; native deny remains effective | Official permission requests and OR policy |
| Single/multiple choice | Native question Hook + current-screen driver + matching native result | Structured native forms |
| Custom text answer | Native single-choice Write-in; mixed custom multi-select is not advertised | Supported form schemas |
| Generic MCP forms / URL authorization | No general responder; unknown native panels remain local | Supported primitive forms; URL elicitation is not taken over |
| Model catalog and selection | Native account catalog; fully-idle child restart and exact conversation resume; observed configuration ACK | Official config setter and ACK |
| Reasoning effort | Account-advertised model variants; no fabricated universal level list | Native config options |
| Native execution mode | Observed native choices; fully-idle restart/resume | Official config options |
| App text attachments | Bounded user-supplied UTF-8 context | Negotiated embedded resources |
| App image attachments | PNG/JPEG signature validation; private session files and native reading, subject to model support | Negotiated direct image blocks |
| Commands | Curated prompt skills and `/compact`; account/UI commands are not passed as generic chat actions | Dynamic native command list |
| Usage | Actual transcript token counts; no fabricated cost, quota balance or context window | Also official context occupancy/window when reported |
| OriginRouter device tools | Session-bound MCP and daemon approval; native-tool and device approvals can be separate steps | Session-bound MCP and daemon approval |
| Reconnect | Existing wrapper re-registers after daemon restart; no second native process | Existing ACP reconnect path |
| Automatic interrupt-and-continue recovery | Not advertised; a formal native cancellation ACK is not assumed | Existing acknowledged recovery path |
| Side/fork and generic background-task management | Native local panels; no general structured App controller | No supported session/fork (observed -32601); task events only |
| Independent terminal attach/detach client | Not added | Not applicable |
| OriginRouter multi-agent/scheduled agy launches | Deferred | Deferred |

The native menu drivers are enabled for the tested 1.5.13 version. The actual startup banner
also checks the running version, guarding against an update between discovery and spawn.
Unknown versions retain native/basic control; unverified menu and content capabilities stay
unavailable. Unsupported controls stay grey instead of reporting a successful no-op.

## Lifecycle guarantees

- The broker, named environment-gated Hooks and optional device MCP entry are prepared before
  the child starts. No workspace `.agents` files are modified. User Hook/MCP entries are kept.
- Bare agy does not contact the OR broker; the inactive MCP entry exposes no tools. There is
  still process startup overhead. `originrouter agy-integration uninstall` removes only owned entries.
- App initial messages wait for the native editor. A previously approved App workspace can
  satisfy its matching native trust prompt; unknown trust/login/modal screens do not receive chat text.
- Unsent message intents are persisted locally. Possibly submitted messages are not automatically
  replayed after a crash. Native USER_INPUT confirms a receipt; a queued command is not proof of inference.
- Local drafts block remote input. Questions use current terminal state, exact tool/step correlation,
  and the actual answer result; prefix matches or a generic subsequent model invocation are not ACKs.
- Model/effort/mode changes wait for full idle, no pending interaction or draft, then stop the old
  child before replacing it. The OR logical session and native conversation remain; PID/physical PTY change.
  CLI flags override this session. Remote setters do not persist defaults via `/model` or `/effort`.
- The local conversation lock retains child identity, so a surviving native writer is not mistaken
  for a free conversation after its wrapper dies. Recovery does not start a concurrent second writer.
- Hook cancellation, timeout, stale replies, child exit and session exit close pending interactions.
  Ctrl+C is not assumed to emit Stop. Turn completion is distinct from closing the session.

## Validation

[The follow-up lifecycle audit](agy-audit-2026-11-20.md) records fixes and
regression evidence for crash, cancellation, duplicate delivery, UTF-8 Hook
framing, configuration acknowledgements and App attachment recovery. It separates
real native-process acceptance, simulated failures and platform limits.

[Sanitized unified-runtime evidence](fixtures/agy-unified-runtime-live-2026-11-20.json) records
actual App/local API and native process checks: background startup and initial input, questions,
choices and write-in, local/App approvals, exact model/effort/mode restart, history recall,
text/PNG attachments, device MCP, busy-message deduplication, stop/resume and daemon re-registration.

The CLI regression suite includes native queue, terminal-state, orphan-writer lock, restart,
question ACK, attachment, proxy, gateway-isolation and retained ACP protocol tests.
App checks cover native catalogs, disabled controls, restart notices, questions/form rendering
and interaction lifecycle. See the evidence file for the latest result counts.

Windows/Linux native execution, a physical phone over the deployed public relay, arbitrary
future agy versions, every complex native dialog, and a complete 300-second human wait have
not been accepted by these macOS checks. Do not infer generic ACP capabilities for the TUI.

Reproduce a fresh isolated live acceptance (uses official account quota):

```sh
node scripts/test-agy-live.mjs --live --parity
npm run test:agy
```

Earlier ACP and TUI research remains in the previous dated fixtures and
[original native validation](agy-native-tui-validation.md); their historical entry-based split
is no longer the default behavior.
