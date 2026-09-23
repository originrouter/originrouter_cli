import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanInsertedText,
  expandComposerPastes,
  insertComposerPaste,
  normalizePastedText,
  pruneComposerPastes,
} from "../src/commands/agentWorkspace/composerPastes.js";

test("composer paste helpers sanitize inserted text and preserve tokens", () => {
  assert.equal(cleanInsertedText("a\n\0b"), "ab");
  assert.equal(normalizePastedText("a\r\nb\x1b[31m"), "a\nb");
  const inserted = insertComposerPaste({
    buffer: "x",
    cursor: 1,
    pendingPastes: [],
    nextPasteId: 0,
    pasted: "large text",
  });
  assert.equal(inserted.buffer, "xlarge text");
  assert.equal(expandComposerPastes(inserted.buffer, inserted.pendingPastes), "xlarge text");
  assert.deepEqual(pruneComposerPastes(inserted.buffer, inserted.pendingPastes), []);
});
