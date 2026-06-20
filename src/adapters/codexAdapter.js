import { TerminalAdapter } from "./terminalAdapter.js";
import { CodexAppServerClient, isCodexAppServerAvailable } from "./codex/appServerClient.js";
import { mapCodexAppServerEvent, mapCodexApprovalRequest } from "./codex/eventMapper.js";
import { CODEX_MAIN_ALIAS } from "../config/routes.js";
import {
  permissionEventToInteraction,
  INTERACTION_SOURCES,
} from "../runtime/agentInteractionContract.js";

// Stage 8.0: detect any of the four forms a user might pass to set the
// Codex model directly on the CLI: --model X, --model=X, -m X, -m=X.
// If present, we warn and pass args through unchanged (the user's value
// takes precedence). Otherwise we inject --model <CODEX_MAIN_ALIAS> so
// Codex Code's model lookup hits the local LiteLLM proxy alias, which
// routes.codex.main routes to the configured upstream.
function userProvidedModel(args) {
  for (const a of args) {
    if (a === "--model" || a === "-m") return true;
    if (a.startsWith("--model=") || a.startsWith("-m=")) return true;
  }
  return false;
}

export class CodexAdapter extends TerminalAdapter {
  constructor({ args = [], appServerClient: appServerClientOverride = null, appServerAvailable: appServerAvailableOverride = null } = {}) {
    super({ command: "codex", args });
    this.kind = "codex";
    this.pendingEvents = [];
    this.pendingApprovals = new Map();
    this.appServerClient = null;
    // Stage 8.9: test seams. If a caller passes an explicit
    // appServerAvailable flag, use it and skip the system probe. If
    // a caller passes a custom appServerClient, use it (the probe is
    // still performed only to set the boolean — it does not
    // actually open a process when an override is provided). The
    // default behaviour (no overrides) is unchanged.
    this.appServerAvailable = appServerAvailableOverride;
    this.appServerClientOverride = appServerClientOverride;
  }

  describe() {
    return {
      ...super.describe(),
      adapter: this.kind,
      // Stage 8.4: gate structuredSources on the app-server path so the
      // relay doesn't claim "codex-app-server" is one of the sources
      // when we fell back to terminal-only.
      structuredSources: this.appServerAvailable
        ? ["codex-app-server", "terminal-output"]
        : ["terminal-output"],
      // Stage 8.4: top-level runtime tag. `"codex-app-server"` when
      // the structured app-server path is active, `null` otherwise.
      // The relay/UI uses this to label the session; the session log
      // also writes the same value (src/local/localAgentSession.js).
      runtime: this.appServerAvailable ? "codex-app-server" : null,
    };
  }

  buildLaunch() {
    let args = this.args.slice();
    if (!userProvidedModel(args)) {
      // Stage 8.0: routes.codex.main is the source of truth. Inject the
      // fixed alias so Codex Code's model lookup hits the local LiteLLM
      // proxy, which renders originrouter-codex-model from the configured
      // upstream provider.
      args = ["--model", CODEX_MAIN_ALIAS, ...args];
    } else {
      process.stderr.write(
        "warning: --model passed on the command line; it bypasses routes.codex.main.\n" +
        "Use `originrouter route set codex.main --provider <name> --model <model>` instead.\n",
      );
    }
    return {
      command: "codex",
      args,
      // Defensive fallback for clients that ignore --model.
      env: { OPENAI_MODEL: CODEX_MAIN_ALIAS },
    };
  }

  handleOutput(data) {
    const events = [];
    if (data.includes("approval") || data.includes("permission")) {
      events.push({ type: "agent.possible_permission", provider: "codex", text: data });
    }
    return events;
  }

  async beforeStart({ sessionId, cwd, env }) {
    // Stage 8.9: capture sessionId for dual-emit. The Codex event
    // mapper never sees sessionId; the adapter enriches here.
    this.sessionId = sessionId ?? null;
    // Stage 8.9: skip the system probe when the caller passed an
    // explicit appServerAvailable override (test seam). The
    // production default still probes via isCodexAppServerAvailable.
    if (this.appServerAvailable === null) {
      this.appServerAvailable = await isCodexAppServerAvailable();
    }
    if (!this.appServerAvailable) {
      this.pendingEvents.push({
        type: "agent.adapter.status",
        provider: "codex",
        appServerAvailable: false,
        message: "codex app-server is not available; falling back to terminal adapter events.",
      });
      return;
    }

    this.appServerClient = this.appServerClientOverride || new CodexAppServerClient();
    this.appServerClient.onEvent((event) => {
      // Stage 8.4: when the app-server process exits, deny any UI
      // permission cards that were waiting on its response. The
      // app-server client only owns the JSON-RPC response-timer side;
      // the outer promise returned to the UI lives here in
      // pendingApprovals. We resolve them BEFORE running the mapper
      // so the relay sees the per-card denial first, then the
      // adapter.status event that summarises the session end.
      if (event.type === "codex.app_server.exit" || event.type === "codex.app_server.force_kill") {
        for (const [callId, pending] of this.pendingApprovals) {
          pending.resolve("denied");
          this.pendingEvents.push({
            type: "agent.permission.resolved",
            provider: "codex",
            callId,
            decision: "denied",
            reason: "app_server_exit",
          });
        }
        this.pendingApprovals.clear();
      }
      this.pendingEvents.push(...mapCodexAppServerEvent(event));
    });
    this.appServerClient.onApproval((request) => {
      const legacy = mapCodexApprovalRequest(request);
      // Stage 8.9: dual-emit. Legacy first (the relay expects it),
      // then the new agent.interaction.requested envelope for the
      // App card model. pendingApprovals is keyed by callId, which
      // equals interactionId.
      this.pendingEvents.push(legacy);
      if (this.sessionId != null) {
        try {
          const interaction = permissionEventToInteraction(legacy, {
            source: INTERACTION_SOURCES.APP_SERVER,
            runtime: this.appServerAvailable ? "codex-app-server" : null,
            sessionId: this.sessionId,
            createdAt: Date.now(),
          });
          this.pendingEvents.push(interaction);
        } catch (err) {
          console.error(`[codexAdapter] dual-emit failed: ${err.message}`);
        }
      }
      return new Promise((resolve) => {
        this.pendingApprovals.set(legacy.callId, {
          resolve,
          createdAt: Date.now(),
          request,
        });
      });
    });
    await this.appServerClient.connect({ cwd, env });
    this.pendingEvents.push({
      type: "agent.adapter.status",
      provider: "codex",
      appServerAvailable: true,
    });
  }

  scanStructuredEvents() {
    return this.pendingEvents.splice(0);
  }

  resolvePermission({ callId, interactionId, decision, reason }) {
    // Stage 8.9: accept interactionId as an alias for callId so the
    // new agent.interaction.resolve envelope (which carries
    // interactionId) flows through the same pendingApprovals map.
    // The map is keyed by the same string either way.
    const key = callId || interactionId;
    const pending = this.pendingApprovals.get(key);
    if (!pending) {
      this.pendingEvents.push({
        type: "agent.permission.resolve.error",
        provider: "codex",
        callId: key,
        message: "No pending Codex approval found for this id.",
      });
      return;
    }

    this.pendingApprovals.delete(key);
    pending.resolve(decision || "denied");
    this.pendingEvents.push({
      type: "agent.permission.resolved",
      provider: "codex",
      callId: key,
      decision: decision || "denied",
      reason: reason || undefined,
    });
  }

  cleanup() {
    for (const [callId, pending] of this.pendingApprovals) {
      pending.resolve("denied");
      this.pendingEvents.push({
        type: "agent.permission.resolved",
        provider: "codex",
        callId,
        decision: "denied",
        reason: "adapter cleanup",
      });
    }
    this.pendingApprovals.clear();
    this.appServerClient?.disconnect();
  }
}
