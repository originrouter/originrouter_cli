export class TerminalAdapter {
  constructor({ command, args = [] }) {
    this.kind = "terminal";
    this.command = command;
    this.args = args;
  }

  describe() {
    return {
      adapter: this.kind,
      command: this.command,
      args: this.args,
    };
  }

  buildLaunch() {
    return {
      command: this.command,
      args: this.args,
      env: {},
    };
  }

  handleOutput() {
    return [];
  }
}
