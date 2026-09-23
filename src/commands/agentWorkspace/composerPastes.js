export const LARGE_PASTE_CHAR_THRESHOLD = 1000;
export const PASTE_TOKEN_CODE_POINT_START = 0xF0000;

export function cleanInsertedText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f\r\n]/g, "");
}

export function normalizePastedText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function nextPasteLabel(pendingPastes, charCount) {
  const base = `[Pasted Content ${charCount} chars]`;
  const labels = new Set((pendingPastes || []).map((paste) => paste.label));
  if (!labels.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} #${suffix}`;
    if (!labels.has(candidate)) return candidate;
  }
}

export function insertComposerPaste({ buffer, cursor, pendingPastes, nextPasteId, pasted }) {
  const text = normalizePastedText(pasted);
  if (!text) return { buffer, cursor, pendingPastes, nextPasteId };
  const chars = [...buffer];
  const charCount = [...text].length;
  if (charCount <= LARGE_PASTE_CHAR_THRESHOLD) {
    const inserted = [...text];
    chars.splice(cursor, 0, ...inserted);
    return { buffer: chars.join(""), cursor: cursor + inserted.length, pendingPastes, nextPasteId };
  }
  let id = nextPasteId;
  let token;
  do {
    token = String.fromCodePoint(PASTE_TOKEN_CODE_POINT_START + id);
    id += 1;
  } while (chars.includes(token) || pendingPastes.some((paste) => paste.token === token));
  const paste = { token, label: nextPasteLabel(pendingPastes, charCount), text };
  chars.splice(cursor, 0, token);
  return {
    buffer: chars.join(""),
    cursor: cursor + 1,
    pendingPastes: [...pendingPastes, paste],
    nextPasteId: id,
  };
}

export function pruneComposerPastes(buffer, pendingPastes) {
  const tokens = new Set([...String(buffer || "")]);
  return (pendingPastes || []).filter((paste) => tokens.has(paste.token));
}

export function expandComposerPastes(buffer, pendingPastes) {
  const pastes = new Map((pendingPastes || []).map((paste) => [paste.token, paste.text]));
  return [...String(buffer || "")].map((char) => pastes.get(char) || char).join("");
}

export function pastedKeyText(text, key = {}) {
  if (typeof text === "string") return text;
  if (key.name === "enter" || key.name === "return") return "\n";
  if (key.name === "tab") return "\t";
  return "";
}
