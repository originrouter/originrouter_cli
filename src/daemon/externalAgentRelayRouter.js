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
  constructor({ registry, relayClient, targetDeviceForSession = null }) {
    this.registry = registry;
    this.relayClient = relayClient;
    this.targetDeviceForSession = targetDeviceForSession;
  }

  async handle(payload) {
    if (!payload || typeof payload !== "object") return false;

    if (payload.type === "agent.interactions.snapshot.request") {
      const requested = Array.isArray(payload.sessionIds)
        ? payload.sessionIds
        : [];
      const sessionIds = requested.filter((sessionId) =>
        this.registry.has(sessionId),
      );
      for (const sessionId of sessionIds) {
        await this.relayClient.send("agent.interactions.snapshot", {
          sessionId,
          requestId: payload.requestId,
          ...withoutUndefined(this.registry.controlSnapshot(sessionId)),
        });
      }
      return sessionIds.length > 0;
    }

    const sessionId = String(payload.sessionId || "").slice(0, 64);
    if (!sessionId || !this.registry.has(sessionId)) return false;

    if (payload.type === "agent.history.request") {
      const history = this.registry.history(sessionId, {
        beforeCursor: payload.beforeCursor,
        limit: payload.limit,
      });
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

  async forwardRegistryNotification(notification) {
    if (notification?.type !== "event") return false;
    const event = notification.payload;
    const sessionId = String(
      notification.sessionId || event?.sessionId || "",
    ).slice(0, 64);
    if (!sessionId || !event || typeof event !== "object") return false;
    const targetDeviceId = String(
      this.targetDeviceForSession?.(sessionId) || "",
    ).slice(0, 191);
    const route = targetDeviceId ? { targetDeviceId } : {};

    if (DIRECT_APP_EVENT_TYPES.has(event.type)) {
      await this.relayClient.send(
        event.type,
        withoutUndefined({ ...event, sessionId, ...route }),
      );
      return true;
    }
    const { sessionId: _eventSessionId, ...eventWithoutSessionId } = event;
    await this.relayClient.send("agent.stream.event", {
      sessionId,
      ...route,
      event: withoutUndefined(eventWithoutSessionId),
    });
    return true;
  }
}
