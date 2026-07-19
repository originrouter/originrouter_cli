import { normalizeInteractionResolve } from "./agentInteractionContract.js";

const TERMINAL_STATUSES = new Set(["applied", "expired", "failed", "canceled"]);

export class PendingInteractionRegistry {
  constructor({
    onRequested = async () => {},
    onResult = async () => {},
    now = () => Date.now(),
    tombstoneTtlMs = 5 * 60 * 1000,
  } = {}) {
    this.onRequested = onRequested;
    this.onResult = onResult;
    this.now = now;
    this.tombstoneTtlMs = tombstoneTtlMs;
    this.entries = new Map();
    this.tombstones = new Map();
  }

  request(request, signal) {
    this.cleanup();
    const interactionId = request?.interactionId;
    if (!interactionId) throw new TypeError("interactionId is required");
    if (this.entries.has(interactionId)) {
      return this.entries.get(interactionId).promise;
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry = {
      request,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      status: "pending",
      responseId: null,
      resolved: null,
      createdAt: this.now(),
      expiryTimer: null,
    };
    this.entries.set(interactionId, entry);
    void this.onRequested(request);

    const expiresAtMs = Number(request?.expiresAt || 0) * 1000;
    if (expiresAtMs > 0) {
      const delay = Math.max(0, expiresAtMs - this.now());
      entry.expiryTimer = setTimeout(() => {
        const current = this.entries.get(interactionId);
        if (!current || current.status !== "pending") return;
        current.reject(new Error("interaction_expired"));
        void this.markResult(interactionId, "expired", {
          reason: "auto_resolution_timeout",
        });
      }, delay);
    }

    signal?.addEventListener("abort", () => {
      const current = this.entries.get(interactionId);
      if (!current || current.status !== "pending") return;
      current.reject(new Error("interaction_aborted"));
      void this.markResult(interactionId, "canceled", {
        reason: "native_request_aborted",
      });
    }, { once: true });
    return promise;
  }

  resolve(payload) {
    this.cleanup();
    const normalized = normalizeInteractionResolve(payload);
    const interactionId = normalized.interactionId;
    const responseId = normalized.responseId || `legacy:${interactionId}`;
    const entry = this.entries.get(interactionId);
    if (entry) {
      if (entry.status === "pending") {
        if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
        entry.status = "applying";
        entry.responseId = responseId;
        entry.resolved = { ...normalized, responseId };
        entry.resolve(entry.resolved);
        return { accepted: true, status: "applying", firstDelivery: true };
      }
      void this.onResult({
        interactionId,
        responseId,
        status: "applying",
        reason: entry.responseId === responseId ? "duplicate_response" : "already_applying",
      });
      return { accepted: true, status: "applying", firstDelivery: false };
    }

    const tombstone = this.tombstones.get(interactionId);
    if (tombstone) {
      void this.onResult({
        interactionId,
        responseId,
        status: tombstone.status,
        reason: "already_resolved",
      });
      return { accepted: true, status: tombstone.status, firstDelivery: false };
    }
    void this.onResult({
      interactionId,
      responseId,
      status: "not_found",
      reason: "interaction_not_pending",
    });
    return { accepted: false, status: "not_found", firstDelivery: false };
  }

  async markResult(interactionId, status, extra = {}) {
    if (!TERMINAL_STATUSES.has(status)) {
      throw new TypeError(`invalid interaction result status: ${status}`);
    }
    const entry = this.entries.get(interactionId);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    if (
      entry?.status === "pending"
      && ["expired", "failed", "canceled"].includes(status)
    ) {
      entry.reject(new Error(extra.reason || status));
    }
    this.entries.delete(interactionId);
    const responseId = extra.responseId || entry?.responseId || null;
    this.tombstones.set(interactionId, {
      status,
      responseId,
      expiresAt: this.now() + this.tombstoneTtlMs,
    });
    await this.onResult({
      interactionId,
      responseId,
      status,
      reason: extra.reason || "",
    });
  }

  snapshot() {
    this.cleanup();
    return [...this.entries.values()]
      .map((entry) => ({
        ...entry.request,
        status: entry.status,
      }));
  }

  async cancelAll(reason = "session_stopped") {
    for (const [interactionId, entry] of [...this.entries]) {
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
      if (entry.status === "pending") entry.reject(new Error(reason));
      await this.markResult(interactionId, "canceled", { reason });
    }
  }

  cleanup() {
    const now = this.now();
    for (const [interactionId, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(interactionId);
    }
  }
}
