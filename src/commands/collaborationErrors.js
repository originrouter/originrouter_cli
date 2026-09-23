export class CollaborationCliError extends Error {
  constructor(message, {
    exitCode = 1,
    diagnosticCode = "COLLABORATION_COMMAND_FAILED",
    impact = "The requested collaboration operation did not complete.",
    action = "Run `originrouter collaboration doctor <run-id>` when a Run ID is available.",
    cause = null,
  } = {}) {
    super([
      message,
      `Impact: ${impact}`,
      `Action: ${action}`,
      `Diagnostic code: ${diagnosticCode}`,
    ].join("\n"), cause ? { cause } : undefined);
    this.exitCode = exitCode;
    this.diagnosticCode = diagnosticCode;
  }
}

export function collaborationErrorDetails(status, reason) {
  const code = String(reason || "COLLABORATION_REQUEST_FAILED").toUpperCase();
  if (status === 401 || status === 403 || /AUTH|LOGIN|TRUST|E2EE|IDENTITY/.test(code)) {
    return {
      exitCode: 4,
      action: "Check `originrouter login status`, device trust, and the selected workspace permission.",
    };
  }
  if (/BUDGET|POLICY/.test(code)) {
    return {
      exitCode: 7,
      action: "Review the Run, device, and Agent budget or organization policy before resuming.",
    };
  }
  if (/CAPABILIT|RUNTIME|PROVIDER|MODEL|ROUTE/.test(code)) {
    return {
      exitCode: 5,
      action: "Check the selected device with `originrouter doctor`, then configure its Agent route or runtime.",
    };
  }
  if (status === 503 || /TIMEOUT|OFFLINE|UNAVAILABLE|CONNECTION|RELAY/.test(code)) {
    return {
      exitCode: 10,
      action: "Check device connectivity and retry. The Daemon-owned Run may still be active.",
    };
  }
  return { exitCode: 1 };
}
