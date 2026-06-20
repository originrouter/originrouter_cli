import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "originrouter-cli-provider-test-"));
const env = { ...process.env, ORIGINROUTER_HOME: home };
const bin = join(process.cwd(), "bin/originrouter.js");

function run(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [bin, ...args], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    }) };
  } catch (err) {
    return { code: err.status, stdout: err.stdout?.toString() || "", stderr: err.stderr?.toString() || "" };
  }
}

try {
  // Stage 7: add a litellm provider (deepseek via custom_openai).
  const addOutput = run([
    "provider",
    "add",
    "deepseek",
    "--type",
    "litellm",
    "--litellm-provider",
    "custom_openai",
    "--base-url",
    "https://api.deepseek.com/v1",
    "--api-key",
    "sk-test-deepseek",
    "--model",
    "deepseek-chat",
  ]);
  assert.equal(addOutput.code, 0, `add failed: ${addOutput.stderr}`);
  assert.match(addOutput.stdout, /Provider: deepseek/);
  assert.match(addOutput.stdout, /litellm/);

  const listOutput = run(["provider", "list"]);
  assert.match(listOutput.stdout, /deepseek/);
  assert.match(listOutput.stdout, /litellm/);
  assert.doesNotMatch(listOutput.stdout, /sk-test-deepseek/);

  // Stage 7: provider update — change a single field, preserve the rest.
  const updateOutput = run([
    "provider",
    "update",
    "deepseek",
    "--api-key",
    "sk-rotated-9999",
  ]);
  assert.equal(updateOutput.code, 0, `update failed: ${updateOutput.stderr}`);
  assert.match(updateOutput.stdout, /deepseek/);
  const showOutput = run(["provider", "show", "deepseek"]);
  assert.match(showOutput.stdout, /sk-rot\.\.\.9999/); // masked

  // Stage 7: add a vertex_ai provider to exercise the new flags.
  const addVertex = run([
    "provider",
    "add",
    "vertex",
    "--type",
    "litellm",
    "--litellm-provider",
    "vertex_ai",
    "--vertex-project",
    "my-proj",
    "--vertex-location",
    "us-central1",
    "--model",
    "gemini-1.5-pro",
  ]);
  assert.equal(addVertex.code, 0, `vertex add failed: ${addVertex.stderr}`);
  const showVertex = run(["provider", "show", "vertex"]);
  assert.match(showVertex.stdout, /my-proj/);
  assert.match(showVertex.stdout, /us-central1/);

  // Stage 7: provider add with type=openai-compatible exits non-zero.
  const legacyAdd = run([
    "provider",
    "add",
    "legacy-x",
    "--type",
    "openai-compatible",
    "--base-url",
    "https://x",
    "--api-key",
    "sk",
    "--model",
    "m",
  ]);
  assert.notEqual(legacyAdd.code, 0, "legacy add should fail");
  assert.match(legacyAdd.stderr, /openai-compatible.*no longer supported/);

  // Stage 7.8: --small-fast-model is [legacy]. Still accepted on add
  // (the field round-trips on disk) but the CLI prints a one-line note
  // pointing at the routes layer.
  const addWithFast = run([
    "provider", "add", "legacy-fast",
    "--litellm-provider", "deepseek",
    "--api-key", "sk-x",
    "--model", "deepseek-chat",
    "--small-fast-model", "deepseek-mini",
  ]);
  assert.equal(addWithFast.code, 0, `legacy flag should still be accepted: ${addWithFast.stderr}`);
  assert.match(addWithFast.stdout, /Note: --small-fast-model is \[legacy\]/);
  // The note should hint at the canonical command.
  assert.match(addWithFast.stdout, /originrouter route set claude\.small --provider <name>/);

  // provider show still displays the field with the legacy annotation.
  const showLegacy = run(["provider", "show", "legacy-fast"]);
  assert.equal(showLegacy.code, 0, `show failed: ${showLegacy.stderr}`);
  assert.match(showLegacy.stdout, /smallFastModel: deepseek-mini/);
  assert.match(showLegacy.stdout, /legacy; routes\.claude\.small is source of truth/);

  // And provider use on this legacy-flagged record does NOT seed small.
  const useLegacy = run(["provider", "use", "legacy-fast"]);
  assert.equal(useLegacy.code, 0, `use failed: ${useLegacy.stderr}`);
  assert.match(useLegacy.stdout, /To set fast route: `originrouter route set claude\.small --provider legacy-fast`/);
  // The small row should be "unset" (not seeded from smallFastModel).
  assert.match(useLegacy.stdout, /fast  \(unset; the fast alias will fall back to main\)/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("cli provider smoke ok");