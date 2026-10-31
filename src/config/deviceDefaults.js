// The device-level default model.
//
// Every device has a default model, whether or not a person chose one. The
// profile below is what a fresh install seeds, what a device with no route of
// its own falls back to, and — under the alias architecture — the initial
// value of the map the local gateway translates with.
//
// Before the alias architecture this profile was the model id written into the
// agent's environment at launch, so it survived every upgrade by construction.
// It is the same fact in a new shape: a session starts on the device default,
// and the reader can move it from there.

import { ROUTE_DEFS } from "./routes.js";

// Fresh installations use these exact route values. The ordered preference
// lists in `commands/agentRouteSetup.js` are the catalogue-aware preferences
// an explicit `agent setup --cloud` adapts to; these are the bundled values.
export const DEFAULT_CLOUD_ROUTE_MODELS = Object.freeze({
  claudeMain: "claude-sonnet-5",
  claudeHaiku: "claude-haiku-4-5",
  codexMain: "gpt-5.6-sol",
});

/**
 * The default route slots of one agent, without the provider.
 *
 * The primary slot is pinned. Claude's Haiku family is pinned too: it is the
 * cheap model a device answers its small tasks with, and leaving it unset
 * makes it inherit the primary model — the same price as the main one, which
 * is exactly what the Haiku slot exists to avoid. The remaining families
 * inherit the primary model, which is what an unset slot means.
 *
 * @param {"claude"|"codex"} agent
 * @returns {Record<string, string>} slot -> model id
 */
export function defaultRouteSlots(agent) {
  if (agent === "claude") {
    return {
      main: DEFAULT_CLOUD_ROUTE_MODELS.claudeMain,
      haiku: DEFAULT_CLOUD_ROUTE_MODELS.claudeHaiku,
    };
  }
  if (agent === "codex") {
    return { main: DEFAULT_CLOUD_ROUTE_MODELS.codexMain };
  }
  return {};
}

/**
 * The default model of one slot — what the device answers that slot with.
 *
 * A slot the profile does not pin inherits the primary model, so its default
 * is the primary default.
 *
 * @param {"claude"|"codex"} agent
 * @param {string} slot
 * @returns {string|null}
 */
export function defaultModelForSlot(agent, slot) {
  const slots = defaultRouteSlots(agent);
  if (slots[slot]) return slots[slot];
  const def = ROUTE_DEFS[agent];
  if (!def) return null;
  if (!def.inheritsFromPrimary.includes(slot)) return null;
  return slots[def.primarySlot] || null;
}
