import { TerminalAdapter } from "./terminalAdapter.js";
import {
  CLAUDE_INTERACTION_DECISION_TIMEOUT_MS,
  startClaudeHookServer,
} from "./claude/hookServer.js";
import { cleanupClaudeHookSettings, generateClaudeHookSettings } from "./claude/hookSettings.js";
import { ClaudeJsonlScanner, getClaudeProjectPath } from "./claude/jsonlScanner.js";
import {
  buildInteractionRequest,
  INTERACTION_KINDS,
  permissionEventToInteraction,
  INTERACTION_SOURCES,
} from "../runtime/agentInteractionContract.js";
import { readClaudeConversationHistory } from "../runtime/claudeConversationHistory.js";

const CLAUDE_NATIVE_MODES = Object.freeze([
  { id: "default", label: "Default" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "dontAsk", label: "Don't ask" },
  { id: "bypassPermissions", label: "Bypass permissions" },
]);

// Claude Code exposes --permission-mode only at process start. Interactive
// sessions can still cycle the modes through Shift+Tab. OriginRouter drives
// that native control one step at a time and requires a Hook ACK before it
// sends another key, so a UI/version mismatch cannot turn into blind input.
const CLAUDE_REMOTE_MODE_IDS = new Set([
  "default",
  "acceptEdits",
  "plan",
  "auto",
]);
const CLAUDE_SHIFT_TAB = "\x1b[Z";
const DEFAULT_MODE_CHANGE_TIMEOUT_MS = 3_000;
const DEFAULT_MODE_CHANGE_MAX_STEPS = 8;
const DEFAULT_MODE_OUTPUT_SETTLE_MS = 160;
const claudeInteractionExpiresAt = () =>
  Math.ceil((Date.now() + CLAUDE_INTERACTION_DECISION_TIMEOUT_MS) / 1000);

function normalizeClaudeMode(value) {
  const mode = safeText(value, 32);
  if (mode === "manual") return "default";
  return CLAUDE_NATIVE_MODES.some((item) => item.id === mode) ? mode : "";
}

function initialPermissionMode(args) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value === "--permission-mode" && index + 1 < args.length) {
      return normalizeClaudeMode(args[index + 1]);
    }
    if (value.startsWith("--permission-mode=")) {
      return normalizeClaudeMode(value.slice("--permission-mode=".length));
    }
    if (value === "--dangerously-skip-permissions") {
      return "bypassPermissions";
    }
  }
  return "default";
}

function cleanTerminalText(value) {
  return String(value || "")
    .replace(/\x1b\][^\u0007]*(?:\u0007|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .toLowerCase();
}

function modeFromTerminalText(value) {
  const text = cleanTerminalText(value);
  const candidates = [
    ["plan", /plan.{0,24}mod.{0,12}on.{0,40}shift.{0,12}tab/gis],
    ["auto", /auto.{0,24}mod.{0,12}on.{0,40}shift.{0,12}tab/gis],
    ["acceptEdits", /accept.{0,30}ed.{0,8}on.{0,40}shift.{0,12}tab/gis],
  ];
  let observed = "";
  let observedAt = -1;
  for (const [mode, pattern] of candidates) {
    for (const match of text.matchAll(pattern)) {
      if ((match.index ?? -1) > observedAt) {
        observed = mode;
        observedAt = match.index ?? -1;
      }
    }
  }
  return observed;
}

function safeText(value, maxLength = 512) {
  return String(value || "").slice(0, maxLength);
}

function schemaContainsSecret(value) {
  if (!value || typeof value !== "object") return false;
  if (value.writeOnly === true || value.format === "password") return true;
  return Object.values(value).some(schemaContainsSecret);
}

export function mapClaudeHookEvent(payload = {}) {
  const eventName = safeText(payload.hook_event_name || payload.hookEventName, 64);
  if (!eventName) return null;
  if (eventName === "Stop") {
    return {
      type: "agent.task.complete",
      provider: "claude",
      status: "complete",
      reason: safeText(payload.reason, 512),
    };
  }
  if (eventName === "StopFailure") {
    return {
      type: "agent.task.aborted",
      provider: "claude",
      status: "error",
      reason: safeText(payload.error || payload.reason, 4096),
    };
  }
  if (eventName === "UserPromptSubmit") {
    return {
      type: "agent.task.started",
      provider: "claude",
      id: safeText(payload.prompt_id || payload.uuid || payload.session_id, 128),
    };
  }
  const activity = ({
    SessionEnd: "session_end",
    SubagentStart: "subagent_started",
    SubagentStop: "subagent_stopped",
    PreCompact: "context_compacting",
    PostCompact: "context_compacted",
    Notification: "notification",
    TeammateIdle: "teammate_idle",
    TaskCreated: "background_task_created",
    TaskCompleted: "background_task_completed",
    ConfigChange: "config_changed",
    WorktreeCreate: "worktree_created",
    WorktreeRemove: "worktree_removed",
    InstructionsLoaded: "instructions_loaded",
    CwdChanged: "cwd_changed",
    FileChanged: "file_changed",
    MessageDisplay: "message_displayed",
    PermissionDenied: "permission_denied",
    Setup: "setup",
    UserPromptExpansion: "user_prompt_expanded",
    ElicitationResult: "elicitation_completed",
  })[eventName];
  if (!activity) return null;
  const summary = ({
    SessionEnd: "Claude session is ending",
    SubagentStart: "Claude started a subagent",
    SubagentStop: "Claude subagent stopped",
    PreCompact: "Claude is compacting context",
    PostCompact: "Claude compacted the conversation context",
    Notification: safeText(payload.message || payload.text, 512) || "Claude notification",
    TeammateIdle: "Claude teammate is idle",
    TaskCreated: "Claude background task created",
    TaskCompleted: "Claude background task completed",
    ConfigChange: "Claude configuration changed",
    WorktreeCreate: "Claude created a worktree",
    WorktreeRemove: "Claude removed a worktree",
    InstructionsLoaded: "Claude loaded instructions",
    CwdChanged: "Claude working directory changed",
    FileChanged: "Claude observed a file change",
    MessageDisplay: safeText(payload.message || payload.text, 512) || "Claude displayed a message",
    PermissionDenied: "Claude denied a permission request",
    Setup: "Claude session setup updated",
    UserPromptExpansion: "Claude expanded a user prompt",
    ElicitationResult: `Claude MCP input ${safeText(payload.action, 32) || "completed"}`,
  })[eventName];
  return {
    type: "agent.activity",
    provider: "claude",
    activity,
    summary,
    detail: safeText(payload.error || payload.reason, 4096),
    metadata: {
      hook_event: eventName,
      source: safeText(payload.source, 64),
      notification_type: safeText(payload.notification_type, 64),
      task_id: safeText(payload.task_id, 128),
      task_subject: safeText(payload.task_subject || payload.subject, 512),
      agent_id: safeText(payload.agent_id, 128),
      agent_type: safeText(payload.agent_type, 128),
      file_path: safeText(payload.file_path, 1024),
      cwd: safeText(payload.cwd, 1024),
      worktree_path: safeText(payload.worktree_path, 1024),
      permission_mode: safeText(payload.permission_mode, 32),
      elicitation_id: safeText(payload.elicitation_id, 128),
      mcp_server_name: safeText(payload.mcp_server_name, 128),
      action: safeText(payload.action, 32),
    },
  };
}

export class ClaudeAdapter extends TerminalAdapter {
  constructor({
    args = [],
    cwd = process.cwd(),
    hookServerFactory,
    modeChangeTimeoutMs = DEFAULT_MODE_CHANGE_TIMEOUT_MS,
    modeChangeMaxSteps = DEFAULT_MODE_CHANGE_MAX_STEPS,
    modeOutputSettleMs = DEFAULT_MODE_OUTPUT_SETTLE_MS,
  } = {}) {
    super({ command: "claude", args });
    this.kind = "claude";
    this.cwd = cwd;
    this.projectPath = getClaudeProjectPath(cwd);
    this.scanner = new ClaudeJsonlScanner({ transcriptPath: null, startedAt: Date.now() });
    // Stage 8.9: optional hookServerFactory for tests. Default is the
    // production startClaudeHookServer. Tests pass a fake to avoid
    // spinning a real HTTP listener.
    this.hookServerFactory = hookServerFactory || startClaudeHookServer;
    this.hookServer = null;
    this.hookSettingsPath = null;
    this.pendingEvents = [];
    // Captured at beforeStart() from the session context. The hook
    // server and event mapper never see sessionId; we enrich here.
    this.sessionId = null;
    this.pendingInteractionInputs = new Map();
    this.currentMode = initialPermissionMode(args);
    this.modeControl = this.isNonInteractive(args) ? "unsupported" : "supported";
    this.modeChangeTimeoutMs = Math.max(10, Number(modeChangeTimeoutMs) || DEFAULT_MODE_CHANGE_TIMEOUT_MS);
    this.modeChangeMaxSteps = Math.max(1, Number(modeChangeMaxSteps) || DEFAULT_MODE_CHANGE_MAX_STEPS);
    this.modeOutputSettleMs = Math.max(10, Number(modeOutputSettleMs) || DEFAULT_MODE_OUTPUT_SETTLE_MS);
    this.modeChangeWaiter = null;
    this.modeOutputBuffer = "";
    this.modeOutputTimer = null;
    this.taskActive = false;
    this.sessionReady = false;
  }

  availableModes() {
    const modes = CLAUDE_NATIVE_MODES.filter((item) =>
      CLAUDE_REMOTE_MODE_IDS.has(item.id),
    );
    if (
      this.args.includes("--allow-dangerously-skip-permissions") ||
      this.args.includes("--dangerously-skip-permissions") ||
      this.currentMode === "bypassPermissions"
    ) {
      modes.push(
        CLAUDE_NATIVE_MODES.find((item) => item.id === "bypassPermissions"),
      );
    }
    return modes.filter(Boolean);
  }

  modeStatusEvent({ accepted, reason, requestId } = {}) {
    return {
      type: "agent.mode.status",
      provider: "claude",
      runtime: "claude-pty",
      mode: this.currentMode,
      modeControl: this.modeControl,
      availableModes: this.availableModes(),
      ...(accepted == null ? {} : { accepted: Boolean(accepted) }),
      ...(reason ? { reason: safeText(reason, 128) } : {}),
      ...(requestId ? { requestId: safeText(requestId, 96) } : {}),
    };
  }

  observeMode(value) {
    const mode = normalizeClaudeMode(value);
    if (!mode) return false;
    const changed = mode !== this.currentMode;
    this.currentMode = mode;
    if (changed) this.pendingEvents.push(this.modeStatusEvent());
    const waiter = this.modeChangeWaiter;
    if (waiter && mode !== waiter.previousMode) {
      if (this.modeOutputTimer) clearTimeout(this.modeOutputTimer);
      this.modeOutputTimer = null;
      clearTimeout(waiter.timer);
      this.modeChangeWaiter = null;
      waiter.resolve(mode);
    }
    return changed;
  }

  waitForModeChange(previousMode) {
    return new Promise((resolve) => {
      if (this.modeOutputTimer) clearTimeout(this.modeOutputTimer);
      this.modeOutputTimer = null;
      this.modeOutputBuffer = "";
      const timer = setTimeout(() => {
        if (this.modeChangeWaiter?.resolve === resolve) {
          this.modeChangeWaiter = null;
        }
        resolve(null);
      }, this.modeChangeTimeoutMs);
      this.modeChangeWaiter = { previousMode, resolve, timer };
    });
  }

  handleOutput(data) {
    if (!this.modeChangeWaiter) return [];
    this.modeOutputBuffer = `${this.modeOutputBuffer}${data}`.slice(-12_000);
    const observed = modeFromTerminalText(this.modeOutputBuffer);
    if (observed && observed !== this.modeChangeWaiter.previousMode) {
      this.observeMode(observed);
      return [];
    }
    const footer = cleanTerminalText(this.modeOutputBuffer);
    const footerCount = (footer.match(/for\s*agents|foragents/gi) || []).length;
    const defaultFooter = /for\s*shortcuts|forshortcuts/i.test(footer);
    if (!defaultFooter && footerCount === 0) return [];
    // Claude removes the mode badge when it returns to Default. A redraw may
    // first contain the previous badge and then the badge-free footer, so two
    // footer occurrences confirm that transition without guessing from time.
    if (observed && !defaultFooter && footerCount < 2) return [];
    if (this.modeOutputTimer) clearTimeout(this.modeOutputTimer);
    this.modeOutputTimer = setTimeout(() => {
      this.modeOutputTimer = null;
      if (!this.modeChangeWaiter) return;
      const settledMode = modeFromTerminalText(this.modeOutputBuffer);
      const settledFooter = cleanTerminalText(this.modeOutputBuffer);
      const settledFooterCount = (
        settledFooter.match(/for\s*agents|foragents/gi) || []
      ).length;
      const settledDefaultFooter = /for\s*shortcuts|forshortcuts/i.test(
        settledFooter,
      );
      if (
        settledMode &&
        (settledMode !== this.modeChangeWaiter.previousMode ||
          (!settledDefaultFooter && settledFooterCount < 2))
      ) {
        return;
      }
      this.observeMode("default");
    }, this.modeOutputSettleMs);
    return [];
  }

  async setMode(payload, executor) {
    const requested = normalizeClaudeMode(payload?.mode);
    const requestId = payload?.requestId || payload?.commandId || "";
    const fail = (reason) => {
      this.pendingEvents.push(
        this.modeStatusEvent({ accepted: false, reason, requestId }),
      );
      return false;
    };
    if (this.modeControl !== "supported") return fail("mode_control_unsupported");
    if (!this.sessionReady) return fail("mode_change_not_ready");
    if (!this.availableModes().some((item) => item.id === requested)) {
      return fail("mode_not_available");
    }
    if (!executor || typeof executor.write !== "function") {
      return fail("mode_control_unavailable");
    }
    if (this.taskActive || this.pendingInteractionInputs.size > 0) {
      return fail("mode_change_busy");
    }
    if (this.modeChangeWaiter) return fail("mode_change_in_progress");
    if (requested === this.currentMode) {
      this.pendingEvents.push(
        this.modeStatusEvent({ accepted: true, requestId }),
      );
      return true;
    }

    const visited = new Set([this.currentMode]);
    for (let step = 0; step < this.modeChangeMaxSteps; step += 1) {
      const previousMode = this.currentMode;
      const observedMode = this.waitForModeChange(previousMode);
      executor.write(CLAUDE_SHIFT_TAB);
      const nextMode = await observedMode;
      if (!nextMode) return fail("mode_change_not_confirmed");
      if (nextMode === requested) {
        this.pendingEvents.push(
          this.modeStatusEvent({ accepted: true, requestId }),
        );
        return true;
      }
      if (visited.has(nextMode)) return fail("mode_not_reachable");
      visited.add(nextMode);
    }
    return fail("mode_not_reachable");
  }

  questionPayload(input) {
    return {
      questions: (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).map((question, index) => ({
        id: `q${index + 1}`,
        header: String(question?.header || `Question ${index + 1}`).slice(0, 64),
        question: String(question?.question || "").slice(0, 2048),
        multiple: Boolean(question?.multiSelect),
        allow_other: true,
        options: (Array.isArray(question?.options) ? question.options : []).slice(0, 8).map((option, optionIndex) => ({
          id: `o${optionIndex + 1}`,
          label: String(option?.label || "").slice(0, 128),
          description: String(option?.description || "").slice(0, 512),
          preview: String(option?.preview || "").slice(0, 4096),
        })),
      })),
    };
  }

  questionUpdatedInput(input, response) {
    const answers = response?.answers && typeof response.answers === "object"
      ? response.answers
      : {};
    const mapped = {};
    (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).forEach((question, index) => {
      const raw = answers[`q${index + 1}`];
      const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      mapped[String(question?.question || `Question ${index + 1}`)] = values.map(String).join(", ");
    });
    return { ...input, answers: mapped };
  }

  describe() {
    return {
      ...super.describe(),
      adapter: this.kind,
      runtime: "claude-pty",
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

  async beforeStart({ sessionId, send }) {
    this.sessionId = sessionId ?? null;
    this.startedAt = Date.now();
    this.scanner = new ClaudeJsonlScanner({ transcriptPath: null, startedAt: this.startedAt });
    this.hookServer = await this.hookServerFactory({
      onSessionStart: (sessionId, payload) => {
        this.sessionReady = true;
        this.taskActive = false;
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
        });
        this.observeMode(payload.permission_mode || payload.permissionMode);
      },
      onPermissionRequest: (callId, event) => {
        this.observeMode(event.permissionMode);
        // Stage 8.9: dual-emit. Legacy event first (the relay and
        // downstream consumers expect it); then the new
        // agent.interaction.requested envelope for the App card
        // model. The hook server itself never sees sessionId; the
        // adapter enriches from this.sessionId captured above.
        this.pendingEvents.push(event);
        if (this.sessionId == null) return;
        this.pendingInteractionInputs.set(callId, {
          tool: event.tool,
          input: event.input && typeof event.input === "object" ? event.input : {},
          permissionSuggestions: Array.isArray(event.permissionSuggestions)
            ? event.permissionSuggestions
            : [],
        });
        try {
          const interaction = event.tool === "AskUserQuestion"
            ? buildInteractionRequest({
                provider: "claude",
                runtime: "claude-pty",
                sessionId: this.sessionId,
                interactionId: callId,
                source: INTERACTION_SOURCES.HOOK,
                kind: INTERACTION_KINDS.QUESTIONS,
                title: "Claude has questions",
                prompt: "Answer the questions to continue.",
                payload: this.questionPayload(event.input),
                expiresAt: claudeInteractionExpiresAt(),
              })
            : event.tool === "ExitPlanMode" || event.tool === "exit_plan_mode"
              ? buildInteractionRequest({
                  provider: "claude",
                  runtime: "claude-pty",
                  sessionId: this.sessionId,
                  interactionId: callId,
                  source: INTERACTION_SOURCES.HOOK,
                  kind: INTERACTION_KINDS.CONFIRM,
                  title: "Implement this plan?",
                  prompt: "Review Claude's plan before continuing.",
                  payload: {
                    tool: event.tool,
                    display_name: "Exit plan mode",
                    plan: typeof event.input?.plan === "string" ? event.input.plan.slice(0, 65_536) : "",
                  },
                  expiresAt: claudeInteractionExpiresAt(),
                })
              : permissionEventToInteraction(event, {
                  source: INTERACTION_SOURCES.HOOK,
                  runtime: "claude-pty",
                  sessionId: this.sessionId,
                  createdAt: Date.now(),
                  expiresAt: claudeInteractionExpiresAt(),
                });
          this.pendingEvents.push(interaction);
        } catch (err) {
          // Defensive: the helper only throws on shape-invalid
          // input. Don't crash the session; legacy event is
          // already on the queue.
          console.error(`[claudeAdapter] dual-emit failed: ${err.message}`);
        }
      },
      onPermissionTimeout: (callId, event) => {
        this.pendingInteractionInputs.delete(callId);
        // The hook server's five-minute timer fired without a remote decision. Tell
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
      onElicitationRequest: (interactionId, event) => {
        this.pendingInteractionInputs.set(interactionId, {
          kind: "elicitation",
          mode: event.mode,
        });
        this.pendingEvents.push(buildInteractionRequest({
          provider: "claude",
          runtime: "claude-pty",
          sessionId: this.sessionId,
          interactionId,
          source: INTERACTION_SOURCES.HOOK,
          kind: event.mode === "url" ? INTERACTION_KINDS.URL : INTERACTION_KINDS.FORM,
          title: event.serverName || "Claude MCP request",
          prompt: event.message || "The MCP server needs input.",
          payload: event.mode === "url"
            ? { url: event.url, server_name: event.serverName }
            : { schema: event.requestedSchema, server_name: event.serverName },
          containsSecret: schemaContainsSecret(event.requestedSchema),
          expiresAt: claudeInteractionExpiresAt(),
        }));
      },
      onElicitationTimeout: (interactionId) => {
        this.pendingInteractionInputs.delete(interactionId);
        this.pendingEvents.push({
          type: "agent.permission.resolved",
          provider: "claude",
          callId: interactionId,
          decision: "denied",
          reason: "timeout",
        });
      },
      onHookEvent: (payload) => {
        const hookEvent = safeText(
          payload.hook_event_name || payload.hookEventName,
          64,
        );
        if (hookEvent === "UserPromptSubmit") this.taskActive = true;
        if (
          hookEvent === "Stop" ||
          hookEvent === "StopFailure" ||
          hookEvent === "SessionEnd"
        ) {
          this.taskActive = false;
        }
        this.observeMode(payload.permission_mode || payload.permissionMode);
        const event = mapClaudeHookEvent(payload);
        if (event) this.pendingEvents.push(event);
      },
    });
    this.hookSettingsPath = generateClaudeHookSettings({
      port: this.hookServer.port,
      registerPermissionRequest: !this.isNonInteractive(this.args),
      registerElicitation: !this.isNonInteractive(this.args),
    });
  }

  scanStructuredEvents() {
    return [...this.pendingEvents.splice(0), ...this.scanner.scan()];
  }

  getTranscriptPath() {
    return this.scanner.transcriptPath || null;
  }

  readConversationHistory(options = {}) {
    return readClaudeConversationHistory(this.getTranscriptPath(), options);
  }

  resolvePermission(payload) {
    if (!this.hookServer) return false;
    const callId = payload.callId || payload.interactionId || payload.id;
    if (!callId) {
      this.pendingEvents.push({
        type: "agent.permission.resolve.error",
        provider: "claude",
        message: "No callId in /client/permission payload.",
      });
      return false;
    }
    const decision = payload.decision || "denied";
    const pending = this.pendingInteractionInputs.get(callId);
    if (pending?.kind === "elicitation") {
      const action = payload.action === "submit" || payload.action === "allow"
        ? "accept"
        : payload.action === "cancel" || decision === "abort"
          ? "cancel"
          : "decline";
      const ok = this.hookServer.resolveElicitation({
        interactionId: callId,
        action,
        content: payload.response?.values || payload.response || {},
      });
      if (!ok) return false;
      this.pendingInteractionInputs.delete(callId);
      this.pendingEvents.push({
        type: "agent.permission.resolved",
        provider: "claude",
        callId,
        decision: action === "accept" ? "approved" : action === "cancel" ? "abort" : "denied",
        decisionSource: payload.decisionSource || undefined,
      });
      return true;
    }
    const updatedInput = pending?.tool === "AskUserQuestion"
      ? this.questionUpdatedInput(pending.input, payload.response)
      : undefined;
    const ok = this.hookServer.resolvePermission({
      callId,
      decision,
      reason: payload.reason,
      updatedInput,
    });
    if (!ok) {
      this.pendingEvents.push({
        type: "agent.permission.resolve.error",
        provider: "claude",
        callId,
        message: "No pending Claude hook permission for this callId.",
      });
      return false;
    }
    this.pendingInteractionInputs.delete(callId);
    this.pendingEvents.push({
      type: "agent.permission.resolved",
      provider: "claude",
      callId,
      decision,
      decisionSource: payload.decisionSource || undefined,
      // Claude only supplies session-rule suggestions for some prompts.
      // Mark the fallback so the App does not claim a rule was installed.
      sessionRulePending: decision === "approved_for_session"
        && !(pending?.permissionSuggestions?.length > 0),
    });
    return true;
  }

  cleanup() {
    if (this.modeOutputTimer) {
      clearTimeout(this.modeOutputTimer);
      this.modeOutputTimer = null;
    }
    if (this.modeChangeWaiter) {
      clearTimeout(this.modeChangeWaiter.timer);
      this.modeChangeWaiter.resolve(null);
      this.modeChangeWaiter = null;
    }
    this.hookServer?.stop();
    cleanupClaudeHookSettings(this.hookSettingsPath);
    this.pendingInteractionInputs.clear();
  }
}
