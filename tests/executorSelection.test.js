import assert from "node:assert/strict";
import test from "node:test";

import { createExecutor, normalizeExecutor } from "../src/executors/createExecutor.js";
import { PtyExecutor } from "../src/executors/ptyExecutor.js";
import { PipeExecutor } from "../src/executors/pipeExecutor.js";
import { TmuxExecutor } from "../src/executors/tmuxExecutor.js";
import { extractOriginRouterOptions } from "../src/local/localAgentSession.js";

test("normalizeExecutor falls back to pty for unknown / missing kinds", () => {
  assert.equal(normalizeExecutor(), "pty");
  assert.equal(normalizeExecutor(undefined), "pty");
  assert.equal(normalizeExecutor(null), "pty");
  assert.equal(normalizeExecutor("magic"), "pty");
  assert.equal(normalizeExecutor(42), "pty");
});

test("normalizeExecutor passes through the known kinds", () => {
  assert.equal(normalizeExecutor("pty"), "pty");
  assert.equal(normalizeExecutor("pipe"), "pipe");
  assert.equal(normalizeExecutor("tmux"), "tmux");
});

test("createExecutor returns the matching executor class", () => {
  assert.ok(createExecutor("pty") instanceof PtyExecutor);
  assert.ok(createExecutor("pipe") instanceof PipeExecutor);
  assert.ok(createExecutor("tmux") instanceof TmuxExecutor);
  // Unknown kinds must not silently become a different executor semantics.
  assert.ok(createExecutor("nonsense") instanceof PtyExecutor, "defaults to pty");
});

test("extractOriginRouterOptions parses --originrouter-executor into options.executor", () => {
  const { options, passthrough } = extractOriginRouterOptions([
    "--originrouter-executor",
    "pipe",
    "--flag-for-agent",
  ]);
  assert.equal(options.executor, "pipe");
  assert.deepEqual(passthrough, ["--flag-for-agent"]);
});
