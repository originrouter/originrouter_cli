import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deleteCollaborationDraft,
  getCollaborationDraft,
  listCollaborationDrafts,
  saveCollaborationDraft,
} from "../src/collaboration/collaborationDraftStore.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-drafts-"));
const saved = saveCollaborationDraft({
  step: 4,
  objective: "Finish the release workflow",
  style_id: "implement_review",
  participant_count: 2,
  participants: [{
    participant_id: "planner",
    display_name: "Coordinator",
    device_id: "device-local",
    runtime: "codex",
    workspace_id: "/workspace",
    permission_profile: "guarded",
    planner: true,
  }],
}, { stateDir });

assert.match(saved.draft_id, /^draft-/);
assert.equal(getCollaborationDraft(saved.draft_id, { stateDir })?.objective, "Finish the release workflow");
assert.equal(listCollaborationDrafts({ stateDir }).length, 1);
assert.equal(statSync(join(stateDir, "collaboration-drafts.json")).mode & 0o777, 0o600);

const updated = saveCollaborationDraft({
  ...saved,
  step: 7,
  concurrency: 2,
}, { stateDir });
assert.equal(updated.draft_id, saved.draft_id);
assert.equal(listCollaborationDrafts({ stateDir }).length, 1);
assert.equal(getCollaborationDraft(saved.draft_id, { stateDir })?.step, 7);

assert.equal(deleteCollaborationDraft(saved.draft_id, { stateDir }), true);
assert.equal(deleteCollaborationDraft(saved.draft_id, { stateDir }), false);
assert.equal(listCollaborationDrafts({ stateDir }).length, 0);

console.log("collaboration draft store tests passed");
