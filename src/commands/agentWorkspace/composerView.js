import { WORKSPACE_MODES } from "../../collaboration/workspaceModes.js";
import { INTERACTION_SURFACES } from "./interactionState.js";
import { fitDisplayText, padDisplayRight, promptDisplayWidth, wrapDisplayText } from "./terminalText.js";
import { accent, muted, strong } from "./panels.js";
import {
  attentionActionLabel,
  attentionParticipantLabel,
  attentionReplyPrompt,
  attentionRequestContext,
  attentionRequestKind,
  permissionLabel,
  sessionPermissionOptions,
} from "./attentionHelpers.js";
import { runtimePhase } from "./runtimeRows.js";

function composerStatus(columns, runtime = null) {
  const profile = runtime?.sessionApprovalOverride?.profile
    || runtime?.snapshot?.run?.supervisor_permission_profile
    || runtime?.configuration?.supervisor_permission_profile
    || "guarded";
  const policyId = runtime?.sessionApprovalOverride?.policyId
    || runtime?.snapshot?.run?.supervisor_policy_id
    || runtime?.configuration?.supervisor_policy_id
    || "";
  if (!runtime) {
    const status = `● ${permissionLabel(profile, policyId).toLowerCase()} · session approval`;
    return `${" ".repeat(Math.max(0, columns - promptDisplayWidth(status) - 2))}${accent(status)}  `;
  }
  const status = `● ${runtimePhase(runtime)} · Esc to interrupt`;
  return padDisplayRight(accent(`  ${status}`), columns);
}

function runtimeComposer(runtime, columns) {
  return composerLine(
    runtime.composerBuffer || "",
    runtime.composerCursor,
    columns,
    runtime.composerPastes,
  );
}

function composerLine(value, cursor, columns, pendingPastes = []) {
  const chars = [...String(value || "")];
  const boundedCursor = Math.max(0, Math.min(
    Number.isInteger(cursor) ? cursor : chars.length,
    chars.length,
  ));
  const pasteLabels = new Map(
    (pendingPastes || []).map((paste) => [paste.token, paste.label]),
  );
  const displayChars = chars.map((char) => pasteLabels.get(char) || (char === "\t" ? "  " : char));
  const tokens = [
    ...displayChars.slice(0, boundedCursor),
    "▌",
    ...displayChars.slice(boundedCursor),
  ].flatMap((token) => [...token]);
  const lineWidth = Math.max(3, columns - 1);
  const prefix = "› ";
  const continuationPrefix = "  ";
  const lines = [];
  let line = prefix;
  let width = promptDisplayWidth(prefix);

  for (const token of tokens) {
    if (token === "\n") {
      lines.push(line);
      line = continuationPrefix;
      width = promptDisplayWidth(continuationPrefix);
      continue;
    }
    const tokenWidth = promptDisplayWidth(token);
    if (width > promptDisplayWidth(prefix) && width + tokenWidth > lineWidth) {
      lines.push(line);
      line = continuationPrefix;
      width = promptDisplayWidth(continuationPrefix);
    }
    line += token;
    width += tokenWidth;
  }
  lines.push(line);

  return lines
    .map((item) => padDisplayRight(strong(item), columns))
    .join("\n");
}

function runtimePathComposer(runtime, columns) {
  let value = runtime.composerBuffer || "";
  if (runtime.phase === "needs_setup") {
    const selected = runtime.setupMode === "path"
      ? null
      : runtime.setup?.workspaces?.[runtime.setupSelection || 0];
    value = selected?.canonical_path || runtime.setupPath || runtime.setup?.default_path || "";
  }
  const prompt = `› ${value}`;
  return padDisplayRight(strong(fitDisplayText(prompt, Math.max(1, columns - 1))), columns);
}

function wrappedInteractionLines(lines, columns, maxLines = 16) {
  const width = Math.max(1, columns - 1);
  const rendered = [];
  for (const line of lines) {
    for (const row of wrapDisplayText(line, width).slice(0, 3)) {
      rendered.push(padDisplayRight(strong(fitDisplayText(row, width)), columns));
      if (rendered.length >= maxLines) return rendered.join("\n");
    }
  }
  return rendered.join("\n");
}

function interactionComposer(runtime, columns, {
  surface = INTERACTION_SURFACES.INLINE,
  maxRows = Number.POSITIVE_INFINITY,
} = {}) {
  const focusedInteraction = surface === INTERACTION_SURFACES.FOCUSED;
  const kind = runtime.interactionKind;
  let lines;
  if (kind === "device") {
    lines = [
      "? Which remote devices should participate?",
      "↑/↓ move · Space toggle · Enter confirm · A select all",
      "Esc cancel",
    ];
  } else if (kind === "workspace") {
    lines = [
      "? Choose a ready workspace",
      "↑/↓ select · Enter confirm · P or typing enters a folder not listed",
      "Esc cancel",
    ];
  } else if (kind === "setup") {
    const path = String(runtime.setupPath || "");
    const pathChars = [...path];
    const pathCursor = Math.max(0, Math.min(
      Number.isInteger(runtime.setupCursor) ? runtime.setupCursor : pathChars.length,
      pathChars.length,
    ));
    const pathWithCursor = path
      ? `${pathChars.slice(0, pathCursor).join("")}▌${pathChars.slice(pathCursor).join("")}`
      : "▌";
    lines = [
      runtime.setup?.remote
        ? "? Enter a folder path to request from the target device"
        : "? Enter a folder path to authorize",
      path
        ? `› ${pathWithCursor}`
        : `› ${pathWithCursor}  ${muted(`example: ${runtime.setup?.default_path || "/path/to/workspace"}`)}`,
      runtime.setup?.workspaces?.length
        ? "Tab completes · ↑/↓ suggestions · Enter authorize · Esc back"
        : "Tab completes · ↑/↓ suggestions · Enter authorize · Esc cancels",
    ];
  } else if (kind === "configuration") {
    lines = [
      "? Use this collaboration team?",
      "↑/↓ select an Agent · E edit selection · Enter confirm · PgUp/PgDn review · Esc return",
    ];
  } else if (kind === "configuration_question") {
    const question = runtime.configurationQuestion || {};
    const answer = String(runtime.decisionBuffer || "");
    const answerChars = [...answer];
    const answerCursor = Math.max(0, Math.min(runtime.decisionCursor || 0, answerChars.length));
    const progress = runtime.configurationQuestionCount > 1
      ? ` · ${Number(runtime.configurationQuestionIndex || 0) + 1}/${runtime.configurationQuestionCount}`
      : "";
    lines = [
      `? ${question.header || "Planner question"}${progress}`,
      question.question || "Provide the missing collaboration context.",
      ...(question.options || []).map((option, index) => (
        `${index + 1}. ${option.label}${option.description ? ` · ${option.description}` : ""}`
      )),
      composerLine(answer, answerCursor, columns),
      "Enter submits · type an option number/label or another answer · Ctrl+U clears · Esc cancels",
    ];
  } else if (kind === "team_edit") {
    lines = [
      "? Edit an Agent, or finish editing",
      "↑/↓ select · Enter Runtime/model · P Agent limit · S Session approval · D done",
    ];
  } else if (kind === "team_runtime") {
    lines = [
      "? Choose the Agent Runtime",
      "↑/↓ select · Enter continue to model route · Esc back",
    ];
  } else if (kind === "team_route") {
    lines = [
      "? Choose the model route",
      "↑/↓ select · Enter save Agent · Esc back to Runtime",
    ];
  } else if (kind === "team_permission") {
    lines = [
      "? Choose this Agent's access policy",
      "↑/↓ select · Enter save access · Esc back",
    ];
  } else if (kind === "team_session_permission") {
    lines = [
      "? Choose the Session approval policy",
      "↑/↓ select · Enter save Session approval · Esc back",
    ];
  } else if (kind === "live_session_permission") {
    const options = runtime.sessionPermissionOptions || sessionPermissionOptions({ includePolicies: true });
    const selected = Math.max(0, Math.min(
      Math.max(0, options.length - 1),
      Number(runtime.teamSessionPermissionSelection) || 0,
    ));
    lines = [
      "? Change Session approval now?",
      ...options.map((option, index) => `${index === selected ? "›" : " "} ${option.label}`),
      options[selected]?.description || "",
    ];
  } else if (kind === "live_workspace_mode") {
    const selected = Math.max(0, Math.min(
      WORKSPACE_MODES.length - 1,
      Number(runtime.workspaceModeSelection) || 0,
    ));
    lines = [
      runtime.runId ? "? Use this mode after /new?" : "? Use this collaboration mode?",
      runtime.runId
        ? "The active Run keeps its current team. The selected mode applies after /new."
        : "Choose how OriginRouter should form the Agent team for the next objective.",
      ...WORKSPACE_MODES.map((option, index) => `${index === selected ? "›" : " "} ${option.label}`),
      WORKSPACE_MODES[selected]?.description || "",
    ];
  } else if (kind === "session_resume") {
    lines = [
      "? Choose a Workspace Session to restore",
      "↑/↓ select · Enter restore · Esc return to the Workspace prompt",
    ];
  } else if (kind === "plan") {
    lines = [
      "? Start this plan?",
      "↑/↓ or PgUp/PgDn review · Enter start · E request changes · Esc leave pending",
    ];
  } else if (kind === "plan_revision") {
    const feedback = String(runtime.decisionBuffer || "");
    const feedbackChars = [...feedback];
    const feedbackCursor = Math.max(0, Math.min(runtime.decisionCursor || 0, feedbackChars.length));
    lines = [
      "? What should the Planner change?",
      composerLine(feedback, feedbackCursor, columns),
      "Enter submit changes · Ctrl+U clears · Esc back to plan",
    ];
  } else if (kind === "completion") {
    const canRetry = ["failed", "cancelled", "expired"].includes(runtime.snapshot?.run?.state);
    lines = [
      `? ${runtime.snapshot?.run?.state === "completed" ? "Collaboration complete" : "Collaboration stopped"}`,
      canRetry
        ? "R retry · ↑/↓ review · Enter return to objective prompt"
        : "↑/↓ or PgUp/PgDn review · Enter return to objective prompt",
    ];
  } else if (kind === "attention") {
    const permission = runtime.attention?.kind === "approval";
    const requestKind = attentionRequestKind(runtime.attention);
    const participant = attentionParticipantLabel(runtime.attention, runtime);
    const attentionTitle = runtime.attention?.title
      || (permission ? `Allow the request from ${participant}?`
        : requestKind === "confirm" ? `Continue with ${participant}?`
          : requestKind === "questions" ? `Answer questions from ${participant}?`
            : requestKind === "form" ? `Complete the form for ${participant}?`
              : requestKind === "url" ? `Continue authorization for ${participant}?`
                : `Respond to ${participant}?`);
    const attentionHeading = permission
      ? `Allow the request from ${participant}? · ${attentionTitle}`
      : requestKind === "confirm"
        ? `Continue with ${participant}? · ${attentionTitle}`
        : requestKind === "questions"
          ? `Answer questions from ${participant}? · ${attentionTitle}`
          : requestKind === "form"
            ? `Complete the form for ${participant}? · ${attentionTitle}`
            : requestKind === "url"
              ? `Continue authorization for ${participant}? · ${attentionTitle}`
              : `Respond to ${participant}? · ${attentionTitle}`;
    if (!focusedInteraction) {
      const context = attentionRequestContext(runtime.attention, runtime);
      const actions = (runtime.attention?.actions || []).map((action, index) => (
        `${index === runtime.attentionSelection ? "›" : " "} ${index + 1}. ${attentionActionLabel(action, runtime.attention)}`
      ));
      return wrappedInteractionLines([
        `? ${attentionHeading}`,
        ...context.map((item) => `${item.label}: ${item.value}`),
        ...(runtime.attention?.risk ? [`Risk: ${runtime.attention.risk}`] : []),
        ...actions,
        permission
          ? "↑/↓ select · Enter confirms · Shift+Tab changes later requests · D detach"
          : "↑/↓ select · Enter continues · Shift+Tab changes later requests · D detach",
      ], columns);
    }
    lines = [
      `? ${attentionHeading}`,
      permission
        ? "↑/↓ select · Enter confirms · Shift+Tab changes approval for later requests"
        : "↑/↓ select · Enter continues · Shift+Tab changes approval for later requests",
      "D detaches · Esc stays with Run",
    ];
  } else if (kind === "attention_reply") {
    const replyPrompt = attentionReplyPrompt(runtime.attention);
    if (!focusedInteraction) {
      const question = attentionRequestContext(runtime.attention, runtime)
        .filter((item) => ["Requested by", "Request"].includes(item.label))
        .map((item) => `${item.label}: ${item.value}`);
      return [
        wrappedInteractionLines([
          `? ${replyPrompt}`,
          ...question,
        ], columns, 6),
        composerLine(runtime.decisionBuffer || "", runtime.decisionCursor || 0, columns),
        wrappedInteractionLines([
          "Enter submits · Ctrl+U clears · Esc back to actions · Shift+Tab approval",
        ], columns, 2),
      ].join("\n");
    }
    lines = [
      `? ${replyPrompt}`,
      composerLine(runtime.decisionBuffer || "", runtime.decisionCursor || 0, columns),
      "Enter submits · Ctrl+U clears · Esc back to actions · Shift+Tab approval",
    ];
  } else if (kind === "paused") {
    lines = [
      "? Resume this collaboration?",
      runtime.snapshot?.run?.pause_reason || "The Run is preserved and can continue from its current state.",
    ];
  } else if (kind === "reconnect") {
    lines = [
      "? Reconnect to this Run?",
      "OriginRouter service still owns this Run and its Agent bindings.",
      "No new Run will be created.",
    ];
  } else {
    lines = ["? OriginRouter needs your input"];
  }
  const visibleLines = lines.filter(Boolean);
  // The action dock may be the whole available screen on a short terminal.
  // Keep the currently selected option visible and never emit more rows than
  // the alternate-screen frame owns; otherwise an ANSI autowrap/scroll would
  // leak rows beyond the viewport.
  if (visibleLines.length > maxRows) {
    const selectedIndex = visibleLines.findIndex((line) => /^›\s/.test(line));
    if (selectedIndex >= 0 && maxRows > 1) {
      const optionRows = Math.max(1, maxRows - 1);
      const start = Math.max(1, Math.min(
        Math.max(1, visibleLines.length - optionRows),
        selectedIndex - Math.floor(optionRows / 2),
      ));
      lines = [visibleLines[0], ...visibleLines.slice(start, start + optionRows)];
    } else {
      lines = visibleLines.slice(0, maxRows);
    }
  } else {
    lines = visibleLines;
  }
  const width = Math.max(1, columns - 1);
  return lines
    .map((line) => padDisplayRight(strong(fitDisplayText(line, width)), columns))
    .join("\n");
}

function interactionStatus(runtime, columns) {
  const labels = {
    device: "selecting remote devices",
    workspace: "selecting workspace",
    setup: "choosing folder",
    configuration: "reviewing team",
    team_edit: "editing team",
    team_runtime: "choosing Agent Runtime",
    team_route: "choosing model route",
    team_permission: "choosing Agent access limit",
    team_session_permission: "choosing Session approval",
    live_session_permission: "choosing Session approval",
    live_workspace_mode: "choosing collaboration mode",
    session_resume: "choosing a Workspace Session",
    plan: "reviewing plan",
    plan_revision: "requesting plan changes",
    completion: "reviewing result",
    attention: "Agent needs input",
    attention_reply: "replying to Agent",
    paused: "collaboration paused",
    reconnect: "connection paused · Run preserved",
  };
  return padDisplayRight(muted(`  ${labels[runtime.interactionKind] || "waiting for input"}`), columns);
}

export {
  composerLine,
  composerStatus,
  interactionComposer,
  interactionStatus,
  runtimeComposer,
  runtimePathComposer,
};
