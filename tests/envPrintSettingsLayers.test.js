// `env print` has to describe what a Claude session will really see. Claude
// Code merges its own settings files above the subprocess environment, so a
// report built from process.env alone printed "(unset)" for the very keys a
// stale ~/.claude/settings.json was forcing — which is how the reported
// routing failure stayed invisible to the diagnostic meant to catch it.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "originrouter-envprint-test-"));
const home = join(root, "home");
const project = join(root, "project");
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(join(project, ".claude"), { recursive: true });

// The shape of the machine that prompted this: stale base URL, a bogus
// constant-cased model, both credential variables, the model-family defaults,
// plus an unrelated key that is none of our business.
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:5580",
    ANTHROPIC_AUTH_TOKEN: "sk-stale-secret",
    ANTHROPIC_API_KEY: "sk-stale-secret",
    ANTHROPIC_MODEL: "CLAUDE_HAIKU_4_5_20251001_V1_0",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "CLAUDE_HAIKU_4_5_20251001_V1_0",
    SOMETHING_UNRELATED: "not-our-business",
  },
  apiKeyHelper: "/usr/local/bin/get-key",
  theme: "auto",
}));
writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
  env: { ANTHROPIC_MODEL: "project-model" },
}));

// readClaudeForeignSettings resolves the user layer from homedir(), which reads
// HOME on POSIX. Set it before importing so os.homedir() picks it up.
const previousHome = process.env.HOME;
process.env.HOME = home;

const { claudeSettingsLayerReport } = await import("../src/index.js");

const routedResult = {
  source: "originrouter-coding",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:43210/coding",
    ANTHROPIC_AUTH_TOKEN: "or_local_token",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "claude-opus-5",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
    CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-opus-5",
  },
};

try {
  // ---------- a resolved route reports what it overrides ----------

  const report = claudeSettingsLayerReport("claude", routedResult, project).join("\n");

  // The user layer and the keys it sets are both named. Without this the report
  // claimed these keys were unset.
  assert.match(report, /~\/\.claude\/settings\.json/);
  assert.match(report, /ANTHROPIC_BASE_URL/);
  assert.match(report, /ANTHROPIC_MODEL/);
  assert.match(report, /ANTHROPIC_DEFAULT_HAIKU_MODEL/);
  assert.match(report, /overridden by OriginRouter at launch/);

  // apiKeyHelper is named: it injects a second credential of its own.
  assert.match(report, /apiKeyHelper/);

  // Credential values never appear — these files hold live keys.
  assert.equal(report.includes("sk-stale-secret"), false);

  // Keys outside the transport set are the user's business, not ours.
  assert.equal(report.includes("SOMETHING_UNRELATED"), false);
  assert.equal(report.includes("theme"), false);

  // The project layer is reported too, not just the user one.
  assert.match(report, /\.claude\/settings\.json\n\s+env: ANTHROPIC_MODEL/);

  // ---------- no route means nothing is overridden ----------

  // With no OriginRouter route the settings files are what actually decide, and
  // the report has to say that rather than claim an override that never happens.
  const inherited = claudeSettingsLayerReport("claude", { source: "inherited", env: {} }, project)
    .join("\n");
  assert.match(inherited, /in effect \(no OriginRouter route to override it\)/);
  assert.equal(inherited.includes("overridden by OriginRouter"), false);

  // ---------- scope ----------

  // Codex does not read Claude settings files.
  assert.deepEqual(claudeSettingsLayerReport("codex", routedResult, project), []);

  // A settings file that sets nothing we touch produces no section at all,
  // rather than a bare header.
  const quietHome = join(root, "quiet");
  mkdirSync(join(quietHome, ".claude"), { recursive: true });
  writeFileSync(join(quietHome, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  process.env.HOME = quietHome;
  const quietProject = join(root, "quiet-project");
  mkdirSync(quietProject, { recursive: true });
  assert.deepEqual(claudeSettingsLayerReport("claude", routedResult, quietProject), []);

  // A `model` field is a separate surface from ANTHROPIC_MODEL and is reported
  // so a reader knows it is there. Model names are not secrets.
  const modelHome = join(root, "modelhome");
  mkdirSync(join(modelHome, ".claude"), { recursive: true });
  writeFileSync(join(modelHome, ".claude", "settings.json"),
    JSON.stringify({ model: "claude-opus-5[1m]" }));
  process.env.HOME = modelHome;
  const modelReport = claudeSettingsLayerReport("claude", routedResult, quietProject).join("\n");
  assert.match(modelReport, /model: claude-opus-5\[1m\]/);

  // Malformed JSON is Claude Code's problem to report; this must not throw.
  const brokenHome = join(root, "broken");
  mkdirSync(join(brokenHome, ".claude"), { recursive: true });
  writeFileSync(join(brokenHome, ".claude", "settings.json"), "{ not valid json");
  process.env.HOME = brokenHome;
  assert.deepEqual(claudeSettingsLayerReport("claude", routedResult, quietProject), []);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("env print settings layer tests passed");
