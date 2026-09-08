import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const TERMINAL_RUN_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

function unixSeconds(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

function eventTerminal(event) {
  return TERMINAL_RUN_EVENTS.has(String(event?.event_type || ""));
}

export function buildRunBundle(runId, events, { accountId = 0 } = {}) {
  const ordered = [...events].sort((a, b) => {
    const time = String(a.occurred_at).localeCompare(String(b.occurred_at));
    return time || String(a.event_id).localeCompare(String(b.event_id));
  }).map((event, index) => {
    // OAuth session ownership is only a local queue guard. It must never be
    // included in the training archive.
    const { account_session_id, ...archiveEvent } = event;
    return { ...archiveEvent, event_seq: index + 1 };
  });
  const started = ordered[0]?.occurred_at || "";
  const ended = ordered.at(-1)?.occurred_at || started;
  const origins = new Set(ordered.map((event) => event.bundle_origin).filter(Boolean));
  const bundleOrigin = origins.size === 1
    ? [...origins][0]
    : /^acr_/.test(runId) ? "collaboration_run" : "direct_wrapper";
  const gatewayLinkedEventCount = ordered.filter(
    (event) => event.content_availability === "gateway_linked" || event.gateway_response_ids?.length,
  ).length;
  const delegationDetected = ordered.some((event) => (
    event.delegation_detected === true
    || event.delegation_id
    || event.parent_agent_id
    || ["subagent", "subagent_started", "subagent_stopped"].includes(event.payload?.activity)
  ));
  const runStatus = ordered.some((event) => event.event_type === "run.completed")
    ? "completed"
    : ordered.some((event) => event.event_type === "run.cancelled")
      ? "cancelled"
      : ordered.some((event) => event.event_type === "run.failed")
        ? "failed"
        : "incomplete";
  const bundle = {
    schema_version: 1,
    bundle_type: "agent_run",
    bundle_id: `bundle_${createHash("sha256")
      .update(`${runId}\n${ordered.map((event) => event.event_id).join("\n")}`)
      .digest("hex")
      .slice(0, 48)}`,
    account_id: Number(accountId) || 0,
    run_id: runId,
    bundle_origin: bundleOrigin,
    content_availability: gatewayLinkedEventCount ? "gateway_linked" : "metadata_only",
    gateway_linked_event_count: gatewayLinkedEventCount,
    delegation_detected: delegationDetected,
    started_at: started,
    ended_at: ended,
    started_at_unix: unixSeconds(started),
    ended_at_unix: unixSeconds(ended),
    run_status: runStatus,
    events: ordered,
  };
  const bytes = gzipSync(Buffer.from(`${JSON.stringify(bundle)}\n`, "utf8"));
  return {
    bundle,
    body: bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    terminal: ordered.some(eventTerminal),
    eventCount: ordered.length,
  };
}
