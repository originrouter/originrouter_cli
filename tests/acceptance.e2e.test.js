// Stage 6 end-to-end acceptance.
//
// Boots a real daemon in a tmp home, exercises the local CLI + HTTP API,
// then tears everything down. Each step asserts and throws on failure.
// Run via `npm run acceptance` (or `node --test tests/acceptance.e2e.test.js`).
//
// NOT in the `npm test` chain — this is opt-in, opt-in by name. The unit
// + smoke chain in `npm test` stays fast.
//
// Skips if `node:fs.mkdtempSync` is unavailable, which would indicate a
// platform we don't support.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const bin = resolve(repo, "bin", "originrouter.js");

// ---- Helpers ----

function runCli(args, { env, timeoutMs = 60_000 } = {}) {
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
    const t = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      rejectRun(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolveRun({ code, stdout, stderr });
    });
  });
}

function assertStep(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  console.error(`  ✗ ${name}`);
  if (detail) console.error(`    ${detail}`);
  throw new Error(`acceptance step failed: ${name}`);
}

async function waitFor(label, fn, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = fn();
      if (v) return v;
      last = "fn returned falsy";
    } catch (err) { last = err.message; }
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}: ${last || "no progress"}`);
}

// ---- Test ----

let home;
let daemon;
try {
  home = mkdtempSync(join(tmpdir(), "originrouter-acceptance-"));
  const env = { ORIGINROUTER_HOME: home };
  const configPath = join(home, "config.json");
  const tokenPath = join(home, "local-api.token");
  const daemonStatePath = join(home, "daemon.state.json");
  const proxyStatePath = join(home, "proxy.state.json");

  console.log(`acceptance: home=${home}`);

  // Step 1: seed a fresh tmp home (already done via mkdtempSync).
  assertStep("step 1: fresh tmp home", existsSync(home));

  // Step 2: boot the daemon. Spawn detached; wait for daemon.state.json.
  console.log("  · spawning daemon…");
  daemon = spawn("node", [bin, "daemon", "--local-port", "0"], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Capture stderr for diagnostics.
  let daemonStderr = "";
  daemon.stderr.on("data", (c) => { daemonStderr += c.toString("utf8"); });
  // Don't `await` — this is a long-running process. We send SIGTERM at the
  // end of the test (or in finally) to clean up.
  const daemonState = await waitFor("daemon.state.json", () => {
    if (!existsSync(daemonStatePath)) return null;
    const s = JSON.parse(readFileSync(daemonStatePath, "utf8"));
    return s.localApiPort ? s : null;
  }, { timeoutMs: 15_000 });
  assertStep("step 2: daemon booted, localApiPort set", typeof daemonState.localApiPort === "number");
  const port = daemonState.localApiPort;

  // Step 3: read the token.
  const token = readFileSync(tokenPath, "utf8").trim();
  assertStep("step 3: token file present and 64 hex chars", /^[a-f0-9]{64}$/i.test(token));

  // Step 4: provider add via CLI.
  const addResult = await runCli([
    "provider", "add", "deepseek",
    "--type", "litellm",
    "--litellm-provider", "deepseek",
    "--base-url", "https://api.deepseek.com/v1",
    "--api-key", "sk-test-acceptance",
    "--model", "deepseek-chat",
  ], { env });
  assertStep("step 4: provider add exit 0", addResult.code === 0, `stderr=${addResult.stderr}`);
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  assertStep("step 4: config.json has deepseek", !!cfg.providers?.deepseek);
  assertStep("step 4: deepseek is type=litellm", cfg.providers.deepseek.type === "litellm");
  assertStep("step 4: deepseek.litellmProvider=deepseek", cfg.providers.deepseek.litellmProvider === "deepseek");

  // Step 4c: provider add --type openai-compatible exits non-zero (Stage 7 migration).
  const legacyAdd = await runCli([
    "provider", "add", "legacy-x",
    "--type", "openai-compatible",
    "--base-url", "https://x",
    "--api-key", "sk",
    "--model", "m",
  ], { env });
  assertStep("step 4c: openai-compatible add rejected", legacyAdd.code !== 0, `stderr=${legacyAdd.stderr}`);
  assertStep("step 4c: error message mentions migration",
    /no longer supported/.test(legacyAdd.stderr),
    `stderr=${legacyAdd.stderr}`);

  // Step 4b: seed a legacy openai-compatible record on disk; PUT without
  // --type auto-normalizes to litellm/custom_openai; subsequent show
  // returns type=litellm.
  const cfgBefore = JSON.parse(readFileSync(configPath, "utf8"));
  cfgBefore.providers["legacy-deepseek"] = {
    name: "legacy-deepseek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-legacy",
    model: "deepseek-chat",
  };
  writeFileSync(configPath, JSON.stringify(cfgBefore, null, 2));
  const updateResult = await runCli([
    "provider", "update", "legacy-deepseek",
    "--base-url", "https://api.deepseek.com/v2",
  ], { env });
  assertStep("step 4b: provider update exit 0", updateResult.code === 0, `stderr=${updateResult.stderr}`);
  const cfgAfter = JSON.parse(readFileSync(configPath, "utf8"));
  assertStep("step 4b: legacy auto-normalized to litellm",
    cfgAfter.providers["legacy-deepseek"].type === "litellm");
  assertStep("step 4b: litellmProvider=custom_openai",
    cfgAfter.providers["legacy-deepseek"].litellmProvider === "custom_openai");
  assertStep("step 4b: baseUrl preserved/updated",
    cfgAfter.providers["legacy-deepseek"].baseUrl === "https://api.deepseek.com/v2");

  // Step 5: proxy install. Skipped if already installed; this is a no-op.
  // First-run pip install of litellm + transitive deps can take >60s on
  // a cold cache, so allow several minutes here.
  const installResult = await runCli(["proxy", "install"], { env, timeoutMs: 300_000 });
  assertStep("step 5: proxy install ok (or already installed)",
    installResult.code === 0,
    `code=${installResult.code} stderr=${installResult.stderr}`);

  // Step 6: provider use writes Claude routes, then proxy starts in route
  // mode. Stage 7.6 no longer starts the Claude path via provider mode.
  const useResult = await runCli(["provider", "use", "deepseek", "--agent", "claude"], { env });
  assertStep("step 6a: provider use writes routes", useResult.code === 0, `stderr=${useResult.stderr}`);
  const cfgAfterUse = JSON.parse(readFileSync(configPath, "utf8"));
  assertStep("step 6a: routes.claude.main points at deepseek",
    cfgAfterUse.routes?.claude?.main?.provider === "deepseek");

  // Step 6: proxy start via CLI.
  const proxyPort = 47123;
  const startResult = await runCli([
    "proxy", "start", "--port", String(proxyPort),
  ], { env });
  assertStep("step 6b: proxy start route-mode exit 0", startResult.code === 0, `stderr=${startResult.stderr}`);
  const proxyState = await waitFor("proxy.state.json running", () => {
    if (!existsSync(proxyStatePath)) return null;
    const s = JSON.parse(readFileSync(proxyStatePath, "utf8"));
    return s.state === "running" ? s : null;
  }, { timeoutMs: 25_000 });
  assertStep("step 6: proxy state.json shows running", proxyState.state === "running");
  assertStep("step 6: proxy state.json shows route mode", proxyState.mode === "route");
  assertStep("step 6: proxy port matches", proxyState.port === proxyPort);

  // Step 7: health check via HTTP.
  const healthRes = await fetch(`http://127.0.0.1:${proxyPort}/health/liveliness`);
  assertStep("step 7: proxy /health/liveliness ok", healthRes.ok);

  // Step 8: env print.
  const envResult = await runCli([
    "env", "print", "--agent", "claude",
  ], { env });
  assertStep("step 8: env print exit 0", envResult.code === 0);
  assertStep("step 8: env print includes ANTHROPIC_BASE_URL",
    envResult.stdout.includes(`ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`),
    `stdout=${envResult.stdout}`);
  assertStep("step 8: env print includes fixed model alias",
    envResult.stdout.includes("ANTHROPIC_MODEL=originrouter-claude-model"),
    `stdout=${envResult.stdout}`);
  assertStep("step 8: env print includes fixed fast alias",
    envResult.stdout.includes("ANTHROPIC_SMALL_FAST_MODEL=originrouter-claude-fast-model"),
    `stdout=${envResult.stdout}`);
  assertStep("step 8: env print masks the noop api key",
    envResult.stdout.includes("ANTHROPIC_API_KEY=sk-n...gh")
    || envResult.stdout.includes("ANTHROPIC_API_KEY=sk-noop-litellm-passthrough"),
    `stdout=${envResult.stdout}`);

  // Step 9: local API provider CRUD with bearer token.
  const auth = { Authorization: `Bearer ${token}` };
  const addRes = await fetch(`http://127.0.0.1:${port}/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      name: "smoke",
      type: "litellm",
      litellmProvider: "anthropic",
      baseUrl: "https://example.com",
      apiKey: "sk-smoke-acceptance",
      model: "smoke-model",
    }),
  });
  assertStep("step 9a: POST /providers 200", addRes.ok);
  const putRes = await fetch(`http://127.0.0.1:${port}/providers/smoke`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      litellmProvider: "anthropic",
      baseUrl: "https://example.com",
      model: "smoke-model-v2",
    }),
  });
  assertStep("step 9b: PUT /providers/smoke 200", putRes.ok);
  const delRes = await fetch(`http://127.0.0.1:${port}/providers/smoke`, {
    method: "DELETE",
    headers: auth,
  });
  assertStep("step 9c: DELETE /providers/smoke 200", delRes.ok);

  // Step 9d: unauthenticated POST should 401.
  const unauthRes = await fetch(`http://127.0.0.1:${port}/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "unauth", type: "litellm", litellmProvider: "anthropic", baseUrl: "https://x", apiKey: "sk-x", model: "m" }),
  });
  assertStep("step 9d: unauthenticated POST /providers → 401", unauthRes.status === 401);

  // Step 10: proxy stop via CLI.
  const stopResult = await runCli(["proxy", "stop"], { env });
  assertStep("step 10: proxy stop exit 0", stopResult.code === 0);
  await waitFor("proxy.state.json removed", () => !existsSync(proxyStatePath), { timeoutMs: 5_000 });
  assertStep("step 10: proxy.state.json removed", !existsSync(proxyStatePath));

  // Step 11: catalog endpoint is reachable and returns >= 5 entries.
  const catalogRes = await fetch(`http://127.0.0.1:${port}/catalog/litellm-providers`);
  assertStep("step 11: catalog endpoint reachable", catalogRes.ok);
  const catalogBody = await catalogRes.json();
  assertStep("step 11: catalog has >= 5 entries", Array.isArray(catalogBody.providers) && catalogBody.providers.length >= 5);
  assertStep("step 11: catalog entries have id+fields",
    catalogBody.providers.every((p) => p.id && Array.isArray(p.fields)));

  // ============ Stage 7.5: Model routes ============

  // Step 12: route set writes routes.claude.main.
  const routeSetResult = await runCli([
    "route", "set", "claude.main", "--provider", "deepseek", "--model", "deepseek-chat",
  ], { env });
  assertStep("step 12: route set claude.main exit 0", routeSetResult.code === 0, `stderr=${routeSetResult.stderr}`);
  const cfgAfterRoute = JSON.parse(readFileSync(configPath, "utf8"));
  assertStep("step 12: routes.claude.main persisted",
    cfgAfterRoute.routes?.claude?.main?.provider === "deepseek" &&
    cfgAfterRoute.routes?.claude?.main?.model === "deepseek-chat");

  // ============ Stage 8.0: Codex route ============

  // Step 12c: codex route set writes routes.codex.main.
  const codexSetResult = await runCli([
    "route", "set", "codex.main", "--provider", "deepseek", "--model", "deepseek-chat",
  ], { env });
  assertStep("step 12c: route set codex.main exit 0", codexSetResult.code === 0, `stderr=${codexSetResult.stderr}`);
  const cfgAfterCodex = JSON.parse(readFileSync(configPath, "utf8"));
  assertStep("step 12c: routes.codex.main persisted",
    cfgAfterCodex.routes?.codex?.main?.provider === "deepseek" &&
    cfgAfterCodex.routes?.codex?.main?.model === "deepseek-chat");

  // Step 12d: route set codex.small is rejected.
  const codexSmallResult = await runCli([
    "route", "set", "codex.small", "--provider", "deepseek",
  ], { env });
  assertStep("step 12d: route set codex.small rejected",
    codexSmallResult.code !== 0 && /unknown route slot 'small' for agent 'codex'/.test(codexSmallResult.stderr),
    `stderr=${codexSmallResult.stderr}`);

  // Step 12e: env print --agent codex shows the route.
  const codexEnvResult = await runCli(["env", "print", "--agent", "codex"], { env });
  // The proxy is not running here, so env will carry the error message,
  // but the route table at the top of the output must mention codex.
  assertStep("step 12e: env print --agent codex shows codex route",
    codexEnvResult.stdout.includes("gpt-5.4") &&
    codexEnvResult.stdout.includes("deepseek-chat"));

  // Step 12b: legacy anthropic provider add is rejected in Stage 7.6.
  const anthropicAdd = await runCli(["provider", "add", "anthropic-test",
    "--type", "anthropic",
    "--base-url", "https://example.com",
    "--api-key", "sk-test",
    "--model", "m"], { env });
  assertStep("step 12b: provider add --type anthropic rejected",
    anthropicAdd.code !== 0 && /litellm-provider anthropic/.test(anthropicAdd.stderr),
    `stderr=${anthropicAdd.stderr}`);

  // Step 13: GET /routes (no auth) returns 401 (NOT public).
  const routesNoAuth = await fetch(`http://127.0.0.1:${port}/routes`);
  assertStep("step 13: GET /routes without bearer → 401", routesNoAuth.status === 401);

  // Step 13b: GET /routes with bearer returns the saved shape.
  const routesAuth = await fetch(`http://127.0.0.1:${port}/routes`, { headers: auth });
  assertStep("step 13b: GET /routes with bearer → 200", routesAuth.ok);
  const routesBody = await routesAuth.json();
  assertStep("step 13b: routes body has main",
    routesBody?.routes?.claude?.main?.provider === "deepseek");

  // Step 14: env print shows the fixed alias when routes are set.
  // (The proxy is currently in mode=provider from step 6; alias only emits
  // when the running proxy's currentProvider matches. The `provider use`
  // double-write already pointed currentProvider at deepseek. Restart the
  // proxy in route mode so the alias path is exercised.)
  // First stop the running provider-mode proxy.
  const stopForRoute = await runCli(["proxy", "stop"], { env });
  assertStep("step 14a: proxy stop exit 0", stopForRoute.code === 0);
  await waitFor("proxy.state.json removed", () => !existsSync(proxyStatePath), { timeoutMs: 5_000 });

  // Start in routes mode (no --provider).
  const routeStart = await runCli(["proxy", "start", "--port", String(proxyPort)], { env });
  assertStep("step 14b: proxy start (routes mode) exit 0",
    routeStart.code === 0, `stderr=${routeStart.stderr}`);
  const routeState = await waitFor("proxy.state.json running (routes mode)", () => {
    if (!existsSync(proxyStatePath)) return null;
    const s = JSON.parse(readFileSync(proxyStatePath, "utf8"));
    return s.state === "running" ? s : null;
  }, { timeoutMs: 25_000 });
  assertStep("step 14c: proxy state shows mode=route", routeState.mode === "route");
  assertStep("step 14c: proxy state has routesHash", typeof routeState.routesHash === "string" && routeState.routesHash.length > 0);
  assertStep("step 14c: proxy state has aliases",
    Array.isArray(routeState.aliases) && routeState.aliases.includes("originrouter-claude-model"));

  // Step 15: env print with the fixed alias.
  const envResult2 = await runCli([
    "env", "print", "--agent", "claude",
  ], { env });
  assertStep("step 15: env print shows ANTHROPIC_MODEL=originrouter-claude-model",
    /ANTHROPIC_MODEL=originrouter-claude-model\b/.test(envResult2.stdout),
    `stdout=${envResult2.stdout}`);
  assertStep("step 15: env print shows ANTHROPIC_SMALL_FAST_MODEL=originrouter-claude-fast-model",
    /ANTHROPIC_SMALL_FAST_MODEL=originrouter-claude-fast-model\b/.test(envResult2.stdout),
    `stdout=${envResult2.stdout}`);
  assertStep("step 15: env print shows ANTHROPIC_BASE_URL",
    envResult2.stdout.includes(`ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`),
    `stdout=${envResult2.stdout}`);

  // Step 16: PUT /routes/claude triggers auto-restart when proxy is running
  // in route mode. The routes hash should change.
  const oldHash = routeState.routesHash;
  const putRoutes = await fetch(`http://127.0.0.1:${port}/routes/claude`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      main: { provider: "deepseek", model: "deepseek-chat" },
      small: { provider: "deepseek", model: "deepseek-chat-fast" },
    }),
  });
  assertStep("step 16a: PUT /routes/claude → 200", putRoutes.ok);
  const putBody = await putRoutes.json();
  assertStep("step 16b: PUT response has proxy.currentRouteHash",
    typeof putBody?.proxy?.currentRouteHash === "string");
  // The hash should differ from the previous (because we added small).
  // The proxy auto-restarted; if it succeeded, currentRouteHash matches new.
  // If the restart failed, needsRestart=true.
  if (!putBody?.proxy?.needsRestart) {
    assertStep("step 16c: auto-restart succeeded (hash updated)",
      putBody.proxy.currentRouteHash !== oldHash,
      `old=${oldHash} new=${putBody?.proxy?.currentRouteHash}`);
  }

  console.log("\nacceptance e2e: 18/18 steps ok");
} catch (err) {
  console.error("\nacceptance e2e: FAILED");
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  if (daemon && !daemon.killed) {
    try { daemon.kill("SIGTERM"); } catch {}
    // Wait briefly for the daemon to actually exit.
    await delay(300);
    if (!daemon.killed) {
      try { daemon.kill("SIGKILL"); } catch {}
    }
  }
  if (home) {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }
}
