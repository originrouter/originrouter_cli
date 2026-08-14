import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { ensureStateDir } from "../persistence/state.js";

const SCHEMA_VERSION = 1;
const MAX_DRAFTS = 20;

function draftPath(stateDir) {
  return join(stateDir, "collaboration-drafts.json");
}

function readDocument(stateDir) {
  const path = draftPath(stateDir);
  if (!existsSync(path)) return { schema_version: SCHEMA_VERSION, drafts: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      schema_version: SCHEMA_VERSION,
      drafts: Array.isArray(value?.drafts) ? value.drafts : [],
    };
  } catch {
    return { schema_version: SCHEMA_VERSION, drafts: [] };
  }
}

function writeDocument(stateDir, document) {
  const path = draftPath(stateDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizedDraft(input = {}, { touch = true } = {}) {
  const now = new Date().toISOString();
  return {
    draft_id: cleanText(input.draft_id, 96) || `draft-${randomUUID()}`,
    schema_version: SCHEMA_VERSION,
    wizard_sequence_version: Number(input.wizard_sequence_version) === 2 ? 2 : 1,
    step: Math.max(1, Math.min(7, Number(input.step) || 1)),
    objective: cleanText(input.objective, 16_000),
    style_id: cleanText(input.style_id, 64),
    participant_count: Math.max(0, Math.min(16, Number(input.participant_count) || 0)),
    participants: Array.isArray(input.participants)
      ? input.participants.slice(0, 16).map((item) => ({
          participant_id: cleanText(item?.participant_id, 32),
          display_name: cleanText(item?.display_name, 80),
          device_id: cleanText(item?.device_id, 191),
          runtime: cleanText(item?.runtime, 32),
          provider: cleanText(item?.provider, 191),
          model: cleanText(item?.model, 191),
          workspace_id: cleanText(item?.workspace_id, 191),
          permission_profile: cleanText(item?.permission_profile, 64),
          role_hint: cleanText(item?.role_hint, 2_000),
          planner: item?.planner === true,
        }))
      : [],
    concurrency: Math.max(0, Math.min(16, Number(input.concurrency) || 0)),
    token_limit: Number.isFinite(Number(input.token_limit)) && Number(input.token_limit) > 0
      ? Number(input.token_limit)
      : null,
    amount_limit_micros:
      Number.isFinite(Number(input.amount_limit_micros))
      && Number(input.amount_limit_micros) > 0
        ? Math.floor(Number(input.amount_limit_micros))
        : null,
    currency: /^[A-Z]{3}$/.test(String(input.currency || "").trim().toUpperCase())
      ? String(input.currency).trim().toUpperCase()
      : null,
    independent_review: input.independent_review == null
      ? null
      : input.independent_review === true,
    parallel_tasks: input.parallel_tasks == null
      ? null
      : input.parallel_tasks === true,
    analyze_before_retry: input.analyze_before_retry == null
      ? null
      : input.analyze_before_retry === true,
    preference: cleanText(input.preference, 4_000),
    created_at: cleanText(input.created_at, 64) || now,
    updated_at: touch ? now : (cleanText(input.updated_at, 64) || now),
  };
}

export function saveCollaborationDraft(input, {
  stateDir = ensureStateDir(),
} = {}) {
  const draft = normalizedDraft(input);
  const document = readDocument(stateDir);
  const drafts = document.drafts
    .filter((item) => item?.draft_id !== draft.draft_id)
    .concat(draft)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, MAX_DRAFTS);
  writeDocument(stateDir, { schema_version: SCHEMA_VERSION, drafts });
  return draft;
}

export function listCollaborationDrafts({
  stateDir = ensureStateDir(),
} = {}) {
  return readDocument(stateDir).drafts
    .map((item) => normalizedDraft(item, { touch: false }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getCollaborationDraft(draftId, options = {}) {
  const id = cleanText(draftId, 96);
  return listCollaborationDrafts(options).find((item) => item.draft_id === id) || null;
}

export function deleteCollaborationDraft(draftId, {
  stateDir = ensureStateDir(),
} = {}) {
  const id = cleanText(draftId, 96);
  const path = draftPath(stateDir);
  const document = readDocument(stateDir);
  const drafts = document.drafts.filter((item) => item?.draft_id !== id);
  if (drafts.length === document.drafts.length) return false;
  if (drafts.length === 0) {
    if (existsSync(path)) unlinkSync(path);
  } else {
    writeDocument(stateDir, { schema_version: SCHEMA_VERSION, drafts });
  }
  return true;
}
