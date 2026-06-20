import { TerminalAdapter } from "./terminalAdapter.js";
import { startClaudeHookServer } from "./claude/hookServer.js";
import { cleanupClaudeHookSettings, generateClaudeHookSettings } from "./claude/hookSettings.js";
import { ClaudeJsonlScanner, getClaudeProjectPath } from "./claude/jsonlScanner.js";

export class ClaudeAdapter extends TerminalAdapter {
  constructor({ args = [], cwd = process.cwd() }) {
    super({ command: "claude", args });
    this.kind = "claude";
    this.cwd = cwd;
    this.projectPath = getClaudeProjectPath(cwd);
    this.scanner = new ClaudeJsonlScanner({ transcriptPath: null, startedAt: Date.now() });
    this.hookServer = null;
    this.hookSettingsPath = null;
    this.pendingEvents = [];
  }

  describe() {
    return {
      ...super.describe(),
      adapter: this.kind,
      projectPath: this.projectPath,
      structuredSources: ["claude-jsonl", "claude-hook"],
    };
  }

  buildLaunch() {
    const args = [...this.args];
    if (this.hookSettingsPath) {
      args.push("--settings", this.hookSettingsPath);
    }
    return {
      command: "claude",
      args,
      env: {},
    };
  }

  // PermissionRequest only fires in Claude Code's interactive mode. Under
  // `claude -p` / `claude --print`, registering the hook adds no value
  // because Claude Code does not suspend on its decision. We detect both
  // flag forms so the generated settings.json stays honest about what is
  // actually wired.
  isNonInteractive(args) {
    return args.includes("-p") || args.includes("--print");
  }

  async beforeStart({ send }) {
    this.startedAt = Date.now();
    this.scanner = new ClaudeJsonlScanner({ transcriptPath: null, startedAt: this.startedAt });
    this.hookServer = await startClaudeHookServer({
      onSessionStart: (sessionId, payload) => {
        const transcriptPath = payload.transcript_path || null;
        if (transcriptPath) {
          this.scanner.setTranscriptPath(transcriptPath, this.startedAt);
        }
        this.pendingEvents.push({
          type: "agent.session.start",
          provider: "claude",
          sessionId,
          cwd: payload.cwd,
          transcriptPath,
          raw: payload,
        });
      },
      onPermissionRequest: (callId, event) => {
        this.pendingEvents.push(event);
      },
      onPermissionTimeout: (callId, event) => {
        // The hook server's 55s timer fired without a remote decision. Tell
        // the front end explicitly so it can show "Remote approval timed
        // out" rather than waiting for an agent.permission.resolved that
        // will never come.
        this.pendingEvents.push({
          type: "agent.permission.resolved",
          provider: "claude",
          callId,
          decision: "denied",
          reason: "timeout",
        });
      },
    });
    this.hookSettingsPath = generateClaudeHookSettings({
      port: this.hookServer.port,
      registerPermissionRequest: !this.isNonInteractive(this.args),
    });
  }

  scanStructuredEvents() {
    return [...this.pendingEvents.splice(0), ...this.scanner.scan()];
  }

  resolvePermission(payload) {
    if (!this.hookServer) return;
    const callId = payload.callId || payload.id;
    if (!callId) {
      this.pendingEvents.push({
        type: "agent.permission.resolve.error",
        provider: "claude",
        message: "No callId in /client/permission payload.",
      });
      return;
    }
    const decision = payload.decision || "denied";
    const ok = this.hookServer.resolvePermission({ callId, decision, reason: payload.reason });
    if (!ok) {
      this.pendingEvents.push({
        type: "agent.permission.resolve.error",
        provider: "claude",
        callId,
        message: "No pending Claude hook permission for this callId.",
      });
      return;
    }
    this.pendingEvents.push({
      type: "agent.permission.resolved",
      provider: "claude",
      callId,
      decision,
      // v1: the session rule has not actually been registered with
      // Claude Code. Mark it so the UI can grey the button.
      sessionRulePending: decision === "approved_for_session",
    });
  }

  cleanup() {
    this.hookServer?.stop();
    cleanupClaudeHookSettings(this.hookSettingsPath);
  }
}
