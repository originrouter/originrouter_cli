# Agent unattended execution

OriginRouter keeps unattended execution as a transient, session-scoped CLI
policy. The application server relays policy changes but does not store the
policy in MySQL and does not make approval decisions.

## Profiles

| Profile | Automatic decisions | Still blocks |
| --- | --- | --- |
| `manual` | None | Every permission, confirmation, question, form, and URL request |
| `guarded` | Plan continuation, read tools, workspace file changes, and routine commands running inside the session working directory | Destructive commands, privilege/system commands, deployment or remote mutation, extra Codex sandbox/network permissions, paths outside the workspace, secret-bearing requests, questions, forms, and URL/OAuth flows |
| `unrestricted` | Every `permission` and `confirm` request for this OriginRouter session, plus an unambiguous single-choice Continue/Cancel or Yes/No question | Ambiguous questions, forms, URL/OAuth flows, and requests marked as containing secrets because OriginRouter cannot invent valid user input |
| `custom` | Only scopes explicitly selected by CLI or App | Every scope not selected, plus the permanently interactive request families below |

`unrestricted` does not grant a machine-global permission. The policy exists
only in the active OriginRouter wrapper process and disappears when the
session exits.

Start a session with a profile:

```bash
originrouter claude --originrouter-autonomy guarded
originrouter claude-terminal --originrouter-autonomy unrestricted
originrouter codex-terminal --originrouter-autonomy guarded
```

`--originrouter-auto-approve` is an alias for guarded mode.

## Custom allow-list

Use one or more `--originrouter-auto-allow` flags to start a custom session
allow-list. Providing this flag without an explicit profile selects `custom`:

```bash
originrouter claude \
  --originrouter-auto-allow plan_continue,read_tools \
  --originrouter-auto-allow workspace_edits,workspace_commands

originrouter codex-terminal \
  --originrouter-autonomy custom \
  --originrouter-auto-allow read_tools,workspace_edits
```

`--originrouter-auto-allow` cannot be combined with `manual`, `guarded`, or
`unrestricted`; omit `--originrouter-autonomy` or set it to `custom`.

Available scopes:

| Scope | Meaning | Risk |
| --- | --- | --- |
| `plan_continue` | Implement a plan or continue a confirmation step | Normal |
| `explicit_continue_questions` | Answer only an unambiguous Continue/Cancel or Yes/No question | Normal |
| `read_tools` | File reads, listing, search, and read-only web tools | Normal |
| `workspace_edits` | Create or modify files inside the current workspace | Normal |
| `workspace_commands` | Run commands in the workspace that are not classified into a higher-risk scope | Normal |
| `additional_permissions` | Extra filesystem/network sandbox grants | High |
| `destructive_commands` | Deletion, destructive Git, disk, or destructive database commands | High |
| `elevated_commands` | sudo, service control, container orchestration, and infrastructure tools | High |
| `network_mutations` | SSH/SCP, pushes, releases, and mutating HTTP requests | High |
| `outside_workspace` | File changes or commands outside the active workspace | High |
| `unknown_tools` | Permission requests that cannot be classified | High |

The App exposes the same list under `Unattended execution > Custom`. Scope
changes are sent to the active CLI session over the local-direct channel when
available and through relay otherwise.

Scopes are session-local and are not persisted by the application server.
Forms, URL/OAuth flows, secret-bearing requests, and ambiguous questions remain
interactive even if every scope is selected.

## Blocking event coverage

### Claude Code

- Tool `PermissionRequest`: commands, file changes, network tools, and other
  protected tool calls. Supported by managed Claude and the native Claude TUI
  through the local Hook server.
- `ExitPlanMode`: represented as a `confirm` interaction. Guarded and full
  profiles continue the plan automatically.
- `AskUserQuestion`: represented as structured questions. Full mode can answer
  only a single unambiguous Continue/Cancel or Yes/No choice; all other
  questions remain interactive.
- MCP elicitation: forms and URL flows always remain interactive. Secret
  schema fields are explicitly marked and never auto-filled.

### Codex

- Managed app-server command execution and file-change approvals are
  represented as `permission` interactions.
- Additional filesystem/network sandbox grants are manual in guarded mode and
  automatic only in full mode.
- `item/tool/requestUserInput` questions and MCP elicitation remain
  interactive.
- Native Codex TUI mirroring cannot attach to Codex app-server's blocking
  approval channel. It reports `autonomyControl=unsupported`; use
  `originrouter codex-terminal` when unattended approval control is required.

## Wire events

- App to CLI: `agent.autonomy.set { sessionId, profile, allowedScopes, requestId }`
- CLI to App: `agent.autonomy.status` with the effective and available scope lists
- Audit/activity: `agent.interaction.auto_resolved`

The App prefers the local management API when the device is reachable and
uses the existing relay path otherwise. Both paths change the same in-memory
CLI policy.
