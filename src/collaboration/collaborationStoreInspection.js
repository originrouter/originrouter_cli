import { derivedAttentionItems, runViewState, taskViewState } from "./collaborationView.js";
import { iso, parseJson, safeText } from "./collaborationStorePrimitives.js";

export function getSnapshot(store, runId) {
    const run = store.getRun(runId, { includeMessages: false });
    if (!run) return null;
    const projected = runViewState(run.state);
    const completedKeys = new Set(run.tasks.filter((task) => task.state === "completed")
      .map((task) => task.task_key).filter(Boolean));
    const tasks = run.tasks.map((task) => ({
      ...task,
      legacy_state: task.state,
      state: taskViewState(task, completedKeys),
    }));
    const storedAttention = store.listAttention(run.run_id, { status: "pending" });
    const derived = derivedAttentionItems(run)
      .filter((item) => !storedAttention.some((stored) => stored.kind === item.kind));
    const attention = [...storedAttention, ...derived];
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(projected.state);
    const retryableTask = tasks.some((task) =>
      ["failed", "cancelled", "blocked", "paused"].includes(task.state),
    );
    return {
      schema_version: 2,
      revision: Number(run.revision || 0),
      last_sequence: Number(run.last_event_sequence || 0),
      run: {
        ...run,
        legacy_state: run.state,
        state: projected.state,
        phase: run.phase || projected.phase,
        pause_reason: run.pause_reason || projected.pauseReason || null,
        blocked_reason: run.blocked_reason || projected.blockedReason || null,
        tasks: undefined,
        agents: undefined,
        artifacts: undefined,
      },
      plan: run.plan,
      tasks,
      participants: Object.entries(run.agents).map(([participantId, participant]) => ({
        participant_id: participantId,
        ...participant,
      })),
      attention,
      artifacts: run.artifacts,
      budget: run.budget,
      usage: run.usage,
      final_report: run.final_report,
      capabilities: {
        can_confirm_plan: projected.state === "awaiting_confirmation",
        can_resolve_approval: attention.some((item) =>
          item.status === "pending" && Array.isArray(item.actions) && item.actions.length > 0,
        ),
        can_pause: ["queued", "running", "blocked"].includes(projected.state),
        can_resume: projected.state === "paused",
        can_cancel: !terminal,
        can_retry_task: !terminal && retryableTask,
        can_retry_run: ["failed", "cancelled", "expired"].includes(projected.state),
        can_change_budget: !terminal,
        can_archive: terminal && !run.archived_at,
        can_delete: terminal,
        can_view_diagnostics: true,
      },
    };
  }

export function getDiagnostics(store, runId) {
    const snapshot = store.getSnapshot(runId);
    if (!snapshot) return null;
    const key = safeText(runId, 195);
    const count = (table, extra = "") => Number(store.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ? ${extra}`,
    ).get(key)?.count || 0);
    const errorEvents = store.db.prepare(`
      SELECT sequence, type, category, severity, payload_json, created_at
      FROM collaboration_execution_events
      WHERE run_id = ? AND severity IN ('warning','error')
      ORDER BY sequence DESC LIMIT 20
    `).all(key).map((row) => {
      const payload = parseJson(row.payload_json, {});
      return {
        sequence: Number(row.sequence || 0),
        type: row.type,
        category: row.category,
        severity: row.severity,
        diagnostic_code: safeText(
          payload.diagnostic_code ?? payload.diagnosticCode ?? payload.code ?? payload.reason,
          96,
        ) || null,
        created_at: row.created_at,
      };
    });
    return {
      schema_version: 1,
      generated_at: iso(store.now()),
      run: {
        run_id: snapshot.run.run_id,
        schema_version: snapshot.schema_version,
        revision: snapshot.revision,
        state: snapshot.run.state,
        legacy_state: snapshot.run.legacy_state,
        phase: snapshot.run.phase,
        connection: snapshot.run.connection,
        coordinator_device_id: snapshot.run.coordinator_device_id,
        created_at: snapshot.run.created_at,
        updated_at: snapshot.run.updated_at,
        started_at: snapshot.run.started_at,
        finished_at: snapshot.run.finished_at,
      },
      counts: {
        participants: snapshot.participants.length,
        tasks: snapshot.tasks.length,
        pending_attention: snapshot.attention.filter((item) => item.status === "pending").length,
        events: count("collaboration_execution_events"),
        artifacts: count("collaboration_artifacts"),
        remote_assignments: count("collaboration_remote_assignments"),
        pending_outbox: count("collaboration_outbox", "AND state NOT IN ('delivered','cancelled')"),
      },
      participants: snapshot.participants.map((participant) => ({
        participant_id: participant.participant_id,
        runtime: participant.runtime,
        device_id: participant.device_id,
        status: participant.status,
        attempt: participant.attempt,
        has_session: Boolean(participant.originrouter_session_id),
        lease_expires_at: participant.lease_expires_at || null,
        last_heartbeat_at: participant.last_heartbeat_at || null,
      })),
      recent_warnings_and_errors: errorEvents,
      database_integrity: store.db.pragma("quick_check", { simple: true }),
    };
  }
