// While a remote action owns the keyboard, device replies still belong to
// the child terminal. Never mix blocked user keys into those replies.
export class TerminalResponseFilter {
  constructor() { this.pending = ''; }
  push(data) {
    this.pending = (this.pending + String(data)).slice(-8192);
    let out = '';
    while (this.pending) {
      const start = this.pending.indexOf('\x1b');
      if (start < 0) { this.pending = ''; break; }
      if (start) this.pending = this.pending.slice(start);
      if (this.pending.length < 2) break;
      if (this.pending[1] === '[') {
        let end = 2;
        while (end < this.pending.length && /[ -?]/.test(this.pending[end])) end++;
        if (end === this.pending.length) break;
        const sequence = this.pending.slice(0, end + 1);
        if (/^\x1b\[[?>=0-9;:]*[cR]$/.test(sequence) || /^\x1b\[[IO]$/.test(sequence)) out += sequence;
        this.pending = this.pending.slice(end + 1);
      } else if (this.pending[1] === ']') {
        const ending = /\x07|\x1b\\/.exec(this.pending);
        if (!ending) break;
        const end = ending.index + ending[0].length, sequence = this.pending.slice(0, end);
        if (/^\x1b\](?:10|11|12);/.test(sequence)) out += sequence;
        this.pending = this.pending.slice(end);
      } else this.pending = this.pending.slice(2);
    }
    return out;
  }
}
