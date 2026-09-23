export function installCollaborationSchema(store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_runs (
        run_id TEXT PRIMARY KEY,
        workspace_session_id TEXT NOT NULL DEFAULT '',
        continued_from_run_id TEXT NOT NULL DEFAULT '',
        team_revision INTEGER NOT NULL DEFAULT 0,
        session_continuation INTEGER NOT NULL DEFAULT 0,
        supervisor_permission_profile TEXT NOT NULL DEFAULT 'guarded',
        supervisor_policy_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL UNIQUE,
        template_id TEXT NOT NULL,
        template_version TEXT NOT NULL,
        objective TEXT NOT NULL,
        preferences TEXT NOT NULL DEFAULT '',
        coordination_prompt TEXT NOT NULL DEFAULT '',
        workflow_template_id TEXT NOT NULL DEFAULT 'plan_implement_verify',
        workspace_mode TEXT NOT NULL DEFAULT '',
        resolved_workspace_mode TEXT NOT NULL DEFAULT '',
        coordinator_runtime TEXT NOT NULL DEFAULT '',
        planning_source TEXT NOT NULL DEFAULT 'local',
        risk_tier TEXT NOT NULL DEFAULT 'green',
        planner_role TEXT NOT NULL DEFAULT 'lead',
        plan_status TEXT NOT NULL DEFAULT 'confirmed',
        plan_revision INTEGER NOT NULL DEFAULT 0,
        plan_revision_feedback TEXT NOT NULL DEFAULT '',
        plan_json TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        revision INTEGER NOT NULL DEFAULT 1,
        phase TEXT NOT NULL DEFAULT '',
        pause_reason TEXT NOT NULL DEFAULT '',
        blocked_reason TEXT NOT NULL DEFAULT '',
        retry_of_run_id TEXT NOT NULL DEFAULT '',
        coordinator_device_id TEXT NOT NULL DEFAULT '',
        gates_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        counters_json TEXT NOT NULL,
        account_budget_blocked INTEGER NOT NULL DEFAULT 0,
        resume_state TEXT NOT NULL DEFAULT '',
        final_report_json TEXT NOT NULL DEFAULT '',
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        archived_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_workspace_sessions (
        workspace_session_id TEXT PRIMARY KEY,
        team_revision INTEGER NOT NULL DEFAULT 1,
        team_json TEXT NOT NULL,
        coordinator_device_id TEXT NOT NULL DEFAULT '',
        supervisor_permission_profile TEXT NOT NULL DEFAULT 'guarded',
        supervisor_policy_id TEXT NOT NULL DEFAULT '',
        latest_run_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_workspace_session_revisions (
        workspace_session_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        team_json TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source_run_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        rejected_at TEXT,
        PRIMARY KEY(workspace_session_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_agents (
        agent_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL,
        device_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        permission_profile TEXT NOT NULL DEFAULT '',
        approval_policy_id TEXT NOT NULL DEFAULT '',
        responsibilities_json TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role_hint TEXT NOT NULL DEFAULT '',
        planner INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        current_task_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        native_session_id TEXT NOT NULL DEFAULT '',
        originrouter_session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT NOT NULL DEFAULT '',
        lease_dispatch_key TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT NOT NULL DEFAULT '',
        last_heartbeat_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        UNIQUE(run_id, role)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_plan_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        feedback TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        superseded_at TEXT,
        PRIMARY KEY(run_id, revision),
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_task_id TEXT,
        assignee_agent_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        task_key TEXT NOT NULL DEFAULT '',
        participant_id TEXT NOT NULL DEFAULT '',
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        instructions TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'read_only',
        deliverable TEXT NOT NULL DEFAULT '',
        result_summary TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        waiting_reason TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        message_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        sender_json TEXT NOT NULL,
        recipient_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        parent_message_id TEXT,
        causation_id TEXT,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        requires_ack INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        locator TEXT NOT NULL DEFAULT '',
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_remote_assignments (
        assignment_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        phase TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        permission_profile TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        native_session_id TEXT NOT NULL DEFAULT '',
        originrouter_session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT NOT NULL DEFAULT '',
        last_heartbeat_at TEXT NOT NULL DEFAULT '',
        last_delivery_id TEXT NOT NULL DEFAULT '',
        fencing_mode TEXT NOT NULL DEFAULT 'legacy',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_remote_cancellations (
        assignment_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT 'cancelled',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_outbox (
        outbox_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        assignment_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_usage_receipts (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        sampled_tokens INTEGER NOT NULL DEFAULT 0,
        amount_micros INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT '',
        cost_source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_execution_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        sequence INTEGER NOT NULL DEFAULT 0,
        task_id TEXT NOT NULL DEFAULT '',
        participant_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'agent',
        severity TEXT NOT NULL DEFAULT 'info',
        visibility TEXT NOT NULL DEFAULT 'detail',
        summary TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        correlation_id TEXT NOT NULL DEFAULT '',
        causation_id TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_attention_items (
        attention_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        participant_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'normal',
        actions_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        UNIQUE(run_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_configuration_sessions (
        configuration_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        objective TEXT NOT NULL,
        coordinator_device_id TEXT NOT NULL,
        coordinator_runtime TEXT NOT NULL,
        request_json TEXT NOT NULL,
        capability_snapshot_json TEXT NOT NULL,
        server_configuration_id TEXT NOT NULL DEFAULT '',
        server_revision INTEGER NOT NULL DEFAULT 0,
        tool_requests_json TEXT NOT NULL DEFAULT '[]',
        server_proposal_json TEXT NOT NULL DEFAULT '{}',
        planning_source TEXT NOT NULL DEFAULT 'server_model',
        conversation_id TEXT NOT NULL DEFAULT '',
        native_session_id TEXT NOT NULL DEFAULT '',
        agent_session_id TEXT NOT NULL DEFAULT '',
        turn_count INTEGER NOT NULL DEFAULT 0,
        questions_json TEXT NOT NULL DEFAULT '[]',
        proposal_json TEXT NOT NULL DEFAULT '{}',
        fallback_reason TEXT NOT NULL DEFAULT '',
        model_error TEXT NOT NULL DEFAULT '',
        planner_invocation_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_collaboration_runs_updated ON collaboration_runs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_runs_updated_stable
        ON collaboration_runs(updated_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_messages_run ON collaboration_messages(run_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_artifacts_run ON collaboration_artifacts(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_remote_session ON collaboration_remote_assignments(originrouter_session_id);
      CREATE INDEX IF NOT EXISTS idx_collaboration_usage_run ON collaboration_usage_receipts(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_outbox_pending ON collaboration_outbox(state, updated_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_execution_run
        ON collaboration_execution_events(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_execution_participant
        ON collaboration_execution_events(run_id, participant_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_attention_run
        ON collaboration_attention_items(run_id, status, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_workspace_session_revisions
        ON collaboration_workspace_session_revisions(workspace_session_id, revision DESC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_configuration_updated
        ON collaboration_configuration_sessions(updated_at DESC);
    `);
    store.ensureColumn("collaboration_runs", "schema_version", "INTEGER NOT NULL DEFAULT 2");
    store.ensureColumn("collaboration_runs", "workspace_session_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "continued_from_run_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "team_revision", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_runs", "session_continuation", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_runs", "supervisor_permission_profile", "TEXT NOT NULL DEFAULT 'guarded'");
    store.ensureColumn("collaboration_runs", "supervisor_policy_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "revision", "INTEGER NOT NULL DEFAULT 1");
    store.ensureColumn("collaboration_runs", "phase", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "pause_reason", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "blocked_reason", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "retry_of_run_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "coordinator_device_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "final_report_json", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "last_event_sequence", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_runs", "started_at", "TEXT");
    store.ensureColumn("collaboration_agents", "originrouter_session_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "approval_policy_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "conversation_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "account_budget_blocked", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_runs", "resume_state", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "preferences", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "coordination_prompt", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "workflow_template_id", "TEXT NOT NULL DEFAULT 'plan_implement_verify'");
    store.ensureColumn("collaboration_runs", "workspace_mode", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "resolved_workspace_mode", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "coordinator_runtime", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "planning_source", "TEXT NOT NULL DEFAULT 'local'");
    store.ensureColumn("collaboration_runs", "risk_tier", "TEXT NOT NULL DEFAULT 'green'");
    store.ensureColumn("collaboration_runs", "planner_role", "TEXT NOT NULL DEFAULT 'lead'");
    store.ensureColumn("collaboration_runs", "plan_status", "TEXT NOT NULL DEFAULT 'confirmed'");
    store.ensureColumn("collaboration_runs", "plan_revision", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_configuration_sessions", "server_configuration_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_configuration_sessions", "server_revision", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_configuration_sessions", "tool_requests_json", "TEXT NOT NULL DEFAULT '[]'");
    store.ensureColumn("collaboration_configuration_sessions", "server_proposal_json", "TEXT NOT NULL DEFAULT '{}'");
    store.ensureColumn("collaboration_configuration_sessions", "planning_source", "TEXT NOT NULL DEFAULT 'server_model'");
    store.ensureColumn("collaboration_configuration_sessions", "planner_invocation_json", "TEXT NOT NULL DEFAULT '{}'");
    store.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_collaboration_runs_workspace_session
        ON collaboration_runs(workspace_session_id, created_at ASC, run_id ASC);
    `);
    store.ensureColumn("collaboration_runs", "plan_revision_feedback", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "plan_json", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_runs", "archived_at", "TEXT");
    store.ensureColumn("collaboration_usage_receipts", "amount_micros", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_usage_receipts", "currency", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_usage_receipts", "cost_source", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "attempt", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_agents", "fencing_token", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_agents", "lease_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "lease_dispatch_key", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "lease_expires_at", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "last_heartbeat_at", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "display_name", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "role_hint", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_agents", "planner", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_agents", "sort_order", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_agents", "current_task_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "task_key", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "participant_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "depends_on_json", "TEXT NOT NULL DEFAULT '[]'");
    store.ensureColumn("collaboration_tasks", "instructions", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "kind", "TEXT NOT NULL DEFAULT 'read_only'");
    store.ensureColumn("collaboration_tasks", "deliverable", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "result_summary", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "attempt", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_tasks", "waiting_reason", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_tasks", "started_at", "TEXT");
    store.ensureColumn("collaboration_tasks", "finished_at", "TEXT");
    store.ensureColumn("collaboration_remote_assignments", "attempt", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_remote_assignments", "fencing_token", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_remote_assignments", "lease_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_remote_assignments", "lease_expires_at", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_remote_assignments", "last_heartbeat_at", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_remote_assignments", "last_delivery_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_remote_assignments", "fencing_mode", "TEXT NOT NULL DEFAULT 'legacy'");
    store.ensureColumn("collaboration_execution_events", "schema_version", "INTEGER NOT NULL DEFAULT 2");
    store.ensureColumn("collaboration_execution_events", "sequence", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_execution_events", "attempt", "INTEGER NOT NULL DEFAULT 0");
    store.ensureColumn("collaboration_execution_events", "category", "TEXT NOT NULL DEFAULT 'agent'");
    store.ensureColumn("collaboration_execution_events", "severity", "TEXT NOT NULL DEFAULT 'info'");
    store.ensureColumn("collaboration_execution_events", "visibility", "TEXT NOT NULL DEFAULT 'detail'");
    store.ensureColumn("collaboration_execution_events", "payload_json", "TEXT NOT NULL DEFAULT '{}'");
    store.ensureColumn("collaboration_execution_events", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_execution_events", "causation_id", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_execution_events", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
    store.ensureColumn("collaboration_execution_events", "recorded_at", "TEXT NOT NULL DEFAULT ''");
    store.backfillExecutionSequences();
    store.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_execution_sequence
        ON collaboration_execution_events(run_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_execution_idempotency
        ON collaboration_execution_events(run_id, idempotency_key)
        WHERE idempotency_key <> '';
      CREATE INDEX IF NOT EXISTS idx_collaboration_execution_cursor
        ON collaboration_execution_events(run_id, sequence ASC);
    `);
  }
