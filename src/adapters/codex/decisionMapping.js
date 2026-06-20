// Stage 8.0A: pure decision-to-wire mapping, extracted from
// CodexAppServerClient so it can be unit-tested directly.
//
// happy's reference (packages/happy-cli/src/codex/codexAppServerClient.ts:
// `mapDecisionToWire`) uses the new wire forms only (`accept` /
// `acceptForSession` / `decline` / `cancel`). OriginRouter keeps a legacy
// fallback for Codex CLIs that still emit the older `execCommandApproval`
// and `applyPatchApproval` methods — see open question #1 in
// docs/agent-runtime-audit.md.

export function mapDecisionToWire(decision, legacy = false) {
  if (legacy) {
    if (decision === "approved" || decision === "approved_for_session" || decision === "denied" || decision === "abort") {
      return decision;
    }
    if (decision === "accept") return "approved";
    if (decision === "acceptForSession") return "approved_for_session";
    if (decision === "cancel") return "abort";
    return "denied";
  }

  if (decision === "approved") return "accept";
  if (decision === "approved_for_session") return "acceptForSession";
  if (decision === "denied") return "decline";
  if (decision === "abort") return "cancel";
  if (decision === "accept" || decision === "acceptForSession" || decision === "decline" || decision === "cancel") {
    return decision;
  }
  return "decline";
}
