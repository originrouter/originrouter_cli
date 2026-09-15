import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_INSTALLERS,
  installerEnvironment,
  refreshAgentPath,
} from "../src/commands/setup.js";

test("Claude and Codex use npm installers on every supported platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.deepEqual(
      {
        kind: AGENT_INSTALLERS.claude[platform].kind,
        packageName: AGENT_INSTALLERS.claude[platform].packageName,
      },
      { kind: "npm", packageName: "@anthropic-ai/claude-code" },
    );
    assert.deepEqual(
      {
        kind: AGENT_INSTALLERS.codex[platform].kind,
        packageName: AGENT_INSTALLERS.codex[platform].packageName,
      },
      { kind: "npm", packageName: "@openai/codex" },
    );
  }
});

test("npm installer environment preserves the parent environment", () => {
  const environment = installerEnvironment(
    AGENT_INSTALLERS.codex.linux,
    { PATH: "/test/bin", NPM_CONFIG_YES: "false" },
  );

  assert.equal(environment.PATH, "/test/bin");
  assert.equal(environment.NPM_CONFIG_YES, "true");
  assert.equal(environment.NPM_CONFIG_UPDATE_NOTIFIER, "false");
});

test("npm installer commands are displayed accurately", () => {
  assert.equal(
    AGENT_INSTALLERS.claude.linux.display,
    "npm install --global @anthropic-ai/claude-code",
  );
  assert.equal(
    AGENT_INSTALLERS.codex.linux.display,
    "npm install --global @openai/codex",
  );
});

test("agent path refresh keeps the parent path and adds user-level bins", async () => {
  const environment = { HOME: "/tmp/originrouter-test-home", PATH: "/test/bin" };
  const refreshed = await refreshAgentPath({ env: environment, platformName: "linux" });

  assert.equal(refreshed.at(-1), "/test/bin");
  assert.equal(environment.PATH, refreshed.join(":"));
  assert.ok(refreshed.includes("/tmp/originrouter-test-home/.local/bin"));
  assert.ok(refreshed.includes("/tmp/originrouter-test-home/.npm-global/bin"));
});
