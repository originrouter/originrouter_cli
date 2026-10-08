const DIRECT_APP_EVENT_TYPES = new Set([
  "agent.interaction.requested",
  "agent.interaction.result",
  "agent.message.result",
]);

const SESSION_COMMAND_TYPES = new Set([
  "agent.message",
  "terminal.input",
  "terminal.resize",
  "terminal.interrupt",
  "agent.interaction.resolve",
  "agent.mode.set",
  "agent.autonomy.set",
  "session.stop",
]);

function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : withoutUndefined(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    );
  }
  return value;
}

export class ExternalAgentRelayRouter {
  constructor({ registry, relayClient, targetDeviceForSession = null, isCollaborationSession = null }) {
    this.registry = registry;
    this.relayClient = relayClient;
    this.targetDeviceForSession = targetDeviceForSession;
    this.isCollaborationSession = isCollaborationSession;
  }

  async handle(payload) {
    if (!payload || typeof payload !== "object") return false;

    if (payload.type === "agent.interactions.snapshot.request") {
      const requested = Array.isArray(payload.sessionIds)
        ? payload.sessionIds
        : [];
      const sessionIds = requested.filter((sessionId) =>
        this.registry.has(sessionId)
        && this.isCollaborationSession?.(sessionId) !== true,
      );
      // One subscribe names every session the App knows about — dozens of
      // them — and each snapshot used to be its own awaited send. Those sends
      // are independent (each names a different session's route), so awaiting
      // them in sequence bought nothing and cost the sum of every round trip:
      // a 40-session subscribe spent seconds here, and because the App paints
      // once per snapshot the user watched the conversation flicker through
      // "syncing" and back for each one. They are not order-coupled, so they
      // go out together.
      //
      // One snapshot is self-contained: a failure to build or send it must
      // not cancel the others, so each is settled rather than awaited.
      await Promise.allSettled(sessionIds.map(async (sessionId) => {
        await this.relayClient.send("agent.interactions.snapshot", {
          sessionId,
          requestId: payload.requestId,
          ...withoutUndefined(this.registry.controlSnapshot(sessionId)),
        });
      }));
      return sessionIds.length > 0;
    }

    const sessionId = String(payload.sessionId || "").slice(0, 64);
    if (!sessionId || !this.registry.has(sessionId)) return false;
    // Ordinary Agent controls are intentionally unavailable for collaboration
    // workers. The collaboration runtime owns their command path and projects
    // results through the collaboration conversation.
    if (this.isCollaborationSession?.(sessionId) === true) return false;

    if (payload.type === "agent.history.request") {
      let history;
      try {
        history = this.registry.history(sessionId, {
          beforeCursor: payload.beforeCursor,
          limit: payload.limit,
        });
      } catch {
        const session = this.registry
          .list?.()
          .find((item) => item.session_id === sessionId);
        history = {
          messages: [],
          nextCursor: null,
          hasMore: false,
          conversationId: session?.conversation_id,
          nativeSessionId: session?.native_session_id,
        };
      }
      await this.relayClient.send("agent.history.page", {
        sessionId,
        requestId: payload.requestId,
        ...withoutUndefined(history),
      });
      return true;
    }

    if (!SESSION_COMMAND_TYPES.has(payload.type)) return false;
    this.registry.enqueueCommand(sessionId, payload);
    return true;
  }

  /**
   * Publish the CLI's attachment facts for a session to the cloud.
   *
   * Attachment (is the Agent process here?) is a different axis from the turn
   * status (is it working?). The cloud mirrors both; it must not synthesise
   * either from the other. This is what keeps a session that stopped locally
   * from being resurrected by a later heartbeat.
   */
  async forwardAttachment(notification, { attached, detachedAt = null } = {}) {
    const sessionId = String(notification?.sessionId || "").slice(0, 64);
    if (!sessionId) return false;
    if (this.isCollaborationSession?.(sessionId) === true) return false;
    const session = this.registry?.attachmentOf?.(sessionId)
      || notification?.payload?.session
      || null;
    if (!session) return false;
    const payload = withoutUndefined({
      sessionId,
      attached: attached === true,
      attachedAt: session.attached_at || session.attachedAt || null,
      detachedAt: detachedAt || session.detached_at || session.detachedAt || null,
      lastActivityAt:
        session.last_activity_at || session.lastActivityAt || null,
    });
    const targetDeviceId = String(
      this.targetDeviceForSession?.(sessionId) || "",
    ).slice(0, 191);
    await this.relayClient.send("agent.session.presence", {
      ...payload,
      ...(targetDeviceId ? { targetDeviceId } : {}),
    });
    return true;
  }

  async forwardRegistryNotification(notification) {
    const notificationType = notification?.type;
    if (notificationType === "registered") {
      return this.forwardAttachment(notification, { attached: true });
    }
    if (notificationType === "unregistered") {
      const detachedAt = notification?.payload?.detachedAt
        || notification?.payload?.session?.detached_at
        || null;
      return this.forwardAttachment(notification, { attached: false, detachedAt });
    }
    if (notificationType === "updated") {
      // An `updated` notification carrying an explicit attach/detach flag is a
      // lifecycle transition (e.g. stale expiry). Plain updates are turn
      // telemetry and stay out of the presence channel unless they carry one.
      if (notification?.payload?.attached === true) {
        return this.forwardAttachment(notification, { attached: true });
      }
      if (notification?.payload?.attached === false) {
        const detachedAt = notification?.payload?.detachedAt || null;
        return this.forwardAttachment(notification, { attached: false, detachedAt });
      }
      return false;
    }
    if (notificationType !== "event") return false;
    const event = notification.payload;
    const sessionId = String(
      notification.sessionId || event?.sessionId || "",
    ).slice(0, 64);
    if (!sessionId || !event || typeof event !== "object") return false;
    // Do not duplicate collaboration worker events into the ordinary Agent
    // stream. CollaborationRuntime delivers them to the matching run/page.
    if (this.isCollaborationSession?.(sessionId) === true) return false;
    const targetDeviceId = String(
      this.targetDeviceForSession?.(sessionId) || "",
    ).slice(0, 191);
    const route = targetDeviceId ? { targetDeviceId } : {};

    // Ordinary Agent sessions are broadcast to every subscribed App. A
    // targeted visible session is delivered to its target and other active
    // subscribers by the E2EE transport.
    const send = targetDeviceId && typeof this.relayClient.sendTargetedAndSubscribers === "function"
      ? (type, payload) => this.relayClient.sendTargetedAndSubscribers(
        type,
        payload,
        { targetDeviceId, routeKey: sessionId },
      )
      : targetDeviceId
      ? (type, payload) => this.relayClient.send(type, payload)
      : typeof this.relayClient.sendBroadcast === "function"
      ? (type, payload) => this.relayClient.sendBroadcast(type, payload, { routeKey: sessionId })
      : (type, payload) => this.relayClient.send(type, payload);
    if (DIRECT_APP_EVENT_TYPES.has(event.type)) {
      await send(
        event.type,
        withoutUndefined({ ...event, sessionId, ...route }),
      );
      return true;
    }
    const { sessionId: _eventSessionId, ...eventWithoutSessionId } = event;
    await send("agent.stream.event", {
      sessionId,
      ...route,
      event: withoutUndefined(eventWithoutSessionId),
    });
    return true;
  }
}
