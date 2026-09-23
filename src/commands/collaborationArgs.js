import { cwd } from "node:process";

import {
  optionValue as value,
  optionValues as values,
} from "./shared/cliArgs.js";

const CONFIRMATION_MODE_ALIASES = Object.freeze({
  required: "required",
  never: "required", // legacy: never auto-confirm
  safe_auto: "safe_auto",
  safe: "safe_auto", // legacy
  always_auto: "always_auto",
  always: "always_auto", // legacy
});

export function normalizeConfirmationMode(value = "required") {
  const normalized = String(value || "required").trim().toLowerCase();
  const mode = CONFIRMATION_MODE_ALIASES[normalized];
  if (!mode) throw new Error(`Unknown confirmation mode '${value}'. Use required, safe_auto, or always_auto.`);
  return mode;
}

export function parseParticipant(raw) {
  const parts = String(raw || "").split(":");
  const participantId = parts.shift()?.trim();
  const runtime = parts.shift()?.trim();
  const deviceId = parts.shift()?.trim();
  const workspaceId = parts.join(":").trim();
  if (!participantId || !runtime || !deviceId) {
    throw new Error("--participant must use id:runtime:device:workspace, for example builder:claude:local:/project");
  }
  return {
    participant_id: participantId,
    runtime,
    device_id: deviceId,
    workspace_id: workspaceId || cwd(),
  };
}

export function roleHints(args) {
  const result = new Map();
  for (const raw of values(args, "role")) {
    const index = raw.indexOf("=");
    if (index <= 0) throw new Error("--role must use participant_id=natural language responsibility");
    result.set(raw.slice(0, index).trim(), raw.slice(index + 1).trim());
  }
  return result;
}

export function participantAssignments(args, name, usage) {
  const result = new Map();
  for (const raw of values(args, name)) {
    const index = String(raw).indexOf("=");
    if (index <= 0 || index === String(raw).length - 1) throw new Error(usage);
    result.set(String(raw).slice(0, index).trim(), String(raw).slice(index + 1).trim());
  }
  return result;
}

export function positiveIntegerOption(raw, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw == null) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`--${name} must be a positive integer${Number.isFinite(max) ? ` no greater than ${max}` : ""}.`);
  }
  return parsed;
}

export function amountMicrosOption(args) {
  const micros = value(args, "amount-limit-micros");
  const amount = value(args, "amount-limit");
  if (micros != null && amount != null) {
    throw new Error("Use either --amount-limit or --amount-limit-micros, not both.");
  }
  if (micros != null) return positiveIntegerOption(micros, "amount-limit-micros");
  if (amount == null) return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--amount-limit must be a positive decimal amount.");
  }
  const converted = Math.round(parsed * 1_000_000);
  if (!Number.isSafeInteger(converted) || converted <= 0) {
    throw new Error("--amount-limit is outside the supported range.");
  }
  return converted;
}
