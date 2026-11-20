# agy capability and validation matrix

Checked against official agy **1.5.13**, macOS ARM64, 2026-11-20.
“Implemented” describes the code path; evidence distinguishes real-account
checks from protocol tests. Windows/Linux and a physical phone over the
deployed public relay have not been accepted on this machine.

## Architecture boundaries

- `originrouter agy` owns one official TUI process, observed through PTY,
  Hooks and native transcripts. ACP never impersonates attachment to that TUI.
- App new/resume owns an official `agy acp` process. Google conversation IDs
  remain distinct from existing OriginRouter session/run/conversation IDs.
- Google's login, model requests and quota stay in official agy. No Provider
  injection, third-party Google OAuth client or credential reader is added.
- Claude/Codex gateway sessions retain their fixed native aliases and
  gateway model selection. Native catalogs/setters apply only to explicit
  `--native-config` managed Claude/Codex sessions.
- Trust, local API, E2EE routing, acknowledgements, autonomy policy, pending
  interactions and audit remain the existing OriginRouter control boundary.

## Function matrix

| Feature relative to Claude/Codex integration | App-created agy ACP | Terminal-started agy TUI | Evidence / limit |
| --- | --- | --- | --- |
| Optional official installation and proxy fallback | Implemented | Implemented | Env-first/system-static-proxy fixtures; optional installation defaults to No |
| Account login | Reuses official saved login | Official login UI | Real account; OriginRouter does not authenticate on Google's behalf |
| App new/resume/stop, identity and history | Implemented | Follow existing run; resume after stop | Real local API/native processes |
| Messages during a running task | Native ACP steering | Native TUI queue policy | Real steering; one logical turn across concurrent prompts; local draft/modal refuses input |
| Cancel and stale approval rejection | Native cancel completion | PTY interrupt + Hook cancellation | Both real; TUI does not reliably emit Stop on Ctrl+C |
| Tool permissions and OriginRouter profiles | Requests raised by native permission engine | PreToolUse broker | Real approvals; native explicit deny wins; manual/guarded policy tests |
| Questions/forms | Titled choices, multiple choices, text, numeric/boolean fields, cancel | Native panel remains local | Real elicitation answer via local API; App widget tests; unknown schemas fall back to native behavior |
| Text/thoughts/plans/tool output and diffs | Implemented | Available Hook/transcript events | Real text/thought/tool traffic; plan/partial-tool protocol tests |
| History details | Thoughts, tool pairs, actual token counts | Same transcript parser | Stable IDs, bounded paging and parser tests |
| Native model/thinking selection | Official catalog and config ACK | Unsupported controls grey | Real switches; original user default unchanged |
| Native execution mode | Official config option | Observe native mode; setter disabled | Separate from OriginRouter permission profiles |
| `/` menu | Dynamic native directory plus App rename/export/quit | Documented prompt skills plus App actions | Real directory and `/compact`; UI-only controls not advertised |
| Images and text-file attachments | Capability-negotiated direct/E2EE content | Disabled | Real image recognition and local-API embedded text; refused sends restore App attachments |
| Context/usage | Actual context occupancy/window; transcript token counts | Transcript token counts | No fabricated bill, quota balance or rate-limit reset |
| OriginRouter device-tools MCP | Existing session-bound approval flow | Not advertised | Real `remote_env_list` through MCP + daemon approval |
| Runtime supervision/recovery | Turn ID, output samples, native cancel ACK and send receipt | Automatic recovery not advertised | Real cancel ACK; continuation/loop/recovery/stop-protection protocol tests |
| Reconnect | Commands, capabilities, usage/settings restored | Existing wrapper reconnect | Daemon restart/re-registration and App session-isolation tests |
| Errors/rate limits | RPC errors feed task failure/supervision | Existing process/error events | No live quota exhaustion or manufactured model loop |
| Side conversation/fork | Not exposed | Native `/btw` panel remains local | Real `session/fork`: **-32601 Method not found**; no fork capability advertised |
| Background-task management | Tool activity/results forwarded | Native panel remains local | No verified ACP equivalent of Codex background terminal list/stop |
| Google URL authorization / quota dashboard | Not taken over | Official CLI panels | No verified App control contract; credentials remain official |
| OriginRouter multi-agent/scheduled agy launches | Deferred by agreed scope | Deferred by agreed scope | Existing orchestration runtime lists stay unchanged |

Native ACP may advertise its own `schedule`, `swarm` or other skills.
Forwarding those official commands does not enable OriginRouter's distributed
collaboration or scheduled agy launch engine.

Attachments use at most 8 blocks, 512 KB per selected file and 768 KB of
serialized content. Only inline image bytes and UTF-8 text are accepted;
the daemon never fetches arbitrary attachment URLs or reads a client path.
PDF/binary attachment UI is not offered. Unsupported content is rejected
instead of silently discarded.

## Verification

- Full CLI `npm test` plus agy transport/permission/reconnect/recovery tests.
- Real ACP: new/resume/reply, model/effort ACK, device MCP approval, question
  form answer, embedded text, image recognition, steering, cancel, `/compact`,
  stop and same-conversation history.
- Real TUI: App messages, Hook approval, explicit-deny precedence, stop and
  same-native-conversation resume.
- Real Claude SDK/Codex app-server native catalogs and setting ACK without
  inference; gateway isolation remains covered by existing tests.
- App expanded regression: **1478 passed, 5 skipped, 2 existing failures**:
  audit empty-search copy and an ambiguous `最新对话` tap finder. A new
  attachment-menu regression found here was corrected and its tests pass.
  Focused native/model/history/client/menu/form tests pass.
- Backend launch/permission/model tests: **18 passed**.
- Agent/workspace/App-shell analysis has no errors; style infos remain.
  Full-project analysis retains the previously recorded unrelated
  `BridgedAuditClient.listRecentEvents` smoke-tool issue.

See [sanitized evidence](fixtures/agy-parity-live-2026-11-20.json).
From a source checkout, reproduce the local API acceptance (uses official account quota):

```sh
node scripts/test-agy-live.mjs --live --parity
npm run test:agy
```

No npm publication, backend deployment or global CLI replacement is performed.

## Official references

- [ACP guide](https://antigravity.google/docs/ide/extensions/acp/)
- [CLI reference](https://antigravity.google/docs/cli/reference/)
- [Official changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)

The guide documents images/embedded resources, forms, in-flight steering,
permissions and cancellation. Availability is also checked against the
installed executable's initialize/session/config/command responses rather
than inferred from generic ACP alone.
