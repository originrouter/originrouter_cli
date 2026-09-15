import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_INSTALLERS,
  installerEnvironment,
} from "../src/commands/setup.js";

test("Codex installers are forced to remain non-interactive", () => {
  assert.equal(
    AGENT_INSTALLERS.codex.darwin.env.CODEX_NON_INTERACTIVE,
    "1",
  );
  assert.equal(
    AGENT_INSTALLERS.codex.linux.env.CODEX_NON_INTERACTIVE,
    "1",
  );
  assert.equal(
    AGENT_INSTALLERS.codex.win32.env.CODEX_NON_INTERACTIVE,
    "1",
  );
});

test("installer-specific environment preserves the parent environment", () => {
  const environment = installerEnvironment(
    AGENT_INSTALLERS.codex.linux,
    { PATH: "/test/bin", CODEX_NON_INTERACTIVE: "false" },
  );

  assert.equal(environment.PATH, "/test/bin");
  assert.equal(environment.CODEX_NON_INTERACTIVE, "1");
});

test("Claude installer does not opt into Codex non-interactive mode", () => {
  assert.equal(AGENT_INSTALLERS.claude.linux.env, undefined);
  assert.equal(AGENT_INSTALLERS.claude.win32.env, undefined);
});
