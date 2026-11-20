# Changelog

All notable changes to OriginRouter CLI will be documented here. The project
uses Semantic Versioning and follows the Keep a Changelog structure.

## Unreleased

### Added

- Optional official Antigravity installation (`setup --with-agy`), a native
  `originrouter agy` TUI with Hooks/control/history, and App-created or resumed
  sessions through official ACP. Authentication and quota remain with agy.
- Native model catalogs and model/effort control for explicit
  `--native-config` Claude SDK and Codex app-server sessions. Gateway sessions
  retain their existing model alias and route ownership.
- Per-launch network proxy discovery with environment precedence and static
  system proxy fallback, including installer download subprocesses.
- Antigravity ACP steering, native command menus, question forms, image/text
  context, usage, device-tools MCP and acknowledged runtime recovery through
  existing App/device control paths. Unsupported native controls stay disabled.

### Fixed

- Preserve native configuration when reopening recorded native conversations;
  report authentication/startup errors and detach ended Antigravity sessions
  before cloud reporting can delay their local presence update.

## 0.6.0 - 2026-11-17

### Added

- **A device can hold an SSH host.** A host the user configures is kept per
  account with its own credentials, its own confirmed fingerprint and its own
  connection. The fingerprint is what the user confirms once; a host whose key
  changes is warned about and cannot be used until it is confirmed again.
  Credentials live in the platform keyring, not in the store — the headless
  vault is the variant for a device that has no keyring to talk to — so a host
  can be edited without its credentials being replaced. One transport carries
  several sessions, and a command that times out leaves the remote outcome
  unknown: an unknown outcome freezes the session, and the next command is
  refused until the host has been looked at, because running more commands on a
  session whose state is unknown is how one timeout becomes two.
- **A task can run on its own schedule.** A task the user wrote once can start
  a run by itself: once at a time, every so many seconds, or every week on
  given days and times in a named timezone. The schedule is stored per account
  and every write carries the revision it was made against, so two devices
  editing the same task cannot silently overwrite one another. The scheduler
  launches through the same supervisor the App uses, so a scheduled run is
  judged and recovered like any other run, and a run that is already active is
  not started a second time. The launch is remembered before it is attempted:
  if the daemon dies between the two, the task still says a run was due, which
  is the difference between "ran" and "never ran".
- **An Agent can act on the machine it runs on.** The scheduled tasks and the
  SSH hosts the user configured are exposed as their own MCP server, mounted
  next to the collaboration one, so a session that should not reach the device
  is not given the server in the first place. Every operation is checked by
  the daemon, not by the client that asked, and the approval is the user's
  answer to the daemon's own question: one approval is tied to one session, one
  account and one request, and an answer that arrives for a session that has
  since been detached, for an account that has since changed, or after the
  question has expired is refused. The tools say what they cannot do — a
  timeout or a disconnect means the outcome is unknown and must not be retried.
- **A run that hangs is judged, watched and recovered.** A turn that never
  answered used to sit in the supervisor until its timeout, and the timeout was
  the only thing that ever ended it. The supervisor now watches what the run
  actually produced: the output sampler cuts a stream into samples, the loop
  detector recognises a repeated cycle, and a judge asks a model whether a run
  that has stopped moving is still working or is stuck. Recovery is durable —
  what the supervisor knows about a session is written to the task store, so a
  daemon that restarts mid-recovery finds the same uncertainty instead of
  starting a second turn on a session that is still running. A run the user
  stopped leaves a mark that survives the restart, and the supervisor refuses
  to resume until the user asks again.
- **The local API serves the devices and the runs.** The loopback API now
  answers for the new surfaces: the SSH hosts, the scheduled tasks, and the
  device tools an Agent asked for. The requests that carry credentials or run
  commands are answered only on loopback; another device has to come through
  the encrypted relay, which is the path that can be authenticated. Two kinds
  of traffic are deliberately not kept: the streaming samples a run produces
  are transient — a sample that arrives after a reconnect could belong to an
  earlier turn — and an approval result is the same, a capability decision
  that was true once and must not be replayed into a run the user has not seen.
- **The daemon answers the requests the other devices send.** A device that
  asks this one to hold a schedule or manage an SSH host sends it over the
  encrypted relay. The session manager routes the request to the service that
  owns it and answers under the request id that came with it; a service that is
  not there answers with why, so the other device is not left waiting. The two
  message types are protected, so their contents are encrypted the way the
  rest of the device traffic is: a host the user configured carries a password
  or a private key, and neither belongs in a message the relay can read.
- **The device says what ends a session's processes.** Closing an SSH session
  ended every process the session had started on the host. That was the safe
  answer, but not always the wanted one: a user who started a long command in
  the background had it killed by closing the session. Two settings, both on
  by default, say whether closing a session ends the remote processes it
  started and whether a command may run in the background at all; only an
  explicit false turns one off, and a setting that was never written leaves
  the behaviour the device promised. A background command travels inside a
  quoted here-document and runs as a child of the shell that carries it, so no
  byte of it is re-parsed by the shell that runs it and a signal ends the
  command on the first signal.
- **A conversation's name comes from the agent, and a chosen one stays.** A
  conversation's title was whatever the App wrote into the launch request
  ("Claude Code", "Codex") and nothing ever replaced it: the CLI reported that
  literal on every event, the server kept it, and the rail showed it forever.
  There are three kinds of title and one order between them — a title the user
  set, then a title the agent produced, then a placeholder. The agent's own
  name is read from the transcript (`ai-title` for Claude, `thread/name/updated`
  for Codex) and reported lazily, so a name that lands mid-run reaches the next
  event instead of waiting for the session to end. A placeholder never
  displaces a name, and `title_is_custom` rises and never falls, so a later
  sync cannot overwrite a rename.
- **The device says which session a conversation belongs to.** The device is
  the one side that knows both ids: its catalogue holds a conversation's runs,
  and each run records the session id it was started under. The conversation
  row now carries that `session_id`, and a conversation looked up by the id
  the App holds is found again through its runs — the App reopens a session by
  the session id, which for a session the App started is a different string
  from the conversation id. The link goes to the cloud catalogue too, and the
  sync cursor's namespace moves to v5, so the existing conversations are
  reported once more to add it.
- **A model keeps the levels the reader wrote for it.** The device does not
  know what a model the reader brought with them can do — only the reader
  does. So the levels live beside the pricing, in the provider's own record,
  and are the reader's own words: kept verbatim, saved with the model, and
  carried along when the model is shared with another device. The levels a
  model has are then read in one order — the reader's own declaration, the
  cloud's coding catalogue, the local table, and finally **empty**, which is an
  honest answer: a level a model does not have, chosen anyway, fails when it
  is pressed, and nothing stopped the reader from pressing it. Empty is
  reported as "not supported", and the App greys that row out instead of
  offering a list of levels that would fail.
- **A session can name its own model.** The device route stays the default:
  a session that names no model runs on whatever the device is routed to, and
  changing the device's route never invalidates a session's own choice. The
  override is written per session, survives the daemon, and is applied by the
  compatibility gateway on the next request — the agent keeps asking for the
  route alias it was given and never learns which upstream model is really
  answering, so the Claude and Codex SDKs are untouched by this.
- A launch-time `--model` now *is* a session override rather than the agent's
  own model string. In route mode the agent must keep asking for the route
  alias, or the proxy has nothing to translate — handing a concrete id
  straight through named a model the proxy could not resolve. A target that
  does not validate is reported and the device route stays in force.
- The session publishes its model as soon as it is ready
  (`agent.model.status`). The registry folds the status into the session
  record, and the session list and control snapshot carry it out.
- The status reaches the cloud too, so an App on another machine sees the
  session's model without asking the device: the runtime event carries the
  session's four model facts (`model`, `modelProvider`, `source`,
  `modelControl`), and the control plane records them on the session row.
- `modelControl` tells the App whether the session's model may be changed. It
  is `supported` only on route mode, which is the one transport with a place to
  rewrite the request's model — the compatibility gateway. A session connected
  through the account bridge is still route mode, so it can change its own
  conversation's model; a session on `remote-coding`,
  `originrouter-coding` or `inherited` reports `unsupported` and the App shows
  its model read-only.
- **A refused change is said out loud.** The device's answer to a model change
  travels with the status event — whether the change was accepted and, when it
  was not, the device's own reason — so the App can tell the reader that the
  change did not happen instead of leaving the tap looking like it did nothing.

### Changed

- **One provider conversation is one row, here too.** The identity of a
  conversation is the provider's own id — the Claude Code session uuid — and
  the device's catalogue now says so in the database rather than only in code:
  a partial unique index on `(agent_type, native_session_id)`, where
  `native_session_id <> ''` says in the index itself that a conversation the
  agent has not named yet is its own conversation. The write path finds the
  row that already holds the provider id and writes there, so a second row
  cannot be written at all; the label of the current attempt only counts when
  nobody holds it yet. The rule is shared with the server and the App through
  `contract/agent_conversation_rules.json`, pinned by SHA-256, so the three
  sides answer the same question the same way.
- **A switched conversation is handed over, not torn down.** In the TUI,
  `/resume` used to make the user watch the process be interrupted and read a
  notice. It now stops the old process, rewrites the arguments to the new
  conversation's resume and starts a new wrapper — the same terminal, and the
  reader does nothing. The handover is decided by the provider's own id: the
  first id a run reports is the conversation of that run, and a different id
  later means the agent changed conversation underneath (`/resume`, `/branch`,
  `/clear`) — not that it was renamed. One conversation has one writer at a
  time, because two processes writing one transcript file split the history in
  a way nobody can untangle afterwards; the lock is on the provider's
  conversation id and it lapses with the process that held it.
- **The device reads the coding catalogue the App reads.** The agent channel
  read the console's `/ai/model`, which answers "what may this account buy"
  and is not cut by tier, so the device and the App read two different lists:
  the App listed the models the account can really run while the device
  picked one a free account's request would be silently downgraded from. The
  device now reads `GET /coding/v1/models` — the same list as the App's model
  picker, answered by the token and the host that answer the request. A free
  account is therefore given the models it can run: the default route asks the
  catalogue for a model it can serve rather than naming a paid one.
- The session's model is not invalidated by a device route change. A route is
  the default; a session's own choice is a fact about that session.
- **The list of models a session may be pinned to is no longer carried on the
  session.** It is the device's fact, and it already has exactly one transport:
  the local-control provider snapshot (`localControlProviderSnapshot` →
  `providers_json`). The runtime event carries the session's model and nothing
  else, the registry does not store a catalogue, and the App asks the device
  for the list when it opens its picker. A per-session copy would go stale the
  moment the device's providers changed, and the CLI's own
  `availableSessionModels` — a third derivation of the same rule — is gone
  with it.
- **An approval policy is enforced; there is no observation mode.** Shadow
  mode evaluated a policy, recorded what it would have decided, and then
  asked the user anyway — a decision nobody was bound by. It is gone: the
  evaluator's decision is the outcome, so allow allows, deny denies, and only
  "ask" reaches the user. A policy file that still carries the legacy
  `metadata.enforcement: "shadow"` marker keeps loading and is enforced like
  any other — the marker now loads as a validation warning, not a mode — and
  the `agent.approval_policy.shadow` event went with it.

### Fixed

- **An interrupted turn is a turn that ended.** Interrupting a turn in the
  terminal wrote one line to the transcript (`[Request interrupted by user]`)
  and sent no event at all, so the device's `turn_state` stayed latched on
  `running` and the App showed the stop button for a run that had already
  stopped. The scanner knows the marker and reads it as the end of the turn.
- **The process's end reaches the device's event tail.** `session.exited` and
  `session.error` went to the relay frame and to the server's runtime-event
  report, and to neither the local tail, so a runtime that crashed or was
  killed left the App's last word as `agent.task.started` — a turn latched
  open and a stop button for a session with nothing left to stop. They go
  there too now, and they go out before the bridge closes, because a closed
  bridge delivers nothing.
- **The review template must apply to this device and workspace.** A review
  template the user chose for one device or one workspace was used on any
  device. The template says which device it was written for and which
  workspace it belongs to, and a launch on a different one is refused: the
  answer the template gives was written about somewhere else.
- **A refresh answer carries more than the audience it asked for.** Surety
  answers a refresh with every access token the session may use, not just the
  one the call named; the refresher kept only the audience it asked for and
  threw the rest away, so the next request for a different resource had to
  refresh again — spending the refresh token it had just been handed to buy a
  token the previous answer already carried.
- **The relay's token is asked for when it is used.** The client held one
  bearer, set when the relay connection opened, and sent it on every request
  after that. The token lives about ten minutes, so from the moment it expired
  every `POST /relay/v1/messages` was refused as unauthorized — once a minute
  — until a reconnect put a new one in place. The relay now asks its provider
  for a token at the moment a request goes out, including the WebSocket
  handshake, which cannot be retried with a different token later. A provider
  with nothing to give leaves the client on the token it holds, so a request
  that would have gone out still goes out.
- **A conversation that the local catalogue and the cloud name differently no
  longer fails every five minutes.** The cloud freezes a conversation's id on
  the first report that names it, and the local catalogue keeps the id of the
  attempt that was last active; when the two disagree, every route that looks
  the conversation up by id (`reconcile-previews`, `history/manifests/start`)
  answers 404, and the queued previews and the transcript never drain.
  `scripts/align-catalog-conversation-id.sql` puts the local row back under
  the id the cloud froze — one transaction over the local sqlite, the daemon
  keeps running, nothing on the cloud is touched, and the transcript is not
  uploaded again. `docs/agent-conversation-id-alignment.md` says what happened
  and when the same shape appears again (the same conversation used on a
  second device).
- **A credential write or clear can no longer cross an account switch.** An
  OAuth refresh, a logout, or a login inspection that stalled mid-flight used
  to act on whichever account was active when it resumed, so a slow operation
  started under one account could overwrite or erase a newer login under
  another. Credential files now sit under a cross-process lock — a SQLite
  transaction, which the operating system releases when a process dies, so a
  dead holder no longer leaves a lock its successor has to time out — and
  every clear and refresh compares the stored session's identity against the
  one the operation began with. An operation that finds the account changed
  underneath it answers `account_changed` instead of acting on a session it
  was never started against, and a logout that lands late leaves the newer
  login alone.
- **The device's name is read from the account registry, once a session
  exists.** Enrollment and the name a device shows used to be decided on their
  own; a device that had already been named on another account could carry
  that name into a new login. The account registry is authoritative for a
  synchronized name: the daemon asks it once the session is up and applies
  the answer only to the account and session that asked for it — a response
  that lands after an account switch is dropped — and a name that was
  synchronized under one account is never proposed as the default for
  another.
- **A finished run stays answerable, and a command for a dead run is
  refused.** Restarting the daemon used to forget every run the registry had
  ever heard of: history for a completed session answered
  `session_not_registered` as if the run had never existed, and a command
  aimed at a dead run was queued into a buffer no process would ever drain —
  the App got nothing back at all. The registry now rebuilds its runs from
  the catalogue on boot, so a finished session's transcript stays where
  `history` can read it. A run the catalogue last saw as live keeps its
  status for one stale window — a wrapper that survived the restart
  re-attaches the moment it calls home, and one that does not is finished
  with the bookkeeping an exit would have done. A command for a run whose
  process is gone is answered with `session_detached`, a terminal refusal on
  the protected relay route, so the App hears "not running on this device"
  instead of silence.

### Security

- **DPoP (RFC 9449): a device proves it holds the key it registered.** After
  login the CLI registers a short-lived Ed25519 key, proves possession of it,
  and from then on its control-plane and relay requests carry a proof signed
  by that key instead of trusting the bearer token alone. A token copied out
  of a log or a backup no longer buys anything on its own: the thief has no
  private key. The registration is signed by the device's long-term E2EE key,
  so a stolen access token cannot register a key of its own.

  Nothing changes for a device that has not registered: a device that has not
  logged in since this shipped, an older server that does not have the routes,
  or a server whose migration has not run all keep sending bearer tokens.
  `ORIGINROUTER_DPOP=off` turns the feature off entirely.

  Registration now ends in an activated session, not just a proven key. After
  the proof the device completes `POST /cli/v1/dpop/session/activate`, and the
  server answers protected calls only after that step — a login's first
  protected request used to arrive at a `device_session_not_activated`
  challenge and fail. The DPoP fetch prepares a session once before a login's
  first protected request, answers the challenge by activating again and
  replaying the request once, and concurrent CLI processes run the whole
  sequence under the same lock that protects the credential store, so two
  logins share one registration rather than racing two.

### Upgrade notes

- **DPoP is on for a device that has logged in since the upgrade.** The server
  has to have run `sql/056_originrouter_dpop_keys.sql` before a device's key
  means anything there. Until it has, the server does not have the route and
  the device carries on with bearer tokens exactly as before — the registration
  is what turns the feature on, not the version. A device that has not logged
  in since the upgrade is not affected at all, and `ORIGINROUTER_DPOP=off`
  turns the feature off entirely.
- **The device's catalogue folds its duplicate conversations once.** The
  unique index on the provider's conversation id can only be made once the
  rows that break it are gone, so the device folds them on the first open: one
  conversation under several labels becomes one row, and the label of the row
  that already held it stays. If a row cannot be folded, the device says so in
  its log and leaves the index alone rather than refusing to start.
- **A launch-time `--model` is now a session override, not the agent's own
  model string.** In route mode the model has to be a route alias the proxy
  can resolve — handing a concrete upstream id straight through named a model
  the proxy could not resolve, and the request quietly meant something else. A
  target that does not validate is reported and the device route stays in
  force.
- **A model's reasoning levels may now read as unsupported.** The levels are
  read from the reader's own declaration first, then the cloud's coding
  catalogue, then the local table, and finally empty. A model none of those
  know now reports "not supported" and the App greys the row out, where before
  it was offered the runtime's whole word list — levels that failed when they
  were pressed, with nothing in the interface to stop it. The reader's own
  declaration is the way to say what a model can do, and it is kept with the
  model.

## 0.5.1 - 2026-10-15

### Added

- `agent.interactionTimeoutMs` decides how long a request for permission may
  wait. It used to be whichever of five hard-coded deadlines fired first, and
  the outermost was 315s — so a phone in a pocket produced a permission decision
  nobody made: the request expired while the screen was off, the registry
  recorded `expired` / `auto_resolution_timeout`, and the agent was told the
  user had declined. Whether a request should ever expire is the user's call.
  The setting takes a millisecond count or `5m` / `2h` / `1d`, defaults to `0` —
  wait as long as it takes, and the App shows no countdown — and is read per
  request, so `config set` takes effect on the next approval without a daemon
  restart. All five layers move together, each one outward getting a fixed 15s
  grace, so the window you configured is always what fires first and the layer
  above it only covers an answer that never arrives. Claude Code insists on a
  finite hook deadline; that one keeps an 86400s ceiling and is documented as
  the thing that finally gives up.

### Changed

- **The Local API now binds `0.0.0.0` by default, and LAN access is on by
  default.** 0.5.0 bound loopback, which made the daemon unreachable from every
  device but this one — including the three routes that exist precisely for a
  device that cannot read a 0600 file on this machine: `/local/e2ee/session`,
  `/local/e2ee/messages` and `/local/pair/redeem`. The bearer token is unmoved
  and is still the wall; everything else on the socket answers 401. See
  **Upgrade notes** below.
- The bind address follows the binding instead of second-guessing it. It is the
  answer to "how do you reach me", so a concrete bind is kept, a loopback bind
  says loopback, and only the wildcard is scanned for a LAN address to suggest —
  the one bind whose LAN address is real. Before this, `suggestLanHost` scanned
  the interfaces for a bind address it treated as unknown, and a wildcard bind
  got a LAN address every phone was told to use.
- Consent and address resolve together, because they are one decision. A caller
  that names an address must also consent to exposing it; a caller that names
  nothing gets the shipped pair. Reading the two independently is what let them
  contradict — a loopback address with consent off is not a policy, it is a
  server that refuses to start on its own defaults.
- `local api pair` issues one credential instead of two ways in. The
  8-character code and the signed pairing line handed over the same ticket, and
  the code path was the weaker one: it signed nothing, so what it handed out was
  a routing hint rather than a credential — while the App kept two input fields,
  two error vocabularies and a mode switch for the privilege. The code, `--line`
  and `--json` are gone; a command that prints one thing should not have a flag
  for asking for that thing. The signed line prints as a terminal QR and as
  text, wrapped as `originrouter://pair?v=2&l=<payload>` because the shared
  scanner admits `originrouter:` and nothing else.
- `local api pair` output and its `--help` paragraph state facts instead of
  briefing. Someone who typed `local api pair` has already decided to pair, and
  both were answering questions that reader does not have. The output block now
  labels its fields the way `status` does — `bindAddress`, `tokenSet` — because
  those are the keys inside the files they point at.

### Fixed

- The pairing code named an address nothing was listening on. The daemon bound
  `127.0.0.1` while `suggestLanHost` returned the LAN address, so the pairing
  line, the QR and the `Address` line all carried an address with no socket
  behind it. Every phone scanned a code pointing at nothing; pairing worked only
  from the host itself, and the CLI printed "Edit the address in the App"
  underneath, so the failure looked like the App's.
- `local api status` reported `baseUrl` formatted straight from the bind, and
  would have printed `http://0.0.0.0:<port>` under the new wildcard default — a
  base URL that is not a URL you can fetch.
- Opening the workspace picker on a phone spun for 30 seconds and then reported
  that the device had not answered. The device had answered; the CLI threw the
  answer away. `agent.workspace.browse` had two responders, and the one ahead in
  the dispatch chain opened with a device check that compared the target in the
  relay payload against this device's id — a field the App never puts there. An
  absent field yields `""`, which is never the device id, so every such frame
  was claimed and dropped, before any log line, on both ends. One type now has
  one owner. `collaboration.remote.error` had the same guard inverted, so
  App-sent error frames skipped error handling entirely.
- One permission ask is one card. Claude Code 2.1.283 does not put
  `tool_use_id` on `PermissionRequest`, so the hook server minted a fresh id per
  delivery, and every repeat delivery became its own independent permission:
  three cards for one Write, three expiries, three denials back to the terminal.
  The ask is now identified by what it actually carries on both ends —
  `(session_id, prompt_id, tool_name, canonical(tool_input))` — with a repeat
  delivery joining the open hold and receiving the same answer. A payload
  missing any field falls back to the old random id, since merging two
  looks-alike asks is worse than two cards.
- A remote permission no longer vanishes after exactly five seconds. The hook
  forwarder's `http.request` named no agent, so it inherited `http.globalAgent`
  — which Node 19+ gives a 5s socket timeout — and overrode
  `permissionRequestTimeoutMs: 0`, the setting that means "hold until someone
  answers", with a deadline nobody chose and nobody could configure. Claude Code
  then fell back to its own terminal prompt. Measured on the live session: three
  attempts, 1934→1939, 1940→1944, 1944→1949, `client_disconnected` every time.
- A trailing thinking block no longer re-opens a finished turn. A turn routinely
  arrives as `agent.task.started → task_result_ready → agent.thinking →
  agent.text`, and reading that last block as a fresh turn start re-latched a
  finished turn to "running" — so the App showed a stop button for an idle
  Agent. `agent.thinking` may now lift an active turn, never open one.
- Revoking a device or rotating its key no longer invalidates signatures that
  device had already made. Trust is judged at signing time — was the signer
  trusted *when it signed* — rather than whether it is trusted now, which had
  retroactively voided the admission policy every other device vouches for: the
  CLI alone stopped relaying while the App kept working.
- A trust event no longer wedges the conversation silently. The sender still
  holds the session an `e2ee.sessions.reset` arrived on, so its next envelope was
  read as a first one and refused, and the session stayed stuck until the App's
  half was reaped half an hour later. The sender is now told to drop its half
  instead.

### Upgrade notes

- **The daemon listens on all interfaces after upgrading.** 0.5.0 bound
  `127.0.0.1`; 0.5.1 binds `0.0.0.0` with LAN access on. This is deliberate —
  a loopback bind put the three token-free E2EE routes where no device but this
  one could reach them, which is why pairing from a phone never worked — but it
  is a real change in posture, so: the bearer token is still the wall and
  everything else on the socket answers 401, and the token-free routes
  (`/local/e2ee/session`, `/local/e2ee/messages`, `/local/pair/redeem`) are
  authenticated cryptographically by device identity, not by possession of the
  file. To go back to loopback, set the bind address explicitly —
  `originrouter local config set --bind 127.0.0.1 --allow-lan off` — which is
  now recorded as your choice rather than as a note of what the default
  happened to be, so a later upgrade will not undo it. An install that never
  chose anything picks up the new default on its own and needs no action.
- `local api pair` no longer accepts `--line`, `--json`, and no longer prints an
  8-character code. Scan the QR or paste the printed line; the App's pairing
  import field takes the line, and the code field is gone from both sides.
- `agent.interactionTimeoutMs` defaults to `0`, which is a change from the 315s
  ceiling it replaces. If you relied on that ceiling to unstick a request whose
  device had gone away, set it explicitly — but note the old behaviour it
  replaced also told the agent you had declined.

## 0.5.0 - 2026-10-08

### Added

- Claude model routing now has five slots — one primary model plus one per
  model family — instead of two. Claude Code resolves its built-in subagents by
  family, so an agent declaring `model: opus` reads `ANTHROPIC_DEFAULT_OPUS_MODEL`
  and one declaring `model: haiku` reads `ANTHROPIC_DEFAULT_HAIKU_MODEL`. With
  only `main` and `small`, four of the five families had nowhere to point except
  the primary model. The slots are `main`, `opus`, `sonnet`, `haiku` and `fable`,
  each injected as its own environment variable, and each auxiliary slot may
  **inherit the primary model** — the default, which keeps a family following the
  primary even when the primary's provider is later changed.
  `originrouter route set claude` takes `--opus`, `--sonnet`, `--haiku` and
  `--fable`, each accepting a model id or the literal `inherit`.
- Live events for a session with several subscribers are sealed once under a
  per-session group key and fanned out by the relay, instead of being re-encrypted
  for every recipient. Request and response traffic stays pairwise. Group keys
  are stored under `<state-dir>/session-group-keys/` with directory mode `0700`
  and file mode `0600`. Subscribing to 40 sessions no longer takes about six
  seconds, and no longer delays the first history page by roughly eighteen:
  subscribers get every key they are missing in one frame and report the keys
  they already hold, so a re-subscribe in the steady state sends nothing.
- Agent presence is reported explicitly (`agent.session.presence`) rather than
  inferred from turn status, and is reconciled against the catalog on every relay
  reconnect, so a session that stopped while the relay was down cannot linger as
  active.
- `originrouter daemon status|restart|stop` delegate to the service manager.

### Changed

- `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` are no longer
  injected. The first is replaced by the per-family defaults above;
  `CLAUDE_CODE_SUBAGENT_MODEL` was removed because it collapsed every model-less
  subagent onto the primary model. The `originrouter-claude-fast-model` alias no
  longer exists.
- All Claude slots must share one provider, and this is now enforced across every
  slot rather than only between `main` and `small`.
- When the Local API lands on a port other than the one requested, the daemon
  says so loudly and names the command that pins a port — under a service manager
  its own stderr goes to `logs/daemon.err.log`, where nobody reads it.
- Session ids are `claude-<32 hex>` rather than `claude-<millisecond
  timestamp>`. The server keys sessions with `UNIQUE (session_id)` and no account
  column, so the old id was only unique within one machine: two devices starting
  in the same millisecond collided and the second user's conversation was left
  with no session row at all.
- The provider's own conversation id is recorded as `native_session_id` instead
  of being folded into the conversation id, which had split one run across two
  unjoinable keys. An empty report never overwrites an id recorded earlier.
- Shell completion for route targets is derived from the routing table rather
  than hand-maintained.

### Fixed

- The Local API port no longer ratchets away from the default. `local-api.json`
  records where the daemon last bound, not a port anyone asked to keep, but it
  was treated as authoritative — so on a host where 7437 was taken the daemon
  moved to 7438, wrote 7438 back, and then preferred 7438 permanently. Port
  selection is now precedence-ordered and fallback-aware, and a port set with
  `local api set-port` survives restarts.
- `a ?? b != null ? x : y` parses as `(a ?? (b != null)) ? x : y`, so a port from
  `local-api.json` counted as *explicitly requested* — and explicit ports never
  fall back, which turned a busy port into a hard startup failure.
- `--local-port 0` / `ORIGINROUTER_LOCAL_PORT=0` again ask the kernel for a free
  port, as they did in 0.4.9, and that request now outranks the recorded and
  default ports rather than being overridden by them.
- Ports are parsed strictly. `Number.parseInt` stops at the first character it
  cannot use, so `"80abc"`, `"80.5"` and `"0x10"` were read as 80, 80 and 0 —
  a typo became a plausible wrong port instead of an error.
- Sending and stopping no longer flicker. The CLI reported "terminal activity"
  on a two-second timer whenever the terminal's rendered output changed, and
  interactive TUIs redraw constantly: one measured session produced tens of
  thousands of identical rows, which crowded real turn events out of the App's
  most-recent-100 window. The reporter is gone; turn state comes only from turn
  events.
- Conversations no longer reorder or stick on "running". The activity timestamp
  is a high-water mark (`MAX(last_activity_at, ?)`) so a late duplicate finish
  cannot move it backwards; the latest-run join prefers a still-open run; and the
  exit status sync runs first, bounded by a timeout, instead of being reaped
  before it could run.
- Long Claude conversations page back without re-reading and re-parsing the whole
  transcript on every page; the parse is cached per file revision by
  (path, size, mtime).
- `originrouter daemon` refuses to start a second instance beside a live one,
  instead of drifting to the next free port and rewriting the endpoint App
  pairing reads.
- `tests/acceptance.e2e.test.js` no longer asserts the pre-Stage-9.0 provider
  wire shape. `--type litellm` has been a CLI-input alias normalized to
  `type: "proxy"` + `engine: "litellm"` on write, so steps 4 and 4b had been
  failing since that rename — they only appeared to pass because the daemon
  failed to start first and the suite never reached them.

### Upgrade notes

- If you had set `claude.small` to a cheaper, faster model, the **Haiku family
  now uses your primary model**, which is more expensive. There is no automatic
  migration and the old value is dropped. Restore it explicitly with
  `originrouter route set claude --provider <name> --haiku <cheap-model>`. The
  CLI warns when it finds a leftover `claude.small` in `env print` and `doctor`,
  and the key is left on disk, inert, so a rollback stays possible.
- Your first run restarts the route-mode proxy once, because the slot set changed
  and therefore the route hash changed. This is expected and self-corrects.

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
