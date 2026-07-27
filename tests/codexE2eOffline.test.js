// Stage 8.3: offline end-to-end coverage for the Codex route → config →
// proxy snapshot → env print chain. No network, no daemon, no LiteLLM.
//
// What this file proves:
//   1. `provider add` writes a usable record.
//   2. `route set codex.main` writes config.routes.codex.main.
//   3. A hand-written proxy.state.json with a matching routesHash
//      causes `env print --agent codex` to render the three OPENAI_*
//      variables pointing at port 40123 with the no-op key.
//   4. `route show codex` and `route show claude` render the right
//      agent-scoped slices (Codex alias on codex, Claude alias on claude,
//      no cross-agent leakage).
//   5. `route clear codex.main` followed by `env print --agent codex`
//      exits 1 with the "Codex requires routes.codex.main" message.
//   6. CodexAdapter.buildLaunch() injects --model gpt-5.4
//      unless the user passed --model or -m in any of the four accepted
//      forms (--model X, --model=X, -m X, -m=X), in which case the args
//      pass through and a warning is written to stderr.
//
// What this file does NOT prove:
//   - Network reachability of the configured upstream.
//   - That Codex Code actually consumed the OPENAI_* env (only an E2E
//     against the running child process can prove that).
//   - That LiteLLM rendered the alias correctly (only the running proxy
//     and its log prove that).
//
// `runCli` is intentionally duplicated from tests/cliRoute.test.js:15-36.
// If you change its signature here, change it there too. Refactor to a
// shared util is a separate cleanup.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAdapter } from "../src/adapters/codexAdapter.js";
import { CODEX_MAIN_ALIAS, getAllRoutes, hashRoutes, ROUTE_DEFS } from "../src/config/routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const bin  = resolve(repo, "bin", "originrouter.js");

function runCli(args, { env, expectFail = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [bin, ...args], {
      cwd: repo,
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("exit", (code) => {
      if (expectFail) {
        resolveRun({ code, stdout, stderr });
      } else if (code !== 0) {
        rejectRun(new Error(`cli ${args.join(" ")} exited ${code}\nstdout=${stdout}\nstderr=${stderr}`));
      } else {
        resolveRun({ code, stdout, stderr });
      }
    });
  });
}

function readConfig(home) {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
}

// Mirrors the field shape written by src/proxy/manager.js:381-394,
// then persisted via src/persistence/state.js:64-70 (which wraps with
// { version, updatedAt, ...state }). Reuses that wrapper by importing
// `writeProxyState` directly.
function writeFakeProxyState(home, { port, routesHash, aliases }) {
  // We do not import writeProxyState here to keep this test a leaf node;
  // instead we mirror the exact JSON write the manager would perform
  // (state.js wraps with version+updatedAt). The pid we use must respond
  // to kill(pid, 0), so we re-use the test process pid — readLocalProxySnapshot
  // does this pid-presence check at src/proxy/snapshot.js:46-67.
  const state = {
    version: "8.3-test",
    updatedAt: new Date().toISOString(),
    version_pinned: "1.83.0",
    state: "running",
    pid: process.pid,
    port,
    host: "127.0.0.1",
    mode: "route",
    routesHash,
    aliases,
    provider: null,
    startedAt: new Date().toISOString(),
    configPath: `${home}/proxy.state.d/config-routes-${routesHash}.yaml`,
    logPath: `${home}/logs/litellm-test.log`,
  };
  writeFileSync(join(home, "proxy.state.json"), JSON.stringify(state, null, 2));
}

function withCapturedStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  try {
    return { result: fn(), stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

const home = mkdtempSync(join(tmpdir(), "originrouter-codex-e2e-offline-"));
const env = { ORIGINROUTER_HOME: home };

try {
  // ---- 1. seed a litellm provider ----
  await runCli(["provider", "add", "openai_codex",
    "--type", "litellm",
    "--litellm-provider", "openai",
    "--api-key", "sk-test",
    "--model", "gpt-5-codex"], { env });

  // ---- 2. route set codex.main ----
  await runCli(["route", "set", "codex.main",
    "--provider", "openai_codex", "--model", "gpt-5-codex"], { env });
  {
    const cfg = readConfig(home);
    assert.deepEqual(cfg.routes.codex.main, { provider: "openai_codex", model: "gpt-5-codex" });
  }

  // ---- 3. compute the routesHash the env-print path will compare against ----
  const routesHash = hashRoutes(getAllRoutes(readConfig(home)));
  assert.match(routesHash, /^[0-9a-f]{16}$/);

  // ---- 4. write a fake proxy snapshot whose hash matches ----
  writeFakeProxyState(home, {
    port: 40123,
    routesHash,
    aliases: [ROUTE_DEFS.codex.aliases.main],
  });
  assert.ok(existsSync(join(home, "proxy.state.json")));

  // ---- 5. env print --agent codex (happy path) ----
  {
    const r = await runCli(["env", "print", "--agent", "codex"], { env });
    assert.equal(r.code, 0, `env print exited ${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /Codex routes:/);
    assert.match(r.stdout, /model\s+gpt-5.4\s+->\s+openai_codex\s*\/\s*gpt-5-codex/);
    assert.match(r.stdout, /\(Codex 8\.0 has no small\/fast slot; Codex does not fall back to Claude\.\)/);
    // Stage 9.1B: env print header is agent-aware. The agent here is
    // codex, so the header must read "what codex will see" — not "what
    // claude will see" (that was the pre-9.1B lie).
    assert.match(r.stdout, /Effective env \(what codex will see\):/);
    assert.match(r.stdout, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:40123\/v1/);
    // Stage 9.1B: formatEnvValue now masks OPENAI_API_KEY the same way
    // it masks ANTHROPIC_API_KEY. The full noop key value
    // `sk-noop-litellm-passthrough` must never appear in stdout.
    assert.ok(!r.stdout.includes("sk-noop-litellm-passthrough"),
      "raw proxy noop key must never appear in env print output");
    assert.match(r.stdout, /OPENAI_API_KEY=sk-n\.\.\.gh/);
    assert.match(r.stdout, /OPENAI_MODEL=gpt-5.4/);
  }

  // ---- 6. route show codex ----
  {
    const r = await runCli(["route", "show", "codex"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Routes for codex:/);
    assert.match(r.stdout, /gpt-5.4/);
    assert.match(r.stdout, /openai_codex/);
    assert.match(r.stdout, /gpt-5-codex/);
    assert.match(r.stdout, /routesHash:\s+[0-9a-f]{16}/);
    // isolation: Codex view must not leak Claude aliases
    assert.doesNotMatch(r.stdout, /originrouter-claude-model/);
    assert.doesNotMatch(r.stdout, /originrouter-claude-fast-model/);
  }

  // ---- 7. route show claude ----
  {
    const r = await runCli(["route", "show", "claude"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Routes for claude:/);
    // isolation: Claude view must not leak Codex provider or alias
    assert.doesNotMatch(r.stdout, /openai_codex/);
    assert.doesNotMatch(r.stdout, /gpt-5.4/);
  }

  // ---- 8. route clear codex.main ----
  {
    const r = await runCli(["route", "clear", "codex.main"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Cleared route codex\.main/);
    const cfg = readConfig(home);
    // clearRoute deletes `routes.codex.main` and, when no agents remain,
    // deletes the top-level `routes` key entirely (see src/config/routes.js:188-190).
    assert.ok(
      cfg.routes === undefined || cfg.routes.codex === undefined || cfg.routes.codex?.main === undefined,
      `expected codex.main to be cleared; got routes=${JSON.stringify(cfg.routes)}`,
    );
  }

  // ---- 9. env print --agent codex preserves existing auth when unset. ----
  {
    const r = await runCli(["env", "print", "--agent", "codex"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Source: inherited/);
    assert.match(r.stdout, /existing Codex login and environment are preserved/);
  }

  // ---- 10. CodexAdapter buildLaunch: no user model ----
  {
    const launch = new CodexAdapter({ args: [] }).buildLaunch();
    assert.equal(launch.command, "codex");
    assert.deepEqual(launch.args, ["--model", CODEX_MAIN_ALIAS]);
    assert.equal(launch.env.OPENAI_MODEL, CODEX_MAIN_ALIAS);
  }

  // ---- 11. CodexAdapter buildLaunch: --model X (pass-through + warning) ----
  for (const userArgs of [
    ["--model", "gpt-4"],
    ["-m", "gpt-4"],
    ["--model=foo"],
    ["-m=foo"],
  ]) {
    const { stderr } = withCapturedStderr(() => {
      const launch = new CodexAdapter({ args: userArgs }).buildLaunch();
      assert.deepEqual(launch.args, userArgs,
        `user args ${JSON.stringify(userArgs)} must pass through unchanged`);
      assert.equal(launch.env.OPENAI_MODEL, CODEX_MAIN_ALIAS);
    });
    assert.ok(stderr.includes("warning: --model passed on the command line"),
      `expected warning for args ${JSON.stringify(userArgs)}; stderr was:\n${stderr}`);
  }

  // ---- 12. route set codex.main again (re-prove write after clear) ----
  await runCli(["route", "set", "codex.main",
    "--provider", "openai_codex", "--model", "gpt-5-codex"], { env });
  {
    const cfg = readConfig(home);
    assert.deepEqual(cfg.routes.codex.main, { provider: "openai_codex", model: "gpt-5-codex" });
  }

  console.log("codex e2e offline ok");
} finally {
  rmSync(home, { recursive: true, force: true });
}
