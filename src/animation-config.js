const DEFAULT_MODEL_PROVIDER = "openai";
const DEFAULT_SIZE = "720x1280";
const DEFAULT_BACKGROUND_COLOR = "#00ff00";

// 支持的模型提供商（品牌）：选一个品牌，图片和视频都用该品牌
const AVAILABLE_PROVIDERS = Object.freeze([
  { id: "openai", label: "OpenAI (ChatGPT)", imageModel: "gpt-image-1.5", videoModel: "sora-2" },
  { id: "bytedance", label: "Bytedance", imageModel: "doubao-seedream-5-0-260128", videoModel: "doubao-seedance-2-0-fast-260128" }
]);

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeDeep(item);
    }
    return Object.freeze(value);
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      freezeDeep(item);
    }
    return Object.freeze(value);
  }

  return value;
}

function normalizeHexColor(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function buildPrompt(actionId) {
  const basePrompt = [
    "使用同一只宠物，固定镜头和固定光线，#00ff00 纯色背景。",
    "宠物不离开画面，不增加道具，不戴项圈，不引入其他主体，不改变场景，地面不出现投影或阴影，背景必须是完全均匀的纯绿色。",
    "结束时回到标准坐姿。"
  ];

  if (actionId === "stand-sit") {
    return [
      basePrompt[0],
      "宠物从标准坐姿自然站起，短暂停留后再坐回。",
      basePrompt[1],
      basePrompt[2]
    ].join("");
  }

  if (actionId === "sleep") {
    return [
      basePrompt[0],
      "宠物从标准坐姿缓慢趴下睡觉，短暂停留后自然坐回。",
      basePrompt[1],
      basePrompt[2]
    ].join("");
  }

  if (actionId === "look-up") {
    return [
      basePrompt[0],
      "宠物从标准坐姿抬起头，疑惑地看向天空，短暂停留后回到坐姿。",
      basePrompt[1],
      basePrompt[2]
    ].join("");
  }

  if (actionId === "roll-over") {
    return [
      basePrompt[0],
      "宠物从坐姿躺倒，翻过身露出肚皮，轻微摇晃，然后翻回坐姿。",
      basePrompt[1],
      basePrompt[2]
    ].join("");
  }

  if (actionId === "run") {
    return [
      basePrompt[0],
      "宠物从坐姿站起奔跑（原地或小范围），然后停下回到坐姿。",
      basePrompt[1],
      basePrompt[2]
    ].join("");
  }

  if (actionId === "stretch") {
    return [
      basePrompt[0],
      "宠物从坐姿站起，伸懒腰并打哈欠，然后坐回原位。",
      basePrompt[1],
      basePrompt[2]
    ].join("");
  }

  return [
    basePrompt[0],
    "宠物保持标准坐姿，轻微呼吸、眨眼和自然摇尾巴。",
    basePrompt[1],
    basePrompt[2]
  ].join("");
}

function buildAnimationDefinitions(videoModel = "sora-2") {
  return freezeDeep([
    {
      id: "idle",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 4,
      prompt: buildPrompt("idle")
    },
    {
      id: "stand-sit",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 8,
      prompt: buildPrompt("stand-sit")
    },
    {
      id: "sleep",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 8,
      prompt: buildPrompt("sleep")
    },
    {
      id: "look-up",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 6,
      prompt: buildPrompt("look-up")
    },
    {
      id: "roll-over",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 8,
      prompt: buildPrompt("roll-over")
    },
    {
      id: "run",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 6,
      prompt: buildPrompt("run")
    },
    {
      id: "stretch",
      model: videoModel,
      size: DEFAULT_SIZE,
      seconds: 5,
      prompt: buildPrompt("stretch")
    }
  ]);
}

const ANIMATION_DEFINITIONS = buildAnimationDefinitions();
const ANIMATION_DEFINITION_BY_ID = new Map(
  ANIMATION_DEFINITIONS.map((definition) => [definition.id, definition])
);

function createActionState(definition) {
  return {
    id: definition.id,
    remoteTaskId: null,
    progress: 0,
    status: "queued",
    failure: null
  };
}

function createAnimationBatch(referencePath, backgroundColor) {
  const normalizedBackgroundColor = normalizeHexColor(backgroundColor);
  if (normalizedBackgroundColor !== DEFAULT_BACKGROUND_COLOR) {
    throw new Error("动画背景色必须锁定为 #00ff00。");
  }

  return {
    referencePath,
    backgroundColor: normalizedBackgroundColor,
    status: "queued",
    candidateReady: false,
    cancellationRequested: false,
    actions: ANIMATION_DEFINITIONS.slice(0, 3).map(createActionState)
  };
}

function cloneAction(action) {
  return {
    id: action.id,
    remoteTaskId: action.remoteTaskId ?? null,
    progress: action.progress ?? 0,
    status: action.status,
    failure: action.failure ? { ...action.failure } : null
  };
}

function cloneBatch(batch) {
  return {
    referencePath: batch.referencePath,
    backgroundColor: batch.backgroundColor,
    status: batch.status,
    candidateReady: batch.candidateReady,
    cancellationRequested: batch.cancellationRequested ?? false,
    actions: batch.actions.map(cloneAction)
  };
}

function isTerminalBatch(batch) {
  return ["completed", "failed", "cancelled"].includes(batch.status);
}

function isActiveActionStatus(status) {
  return status === "submitted" || status === "in_progress";
}

function getEventActionId(event) {
  return event.actionId ?? event.action ?? null;
}

function getCurrentActionIndex(batch) {
  let queuedIndex = -1;
  let activeIndex = -1;
  let completedIndex = -1;
  let seenQueued = false;
  let seenActive = false;
  let seenCancelled = false;

  for (let index = 0; index < batch.actions.length; index += 1) {
    const action = batch.actions[index];

    if (action.status === "completed") {
      if (seenQueued || seenActive || seenCancelled) {
        throw new Error("动画批次顺序无效：completed 不能出现在当前动作之后。");
      }
      completedIndex = index;
      continue;
    }

    if (action.status === "queued") {
      if (seenCancelled) {
        throw new Error("动画批次顺序无效：queued 不能出现在已取消动作之后。");
      }
      if (queuedIndex === -1) {
        queuedIndex = index;
      }
      seenQueued = true;
      continue;
    }

    if (isActiveActionStatus(action.status)) {
      if (seenQueued) {
        throw new Error("动画批次顺序无效：进行中动作不能出现在 queued 之后。");
      }
      if (seenCancelled) {
        throw new Error("动画批次顺序无效：进行中动作不能出现在已取消动作之后。");
      }
      if (seenActive) {
        throw new Error("动画批次顺序无效：只能存在一个进行中的当前动作。");
      }
      activeIndex = index;
      seenActive = true;
      continue;
    }

    if (action.status === "cancelled") {
      if (seenQueued) {
        throw new Error("动画批次顺序无效：cancelled 不能出现在 queued 之后。");
      }
      seenCancelled = true;
      continue;
    }

    if (action.status === "failed") {
      throw new Error(`动画批次顺序无效：${action.status} 不能出现在进行中的批次中。`);
    }

    throw new Error(`未知动作状态：${action.status}`);
  }

  if (activeIndex !== -1) {
    return activeIndex;
  }

  if (queuedIndex !== -1) {
    return queuedIndex;
  }

  if (seenCancelled && completedIndex !== -1) {
    return completedIndex;
  }

  return -1;
}

function deriveBatchStatus(batch) {
  const actions = batch.actions;
  const hasCancelled = actions.some((action) => action.status === "cancelled");
  const hasActive = actions.some((action) => isActiveActionStatus(action.status));

  if (batch.cancellationRequested) {
    return hasActive ? "cancelling" : "cancelled";
  }

  if (actions.some((action) => action.status === "failed")) {
    return "failed";
  }

  if (actions.every((action) => action.status === "completed")) {
    return "completed";
  }

  if (hasCancelled) {
    return hasActive ? "cancelling" : "cancelled";
  }

  if (hasActive || actions.some((action) => action.status === "completed")) {
    return "in_progress";
  }

  return "queued";
}

function advanceAnimationBatch(batch, event) {
  const nextBatch = cloneBatch(batch);

  if (!event || typeof event.type !== "string") {
    throw new Error("动画事件缺少 type。");
  }

  if (isTerminalBatch(nextBatch)) {
    return nextBatch;
  }

  if (event.type === "cancel-remaining") {
    const currentActionIndex = getCurrentActionIndex(nextBatch);
    if (currentActionIndex === -1) {
      throw new Error("动画批次缺少当前动作，无法取消剩余动作。");
    }

    const hasActiveAction = nextBatch.actions.some((action) =>
      isActiveActionStatus(action.status)
    );

    nextBatch.actions = nextBatch.actions.map((action) =>
      action.status === "queued"
        ? {
            ...action,
            status: "cancelled"
          }
        : action
    );
    nextBatch.cancellationRequested = true;
    nextBatch.status = hasActiveAction ? "cancelling" : "cancelled";
    nextBatch.candidateReady = false;
    return nextBatch;
  }

  const actionId = getEventActionId(event);
  if (!actionId) {
    throw new Error("动画事件缺少 actionId。");
  }

  const actionIndex = nextBatch.actions.findIndex((action) => action.id === actionId);
  if (actionIndex === -1) {
    throw new Error(`找不到当前动作：${actionId}`);
  }

  const currentActionIndex = getCurrentActionIndex(nextBatch);
  if (currentActionIndex === -1) {
    throw new Error("动画批次缺少当前动作。");
  }

  if (actionIndex !== currentActionIndex) {
    throw new Error(`只能推进当前动作：${nextBatch.actions[currentActionIndex].id}`);
  }

  const action = nextBatch.actions[actionIndex];

  if (event.type === "submitted") {
    if (action.status !== "queued") {
      throw new Error(`动作 ${action.id} 不能再次提交。`);
    }

    nextBatch.actions[actionIndex] = {
      ...action,
      remoteTaskId: event.remoteTaskId ?? null,
      progress: 0,
      status: "in_progress",
      failure: null
    };
  } else if (event.type === "progress") {
    if (action.status !== "in_progress") {
      throw new Error(`动作 ${action.id} 只有在提交后才能推进进度。`);
    }

    nextBatch.actions[actionIndex] = {
      ...action,
      progress: Number.isFinite(event.progress)
        ? Math.max(0, Math.min(100, event.progress))
        : action.progress,
      status: "in_progress"
    };
  } else if (event.type === "completed") {
    if (action.status !== "in_progress") {
      throw new Error(`动作 ${action.id} 只有在进行中时才能完成。`);
    }

    nextBatch.actions[actionIndex] = {
      ...action,
      progress: 100,
      status: "completed",
      failure: null
    };
  } else if (event.type === "failed") {
    if (action.status !== "in_progress") {
      throw new Error(`动作 ${action.id} 只有在进行中时才能失败。`);
    }

    nextBatch.actions[actionIndex] = {
      ...action,
      status: "failed",
      failure: {
        message: event.message || "未知失败"
      }
    };
  } else if (event.type === "cancelled") {
    if (!nextBatch.cancellationRequested || action.status !== "in_progress") {
      throw new Error(`动作 ${action.id} 只能在取消请求后收敛为已取消。`);
    }

    nextBatch.actions[actionIndex] = {
      ...action,
      status: "cancelled",
      failure: null
    };
  } else {
    throw new Error(`未知动画事件类型：${event.type}`);
  }

  nextBatch.status = deriveBatchStatus(nextBatch);
  nextBatch.candidateReady = nextBatch.status === "completed";
  return nextBatch;
}

function getNextPendingAction(batch) {
  if (!batch || batch.cancellationRequested || isTerminalBatch(batch)) {
    return null;
  }

  if (batch.actions.some((action) => isActiveActionStatus(action.status))) {
    return null;
  }

  const nextIndex = batch.actions.findIndex((action) => action.status === "queued");
  if (nextIndex === -1) {
    return null;
  }

  if (!batch.actions.slice(0, nextIndex).every((action) => action.status === "completed")) {
    return null;
  }

  if (
    batch.actions
      .slice(nextIndex + 1)
      .some((action) => isActiveActionStatus(action.status) || action.status === "completed")
  ) {
    return null;
  }

  return batch.actions[nextIndex];
}

function getAnimationDefinition(actionId) {
  return ANIMATION_DEFINITION_BY_ID.get(actionId) || null;
}

module.exports = {
  ANIMATION_DEFINITIONS,
  ANIMATION_DEFINITION_BY_ID,
  AVAILABLE_PROVIDERS,
  DEFAULT_MODEL_PROVIDER,
  buildAnimationDefinitions,
  advanceAnimationBatch,
  createAnimationBatch,
  getAnimationDefinition,
  getNextPendingAction
};
