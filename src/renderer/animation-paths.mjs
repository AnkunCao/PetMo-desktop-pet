const PLAYABLE_ACTION_KEYS = Object.freeze([
  "idle",
  "stand-sit",
  "sleep",
  "look-up",
  "roll-over",
  "run",
  "stretch"
]);

function pickString(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

export function normalizePlayableAnimationPaths(paths) {
  if (!paths || typeof paths !== "object") {
    return {};
  }

  const normalized = {};
  for (const actionId of PLAYABLE_ACTION_KEYS) {
    const sourcePath = actionId === "stand-sit"
      ? pickString(paths["stand-sit"]) || pickString(paths.standSit)
      : pickString(paths[actionId]);
    if (sourcePath) {
      normalized[actionId] = sourcePath;
    }
  }

  return normalized;
}
