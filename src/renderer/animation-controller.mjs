const DEFAULT_IDLE_DELAY_RANGE_MS = Object.freeze({
  min: 2200,
  max: 4800
});

function clampRandom(randomValue) {
  if (!Number.isFinite(randomValue)) {
    return 0;
  }
  if (randomValue <= 0) {
    return 0;
  }
  if (randomValue >= 1) {
    return 0.999999;
  }
  return randomValue;
}

function normalizeDelayRange(range) {
  const min = Number(range?.min);
  const max = Number(range?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return { ...DEFAULT_IDLE_DELAY_RANGE_MS };
  }
  return { min, max };
}

function normalizeActionPaths(paths) {
  if (!paths || typeof paths !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(paths).filter(([, value]) => typeof value === "string" && value.trim())
  );
}

function cloneState(state) {
  return { ...state };
}

export function createAnimationController(options = {}) {
  const random = typeof options.random === "function" ? options.random : Math.random;
  const transitionMs = Number.isFinite(options.transitionMs) ? options.transitionMs : 150;
  const idleDelayRangeMs = normalizeDelayRange(options.idleDelayRangeMs);
  const scheduleTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearScheduledTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);

  const listeners = new Set();
  let availableActions = {};
  let started = false;
  let idleTimer = null;
  let transitionTimer = null;
  let pendingActionId = "";
  let state = {
    phase: "idle",
    actionId: "idle",
    nextActionId: null,
    previousActionId: null,
    transitionMs
  };

  function emit(nextState) {
    state = {
      phase: nextState.phase,
      actionId: nextState.actionId,
      nextActionId: nextState.nextActionId ?? null,
      previousActionId: nextState.previousActionId ?? null,
      transitionMs
    };
    const snapshot = cloneState(state);
    listeners.forEach((listener) => listener(snapshot));
  }

  function clearTimers() {
    if (idleTimer !== null) {
      clearScheduledTimeout(idleTimer);
      idleTimer = null;
    }
    if (transitionTimer !== null) {
      clearScheduledTimeout(transitionTimer);
      transitionTimer = null;
    }
  }

  function getPlayableActions() {
    return Object.keys(availableActions).filter((actionId) => actionId !== "idle");
  }

  function pickIdleDelay() {
    if (idleDelayRangeMs.min === idleDelayRangeMs.max) {
      return idleDelayRangeMs.min;
    }

    return idleDelayRangeMs.min + clampRandom(random()) * (idleDelayRangeMs.max - idleDelayRangeMs.min);
  }

  function pickRandomAction() {
    const playableActions = getPlayableActions();
    if (playableActions.length === 0) {
      return "";
    }

    const index = Math.floor(clampRandom(random()) * playableActions.length);
    return playableActions[index];
  }

  function scheduleNextAction() {
    // 停用自动循环：空闲状态保持，仅在用户点击时触发随机动作。
    // 旧逻辑会在 idleDelayRangeMs 后自动过渡到随机动作；新逻辑禁用该循环。
    return;
  }

  function transitionToAction(actionId) {
    pendingActionId = actionId;
    emit({
      phase: "transition-out",
      actionId: "idle",
      nextActionId: actionId
    });

    transitionTimer = scheduleTimeout(() => {
      transitionTimer = null;
      if (!started || pendingActionId !== actionId) {
        return;
      }

      emit({
        phase: "action",
        actionId
      });
    }, transitionMs);
  }

  const api = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState() {
      return cloneState(state);
    },
    getAvailableActions() {
      return { ...availableActions };
    },
    setAvailableActions(paths) {
      availableActions = normalizeActionPaths(paths);
      if (started) {
        clearTimers();
        scheduleNextAction();
      }
      return { ...availableActions };
    },
    start() {
      started = true;
      pendingActionId = "";
      clearTimers();
      emit({
        phase: "idle",
        actionId: "idle"
      });
      scheduleNextAction();
      return cloneState(state);
    },
    stop() {
      started = false;
      pendingActionId = "";
      clearTimers();
      emit({
        phase: "idle",
        actionId: "idle"
      });
      return cloneState(state);
    },
    triggerRandomAction() {
      if (!started || state.phase !== "idle") {
        return false;
      }

      clearTimers();
      const actionId = pickRandomAction();
      if (!actionId) {
        return false;
      }

      transitionToAction(actionId);
      return actionId;
    },
    finishAction(actionId = state.actionId) {
      if (!started || state.phase !== "action" || state.actionId !== actionId) {
        return false;
      }

      pendingActionId = "";
      emit({
        phase: "transition-in",
        actionId: "idle",
        previousActionId: actionId
      });

      transitionTimer = scheduleTimeout(() => {
        transitionTimer = null;
        if (!started) {
          return;
        }

        emit({
          phase: "idle",
          actionId: "idle"
        });
        // 动作结束后回到空闲状态，不再自动调度下一个动作。等待用户点击触发。
      }, transitionMs);

      return true;
    },
    dispose() {
      api.stop();
      listeners.clear();
    }
  };

  return api;
}
