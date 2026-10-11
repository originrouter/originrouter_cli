#!/usr/bin/env node

// Claude Code hook forwarder for OriginRouter.
//
// Claude Code spawns this script for every registered hook event and reads
// the hook's decision from this process's stdout. We forward the original
// stdin JSON to OriginRouter's local hook server, which holds the request
// open until the remote client sends a decision.
// When the hook server finally responds, we copy its response body to our
// own stdout so Claude Code can read the structured hook return.
//
// Event dispatch is keyed off `hook_event_name` (legacy: `hookEventName`)
// in the JSON body:
//   SessionStart       -> POST /hook/session-start
//   PermissionRequest  -> POST /hook/permission-request
//   Other registered lifecycle hooks -> POST /hook/event
//
// Stage 8.5: the HTTP layer lives in claude-session-hook-forwarder-impl.cjs
// as the pure `postHookBody()` function. This wrapper is a thin CJS shell
// that reads stdin / argv and calls into the impl. The original
// "non-empty body that isn't 'ok'" stdout behavior is preserved.

const { postHookBody } = require("./claude-session-hook-forwarder-impl.cjs");

const port = Number(process.argv[2]);
if (!port) process.exit(1);

// Socket timeout for a held-open permission, in ms, written into the hook
// config by generateClaudeHookSettings. It arrives here rather than being
// read from config.json because this script is CommonJS on purpose — reading
// it from an ESM module would need require(esm), which only exists on Node
// >=22.12, while the package supports >=22. Passing it also guarantees the
// socket and the hook server agree: one value, computed once, written into the
// same file that spawns us.
//
// Absent (older hook config, or a hand-run of this script) leaves it
// undefined, and postHookBody falls back to its own default.
const permissionArg = Number(process.argv[3]);
const permissionRequestTimeoutMs = Number.isFinite(permissionArg) && permissionArg >= 0
  ? permissionArg
  : undefined;

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  body += chunk;
});

process.stdin.on("end", async () => {
  const result = await postHookBody(body, port, {
    logger: console.error,
    permissionRequestTimeoutMs,
  });
  // For PermissionRequest, the hook server's response body is the JSON
  // Claude Code expects. Write it to stdout verbatim. For SessionStart
  // the body is just "ok" and is irrelevant — drop it.
  if (result.responseBody && result.responseBody !== "ok") {
    process.stdout.write(result.responseBody);
  }
  process.exit(0);
});
