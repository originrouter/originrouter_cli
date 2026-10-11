import { createHash } from "node:crypto";

// Identity for a Claude Code permission prompt.
//
// Claude Code 2.1.283 does NOT put a `tool_use_id` on `PermissionRequest`. The
// captured payload is:
//
//   { cwd, effort, hook_event_name, permission_mode, permission_suggestions,
//     prompt_id, session_id, tool_input, tool_name, transcript_path }
//
// `PostToolUse` and `PermissionDenied` carry `tool_use_id`, but `PermissionRequest`
// does not — so an adapter that keys permissions off `tool_use_id` alone has no
// identity at the moment the request is created. That is not a cosmetic gap:
// the interaction id is minted from it, and everything downstream (the
// adapter's pending map, the interaction registry, the card the App renders,
// the resolve path) is keyed by that id. Minting a fresh random one per
// arrival therefore turns N deliveries of one ask into N independent
// permissions — N cards, N expiries, N denials sent back to the terminal.
//
// `prompt_id` alone is not the answer either: it is scoped to the prompt, not
// the ask. Two Writes in one prompt share it. What is stable across the whole
// lifecycle of a single ask is the tuple below, and it is present on both the
// request and its outcome event:
//
//   PermissionRequest  prompt_id=b806cd4d… tool_name=Write tool_input={file_path…}
//   PostToolUse        prompt_id=b806cd4d… tool_name=Write tool_input={file_path…}
//
// so a decision taken in the terminal can find and close the mirrored App card.
//
// Every field is required. A payload missing any of them returns null, and the
// caller falls back to its old random-id behaviour: no identity means no
// dedupe, which is where we already were. Merging two asks that merely look
// alike would be far worse than showing two cards.

function text(value, maxLength = 4096) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Deterministic serialization. `tool_input` is a free-form object and two
// deliveries of the same ask need not arrive with their keys in the same
// order, so JSON.stringify on the raw value would make the identity unstable
// exactly when it matters.
function canonicalize(value, depth = 0) {
  if (depth > 8) return '"…"';
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, depth + 1)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`)
    .join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Stable identity for one permission ask, or null when the payload does not
 * carry enough to tell one ask from another.
 */
export function permissionRequestIdentity(payload) {
  const sessionId = text(payload?.session_id) || text(payload?.sessionId);
  const promptId = text(payload?.prompt_id) || text(payload?.promptId);
  const toolName = text(payload?.tool_name) || text(payload?.toolName);
  if (!sessionId || !promptId || !toolName) return null;
  const input = payload?.tool_input ?? payload?.toolInput ?? {};
  return `ask:${sessionId}:${promptId}:${toolName}:${digest(canonicalize(input))}`;
}

/**
 * The id a permission is filed under. Claude Code's own `tool_use_id` is
 * preferred when a version supplies it — it is the strongest identity there
 * is — and the payload-derived hash is the fallback that actually holds for
 * `PermissionRequest` on current versions.
 */
export function permissionCallId(payload) {
  const nativeToolUseId = text(payload?.tool_use_id, 191) || text(payload?.toolUseId, 191);
  if (nativeToolUseId) return nativeToolUseId;
  const identity = permissionRequestIdentity(payload);
  return identity
    ? `claude-perm-${digest(identity)}`
    : `claude-perm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}