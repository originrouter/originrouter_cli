import xterm from '@xterm/headless';

// A real terminal buffer, rather than a concatenation of obsolete redraws.
export class AgyNativeScreen {
  constructor(onChange, cols = 100, rows = 30) {
    this.terminal = new xterm.Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
    this.revision = 0;
    this.onChange = onChange;
  }
  write(data) {
    this.flush = new Promise(resolve => this.terminal.write(data, () => { this.revision++; this.onChange?.(this.text()); resolve(); }));
  }
  text() {
    const b = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) || '').join('\n');
  }
  resize(cols, rows) { if (cols > 0 && rows > 0) this.terminal.resize(cols, rows); }
  dispose() { this.terminal.dispose(); }
}

export function agyScreenState(text) {
  const footer = text.trimEnd().split('\n').slice(-8).join('\n');
  const editor = /^\s*>[^\n]*\n[─━-]{3,}/m.test(footer);
  if (editor && /\? for shortcuts/.test(footer) && !/esc to cancel|esc to interrupt/i.test(footer)) return 'idle';
  if (/Select login method:|You are currently not signed in|Sign in to Antigravity/.test(text)
      && !/\? for shortcuts|Auto mode:/.test(text)) return 'needs_login';
  if (/^\s*Do you trust the contents of this project\?\s*$/m.test(text)) return 'needs_native_trust';
  if (/Question \d+\/\d+:/.test(text)) return 'question';
  if (/^\s*(?:Allow access to this file\?|Allow .*\?|Switch Model|Set Effort|Settings|Select.*mode)\s*$/m.test(text)) return 'native_panel';
  return 'unknown';
}
