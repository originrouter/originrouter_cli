// Stage 7.5: CLI tests for the `route` subcommand and the
// `provider use` double-write behavior.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeOAuthCredential } from "./support/oauthCredential.js";

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

const home = mkdtempSync(join(tmpdir(), "originrouter-cli-route-"));
const env = { ORIGINROUTER_HOME: home };

try {
  // ---- 1. seed two litellm providers + one anthropic-compatible (in the new shape) ----
  await runCli(["provider", "add", "deepseek",
    "--litellm-provider", "deepseek",
    "--api-key", "sk-ds", "--model", "deepseek-chat"], { env });
  await runCli(["provider", "add", "moonshot",
    "--litellm-provider", "moonshot",
    "--api-key", "sk-ms", "--model", "moonshot-v1-8k"], { env });
  await runCli(["provider", "add", "minimax",
    "--type", "litellm", "--litellm-provider", "anthropic",
    "--base-url", "https://api.minimax.example/v1",
    "--api-key", "sk-mm", "--model", "MiniMax-M3"], { env });

  // ---- 2. route list with no routes yet ----
  {
    const r = await runCli(["route", "list"], { env });
    assert.match(r.stdout, /no routes configured/);
  }

  // ---- 3. route set claude.main ----
  await runCli(["route", "set", "claude.main",
    "--provider", "deepseek", "--model", "deepseek-chat"], { env });
  {
    const cfg = readConfig(home);
    assert.equal(cfg.routes.claude.main.provider, "deepseek");
    assert.equal(cfg.routes.claude.main.model,    "deepseek-chat");
  }

  // ---- 4. route set claude.small ----
  await runCli(["route", "set", "claude.small",
    "--provider", "moonshot", "--model", "moonshot-v1-8k"], { env });
  {
    const cfg = readConfig(home);
    assert.equal(cfg.routes.claude.small.provider, "moonshot");
  }

  // ---- 5. route show claude ----
  {
    const r = await runCli(["route", "show", "claude"], { env });
    assert.match(r.stdout, /originrouter-claude/);
    assert.match(r.stdout, /deepseek-chat/);
    assert.match(r.stdout, /moonshot-v1-8k/);
  }

  // ---- 6. route set rejects unknown provider ----
  {
    const r = await runCli(["route", "set", "claude.main",
      "--provider", "ghost-provider"], { env, expectFail: true });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not a known provider/);
  }

  // ---- 7. route set rejects unknown agent ----
  {
    const r = await runCli(["route", "set", "ghost.main",
      "--provider", "deepseek"], { env, expectFail: true });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown route agent/);
  }

  // ---- 7b. route set rejects codex.small (Codex 8.0 has no small slot) ----
  {
    const r = await runCli(["route", "set", "codex.small",
      "--provider", "deepseek"], { env, expectFail: true });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown route slot 'small' for agent 'codex'/);
  }

  // ---- 8. route clear claude.small removes the slot but leaves main ----
  await runCli(["route", "clear", "claude.small"], { env });
  {
    const cfg = readConfig(home);
    assert.equal(cfg.routes.claude.main.provider, "deepseek");
    assert.equal(cfg.routes.claude.small, undefined);
  }

  // ---- 9. provider use <litellm> writes routes.claude.main (Stage 7.6) ----
  // No --force needed; --force is silently accepted for backward compat.
  await runCli(["provider", "use", "moonshot", "--agent", "claude"], { env });
  {
    const cfg = readConfig(home);
    // Stage 7.6: currentProvider is no longer written for claude.
    assert.equal(cfg.routes.claude.main.provider, "moonshot");
    assert.equal(cfg.routes.claude.main.model,    "moonshot-v1-8k");
  }

  // ---- 9b. Stage 7.8: provider use does NOT seed routes.claude.small ----
  {
    const cfg = readConfig(home);
    assert.equal(cfg.routes.claude.small, undefined,
      "smallFastModel on the provider no longer seeds routes.claude.small");
  }

  // ---- 9c. Stage 7.8: provider use prints the canonical fast-route hint ----
  {
    const r = await runCli(["provider", "use", "deepseek", "--agent", "claude"], { env });
    assert.match(r.stdout, /To set fast route: `originrouter route set claude\.small --provider deepseek`/);
    // fast row is only printed when small is set; here small is unset.
    assert.match(r.stdout, /fast  \(unset; the fast alias will fall back to main\)/);
  }

  // ---- 10. provider use on a litellm/anthropic provider — also writes routes ----
  await runCli(["provider", "use", "minimax", "--agent", "claude"], { env });
  {
    const cfg = readConfig(home);
    // Stage 7.6: provider use is a routes write regardless of type.
    assert.equal(cfg.routes.claude.main.provider, "minimax");
    assert.equal(cfg.routes.claude.main.model,    "MiniMax-M3");
  }

  // ---- 11. env print shows the unified error when proxy is not running ----
  {
    const r = await runCli(["env", "print", "--agent", "claude"], { env, expectFail: true });
    // No proxy in this test fixture → PROVIDER_UNSUPPORTED.
    assert.match(r.stdout, /Claude requires the local LiteLLM proxy/);
    assert.match(r.stdout, /originrouter-claude-model/);
  }

  // ---- 12. proxy start in routes mode (--port only, no --provider) ----
  //    NOTE: this would actually start LiteLLM. Skipped in unit tests; covered
  //    by acceptance.e2e.

  // ---- 13. proxy start --provider still works in legacy mode ----
  //    Skipped; covered by acceptance.

  // ---- 14. help text mentions routes ----
  {
    const r = await runCli(["--help"], { env });
    assert.match(r.stdout, /route list/);
    assert.match(r.stdout, /route set/);
    assert.match(r.stdout, /originrouter-claude-model/);
    assert.match(r.stdout, /originrouter-claude-fast-model/);
  }

  // ---- 15. Stage 7.8: provider remove clears routes that point at it ----
  // Seed both slots at the same provider, then remove it. Both slots
  // should be cleared and `routes` removed entirely.
  await runCli(["route", "set", "claude.main",  "--provider", "moonshot",  "--model", "moonshot-v1-8k"], { env });
  await runCli(["route", "set", "claude.small", "--provider", "moonshot",  "--model", "moonshot-mini"], { env });
  await runCli(["route", "set", "claude.main",  "--provider", "deepseek",  "--model", "deepseek-chat"], { env });
  {
    const cfg = readConfig(home);
    assert.equal(cfg.routes.claude.main.provider,  "deepseek");
    assert.equal(cfg.routes.claude.small.provider, "moonshot");
  }
  {
    // Remove the small target only.
    const r = await runCli(["provider", "remove", "moonshot"], { env });
    assert.match(r.stdout, /cleared routes\.claude\.small/);
    const cfg = readConfig(home);
    assert.equal(cfg.routes.claude.main.provider, "deepseek", "main untouched");
    assert.equal(cfg.routes.claude.small, undefined, "small cleared (was pointing at removed provider)");
    assert.equal(cfg.providers.moonshot, undefined);
  }
  {
    // Now remove the main target. routes object should be removed entirely.
    const r = await runCli(["provider", "remove", "deepseek"], { env });
    assert.match(r.stdout, /cleared routes\.claude\.main/);
    const cfg = readConfig(home);
    assert.equal(cfg.routes, undefined, "all route slots cleared → routes object removed");
    assert.equal(cfg.providers.deepseek, undefined);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

// ---------- Stage 8.0: codex routes ----------

{
  const home = mkdtempSync(join(tmpdir(), "originrouter-codex-routes-"));
  const env = { ...process.env, ORIGINROUTER_HOME: home };
  // Seed a single litellm provider usable for codex.
  await runCli([
    "provider", "add", "openai_codex",
    "--type", "litellm",
    "--litellm-provider", "openai",
    "--api-key", "sk-test",
    "--model", "gpt-5-codex",
  ], { env });

  // route set codex.main
  await runCli(["route", "set", "codex.main",
    "--provider", "openai_codex", "--model", "gpt-5-codex"], { env });
  {
    const cfg = readConfig(home);
    assert.equal(cfg.routes.codex.main.provider, "openai_codex");
    assert.equal(cfg.routes.codex.main.model,    "gpt-5-codex");
  }

  // route show codex
  {
    const r = await runCli(["route", "show", "codex"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Routes for codex:/);
    assert.match(r.stdout, /gpt-5.4/);
    assert.match(r.stdout, /openai_codex/);
    assert.match(r.stdout, /gpt-5-codex/);
  }

  // route list shows both Claude (none) and Codex groups.
  {
    const r = await runCli(["route", "list"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /claude:/);
    assert.match(r.stdout, /codex:/);
    assert.match(r.stdout, /gpt-5.4/);
  }

  // route set codex.small is a hard error.
  {
    const r = await runCli(["route", "set", "codex.small",
      "--provider", "openai_codex"], { env, expectFail: true });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown route slot 'small' for agent 'codex'/);
  }

  // provider use --agent codex writes the route (not currentProvider.codex).
  {
    const r = await runCli(["provider", "use", "openai_codex", "--agent", "codex"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Codex main route updated/);
    assert.match(r.stdout, /gpt-5.4/);
    const cfg = readConfig(home);
    assert.equal(cfg.routes.codex.main.provider, "openai_codex");
    // Stage 8.0: provider use --agent codex does NOT write currentProvider.codex.
    assert.equal(cfg.currentProvider?.codex, undefined);
  }

  // route clear codex.main removes it.
  {
    const r = await runCli(["route", "clear", "codex.main"], { env });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Cleared route codex\.main/);
    const cfg = readConfig(home);
    assert.equal(cfg.routes, undefined);
  }

  // provider remove cleans routes.codex.main if it pointed at the removed provider.
  await runCli(["route", "set", "codex.main",
    "--provider", "openai_codex", "--model", "gpt-5-codex"], { env });
  {
    const r = await runCli(["provider", "remove", "openai_codex"], { env });
    assert.match(r.stdout, /cleared routes\.codex\.main/);
    const cfg = readConfig(home);
    assert.equal(cfg.routes, undefined);
    assert.equal(cfg.providers.openai_codex, undefined);
  }

  rmSync(home, { recursive: true, force: true });
}

// ---------- Stage 9.1B: env print Source: originrouter-coding + Codex OPENAI_* + raw-key masking ----------

{
  const home = mkdtempSync(join(tmpdir(), "originrouter-env-print-91b-"));
  const env = { ORIGINROUTER_HOME: home };

  try {
    // OriginRouter Cloud providers are login-backed and cannot be added by
    // `provider add`; seed the derived route records directly for this env
    // rendering regression test.
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: {
        official: {
          name: "official",
          type: "originrouter",
          auth: { type: "oauth" },
          model: "claude-sonnet-4-6",
        },
        "official-codex": {
          name: "official-codex",
          type: "originrouter",
          auth: { type: "oauth" },
          model: "gpt-5-codex",
        },
      },
    }, null, 2));

    // Seed a valid OAuth credential so env resolution can select the Coding
    // audience token without contacting Surety.
    const { writeCodingAuth } = await import("../src/persistence/codingAuth.js");
    writeCodingAuth(home, makeOAuthCredential());

    // ---- claude env print: Source: originrouter-coding + masked key ----
    await runCli(["route", "set", "claude.main",
      "--provider", "official", "--model", "claude-sonnet-4-6"], { env });

    {
      const r = await runCli(["env", "print", "--agent", "claude"], { env });
      assert.match(r.stdout, /Source: originrouter-coding/);
      assert.match(r.stdout, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:<session-port>\/coding/);
      assert.match(r.stdout, /ANTHROPIC_MODEL=claude-sonnet-4-6/);
      assert.match(r.stdout, /ANTHROPIC_SMALL_FAST_MODEL=claude-sonnet-4-6/);
      // Raw-key leak check: the masked key form must be present (mask
      // format is `sk-o...ey`), and the raw key value must never appear
      // in stdout.
      assert.match(r.stdout, /ANTHROPIC_AUTH_TOKEN=or_l\.\.\.y>/);
      assert.ok(!r.stdout.includes("or_at_coding_test"),
        "raw Coding access token must never appear in env print output");
      // Agent-aware header
      assert.match(r.stdout, /Effective env \(what claude will see\):/);
    }

    // ---- codex env print: Source: originrouter-coding + OPENAI_* + masked key ----
    await runCli(["route", "set", "codex.main",
      "--provider", "official-codex", "--model", "gpt-5-codex"], { env });

    {
      const r = await runCli(["env", "print", "--agent", "codex"], { env });
      assert.match(r.stdout, /Source: originrouter-coding/);
      assert.match(r.stdout, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:<session-port>\/coding\/v1/);
      assert.match(r.stdout, /OPENAI_MODEL=gpt-5-codex/);
      assert.match(r.stdout, /OPENAI_API_KEY=or_l\.\.\.y>/);
      assert.ok(!r.stdout.includes("or_at_coding_test"),
        "raw Coding access token must never appear in env print output");
      // Agent-aware header — must NOT say "claude"
      assert.match(r.stdout, /Effective env \(what codex will see\):/);
      assert.ok(!/Effective env \(what claude will see\):/.test(r.stdout),
        "codex env print must not advertise the claude header");
      // System env block lists OPENAI_* keys (was previously Claude-only)
      assert.match(r.stdout, /OPENAI_BASE_URL/);
      assert.match(r.stdout, /OPENAI_API_KEY/);
      assert.match(r.stdout, /OPENAI_MODEL/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("cli route tests ok");
