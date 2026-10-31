import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeTranscriptTitle } from "../src/agent/agentTitleSource.js";

test("Claude title polling reads a bounded tail and preserves small-file fallback", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "originrouter-title-window-"));
  const path = join(dir, "transcript.jsonl");
  const oldTitle = `${JSON.stringify({ type: "ai-title", aiTitle: "older title" })}\n`;
  const tailTitle = `\n${JSON.stringify({ type: "ai-title", aiTitle: "最新标题" })}\n`;
  const fd = fs.openSync(path, "w");
  const largeSize = 32 * 1024 * 1024;
  fs.ftruncateSync(fd, largeSize);
  fs.writeSync(fd, oldTitle, 0, "utf8");
  fs.writeSync(fd, tailTitle, largeSize - Buffer.byteLength(tailTitle), "utf8");
  fs.closeSync(fd);

  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  let bytesRequested = 0;
  let wholeFileReads = 0;
  fs.readSync = (...args) => {
    bytesRequested += args[3];
    return originalRead(...args);
  };
  fs.readFileSync = (...args) => {
    wholeFileReads += 1;
    return originalReadFile(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(readClaudeTranscriptTitle(path), "最新标题");
    assert.equal(wholeFileReads, 0);
    assert.equal(bytesRequested, 128 * 1024);

    // For files below the existing 4 MiB limit, an older title outside the
    // tail still remains available. The larger-file rule stays unchanged.
    fs.writeFileSync(path, `${oldTitle}${"x".repeat(256 * 1024)}\n`);
    assert.equal(readClaudeTranscriptTitle(path), "older title");
    fs.writeFileSync(path, `${oldTitle}${"x".repeat(5 * 1024 * 1024)}\n`);
    bytesRequested = 0;
    assert.equal(readClaudeTranscriptTitle(path), "");
    assert.equal(bytesRequested, 128 * 1024);
    assert.equal(wholeFileReads, 0);
  } finally {
    fs.readSync = originalRead;
    fs.readFileSync = originalReadFile;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
