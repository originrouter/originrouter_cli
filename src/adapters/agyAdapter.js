import { readFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { TerminalAdapter } from './terminalAdapter.js';
import { configureAgyHooks } from './agy/hookSettings.js';
import { startAgyHookServer } from './agy/hookServer.js';
import { agyTranscriptPath, agyTranscriptItems, readAgyConversationHistory, agyTranscriptRows } from './agy/history.js';
import { buildInteractionRequest, INTERACTION_KINDS, INTERACTION_SOURCES } from '../runtime/agentInteractionContract.js';
import { agentInteractionTimeoutMsFromConfig } from '../config/agentInteractionTimeout.js';
import { readConfig } from '../persistence/state.js';
import { agyPermissionPayload } from './agy/permissionPayload.js';
import { AgyNativeExecutor } from './agy/nativeExecutor.js';
import { AgyNativeScreen, agyScreenState } from './agy/nativeScreen.js';
import { agySessionArguments, replaceAgyFlags } from './agy/nativeLaunch.js';
import { loadAgyCatalog, agyEffortVariants, agyFooterConfiguration } from './agy/nativeCatalog.js';
import { agyQuestions, questionPanel, questionSelection } from './agy/nativeQuestions.js';
import { prepareAgyAttachments, AGY_NATIVE_PROMPT_CAPABILITIES } from './agy/nativeAttachments.js';
import { configureAgyDeviceMcp } from './agy/mcpSettings.js';
import { fileURLToPath } from 'node:url';
import { AgyNativeQueueStore, validAgyQueuedMessage } from './agy/nativeQueue.js';
import { displaySafeToolInput, toolInputContainsSecret } from '../runtime/displaySafeToolInput.js';
import { observeAgyLocalInput, reconcileAgyLocalDraft, agyEditorDraft } from './agy/nativeInput.js';
import { TerminalResponseFilter } from '../utils/terminalResponses.js';

export function agyNativeArgs(args) { return agySessionArguments(args).args; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value).replace(/\(Recommended\)\s*/gi, '').trim();

function charTerminalWidth(codePoint) {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
  // Combining diacritical / zero-width marks.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    || codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0xfeff
  ) return 0;
  // East Asian Wide / Fullwidth and common emoji blocks occupy 2 cells.
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329 || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f)
      || (codePoint >= 0x3250 && codePoint <= 0x4dbf)
      || (codePoint >= 0x4e00 && codePoint <= 0xa4c6)
      || (codePoint >= 0xa960 && codePoint <= 0xa97c)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6b)
      || (codePoint >= 0xff01 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
      || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function truncateTerminalColumns(text, maxCols) {
  const normalized = String(text).replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
  let width = 0, out = '';
  for (const ch of normalized) {
    const w = charTerminalWidth(ch.codePointAt(0));
    if (width + w > maxCols) break;
    out += ch;
    width += w;
  }
  return out;
}

export class AgyAdapter extends TerminalAdapter {
  constructor({ args = [], cwd, loadCatalog = loadAgyCatalog } = {}) {
    const launch = agySessionArguments(args);
    super({ command: 'agy', args: launch.args });
    this.kind = 'agy'; this.cwd = cwd; this.pendingEvents = []; this.seen = new Map();
    this.nativeSessionId = null; this.transcriptPath = null; this.ready = false;
    this.model = null; this.busy = false; this.mode = 'unknown'; this.fullyIdle = true;
    this.loadCatalog = loadCatalog; this.models = []; this.epoch = 0; this.messages = [];
    this.questions = new Map(); this.completedQuestions = new Set();
    this.initialMessage = launch.initialMessage?.replace(/\r\n/g, '\n') ?? null;
    for (let i = 0; i < this.args.length; i++) {
      const arg = this.args[i];
      if (arg === '--conversation') this.nativeSessionId = this.args[++i] || null;
      else if (arg.startsWith('--conversation=')) this.nativeSessionId = arg.slice(15);
    }
    this.transcriptPath = agyTranscriptPath(this.nativeSessionId);
    if (this.transcriptPath && existsSync(this.transcriptPath) && statSync(this.transcriptPath).size <= 32 * 1024 * 1024) {
      for (const item of agyTranscriptItems(readFileSync(this.transcriptPath, 'utf8'))) this.seen.set(`${this.nativeSessionId}:${item.id}`, JSON.stringify(item));
    }
    this.resetScreen();
  }
  describe() { return { ...super.describe(), runtime: 'agy-pty', structuredSources: ['agy-hooks', 'agy-transcript'] }; }
  createExecutor() { return new AgyNativeExecutor(this); }
  resetScreen(cols = 100, rows = 30) {
    this.screen?.dispose(); this.ready = false; this.screenText = ''; this.state = 'starting';
    this.checkingNativeVersion = true;
    this.nativeInput = null; this.terminalResponses = null;
    this.userTyping = false; this.localTextAwaitingEcho = false;
    this.screen = new AgyNativeScreen(text => this.observeScreen(text), cols, rows);
  }
  resizeScreen(cols, rows) { this.screen.resize(cols, rows); }
  async beforeStart({ sessionId, conversationId, stateDir, env, resolveInteraction, writeLocal, localTerminalAttached }) {
    this.sessionId = sessionId; this.stateDir = stateDir; this.resolveInteraction = resolveInteraction;
    this.catalogEnv = env;
    this.writeLocal = writeLocal; this.localAttached = localTerminalAttached === true;
    this.trustedLaunch = false;
    try { this.trustedLaunch = Boolean(env?.ORIGINROUTER_AGY_TRUSTED_CWD)
      && realpathSync(env.ORIGINROUTER_AGY_TRUSTED_CWD) === realpathSync(this.cwd); } catch {}
    const catalog = await this.loadCatalog(env);
    this.models = catalog.models; this.nativeVersion = catalog.version;
    // Only the native menus exercised against this version get structured drivers.
    this.nativeMenus = this.nativeVersion === '1.5.13';
    this.timeoutMs = Math.min(285000, agentInteractionTimeoutMsFromConfig(readConfig()) || 285000);
    if (stateDir) {
      const parent = join(stateDir, 'agy-attachments'); mkdirSync(parent, { recursive: true, mode: 0o700 });
      this.attachmentDirectory = mkdtempSync(join(parent, 'session-'));
    }
    await this.openBroker();
    try { await configureAgyHooks(); } catch (error) { this.hookServer.close(); throw error; }
    // MCP integration is optional if the user's config is invalid or the name belongs to them.
    try { await configureAgyDeviceMcp(); this.supportsDeviceTools = true; }
    catch (error) { this.pendingEvents.push({ type: 'agent.mcp.status', provider: 'agy', state: 'unavailable', reason: error.message }); }
    this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent());
    if (stateDir) {
      this.queueStore = new AgyNativeQueueStore(stateDir, conversationId || sessionId);
      let saved;
      try { saved = this.queueStore.read(); }
      catch (error) { this.hookServer.close(); this.screen.dispose(); rmSync(this.attachmentDirectory, { recursive: true, force: true }); throw error; }
      this.messages = saved.pending;
      this.recoveredAttachmentRoots = new Set();
      this.messages = this.messages.filter(entry => {
        if (!entry.attachmentRoot) return true;
        try {
          const root = realpathSync(entry.attachmentRoot);
          const inside = relative(realpathSync(join(stateDir, 'agy-attachments')), root);
          if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('invalid_attachment_root');
          this.recoveredAttachmentRoots.add(root); return true;
        } catch {
          this.pendingEvents.push({ type: 'agent.message.result', accepted: false, messageId: entry.id, reason: 'attachment_missing_on_resume', rejectedMessage: entry.text });
          return false;
        }
      });
      this.confirmedIds = saved.confirmed;
      this.messageIds = new Set([...saved.confirmed, ...this.messages.map(m => m.id).filter(Boolean)]);
      this.unconfirmedIds = new Set([...(saved.uncertain || []), saved.inFlight?.id].filter(Boolean));
      if (saved.inFlight) this.pendingEvents.push({ type: 'agent.message.result', provider: 'agy', messageId: saved.inFlight.id,
        accepted: false, reason: 'previous_delivery_unconfirmed', rejectedMessage: saved.inFlight.text });
    }
    if (this.initialMessage && !validAgyQueuedMessage({ text: this.initialMessage })) throw new Error('native_message_too_large');
    if (this.initialMessage && this.messages.length < 16) {
      const entry = { text: this.initialMessage, id: `initial-${sessionId}` };
      this.messages.push(entry); (this.messageIds ||= new Set()).add(entry.id);
    }
    else if (this.initialMessage) this.pendingEvents.push({ type: 'agent.message.result', messageId: `initial-${sessionId}`,
      accepted: false, reason: 'native_queue_full', rejectedMessage: this.initialMessage });
    this.saveQueue();
  }
  async openBroker() {
    this.epoch++;
    const epoch = this.epoch;
    this.hookServer = await startAgyHookServer({
      timeoutMs: this.timeoutMs,
      onEvent: payload => { if (epoch === this.epoch) this.onHook(payload); },
      delegateTool: payload => payload.toolCall?.name === 'ask_question',
      onPermission: (payload, id) => { if (epoch === this.epoch) this.permission(payload.toolCall || {}, id, this.timeoutMs); },
      onCancel: (id, reason) => {
        this.pendingEvents.push({ type: 'agent.permission.resolved', provider: 'agy', callId: id, reason });
        this.updateLocalNotice();
      },
    });
  }
  buildLaunch() {
    const directories = [...(this.attachmentDirectory ? [this.attachmentDirectory] : []), ...(this.recoveredAttachmentRoots || [])];
    return { command: 'agy', args: [...this.args, ...directories.flatMap(dir => ['--add-dir', dir])],
      env: { ...this.hookServer?.env, ...(this.supportsDeviceTools ? {
        ORIGINROUTER_AGY_MCP_SESSION: this.sessionId,
        ORIGINROUTER_AGY_MCP_BIN: fileURLToPath(new URL('../../bin/originrouter.js', import.meta.url)),
      } : {}) } };
  }
  afterNativeStart(result, epoch) {
    this.processEpoch = epoch;
    this.pendingEvents.push({ type: 'agent.process.started', provider: 'agy', pid: result.pid, epoch });
    this.pendingEvents.push({ type: 'agent.capabilities', provider: 'agy', promptCapabilities:
      this.nativeMenus && this.attachmentDirectory ? AGY_NATIVE_PROMPT_CAPABILITIES : {} });
    this.pumpTimer ||= setInterval(() => { void this.pump().catch(error => this.failQueued(error.message)); }, 150);
    this.pumpTimer.unref?.();
  }
  permission(tool, id, timeoutMs, source = INTERACTION_SOURCES.HOOK) {
    this.pendingEvents.push(buildInteractionRequest({ provider: 'agy', runtime: this.describe().runtime,
      sessionId: this.sessionId, interactionId: id, source, kind: INTERACTION_KINDS.PERMISSION,
      title: `${tool.name || tool.title || 'Tool'} needs permission`,
      prompt: tool.title || 'Review this Antigravity action before continuing.',
      payload: agyPermissionPayload(tool, this.cwd),
      containsSecret: toolInputContainsSecret(tool.args || tool.rawInput || {}),
      expiresAt: timeoutMs > 0 ? Math.floor((Date.now() + timeoutMs) / 1000) : null,
    }));
    if (this.localAttached) {
      // Auto-resolved permissions (autonomy, App policy) settle in
      // milliseconds; drawing the hint for them only flashes the bottom row
      // and moves the cursor the TUI shares with us while the user is typing.
      // Hold the notice briefly so only requests that are genuinely still
      // waiting ever appear.
      const noticeTimer = setTimeout(() => {
        (this.noticeTimers ||= new Set()).delete(noticeTimer);
        if (this.disposed || !this.hookServer?.pending.has(id)) return;
        this.localNoticeActive = true;
        this.noticeCallId = id;
        this.writeLocal?.(this.localNotice(`[OriginRouter approval] ${tool.name || 'Tool'} — y: allow once, n: deny; also available in App.`));
      }, 600);
      noticeTimer.unref?.();
      (this.noticeTimers ||= new Set()).add(noticeTimer);
    }
  }
  onHook(payload) {
    const nativeId = String(payload.conversationId || '');
    if (nativeId && nativeId !== this.nativeSessionId) {
      this.nativeSessionId = nativeId; this.transcriptPath = agyTranscriptPath(nativeId);
      this.pendingEvents.push({ type: 'agent.session.start', provider: 'agy', sessionId: nativeId, transcriptPath: this.transcriptPath });
    }
    if (payload.modelName && this.model !== payload.modelName) {
      this.model = payload.modelName; this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent());
    }
    if (payload.hookEventName === 'PreInvocation') {
      this.everInvoked = true;
      if (this.inFlightMessage?.isCommand) { clearTimeout(this.inFlightMessage.timer); this.inFlightMessage = null; this.saveQueue(); }
      if (!this.busy) this.pendingEvents.push({ type: 'agent.task.started', provider: 'agy' });
      this.busy = true; this.fullyIdle = false; this.ready = false;
    }
    if (payload.hookEventName === 'PreToolUse') {
      const tool = payload.toolCall || {};
      // The hook's stepIdx IS the trajectory step the native transcript gives
      // this call's GENERIC result row, so a start keyed on it pairs with the
      // scanner's end deterministically — no shared map, no reliance on the
      // unpredictable native call id, and the pairing survives an adapter
      // restart (where the old in-memory map was always empty and every end
      // fell back to an unmatched generated id, orphaning the start).
      const callId = Number.isInteger(payload.stepIdx) ? `step-${payload.stepIdx}`
        : tool.id || `call-${this.stepIdMisses = (this.stepIdMisses || 0) + 1}`;
      this.pendingEvents.push({ type: 'agent.tool_call.start', provider: 'agy', callId, tool: tool.name, input: displaySafeToolInput(tool.args) });
      if (tool.name === 'ask_question' && this.nativeMenus) {
        const questions = agyQuestions(tool.args);
        if (questions) {
          const id = `${nativeId}:${this.epoch}:${tool.id || payload.stepIdx}`;
          this.questions.set(id, { id, questions, step: payload.stepIdx, toolId: tool.id, epoch: this.epoch });
          this.pendingEvents.push(buildInteractionRequest({ provider: 'agy', runtime: 'agy-pty', sessionId: this.sessionId,
            interactionId: id, source: INTERACTION_SOURCES.HOOK, kind: INTERACTION_KINDS.QUESTIONS,
            title: 'Antigravity has questions', prompt: 'Answer to continue.', payload: { questions },
            expiresAt: Math.floor((Date.now() + this.timeoutMs) / 1000) }));
        }
      }
    }
    if (payload.hookEventName === 'PostToolUse') {
      for (const entry of this.questions.values()) if (entry.step === payload.stepIdx && entry.toolId === payload.toolCall?.id) {
        entry.post = payload;
        if (payload.error) this.closeQuestion(entry, false, 'native_question_failed');
      }
    }
    if (payload.hookEventName === 'Stop') {
      this.busy = !payload.fullyIdle; this.fullyIdle = payload.fullyIdle === true;
      this.pendingEvents.push({ type: payload.error ? 'agent.task.failed' : 'agent.task.complete', provider: 'agy', fullyIdle: payload.fullyIdle,
        ...(payload.error ? { error: String(payload.error).slice(0, 4000) } : {}) });
    }
  }
  observeScreen(text) {
    if (this.disposed) return;
    const actualVersion = this.checkingNativeVersion
      ? text.match(/^\s*Antigravity CLI (\d+\.\d+\.\d+)\b/m)?.[1] : null;
    if (actualVersion) this.checkingNativeVersion = false;
    if (actualVersion && actualVersion !== this.nativeVersion) {
      this.nativeVersion = actualVersion; this.nativeMenus = actualVersion === '1.5.13';
      this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent(), this.modeStatusEvent(),
        { type: 'agent.capabilities', provider: 'agy', promptCapabilities: this.nativeMenus && this.attachmentDirectory ? AGY_NATIVE_PROMPT_CAPABILITIES : {} });
    }
    this.screenText = text; const state = agyScreenState(text); const previousState = this.state;
    if (state === 'idle') this.checkingNativeVersion = false;
    if (state !== this.state) {
      this.state = state;
      this.pendingEvents.push({ type: 'agent.adapter.status', provider: 'agy', state });
      if (state === 'needs_login' && this.everInvoked && !this.reconfiguring) { this.models = []; this.autoModeAvailable = false; this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent()); }
    }
    // After a native cancel/denial, Stop is not guaranteed. The actual idle editor is another observation.
    if (state === 'idle' && previousState !== 'idle' && this.inFlightMessage?.isCommand && this.inFlightMessage.nativeActivityObserved) {
      clearTimeout(this.inFlightMessage.timer); this.inFlightMessage = null; this.saveQueue();
    }
    if (state === 'unknown' && this.inFlightMessage?.isCommand) this.inFlightMessage.nativeActivityObserved = true;
    if (state === 'idle' && previousState !== 'idle' && !this.hookServer?.pending.size && !this.questions.size && !this.inFlightMessage) {
      this.busy = false;
    }
    reconcileAgyLocalDraft(this, text);
    this.ready = state === 'idle' && !this.userTyping && !this.inputTransaction;
    if (state === 'needs_native_trust' && this.trustedLaunch && !this.trustSubmitted
        && text.replace(/\s/g, '').includes(this.cwd.replace(/\s/g, ''))) {
      this.trustSubmitted = true; this.executor?.write('\r');
    }
    const footer = agyFooterConfiguration(this.models, text);
    const header = text.split('\n').find(line => /^\s*▀{8}\s+/.test(line));
    const headerModel = header && (Array.isArray(this.models) ? this.models : []).find(m => header.trim().endsWith(m.displayName));
    if (!footer?.model && headerModel && this.model !== headerModel.id && state === 'idle') {
      this.model = headerModel.id; this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent());
    }
    if (footer) {
      this.autoModeAvailable ||= footer.mode === 'auto';
      if (this.mode !== footer.mode) { this.mode = footer.mode; this.pendingEvents.push(this.modeStatusEvent()); }
      if (footer.model && this.model !== footer.model) { this.model = footer.model; this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent()); }
    }
  }
  handleOutput(data) { if (!this.disposed) this.screen.write(data); return []; }
  async waitFor(test, ms = 5000, isCurrent = () => true) {
    const epoch = this.epoch; const end = Date.now() + ms;
    while (Date.now() < end && !this.disposed && epoch === this.epoch && isCurrent()) {
      if (test()) return true;
      await sleep(40);
    }
    return false;
  }
  async submitRemoteMessage(executor, message, payload = {}) {
    await this.screen?.flush;
    const id = payload.messageId;
    const refuse = reason => {
      (this.messageRefusals ||= new Map()).set(id || '', reason);
      while (this.messageRefusals.size > 32) this.messageRefusals.delete(this.messageRefusals.keys().next().value);
      return false;
    };
    if (this.disposed) return refuse('native_session_stopped');
    if (this.queueUnavailable) return refuse('native_queue_unavailable');
    if (id && this.unconfirmedIds?.has(id)) return refuse('native_delivery_uncertain');
    if (id && (this.messageIds ||= new Set()).has(id)) return true;
    if (typeof message === 'string') message = message.replace(/\r\n/g, '\n');
    if (!validAgyQueuedMessage({ text: message, id })) return refuse('native_message_invalid');
    if (this.userTyping) return refuse('native_local_draft');
    if (this.hookServer?.pending.size) return refuse('native_waiting_permission');
    if (this.messages.length >= 16) return refuse('native_queue_full');
    if (['needs_login', 'needs_native_trust', 'native_panel', 'question'].includes(this.state)) return refuse(`native_${this.state}`);
    let prepared;
    if (payload.content && !this.nativeMenus) return refuse('native_content_unsupported');
    try { prepared = payload.content ? prepareAgyAttachments(message, payload.content, this.attachmentDirectory) : { text: message }; }
    catch { return refuse('native_content_unsupported'); }
    prepared.text = prepared.text.replace(/\r\n/g, '\n');
    if (!validAgyQueuedMessage({ text: prepared.text, id })) {
      if (prepared.root) rmSync(prepared.root, { recursive: true, force: true });
      return refuse('native_message_invalid');
    }
    if (id) this.messageIds.add(id);
    this.messages.push({ text: prepared.text, id, isCommand: payload.isCommand === true, attachmentRoot: prepared.root });
    if (!this.saveQueue()) {
      this.messages.pop(); if (id) this.messageIds.delete(id);
      if (prepared.root) rmSync(prepared.root, { recursive: true, force: true });
      return refuse('native_queue_unavailable');
    }
    this.pendingEvents.push({ type: 'agent.message.queued', provider: 'agy', messageId: id || null });
    await this.pump(); return true;
  }
  messageRefusalReason(messageId) { return this.messageRefusals?.get(messageId || '') || 'native_not_ready'; }
  // A notice must not scroll or disturb the native TUI's cursor model: agy
  // repaints inline via relative moves (\x1b[nA, bare \n) and expects the
  // cursor right where it left it. Use VT100 DECSC/DECRC (\x1b7/\x1b8) rather
  // than SCO \x1b[s/\x1b[u — Apple Terminal.app ignores CSI s/u, which leaves
  // the cursor stranded on the bottom row and shifts every later frame down by
  // two rows, duplicating lines into scrollback. Truncate strictly below cols
  // display cells so the bottom row can never wrap or scroll without toggling
  // DECAWM (\x1b[?7l/\x1b[?7h), which agy manages itself.
  localNotice(text) {
    const rows = this.screen?.terminal?.rows || 24;
    const cols = this.screen?.terminal?.cols || 80;
    const line = truncateTerminalColumns(text, Math.max(1, cols - 1));
    return `\x1b7\x1b[${rows};1H\x1b[2K\x1b[0m${line}\x1b8`;
  }
  clearNoticeTimers() {
    if (!this.noticeTimers) return;
    for (const timer of this.noticeTimers) clearTimeout(timer);
    this.noticeTimers.clear();
  }
  // The TUI only covers the notice when it happens to repaint the bottom row;
  // an idle TUI would leave a stale "y/n" hint on screen forever. When every
  // pending permission is settled — remote App decision, autonomy
  // auto-resolve, local y/n, timeout, cancel — paint the row back to what the
  // TUI last drew there instead of waiting for its next frame.
  updateLocalNotice() {
    if (this.disposed || !this.localAttached || !this.localNoticeActive || this.hookServer?.pending.size) return;
    this.localNoticeActive = false;
    this.noticeCallId = null;
    const lines = String(this.screenText || '').split('\n');
    this.writeLocal?.(this.localNotice(lines[lines.length - 1] || ''));
  }
  flushTransactionTail() {
    const tail = this.transactionTail;
    this.transactionTail = '';
    if (tail && !this.disposed && !this.reconfiguring) this.executor?.write(tail);
  }
  async pump() {
    if (this.pumping || this.disposed || this.queueUnavailable || !this.executor) return;
    this.completeQuestions();
    if (this.ready && !this.models.length && this.catalogEnv && !this.refreshingCatalog && Date.now() - (this.catalogRefreshedAt || 0) > 30000) {
      this.refreshingCatalog = true; this.catalogRefreshedAt = Date.now();
      void this.loadCatalog(this.catalogEnv).then(catalog => {
        if (this.disposed) return;
        this.models = catalog.models; this.observeScreen(this.screenText);
        this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent());
      }).catch(() => {}).finally(() => { this.refreshingCatalog = false; });
    }
    if (!this.ready || this.busy || this.userTyping || this.inputTransaction || this.hookServer?.pending.size || this.questions.size) return;
    this.pumping = true;
    try {
      if (this.pendingConfiguration && this.fullyIdle && !this.inFlightMessage) {
        const change = this.pendingConfiguration; this.pendingConfiguration = null;
        await this.reconfigure(change); return;
      }
      const entry = this.messages[0];
      if (!entry || this.inFlightMessage) return;
      this.messages.shift(); this.inFlightMessage = entry; this.ready = false;
      if (!this.saveQueue()) return;
      this.inputTransaction = true;
      try {
        const submitted = await this.executor.submitMessage(entry.text);
        if (submitted === false) throw new Error('native_input_write_failed');
        // The transcript's USER_INPUT row arrives on a scan seconds later —
        // by then hook events for this turn have already streamed. Emit the
        // user's text now so events stay in real order, and suppress the scan
        // echo of the same text when it lands.
        (this.suppressedUserTexts ||= []).push(entry.text);
        if (this.suppressedUserTexts.length > 16) this.suppressedUserTexts.shift();
        this.pendingEvents.push({ type: 'user.text', provider: 'agy', text: entry.text });
      } catch {
        this.markDeliveryUncertain('native_input_write_failed');
        return;
      }
      finally { this.inputTransaction = false; this.flushTransactionTail(); }
      // Interruption or a fast native receipt can settle the intent during the async PTY write.
      if (this.inFlightMessage !== entry) return;
      // Receipts are confirmed by native USER_INPUT, never by echoing our own send.
      entry.timer = setTimeout(() => {
        if (this.inFlightMessage !== entry) return;
        this.markDeliveryUncertain('native_input_unconfirmed');
      }, 30000);
      entry.timer.unref?.();
    } finally { this.pumping = false; }
  }
  failQueued(reason) {
    for (const entry of this.messages.splice(0)) this.pendingEvents.push({ type: 'agent.message.result', provider: 'agy', messageId: entry.id,
      accepted: false, reason, deliveryState: 'unsent', rejectedMessage: entry.text });
    this.saveQueue();
  }
  markDeliveryUncertain(reason) {
    const entry = this.inFlightMessage;
    if (!entry) return;
    clearTimeout(entry.timer); this.inFlightMessage = null;
    if (entry.id) (this.unconfirmedIds ||= new Set()).add(entry.id);
    this.saveQueue();
    this.pendingEvents.push({ type: 'agent.message.result', provider: 'agy', messageId: entry.id,
      accepted: false, reason, deliveryState: 'uncertain', rejectedMessage: entry.text });
  }
  saveQueue() {
    try { this.queueStore?.write(this.messages, this.inFlightMessage, this.confirmedIds || [], [...(this.unconfirmedIds || [])]); return true; }
    catch (error) {
      if (!this.queueUnavailable) this.pendingEvents.push({ type: 'agent.adapter.status', provider: 'agy', state: 'queue_unavailable', reason: error.message });
      this.queueUnavailable = true; return false;
    }
  }
  handleTerminalInput(data, executor = this.executor) {
    if (data.includes('\x03')) { this.onTerminalInput(data); executor?.interrupt(); return true; }
    const pending = this.hookServer?.pending.keys().next().value;
    if (this.inputTransaction || this.reconfiguring || (pending && this.localAttached)) {
      const replies = (this.terminalResponses ||= new TerminalResponseFilter()).push(data);
      if (replies) executor?.write(replies);
      // Keystrokes typed during a remote write/question transaction used to be
      // silently dropped — the user watches the editor echo nothing, then the
      // next input arrives missing those characters. Buffer plain-text input
      // (escape-bearing chunks may hold device replies already forwarded
      // above, so they still cannot be replayed safely) and flush it once the
      // transaction releases the keyboard.
      if (this.inputTransaction && !this.reconfiguring && !data.includes('\x1b')) {
        this.transactionTail = ((this.transactionTail || '') + data).slice(-8192);
      }
      if (this.inputTransaction || this.reconfiguring) return true;
    } else this.terminalResponses = null;
    if (pending && this.localAttached && !data.includes('\x03')) {
      // Approve what the hint advertises — the newest pending call is what the
      // user just read, not whichever queued first.
      const target = this.noticeCallId && this.hookServer.pending.has(this.noticeCallId) ? this.noticeCallId : pending;
      if (/^[yn]$/i.test(data)) this.resolveInteraction?.({ interactionId: target, responseId: `local-${target}`,
        action: data.toLowerCase() === 'y' ? 'allow' : 'deny', decisionSource: 'local_terminal' });
      // The native screen advertises `esc to cancel`; a bare Escape honors it.
      else if (data === '\x1b') this.resolveInteraction?.({ interactionId: target, responseId: `local-esc-${target}`,
        action: 'deny', decisionSource: 'local_terminal' });
      return true;
    }
    this.onTerminalInput(data);
    executor?.write(data); return true;
  }
  onTerminalInput(data) {
    const input = observeAgyLocalInput(this, data);
    // Same early-emission as the remote path: the editor draft is still on
    // screen while the Enter keystroke is delivered, so capture it before the
    // native submit clears the editor. The scan suppresses the echo.
    if (input?.submitted && this.state === 'idle' && !this.busy) {
      const draft = agyEditorDraft(this.screenText);
      if (draft) {
        (this.suppressedUserTexts ||= []).push(draft);
        if (this.suppressedUserTexts.length > 16) this.suppressedUserTexts.shift();
        this.pendingEvents.push({ type: 'user.text', provider: 'agy', text: draft });
      }
    }
  }
  onInterrupt() {
    const wasBusy = this.busy;
    this.clearNoticeTimers();
    this.hookServer?.cancelAll();
    for (const entry of this.questions.values()) {
      entry.done?.(false);
      this.pendingEvents.push({ type: 'agent.permission.resolved', provider: 'agy', callId: entry.id, reason: 'user_interrupted' });
    }
    this.questions.clear(); this.busy = false;
    if (wasBusy) this.fullyIdle = false;
    this.markDeliveryUncertain('native_input_interrupted');
    if (wasBusy) this.pendingEvents.push({ type: 'agent.task.aborted', provider: 'agy', reason: 'user_interrupted' });
  }
  resolvePermission(payload) {
    const id = payload.interactionId || payload.callId;
    try {
      if (this.completedQuestions.delete(id)) return true;
      const entry = this.questions.get(id);
      if (entry) return this.answerQuestion(entry, payload);
      return this.hookServer?.resolve(id, payload.action || (['approved', 'approved_for_session'].includes(payload.decision) ? 'allow' : 'deny')) || false;
    } finally { this.updateLocalNotice(); }
  }
  onInteractionRegistered(request) {
    if (this.completedQuestions.has(request.interactionId)) this.resolveInteraction?.({ interactionId: request.interactionId,
      responseId: `native-${request.interactionId}`, action: 'submit', response: {}, decisionSource: 'native_terminal' });
  }
  async answerQuestion(entry, payload) {
    if (this.inputTransaction || entry.epoch !== this.epoch || !this.executor) return false;
    if (payload.action === 'cancel' || payload.action === 'deny') { this.executor.interrupt(); this.onInterrupt(); return true; }
    let answers;
    try { answers = entry.questions.map(q => questionSelection(q, payload.response?.answers?.[q.id])); }
    catch { return false; }
    this.inputTransaction = true;
    let timer;
    const confirmed = new Promise(resolve => { entry.done = resolve; });
    const active = () => !this.disposed && entry.epoch === this.epoch && this.questions.get(entry.id) === entry;
    const write = key => {
      if (!active()) throw new Error('native_question_no_longer_pending');
      this.executor.write(key);
    };
    const wait = (test, ms) => this.waitFor(test, ms, active);
    try {
      for (let i = 0; i < entry.questions.length; i++) {
        const q = entry.questions[i], answer = answers[i];
        const valid = () => { const p = questionPanel(this.screenText); return p && p.number === i + 1 && p.total === entry.questions.length && clean(p.question) === clean(q.question); };
        if (!await wait(valid)) return false;
        let panel = questionPanel(this.screenText);
        const move = async target => {
          panel = questionPanel(this.screenText);
          if (!panel || !valid()) throw new Error('question_panel_changed');
          const cursor = panel.options.find(o => o.cursor)?.index;
          if (!Number.isInteger(cursor)) throw new Error('question_cursor_unknown');
          const key = target < cursor ? '\x1b[A' : '\x1b[B';
          for (let n = 0; n < Math.abs(target - cursor); n++) {
            write(key);
            const expected = cursor + (target < cursor ? -1 : 1) * (n + 1);
            if (!await wait(() => valid() && questionPanel(this.screenText)?.options.find(o => o.cursor)?.index === expected, 2000)) throw new Error('question_cursor_unconfirmed');
          }
        };
        if (answer.other) {
          const other = panel.options.find(o => /Write-in/.test(o.label));
          if (!other) return false;
          await move(other.index); write('\r');
          // Native write-in UI is version-gated, and must actually be visible before text is written.
          if (!await wait(() => valid() && /Your answer:\s*/.test(this.screenText))) return false;
          write(answer.other); await sleep(50); write('\r');
        } else if (q.multiple) {
          for (let index = 0; index < q.options.length; index++) {
            panel = questionPanel(this.screenText);
            const option = panel?.options.find(o => o.index === index);
            if (!option || clean(option.label) !== clean(q.options[index].label)) return false;
            if (option.checked !== answer.indices.includes(index)) {
              await move(index); write(' ');
              if (!await wait(() => valid() && questionPanel(this.screenText)?.options.find(o => o.index === index)?.checked === answer.indices.includes(index), 2000)) return false;
            }
          }
          write('\r');
        } else { await move(answer.indices[0]); write('\r'); }
      }
      entry.expected = answers.map((a, i) => a.other || [...a.indices].sort((x, y) => x - y).map(n => clean(entry.questions[i].options[n].label)).join(', '));
      return await Promise.race([confirmed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 30000); })]);
    } catch { return false; }
    finally {
      clearTimeout(timer); this.inputTransaction = false; entry.done = null;
      this.flushTransactionTail();
      // The native idle repaint may have arrived before the tool-result ACK.
      // Re-evaluate it after releasing keyboard ownership; no extra repaint is guaranteed.
      if (!this.disposed) this.observeScreen(this.screenText);
    }
  }
  completeQuestions() {
    if (!this.questions.size || !this.transcriptPath || !existsSync(this.transcriptPath) || statSync(this.transcriptPath).size > 32 * 1024 * 1024) return;
    const rows = agyTranscriptRows(readFileSync(this.transcriptPath, 'utf8'));
    for (const entry of this.questions.values()) {
      const row = rows.get(entry.step);
      if (!entry.post || !row || !['DONE', 'ERROR'].includes(row.status)) continue;
      if (row.status === 'ERROR' || entry.post.error) { this.closeQuestion(entry, false, 'native_question_failed'); continue; }
      if (entry.expected && !entry.expected.every((value, i) => {
        const answer = String(row.content || '').match(new RegExp(`(?:^|\\n)A${i + 1}: ([^\\n]*)`))?.[1];
        return answer != null && clean(answer) === clean(value);
      })) { this.closeQuestion(entry, false, 'native_answer_different'); continue; }
      this.questions.delete(entry.id);
      if (entry.done) entry.done(true);
      else { this.completedQuestions.add(entry.id); this.resolveInteraction?.({ interactionId: entry.id,
        responseId: `native-${entry.id}`, action: 'submit', response: {}, decisionSource: 'native_terminal' }); }
    }
  }
  closeQuestion(entry, accepted, reason) {
    if (!this.questions.delete(entry.id)) return;
    entry.done?.(accepted);
    this.pendingEvents.push({ type: 'agent.permission.resolved', provider: 'agy', callId: entry.id, reason });
  }
  modelStatusEvent(extra = {}) { return { type: 'agent.model.status', provider: 'agy', runtime: this.describe().runtime,
    sessionId: this.sessionId, model: this.model, modelProvider: null, source: 'native',
    modelControl: this.nativeMenus && this.models.length ? 'supported' : 'unsupported',
    availableModels: (Array.isArray(this.models) ? this.models : []).map(m => ({ ...m, provider: '', providerName: 'Antigravity' })),
    changeStrategy: 'restart_when_idle', ...extra }; }
  effortStatusEvent(extra = {}) {
    const variants = agyEffortVariants(this.models, this.model);
    return { type: 'agent.effort.status', provider: 'agy', runtime: this.describe().runtime,
      effort: variants.find(v => v.model === this.model)?.effort || null,
      effortControl: this.nativeMenus && variants.length ? 'supported' : 'unsupported',
      availableEfforts: variants.map(v => v.effort), changeStrategy: 'restart_when_idle', ...extra };
  }
  modeStatusEvent(extra = {}) {
    const enabled = this.nativeMenus && this.mode !== 'unknown';
    return { type: 'agent.mode.status', provider: 'agy', runtime: this.describe().runtime,
      mode: this.mode, modeControl: enabled ? 'supported' : 'unsupported', changeStrategy: 'restart_when_idle',
      availableModes: enabled ? [...new Set(['plan', 'accept-edits', ...(this.autoModeAvailable ? ['auto'] : [])])].map(id => ({ id, label: id })) : [], ...extra };
  }
  setMode(payload) {
    if (!this.modeStatusEvent().availableModes.some(m => m.id === payload.mode)) return this.rejectConfiguration({ kind: 'mode', requestId: payload.requestId }, 'mode_control_unsupported');
    return this.queueConfiguration({ mode: payload.mode, requestId: payload.requestId, kind: 'mode' });
  }
  setModel(payload) {
    if (payload.provider || !this.nativeMenus || !this.models.some(m => m.id === payload.model)) return this.rejectConfiguration({ kind: 'model', requestId: payload.requestId }, 'model_not_enabled');
    return this.queueConfiguration({ model: payload.model, requestId: payload.requestId, kind: 'model' });
  }
  setEffort(payload) {
    const variant = agyEffortVariants(this.models, this.model).find(v => v.effort === payload.effort);
    return variant && this.nativeMenus ? this.queueConfiguration({ model: variant.model, requestId: payload.requestId, kind: 'effort' })
      : this.rejectConfiguration({ kind: 'effort', requestId: payload.requestId }, 'effort_control_unsupported');
  }
  queueConfiguration(change) {
    if (this.pendingConfiguration || this.reconfiguring) return this.rejectConfiguration(change, 'native_configuration_in_progress');
    if (!this.nativeSessionId && (this.everInvoked || this.args.some(arg => arg === '-c' || arg === '--continue'))) return this.rejectConfiguration(change, 'native_conversation_not_ready');
    if ((!change.model || change.model === this.model) && (!change.mode || change.mode === this.mode)) {
      this.pendingEvents.push(this.configurationStatus(change, { requestId: change.requestId, accepted: true })); return true;
    }
    this.pendingConfiguration = change;
    this.pendingEvents.push(this.configurationStatus(change,
      { requestId: change.requestId, accepted: null, reason: 'restart_when_idle' }));
    void this.pump(); return true;
  }
  async reconfigure(change) {
    this.reconfiguring = true;
    try {
      this.hookServer.close(); await this.openBroker();
      const targetModel = change.model || this.model;
      this.args = replaceAgyFlags(this.args, { conversation: this.nativeSessionId, model: targetModel, effort: null,
        ...(change.mode ? { mode: change.mode } : {}) });
      this.model = null; this.busy = false;
      const started = await this.executor.restart(this.buildLaunch());
      this.pendingEvents.push({ type: 'agent.process.restarted', provider: 'agy', pid: started.pid, epoch: this.epoch });
      const accepted = await this.waitFor(() => this.ready && this.model === targetModel && (!change.mode || this.mode === change.mode), 30000);
      this.pendingEvents.push(this.configurationStatus(change,
        { requestId: change.requestId, accepted, reason: accepted ? null : 'native_configuration_unconfirmed' }));
    } catch (error) {
      this.pendingEvents.push(this.configurationStatus(change,
        { requestId: change.requestId, accepted: false, reason: error.message }));
    } finally { this.reconfiguring = false; this.transactionTail = ''; }
  }
  configurationStatus(change, extra) {
    return (change.kind === 'mode' ? this.modeStatusEvent : change.kind === 'effort' ? this.effortStatusEvent : this.modelStatusEvent).call(this, extra);
  }
  rejectConfiguration(change, reason) {
    this.pendingEvents.push(this.configurationStatus(change, { requestId: change.requestId, accepted: false, reason })); return false;
  }
  getTranscriptPath() { return this.transcriptPath; }
  readConversationHistory(options) { return readAgyConversationHistory(this.transcriptPath, options); }
  scanStructuredEvents() {
    this.completeQuestions();
    const events = this.pendingEvents.splice(0);
    if (this.transcriptPath && existsSync(this.transcriptPath)) {
      try {
        const stat = statSync(this.transcriptPath);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        if (stamp === this.transcriptStamp || stat.size > 32 * 1024 * 1024) return events;
        this.transcriptStamp = stamp;
        for (const item of agyTranscriptItems(readFileSync(this.transcriptPath, 'utf8'), { includeToolStarts: false })) {
          const id = `${this.nativeSessionId}:${item.id}`, fingerprint = JSON.stringify(item);
          if (this.seen.get(id) === fingerprint) continue;
          this.seen.set(id, fingerprint);
          if (item.role === 'user' && this.inFlightMessage?.text.trim() === item.text.trim()) {
            const message = this.inFlightMessage; clearTimeout(message.timer); this.inFlightMessage = null;
            if (message.id) this.confirmedIds = [...(this.confirmedIds || []), message.id].slice(-128);
            this.saveQueue();
            events.push({ type: 'agent.message.result', provider: 'agy', messageId: message.id, accepted: true });
          }
          // user.text is emitted the moment a submission lands on the PTY —
          // the transcript row only confirms it seconds later, and emitting it
          // again would put the same message in the transcript twice.
          if (item.role === 'user' && (this.suppressedUserTexts || []).length
              && String(this.suppressedUserTexts[0] || '').trim() === String(item.text || '').trim()) {
            this.suppressedUserTexts.shift();
            continue;
          }
          events.push({ ...(item.event || { type: item.role === 'user' ? 'user.text' : 'agent.text', text: item.text }),
            provider: 'agy', eventId: id, createdAt: Math.floor(Date.parse(item.createdAt) / 1000) || undefined });
        }
      } catch { /* A partial write is retried on the next scan. */ }
    }
    return events;
  }
  cleanup() {
    this.disposed = true; clearInterval(this.pumpTimer); clearTimeout(this.inFlightMessage?.timer);
    this.clearNoticeTimers();
    this.onInterrupt(); this.hookServer?.close(); this.screen?.dispose(); this.failQueued('session_stopped');
    if (this.attachmentDirectory) rmSync(this.attachmentDirectory, { recursive: true, force: true });
    for (const root of this.recoveredAttachmentRoots || []) rmSync(root, { recursive: true, force: true });
  }
}
