import { buildInteractionRequest, INTERACTION_KINDS } from "./agentInteractionContract.js";
import { displaySafeToolInput, toolInputContainsSecret } from "./displaySafeToolInput.js";
import {
  codexCommandApprovalDecision, codexCommandApprovalPresentation, codexQuestionResponse,
  codexQuestions, containsSecretSchema, decisionFor,
} from "./codexAppServerPrimitives.js";

// Both the managed client and the official TUI receive the same server requests.
// Keep presentation and wire decisions together, including the original parameters
// which must never be substituted with a display-truncated value on approval.
export function codexInteraction(method, params, context) {
  const card = (kind, title, prompt, payload, secret, reply, expiresAt = context.expiresAt) => ({
    request: buildInteractionRequest({
      ...context, provider: "codex", kind, title, prompt, payload, containsSecret: secret, expiresAt,
    }),
    reply,
  });
  const allowed = ({ action }) => action === "submit" || action === "allow";
  if (method === "item/tool/requestUserInput") {
    return card(INTERACTION_KINDS.QUESTIONS, "Codex needs input", "Answer the questions to continue.",
      codexQuestions(params), (params.questions || []).some(q => q?.isSecret),
      resolved => allowed(resolved) ? codexQuestionResponse(params, resolved.response) : { answers: {} },
      params.autoResolutionMs ? Math.ceil((Date.now() + params.autoResolutionMs) / 1000) : context.expiresAt);
  }
  if (method === "mcpServer/elicitation/request") {
    const isUrl = params.mode === "url";
    const payload = isUrl ? { url: params.url || "" } : { schema: params.requestedSchema || {} };
    return card(isUrl ? INTERACTION_KINDS.URL : INTERACTION_KINDS.FORM, params.serverName || "MCP request",
      params.message || "The MCP server needs input.", { ...payload, server_name: params.serverName || "" },
      containsSecretSchema(params.requestedSchema), resolved => allowed(resolved)
        ? { action: "accept", content: resolved.response?.values || resolved.response || {}, _meta: null }
        : { action: resolved.action === "cancel" ? "cancel" : "decline", content: null, _meta: null });
  }
  if (method === "item/permissions/requestApproval") {
    return card(INTERACTION_KINDS.PERMISSION, "Grant additional permissions?",
      params.reason || "Codex requested additional sandbox permissions.", {
        tool: "permissions", cwd: String(params.cwd || "").slice(0, 1024),
        requested: displaySafeToolInput(params.permissions || {}), remember_allowed: true,
      }, toolInputContainsSecret(params.permissions), resolved => ({
        permissions: allowed(resolved) ? {
          ...(params.permissions?.network ? { network: params.permissions.network } : {}),
          ...(params.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
        } : {},
        scope: allowed(resolved) && resolved.response?.remember_for_session ? "session" : "turn",
      }));
  }
  const command = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
  const file = method === "item/fileChange/requestApproval" || method === "applyPatchApproval";
  if (!command && !file) return null;
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  return card(INTERACTION_KINDS.PERMISSION, command ? "Run this command?" : "Apply these file changes?",
    params.reason || "Review this action before continuing.", {
      tool: command ? "command" : "file_change",
      command: typeof params.command === "string" ? params.command.slice(0, 2048) : "",
      cwd: String(params.cwd || "").slice(0, 1024),
      ...(file && Array.isArray(params.fileChanges) ? {
        affectedFiles: params.fileChanges.slice(0, 64).map(change => String(change?.path || "").slice(0, 1024)).filter(Boolean),
      } : {}),
      file_changes: file ? displaySafeToolInput(params.fileChanges || params.changes || {}, { maxEncodedLength: 32_768 }) : undefined,
      additional_permissions: command ? displaySafeToolInput(params.additionalPermissions || {}) : undefined,
      network_approval_context: command ? displaySafeToolInput(params.networkApprovalContext || {}) : undefined,
      ...(command && !legacy ? codexCommandApprovalPresentation(params) : { remember_allowed: true }),
    }, toolInputContainsSecret(params), resolved => {
      const decision = command && !legacy ? codexCommandApprovalDecision(params, resolved)
        : decisionFor(resolved.action, Boolean(resolved.response?.remember_for_session));
      return { decision: legacy ? { accept: "approved", acceptForSession: "approved_for_session", decline: "denied", cancel: "abort" }[decision] : decision };
    });
}
