# Codex End-to-End Verification

> **Stage 8.3.** This doc is the repeatable recipe for verifying the
> Codex chain end-to-end on a real machine. It follows Stages 8.0
> (routes backend), 8.1 (runtime robustness), and 8.2 (UI wiring).
> Run the A–G sections in order with a working LiteLLM provider.

## Three rules

Read these before starting. They are non-negotiable.

1. **Automated offline tests don't touch the network.** `npm test`
   includes `tests/codexE2eOffline.test.js`, which exercises the route
   → config → proxy snapshot → `env print` chain shape. It does not
   start a real Codex app-server and does not hit any upstream. If
   that suite is green, the local chain is intact. If you need proof
   the network path was actually exercised, you must read the
   LiteLLM log — see section F.

2. **`env print` proves env injection only.** It renders what
   `buildAgentProviderEnv("codex", config, ...)` would inject into the
   Codex child process's environment: `OPENAI_BASE_URL`,
   `OPENAI_API_KEY`, `OPENAI_MODEL`. It does **not** prove the
   `--model gpt-5.4` CLI argument is injected —
   that is `CodexAdapter.buildLaunch()`'s job, and it is locked by
   the CodexAdapter block of `tests/codexE2eOffline.test.js` and
   verified manually in section E.

3. **The LiteLLM log is the only source of truth.** The model name
   that Codex Code self-reports in its UI is **not** a verification
   source. It reflects what Codex Code reads from its own argv /
   state, not necessarily what OriginRouter wrote into the proxy
   YAML. Verification = log read, not log inference.

## Setup

```bash
export ORIGINROUTER_HOME="$(mktemp -d)"

# Codex CLI: ≥ 0.100 (uses the app-server protocol introduced there)
codex --version

# Daemon: only needed if you intend to spawn `originrouter codex`
# for section F. The route / proxy / env-print checks (A–E) work
# without a running daemon.
originrouter --help   # confirm commands exist; no specific version needed
```

Sections A–D and G do not require a running daemon or proxy. Sections
E and F do. Walk in order; if A–D pass, the local chain is wired
correctly and you can spend the time on F.

## A. Provider inventory

```bash
originrouter provider add openai_codex \
  --type litellm --litellm-provider openai \
  --api-key sk-test --model gpt-5-codex

originrouter provider list
```

**Expected:** one row named `openai_codex` whose `--litellm-provider`
is `openai` and whose model is `gpt-5-codex`. If `provider list`
shows nothing, the `add` failed — re-run with stderr captured.

## B. Route configured

```bash
originrouter route set codex.main \
  --provider openai_codex --model gpt-5-codex

originrouter route show codex
```

**Expected output** (exact literal):

```
Routes for codex:
  main (alias gpt-5.4):
    provider: openai_codex
    model:    gpt-5-codex
  routesHash: <16 hex chars>
```

If `routes.codex.main` shows `(unset; alias gpt-5.4
will not be emitted)`, the `route set` did not stick — check that
`openai_codex` exists in `provider list`.

## C. Proxy up (route mode)

```bash
originrouter proxy install
originrouter proxy start --port 40123
```

Use an explicit `--port 40123`. Do **not** rely on `proxy restart` —
its port-reuse logic can mask a stale routes-hash from a previous
run.

**Expected output:** a line like
`[proxy] started. port=40123 ... mode=route`.

**Verify the snapshot:**

```bash
cat $ORIGINROUTER_HOME/proxy.state.json | jq .
```

Expected fields:

- `state: "running"`
- `mode: "route"`
- `port: 40123`
- `host: "127.0.0.1"`
- `aliases` includes `"gpt-5.4"`
- `routesHash` matches the value printed by `route show codex` above

If `routesHash` does not match, the proxy was started before the
route was set — restart it (`proxy stop && proxy start --port 40123`).

## D. Env print

```bash
originrouter env print --agent codex
```

**Expected:** the `Effective env (what claude will see):` block
contains all three of:

```
OPENAI_BASE_URL=http://127.0.0.1:40123/v1
OPENAI_API_KEY=sk-noop-litellm-passthrough
OPENAI_MODEL=gpt-5.4
```

The `OPENAI_API_KEY` is intentionally a no-op bearer — the local
LiteLLM proxy accepts any value and forwards auth upstream.

**Caveat:** this proves env injection only. The `--model` CLI
argument to the Codex child process is not exercised by `env print`.

## E. `--model` argv injection (CodexAdapter)

CodexAdapter.buildLaunch() injects `--model gpt-5.4`
unless the user passed `--model` / `-m` in any of four accepted
forms. Verify all five behaviors:

```bash
# (1) no user model — adapter must inject
node -e '
  import("./src/adapters/codexAdapter.js").then(({ CodexAdapter }) => {
    const { args, env } = new CodexAdapter({ args: [] }).buildLaunch();
    console.log(JSON.stringify({ args, env }));
  });
'
# expected: {"args":["--model","gpt-5.4"],"env":{"OPENAI_MODEL":"gpt-5.4"}}
```

For the four pass-through cases, wrap `originrouter codex --help` in
a tiny argv-printing shim so you can confirm the args without
running the full Codex CLI:

```bash
cat > /tmp/codex-argv-shim.js <<'EOF'
#!/usr/bin/env node
console.log("argv:", JSON.stringify(process.argv.slice(2)));
EOF
chmod +x /tmp/codex-argv-shim.js
```

Then run:

```bash
node /tmp/codex-argv-shim.js --model gpt-4
# expected: argv: ["--model","gpt-4"]   (pass-through, no injection)

node /tmp/codex-argv-shim.js -m gpt-4
# expected: argv: ["-m","gpt-4"]        (pass-through)

node /tmp/codex-argv-shim.js --model=foo
# expected: argv: ["--model=foo"]       (pass-through)

node /tmp/codex-argv-shim.js -m=foo
# expected: argv: ["-m=foo"]            (pass-through)
```

When the user passes a model flag, `CodexAdapter` writes a stderr
warning. The offline test `tests/codexE2eOffline.test.js` asserts on
the warning text (`warning: --model passed on the command line`).
You do not need to re-verify this manually unless you are debugging
a regression in that suite.

## F. LiteLLM log truth (the only network-path proof)

This section exercises the actual code path: Codex app-server →
LiteLLM proxy → upstream. The log file path is in
`proxy.state.json.logPath` (default
`~/.originrouter/logs/litellm.log`):

```bash
LOG=$(jq -r .logPath $ORIGINROUTER_HOME/proxy.state.json)
tail -f "$LOG" &
TAIL_PID=$!
```

In another terminal, run a single round-trip:

```bash
echo "say hi in one short sentence" | originrouter codex
```

Wait for the prompt to finish, then check the log:

```bash
wait $TAIL_PID
grep -E "model|chat/completions|responses" "$LOG" | tail -20
```

**Expected:** an inbound HTTP request to the OpenAI-compatible
endpoint (`/v1/chat/completions` or `/v1/responses` depending on
the Codex wiring) with a JSON body containing
`"model": "gpt-5.4"` and a successful upstream
dispatch. The exact upstream model name depends on what
`openai_codex` is configured to point at; only the **alias**
`gpt-5.4` is required to appear in the request.

If the log shows a different model name (e.g. `gpt-4` or
`gpt-5-codex`), the proxy was started with stale state — see
"Known failure modes" below.

## G. Negative paths

(1) **Route unset, proxy running** — clear the route, keep the proxy
up:

```bash
originrouter route clear codex.main
originrouter env print --agent codex
echo "exit=$?"
```

**Expected:** non-zero exit; stdout contains
`Codex requires routes.codex.main`.

(2) **Route set, proxy stopped** — set the route back, stop the
proxy, env print:

```bash
originrouter route set codex.main --provider openai_codex --model gpt-5-codex
originrouter proxy stop
originrouter env print --agent codex
echo "exit=$?"
```

**Expected:** non-zero exit; stdout mentions "the local proxy is
not running" and points at `originrouter proxy start --port 40123`.

(3) **Both unset** — clear the route AND keep the proxy stopped,
then try to launch Codex:

```bash
originrouter route clear codex.main
echo "x" | originrouter codex
echo "exit=$?"
```

**Expected:** non-zero exit; stderr mentions either the missing
route or the stopped proxy, depending on which check fires first.

## Known failure modes

- **Log shows upstream model, not alias.** LiteLLM's default log
  level collapses the alias to the upstream model. Re-run with
  `--detailed-debug` (LiteLLM flag) or increase log verbosity. The
  alias must still appear in `route show codex` and `proxy.state.json`.

- **`originrouter codex` ignores `OPENAI_MODEL`.** Some Codex CLI
  versions read only the `--model` flag and ignore the env var.
  This is fine — `CodexAdapter.buildLaunch()` always injects
  `--model gpt-5.4` unless the user passed one.
  Verify with section E.

- **Permission card never resolves.** Codex app-server expects a
  response within 30s; if no decision arrives, the agent emits
  `agent.permission.resolved decision=denied reason=timeout`. This
  is Stage 8.1 behavior, not a regression.

- **Codex app-server exits mid-session** (Stage 8.4). The relay will
  receive one `agent.permission.resolved` per pending UI card
  (with `decision: "denied"`, `reason: "app_server_exit"`) and an
  `agent.adapter.status` with `state: "exited"` and the `code` /
  `signal` fields populated. Pending RPCs do not hang — they are
  rejected within the same tick. To confirm in a real session,
  find the codex app-server pid from `session.started.pid`'s child
  (`pgrep -P`), then `kill -TERM <pid>`. If the process ignores
  SIGTERM for >2s, the relay will receive a
  `state: "force_killed"` event after the SIGKILL fallback. Stage
  8.4 does **not** restart the app-server — the session ends. To
  resume work, start a new `originrouter codex` invocation.

## Cleanup

```bash
originrouter proxy stop
rm -rf "$ORIGINROUTER_HOME"
rm -f /tmp/codex-argv-shim.js
```

## What this doc does not cover

- Reconnect / resume across Codex CLI restarts (deferred to a later
  stage).
- Codex fast route (`codex.small`) — Codex 8.0 has no small slot;
  the backend rejects `routes.codex.small` with a 400.
- Real Codex CLI integration in `npm run acceptance` — the offline
  suite + this manual recipe is the Stage 8.3 verification contract.
  Future stages may add an in-flight Codex step to acceptance.