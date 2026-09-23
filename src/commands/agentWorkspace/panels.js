import { cwd } from "node:process";

import { workspaceModeDefinition, workspaceModeSummary } from "../../collaboration/workspaceModes.js";
import { compactRunState, runLabel } from "./runSummary.js";
import { sessionPermissionOptions, permissionLabel } from "./attentionHelpers.js";
import { findWorkspaceCommand, workspaceCommandUsage } from "../workspaceCommands.js";
import { padDisplayRight, promptDisplayWidth } from "./terminalText.js";

export function workspaceDirectoryName() {
  return cwd().split(/[\\/]/).filter(Boolean).at(-1) || cwd();
}

export function coordinatorLabel(coordinator) {
  return coordinator === "codex" ? "Codex" : "Claude Code";
}


export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  gray: "\x1b[38;5;245m",
  softGray: "\x1b[38;5;250m",
  bgSoft: "\x1b[48;5;255m",
};


export function colorEnabled() {
  return process.env.ORIGINROUTER_NO_COLOR == null && process.env.TERM !== "dumb";
}

export function styled(value, ...codes) {
  if (!colorEnabled() || codes.length === 0) return value;
  return `${codes.join("")}${value}${ANSI.reset}`;
}

export function border(value) {
  return styled(value, ANSI.gray);
}

export function muted(value) {
  return styled(value, ANSI.softGray);
}

export function strong(value) {
  return styled(value, ANSI.bold);
}

export function accent(value) {
  return styled(value, ANSI.cyan);
}

export function defaultWorkspacePanel() {
  return {
    title: "Ready for an objective",
    lines: [
      "Describe the outcome you want.",
      "Chooses the Agent team.",
      "Shift+Tab changes Session approval.",
      "/help shows commands.",
    ],
  };
}

export function helpWorkspacePanel() {
  return {
    title: "Commands",
    lines: [
      "/status - workspace settings and latest Run",
      "/runs [active|recent|all] - collaboration Runs",
      "/resume [session-id] - choose or restore a Workspace Session",
      "/pause, /retry, /cancel [run-id] - Run controls",
      "/agents [run-id] - assigned Agents and routes",
      "/mode, /approval, /team - next collaboration settings",
      "/coordinator codex|claude - preferred lead",
      "/exit - leave OriginRouter",
    ],
  };
}

export function commandHelpPanel(commandName = "") {
  const command = findWorkspaceCommand(commandName);
  if (!command) return helpWorkspacePanel();
  return {
    title: workspaceCommandUsage(command),
    lines: [
      command.description,
      command.name === "resume"
        ? "Without an ID, choose a recent Workspace Session. A Session ID restores only its latest ordered state; Run IDs cannot create a historical branch."
        : "Command arguments in brackets are optional.",
    ],
  };
}

export function workspaceStatusPanel({ coordinator, mode, sessionApproval, lastRun = null }) {
  const lines = [
    `Mode: ${workspaceModeDefinition(mode).label}`,
    `Coordinator: ${coordinatorLabel(coordinator)}`,
    `Session approval: ${permissionLabel(sessionApproval.profile, sessionApproval.policyId)}`,
  ];
  if (lastRun?.run_id) {
    if (lastRun.workspace_session_id) {
      lines.push(`Session: ${lastRun.workspace_session_id}`);
    }
    lines.push(`Latest Run: ${lastRun.run_id} · ${compactRunState(lastRun)}`);
    lines.push(runLabel(lastRun));
  } else {
    lines.push("Latest Run: none in this Workspace session");
  }
  return { title: "Workspace Status", lines };
}

export function workspaceRunsPanel({ category, runs = [], total = 0 }) {
  if (!runs.length) {
    return {
      title: "Collaboration Runs",
      lines: [`No ${category === "all" ? "" : `${category} `}Runs found.`, "Use /resume <session-id> to restore a Workspace Session."],
    };
  }
  const lines = runs.slice(0, 8).flatMap((run) => [
    `${run.run_id} · ${compactRunState(run)}`,
    ...(run.workspace_session_id ? [`  Session ${run.workspace_session_id}`] : []),
    `  ${runLabel(run)}`,
  ]);
  if (total > runs.length) lines.push(`Showing ${runs.length} of ${total} Runs.`);
  lines.push("Use /attach <run-id> to follow a Run, or /resume <session-id> to restore its Session.");
  return { title: `${category[0].toUpperCase()}${category.slice(1)} Runs`, lines };
}

export function workspaceAgentsPanel(run = {}) {
  const agents = Array.isArray(run.participants)
    ? run.participants
    : Object.values(run.agents || {});
  if (!agents.length) {
    return {
      title: "Run Agents",
      lines: [run.run_id ? `Run ${run.run_id} has no Agent assignments yet.` : "Choose a Run with /agents <run-id> or /runs."],
    };
  }
  const lines = [
    `Run ${run.run_id || "current"} · ${compactRunState(run)}`,
    ...agents.slice(0, 8).map((agent) => {
      const identity = agent.display_name || agent.role || agent.participant_id || agent.agent_id || "Agent";
      const route = agent.provider && agent.model ? `${agent.provider}/${agent.model}` : "device default route";
      return `${identity} · ${agent.runtime || "unknown"} · ${route}`;
    }),
  ];
  return { title: "Run Agents", lines };
}

export function workspaceCommandErrorPanel(message) {
  return { title: "Command unavailable", lines: [message, "Use /help to see available commands."] };
}

export function workspaceCommandSuggestionsBlock(suggestions, columns, selectedIndex = 0) {
  if (!suggestions?.length) return "";
  const width = Math.max(1, columns - 2);
  const selected = Math.max(0, Math.min(suggestions.length - 1, Number(selectedIndex) || 0));
  return suggestions.map((suggestion, index) => {
    const label = suggestion.label || workspaceCommandUsage(suggestion.command || suggestion);
    const description = suggestion.description || "";
    const prefix = index === selected ? accent("› ") : muted("  ");
    const row = `${prefix}${label}${description ? ` - ${description}` : ""}`;
    return padDisplayRight(index === selected ? strong(row) : muted(row), width);
  }).join("\n");
}

export function approvalWorkspacePanel() {
  return {
    title: "Session Approval",
    lines: sessionPermissionOptions({ includePolicies: true }).map((option) => (
      `${option.label} - ${option.description}`
    )),
  };
}

export function teamWorkspacePanel({ coordinator, mode, sessionApproval = { profile: "guarded", policyId: "" } }) {
  return {
    title: "Current Team",
    lines: [
      workspaceModeSummary(mode),
      `Coordinator: ${coordinatorLabel(coordinator)}`,
      `Session approval: ${permissionLabel(sessionApproval.profile, sessionApproval.policyId)}`,
    ],
  };
}

export function appLine(value, contentWidth) {
  return `${border("│")} ${padDisplayRight(value, contentWidth)} ${border("│")}`;
}

export function titleLine(title, frameWidth) {
  const visibleTitle = ` ${title} `;
  const remaining = Math.max(1, frameWidth - promptDisplayWidth(visibleTitle) - 2);
  return `${border("╭─")}${strong(visibleTitle)}${border("─".repeat(remaining))}${border("╮")}`;
}

export function bottomLine(frameWidth) {
  return `${border("╰")}${border("─".repeat(frameWidth - 2))}${border("╯")}`;
}

export function metricRow(label, value, width) {
  const labelWidth = 9;
  const visible = `${padDisplayRight(label, labelWidth)} ${value}`;
  return padDisplayRight(visible, width);
}

export function panelRow(value, width, { heading = false } = {}) {
  const text = padDisplayRight(value, width);
  if (heading) return strong(text);
  if (String(value).startsWith("/")) return accent(text);
  return muted(text);
}
