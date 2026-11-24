// A terminal sends focus/device/cursor replies over the same stdin as keys.
// Parse them across chunks; their printable bytes are not a user's draft.
export class AgyNativeInput {
  constructor() { this.state = 'ground'; this.sequence = ''; this.paste = false; }
  push(data) {
    const result = { text: '', submitted: false, interrupted: false, edited: false };
    for (const c of String(data)) {
      if (c === '\x03') {
        result.interrupted = true; this.state = 'ground'; this.sequence = ''; this.paste = false;
        continue;
      }
      if (this.state === 'string') {
        if (c === '\x07' || c === '\x9c') this.state = 'ground';
        else if (c === '\x1b') this.state = 'stringEscape';
        continue;
      }
      if (this.state === 'stringEscape') { this.state = c === '\\' ? 'ground' : 'string'; continue; }
      if (this.state === 'escape') {
        if (c === '[') { this.state = 'csi'; this.sequence = ''; }
        else if (']P_^X'.includes(c)) this.state = 'string';
        else if (c === 'O') this.state = 'ss3';
        else { this.state = 'ground'; result.edited = true; }
        continue;
      }
      if (this.state === 'ss3') { this.state = 'ground'; if (/[ABCDHF]/.test(c)) result.edited = true; continue; }
      if (this.state === 'csi') {
        if (c >= '@' && c <= '~') {
          if (c === '~' && this.sequence === '200') this.paste = true;
          else if (c === '~' && this.sequence === '201') this.paste = false;
          else if (/^[ABCDHF]$/.test(c) || (c === '~' && /^(?:1|2|3|4|5|6|7|8)(?:;\d+)*$/.test(this.sequence))) result.edited = true;
          this.state = 'ground'; this.sequence = '';
        } else if (c === '\x1b') { this.state = 'escape'; this.sequence = ''; }
        else if (this.sequence.length < 128) this.sequence += c;
        continue;
      }
      if (c === '\x1b') this.state = 'escape';
      else if (c === '\x9b') { this.state = 'csi'; this.sequence = ''; }
      else if (c === '\r' || c === '\n') { if (this.paste) result.text += c; else result.submitted = true; }
      else if (/[\x08\x7f\x15\x17\x04]/.test(c)) result.edited = true;
      else if (c >= ' ' && !/[\x7f-\x9f]/.test(c)) result.text += c;
    }
    return result;
  }
}

// Only the editor immediately above the shortcut footer is authoritative.
// Return null for a screen where no verified editor can be read.
export function agyEditorDraft(screen) {
  const lines = String(screen).trimEnd().split('\n');
  const footer = lines.findLastIndex(line => line.includes('? for shortcuts'));
  if (footer < 0 || footer < lines.length - 4) return null;
  let bottom = footer - 1;
  while (bottom >= 0 && !lines[bottom].trim()) bottom--;
  if (bottom < 0 || !/^\s*[─━-]{3,}\s*$/.test(lines[bottom])) return null;
  let start = bottom - 1;
  while (start >= Math.max(0, bottom - 12) && !/^\s*>/.test(lines[start])) start--;
  if (start < 0 || !/^\s*>/.test(lines[start])) return null;
  const draft = [lines[start].replace(/^\s*>\s?/, ''), ...lines.slice(start + 1, bottom)].join('\n').trim();
  if ([
    'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    'Plan mode: research & plan only (shift+tab to cycle)',
    'Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
  ].includes(draft)) return '';
  return draft;
}

export function observeAgyLocalInput(adapter, data) {
  const input = (adapter.nativeInput ||= new AgyNativeInput()).push(data);
  if (input.interrupted) {
    adapter.userTyping = false; adapter.localTextAwaitingEcho = false; adapter.onInterrupt();
  } else if (input.submitted) {
    adapter.userTyping = false; adapter.localTextAwaitingEcho = false; adapter.ready = false;
  } else if (input.text && ['question', 'native_panel', 'needs_native_trust', 'needs_login'].includes(adapter.state)) {
    // Keystrokes in a native modal belong to that control, not the chat editor.
    adapter.localTextAwaitingEcho = false;
  } else if (input.text) {
    adapter.userTyping = true; adapter.localTextAwaitingEcho = true; adapter.ready = false;
  } else if (input.edited) {
    adapter.userTyping = true; adapter.localTextAwaitingEcho = false; adapter.ready = false;
  }
  return input;
}

export function reconcileAgyLocalDraft(adapter, screen) {
  if (adapter.state !== 'idle' || adapter.inputTransaction || adapter.reconfiguring || adapter.busy) return;
  const draft = agyEditorDraft(screen);
  if (draft == null) return;
  if (draft) { adapter.userTyping = true; adapter.localTextAwaitingEcho = false; }
  else if (!adapter.localTextAwaitingEcho) adapter.userTyping = false;
}
