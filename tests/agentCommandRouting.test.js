import assert from "node:assert/strict";

import { resolveAgentCommand } from "../src/index.js";
import { extractOriginRouterOptions } from "../src/local/localAgentSession.js";

assert.deepEqual(resolveAgentCommand("claude", ["--model", "x"]), {
  agent: "claude",
  runtime: "native-pty",
  args: ["--model", "x"],
});
assert.deepEqual(resolveAgentCommand("codex", []), {
  agent: "codex",
  runtime: "native-pty",
  args: [],
});
assert.deepEqual(resolveAgentCommand("claude", ["--terminal", "--resume"]), {
  agent: "claude",
  runtime: "native-pty",
  args: ["--resume"],
});
assert.equal(resolveAgentCommand("claude-terminal", []).runtime, "claude-sdk");
assert.equal(resolveAgentCommand("claude-sdk", []).runtime, "claude-sdk");
assert.equal(resolveAgentCommand("codex-terminal", []).runtime, "codex-app-server");
assert.equal(resolveAgentCommand("codex-app-server", []).runtime, "codex-app-server");
assert.equal(resolveAgentCommand("status", []), null);

assert.deepEqual(
  extractOriginRouterOptions([
    "--originrouter-native-config",
    "-r",
    "claude-session-id",
  ]),
  {
    options: { nativeConfig: true },
    passthrough: ["-r", "claude-session-id"],
  },
);
assert.deepEqual(
  extractOriginRouterOptions([
    "--originrouter-detail",
    "standard",
    "--originrouter-detail=detailed",
    "--resume",
    "claude-session-id",
  ]),
  {
    options: { detailProfile: "detailed" },
    passthrough: ["--resume", "claude-session-id"],
  },
);
assert.deepEqual(
  extractOriginRouterOptions([
    "--originrouter-native",
    "resume",
    "codex-session-id",
  ]),
  {
    options: { nativeConfig: true },
    passthrough: ["resume", "codex-session-id"],
  },
);
assert.deepEqual(
  extractOriginRouterOptions([
    "--originrouter-auto-allow",
    "workspace_edits,workspace_commands",
    "--originrouter-auto-allow=plan_continue",
    "--resume",
    "claude-session-id",
  ]),
  {
    options: {
      autonomyAllowedScopes: [
        "workspace_edits",
        "workspace_commands",
        "plan_continue",
      ],
    },
    passthrough: ["--resume", "claude-session-id"],
  },
);

console.log("agent command routing tests ok");
