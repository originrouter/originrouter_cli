export const UPDATE_MODES = Object.freeze(["prompt", "auto", "off"]);

export function updateModeFromConfig(config) {
  const mode = String(config?.updates?.mode || "prompt").trim().toLowerCase();
  return UPDATE_MODES.includes(mode) ? mode : "prompt";
}

export function setUpdateMode(config, mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!UPDATE_MODES.includes(normalized)) {
    throw new Error("Update mode must be prompt, auto, or off.");
  }
  return {
    ...config,
    updates: {
      ...(config?.updates || {}),
      mode: normalized,
      channel: "stable",
    },
  };
}
