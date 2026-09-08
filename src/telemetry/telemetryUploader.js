import { getStateDir } from "../persistence/state.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "../config/providerRoutes.js";
import { buildRunBundle } from "./runBundle.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 30_000;
const RUN_QUIESCENCE_MS = 2_000;
const MAX_ARCHIVE_BYTES = Math.max(
  1,
  Number(process.env.ORIGINROUTER_CLI_UPLOAD_MAX_BYTES) || 64 * 1024 * 1024,
);

function baseUrl() {
  return (
    process.env.ORIGINROUTER_SERVER_BASE_URL
    || process.env.ORIGINROUTER_CONTROL_BASE_URL
    || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL
  ).replace(/\/+$/, "");
}

async function authForTelemetry({ stateDir, ensureFreshAccessTokenFn }) {
  const credential = await ensureFreshAccessTokenFn({
    stateDir,
    resource: OAUTH_RESOURCES.RELAY,
  });
  const token = accessTokenFor(credential, OAUTH_RESOURCES.RELAY)?.token;
  if (!credential?.deviceId || !credential?.sessionId || !token) return null;
  return { credential, token };
}

export class TelemetryUploader {
  constructor({
    queue,
    stateDir = getStateDir(),
    fetchFn = globalThis.fetch,
    ensureFreshAccessTokenFn = ensureFreshAccessToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxArchiveBytes = MAX_ARCHIVE_BYTES,
  } = {}) {
    this.queue = queue;
    this.stateDir = stateDir;
    this.fetchFn = fetchFn;
    this.ensureFreshAccessTokenFn = ensureFreshAccessTokenFn;
    this.timeoutMs = timeoutMs;
    this.maxArchiveBytes = Math.max(1, Number(maxArchiveBytes) || MAX_ARCHIVE_BYTES);
    this.inFlight = null;
    this.timer = null;
  }

  async request(path, { expectedAccountSessionId = "", ...options } = {}) {
    if (typeof this.fetchFn !== "function") return { ok: false, error: "fetch_unavailable" };
    const auth = await authForTelemetry({
      stateDir: this.stateDir,
      ensureFreshAccessTokenFn: this.ensureFreshAccessTokenFn,
    }).catch(() => null);
    if (!auth) return { ok: false, error: "login_required" };
    if (expectedAccountSessionId && auth.credential.sessionId !== expectedAccountSessionId) {
      return { ok: false, error: "account_session_changed" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(`${baseUrl()}${path}`, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${auth.token}`,
          "X-OriginRouter-Device-Id": auth.credential.deviceId,
        },
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      this.accountSessionId = auth.credential.sessionId || "";
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, error: "request_failed" };
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    return this.request("/cli/v1/telemetry/status", { method: "GET" });
  }

  async currentAccountSessionId() {
    const auth = await authForTelemetry({
      stateDir: this.stateDir,
      ensureFreshAccessTokenFn: this.ensureFreshAccessTokenFn,
    }).catch(() => null);
    return auth?.credential?.sessionId || "";
  }

  async flush({ limit = 50 } = {}) {
    if (!this.queue) return { ok: false, error: "queue_unavailable", sent: 0 };
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._flush({ limit })
      .then((result) => {
        if (!result?.ok && !result?.blocked) this.schedule({ delayMs: RETRY_DELAY_MS, limit });
        return result;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  schedule({ delayMs = 250, limit = 50 } = {}) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush({ limit }).catch(() => {});
    }, Math.max(0, Number(delayMs) || 0));
    this.timer.unref?.();
  }

  async _flush({ limit }) {
    this.queue.prune?.();
    // Authenticate before reading the queue so an account can only ever see
    // the rows written under its own OAuth session.
    const status = await this.status();
    if (!status.ok) return { ok: false, error: status.error || "telemetry_status_failed", sent: 0 };
    const accountSessionId = this.accountSessionId || "";
    if (!accountSessionId) {
      return { ok: false, blocked: true, error: "account_session_required", sent: 0 };
    }
    this.queue.dropPostTerminalEvents?.(accountSessionId);
    const pending = this.queue.pending({ limit, accountSessionId });
    if (!pending.length) return { ok: true, sent: 0, pending: 0 };
    const excluded = pending.filter((event) => event.bundle_origin !== "collaboration_run");
    if (excluded.length) {
      this.queue.markDropped(excluded.map((event) => event.event_id), "direct_wrapper_excluded");
    }
    const eligible = pending.filter((event) => event.bundle_origin === "collaboration_run");
    if (!eligible.length) return { ok: true, sent: 0, dropped: excluded.length };
    const accountEligible = eligible.filter((event) => event.account_session_id === accountSessionId);
    if (!accountEligible.length) {
      return { ok: true, sent: 0, pending_account_session: eligible.length };
    }
    if (status.data?.data?.enabled === false || status.data?.enabled === false) {
      const dropped = accountSessionId
        ? (this.queue.dropPendingForAccount?.(accountSessionId, "privacy_disabled")
          ?? this.queue.markDropped(accountEligible.map((item) => item.event_id), "privacy_disabled"))
        : (this.queue.dropAllPending?.("privacy_disabled")
          ?? this.queue.markDropped(accountEligible.map((item) => item.event_id), "privacy_disabled"));
      return { ok: true, sent: 0, dropped, reason: "privacy_disabled" };
    }
    const serverMaxBytes = Number(status.data?.data?.max_upload_bytes);
    const maxArchiveBytes = Number.isFinite(serverMaxBytes) && serverMaxBytes > 0
      ? Math.min(this.maxArchiveBytes, Math.floor(serverMaxBytes))
      : this.maxArchiveBytes;
    const runResult = await this._flushCompletedRuns({
      maxArchiveBytes,
      accountSessionId,
    });
    if (runResult.more_pending && !runResult.waiting_for_quiescence) {
      this.schedule({ delayMs: 0, limit });
    }
    return runResult.sent > 0 || runResult.error
      ? runResult
      : { ok: true, sent: 0, pending_runs: eligible.length };
  }

  async _flushCompletedRuns({ maxArchiveBytes = this.maxArchiveBytes, accountSessionId = null } = {}) {
    if (!this.queue?.pendingRunIds) return { sent: 0 };
    let sent = 0;
    let bundles = 0;
    const terminalRunIds = this.queue.pendingTerminalRunIds
      ? this.queue.pendingTerminalRunIds({ limit: 20, accountSessionId, minIdleMs: RUN_QUIESCENCE_MS })
      : this.queue.pendingRunIds({ limit: 20, accountSessionId });
    for (const runId of terminalRunIds) {
      const events = this.queue.pendingForRun(runId, { accountSessionId });
      if (events.some((event) => event.bundle_origin !== "collaboration_run")) {
        this.queue.markDropped?.(events.map((event) => event.event_id), "direct_wrapper_excluded");
        continue;
      }
      const built = buildRunBundle(runId, events);
      if (!built.terminal) continue;
      if (built.bundle.bundle_origin !== "collaboration_run") {
        this.queue.markDropped(events.map((event) => event.event_id), "direct_wrapper_excluded");
        continue;
      }
      const archive = {
        archiveId: built.bundle.bundle_id,
        body: built.body,
        sha256: built.sha256,
        bundleCount: 1,
        eventCount: built.eventCount,
        startedAt: built.bundle.started_at_unix,
        endedAt: built.bundle.ended_at_unix,
      };
      if (archive.body.length > maxArchiveBytes) {
        this.queue.markBlocked?.(
          events.map((event) => event.event_id),
          `archive_too_large:${archive.body.length}:${maxArchiveBytes}`,
        );
        return {
          ok: false,
          blocked: true,
          sent,
          error: "archive_too_large",
          archive_bytes: archive.body.length,
          max_archive_bytes: maxArchiveBytes,
        };
      }
      const grant = await this.request("/cli/v1/telemetry/upload-grant", {
        expectedAccountSessionId: accountSessionId || "",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          archive_id: archive.archiveId,
          file_size: archive.body.length,
          sha256: archive.sha256,
          bundle_count: archive.bundleCount,
          event_count: archive.eventCount,
          started_at: archive.startedAt,
          ended_at: archive.endedAt,
        }),
      });
      if (!grant.ok) {
        this.queue.markRetry?.(events.map((event) => event.event_id), grant.error || `http_${grant.status || 0}`);
        return { ok: false, sent, error: grant.error || `http_${grant.status || 0}` };
      }
      const data = grant.data?.data || {};
      if (!data.upload_url || !data.grant || !data.upload_id) {
        this.queue.markRetry?.(events.map((event) => event.event_id), "invalid_upload_grant");
        return { ok: false, sent, error: "invalid_upload_grant" };
      }
      if (accountSessionId && await this.currentAccountSessionId() !== accountSessionId) {
        this.queue.markRetry?.(events.map((event) => event.event_id), "account_session_changed");
        return { ok: false, sent, error: "account_session_changed" };
      }
      const upload = await this._uploadArchive(data, archive);
      if (!upload.ok) {
        this.queue.markRetry?.(events.map((event) => event.event_id), upload.error || `http_${upload.status || 0}`);
        return { ok: false, sent, error: upload.error || `http_${upload.status || 0}` };
      }
      this.queue.markSent(events.map((event) => event.event_id));
      this.queue.prune?.();
      sent += events.length;
      bundles += 1;
    }
    const morePending = this.queue.pendingTerminalRunIds
      ? this.queue.pendingTerminalRunIds({ limit: 1, accountSessionId }).length > 0
      : false;
    const waitingForQuiescence = morePending && terminalRunIds.length === 0;
    if (waitingForQuiescence) {
      this.schedule({ delayMs: RUN_QUIESCENCE_MS });
    }
    return {
      ok: true,
      sent,
      bundle_count: bundles,
      more_pending: morePending,
      waiting_for_quiescence: waitingForQuiescence,
    };
  }

  async _uploadArchive(grant, built) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60_000));
    try {
      const response = await this.fetchFn(grant.upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/gzip",
          "Content-Length": String(built.body.length),
          "X-CLI-Upload-Id": grant.upload_id,
          "X-CLI-Upload-Grant": grant.grant,
          "X-CLI-SHA256": built.sha256,
        },
        body: built.body,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, data };
    } catch {
      return { ok: false, error: "archive_upload_failed" };
    } finally {
      clearTimeout(timer);
    }
  }
}
