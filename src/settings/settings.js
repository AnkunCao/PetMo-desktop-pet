const form = document.querySelector("#pet-form");
const photoInputs = document.querySelectorAll(".photo-input");
const photoSlots = document.querySelectorAll(".photo-slot");
const apiKeyInput = document.querySelector("#api-key");
const keyStatus = document.querySelector("#key-status");
const generateButton = document.querySelector("#generate-button");
const rememberApiKeyInput = document.querySelector("#remember-api-key");
const regenerateButton = document.querySelector("#regenerate-button");
const status = document.querySelector("#status");
const animationSummary = document.querySelector("#animation-summary");
const canonicalStageStatus = document.querySelector("#canonical-stage-status");
const idleProgress = document.querySelector("#idle-progress");
const idleStatus = document.querySelector("#idle-status");
const standSitProgress = document.querySelector("#stand-sit-progress");
const standSitStatus = document.querySelector("#stand-sit-status");
const sleepProgress = document.querySelector("#sleep-progress");
const sleepStatus = document.querySelector("#sleep-status");
const saveStageStatus = document.querySelector("#save-stage-status");
const cancelAnimationButton = document.querySelector("#cancel-animation-button");
const retryAnimationButton = document.querySelector("#retry-animation-button");
const openActionManagerButton = document.querySelector("#open-action-manager-button");
const closeActionManagerButton = document.querySelector("#close-action-manager-button");
const actionManager = document.querySelector("#action-manager");
const chromaSlider = document.querySelector("#chroma-slider");
const chromaValue = document.querySelector("#chroma-value");
const rekeyAllButton = document.querySelector("#rekey-all-button");
const modelProviderSelect = document.querySelector("#model-provider-select");
const modelNote = document.querySelector("#model-note");
const animationProviderBadge = document.querySelector("#animation-provider-badge");
const imageModelDisplay = document.querySelector("#image-model-display");
const videoModelDisplay = document.querySelector("#video-model-display");
const uploadProviderName = document.querySelector("#upload-provider-name");
const progressFills = {
  idle: document.querySelector("#idle-fill"),
  "stand-sit": document.querySelector("#stand-sit-fill"),
  sleep: document.querySelector("#sleep-fill")
};
const EXTRA_ACTIONS = ["look-up", "roll-over", "run", "stretch"];
const previewVideos = {
  idle: document.querySelector("#preview-idle"),
  "stand-sit": document.querySelector("#preview-stand-sit"),
  sleep: document.querySelector("#preview-sleep"),
  "look-up": document.querySelector("#preview-look-up"),
  "roll-over": document.querySelector("#preview-roll-over"),
  run: document.querySelector("#preview-run"),
  stretch: document.querySelector("#preview-stretch")
};

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const TERMINAL_BATCH_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_BATCH_STATUSES = new Set(["queued", "in_progress", "cancelling"]);
const ACTION_ORDER = ["idle", "stand-sit", "sleep"];
const photoDataUrls = ["", "", "", ""];

let hasGeneratedPet = false;
let pendingCandidateBatch = null;
let currentAnimationBatch = null;
let lastAnimationBatch = null;
let trackedAnimationCandidateId = "";
let activeAnimationVersion = "";
let imageGenerationState = "idle";
let isGeneratingPet = false;
let pendingAnimationCommand = null;
let cacheBuster = 0;

// 更新 UI 中的提供商显示标签（图片、视频都跟着改）
function updateProviderDisplay(modelProvider) {
  const providerLabels = {
    "openai": "OpenAI",
    "bytedance": "Bytedance"
  };
  const imageModels = {
    "openai": "gpt-image-1.5",
    "bytedance": "doubao-seedream-5-0-260128"
  };
  const videoModels = {
    "openai": "sora-2",
    "bytedance": "doubao-seedance-2-0-fast-260128"
  };
  const label = providerLabels[modelProvider] || "未知";
  const imageModel = imageModels[modelProvider] || "gpt-image-1.5";
  const videoModel = videoModels[modelProvider] || "sora-2";

  if (modelNote) {
    modelNote.textContent = "当前：" + label;
  }
  if (animationProviderBadge) {
    animationProviderBadge.textContent = label;
  }
  if (imageModelDisplay) {
    imageModelDisplay.textContent = imageModel;
  }
  if (videoModelDisplay) {
    videoModelDisplay.textContent = videoModel;
  }
  if (uploadProviderName) {
    uploadProviderName.textContent = label;
  }
}
let loadingSource = "generate";

function setStatus(message, type = "") {
  if (!status) {
    return;
  }
  status.textContent = message;
  status.className = `status${type ? ` is-${type}` : ""}`;
}

function setElementText(element, text) {
  if (element) {
    element.textContent = text;
  }
}

function setElementDisabled(element, disabled) {
  if (element) {
    element.disabled = disabled;
  }
}

function setElementHidden(element, hidden) {
  if (element) {
    element.hidden = hidden;
  }
}

// 把绝对文件路径转成 <video> 可加载的 file:// URL。设置窗口本身以 file:// 加载，
// 因此本地绝对路径需要补成 file:// 协议才能作为视频源。
function toFileUrl(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return "";
  }
  if (/^[a-z]+:\/\//i.test(filePath)) {
    return filePath;
  }
  const encoded = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

// 根据已激活动画路径渲染七段透明视频预览（位于动作管理模态内）。
// 额外动作卡片随磁盘状态显隐；同时同步底部「新增动作」按钮的可用性。
function renderAnimationPreviews(activeAnimationPaths) {
  const paths = activeAnimationPaths || {};
  const sources = {
    idle: paths.idle,
    "stand-sit": paths["stand-sit"] || paths.standSit,
    sleep: paths.sleep,
    "look-up": paths["look-up"],
    "roll-over": paths["roll-over"],
    run: paths.run,
    stretch: paths.stretch
  };

  for (const [actionId, video] of Object.entries(previewVideos)) {
    const url = toFileUrl(sources[actionId]);
    const card = document.querySelector("#preview-card-" + actionId);
    const hasVideo = Boolean(video && url);

    if (video && url) {
      if (video.src !== url) {
        video.src = url;
      }
    } else if (video) {
      video.removeAttribute("src");
    }

    // 额外动作卡片：有视频才显示；新增按钮：没视频才可点（避免重复生成）。
    if (EXTRA_ACTIONS.includes(actionId)) {
      if (card) {
        card.hidden = !hasVideo;
      }
      const addButton = document.querySelector('.add-action-button[data-action="' + actionId + '"]');
      if (addButton) {
        addButton.hidden = hasVideo;
      }
    }
  }
}

function registerPreviewEvents() {
  // 播放/暂停按钮
  const playButtons = document.querySelectorAll(".preview-play-button");
  for (const button of playButtons) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const actionId = button.dataset.action;
      const video = previewVideos[actionId];
      if (video) {
        if (video.paused) {
          video.play?.().catch(() => {});
        } else {
          video.pause?.();
        }
      }
    });
  }

  // 重生成按钮
  const regenerateButtons = document.querySelectorAll(".preview-regenerate-button");
  for (const button of regenerateButtons) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const actionId = button.dataset.action;
      regenerateSingleAnimation(actionId);
    });
  }

  // 删除按钮（仅额外动作有）
  const deleteButtons = document.querySelectorAll(".preview-delete-button");
  for (const button of deleteButtons) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const actionId = button.dataset.action;
      deleteAnimation(actionId);
    });
  }

  // 单动作「重扣」按钮：用当前滑块强度只重抠这一个动作
  const rekeyButtons = document.querySelectorAll(".preview-rekey-button");
  for (const button of rekeyButtons) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const actionId = button.dataset.action;
      rekeyAnimation(actionId);
    });
  }

  // 新增动作按钮：逐个生成额外动作，复用单动作重生成通道
  const addButtons = document.querySelectorAll(".add-action-button");
  for (const button of addButtons) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const actionId = button.dataset.action;
      regenerateSingleAnimation(actionId);
    });
  }

  // 直接点击视频播放/暂停
  for (const video of Object.values(previewVideos)) {
    if (!video) {
      continue;
    }
    video.addEventListener("click", () => {
      if (video.paused) {
        video.play?.().catch(() => {});
      } else {
        video.pause?.();
      }
    });
  }
}

function getDisplayAnimationBatch() {
  return currentAnimationBatch || lastAnimationBatch || null;
}

function isTerminalAnimationBatch(batch) {
  return TERMINAL_BATCH_STATUSES.has(batch?.status);
}

function isAnimationActive(batch) {
  return Boolean(batch && ACTIVE_BATCH_STATUSES.has(batch.status));
}

function getFailedAnimationAction(batch) {
  if (!batch?.actions) {
    return null;
  }
  return batch.actions.find((action) => action.status === "failed") || null;
}

function getActionState(batch, actionId) {
  return batch?.actions?.find((action) => action.id === actionId) || null;
}

function getActionProgressText(action) {
  const progress = Number.isFinite(action?.progress) ? action.progress : 0;
  return `${Math.max(0, Math.min(100, Math.round(progress)))}%`;
}

function getActionStatusText(action, batch) {
  if (!action) {
    return "未开始";
  }

  if (action.status === "completed") {
    return "已完成";
  }
  if (action.status === "submitted" || action.status === "in_progress") {
    return "生成中";
  }
  if (action.status === "failed") {
    return "失败";
  }
  if (action.status === "cancelled") {
    return "已取消";
  }
  if (action.status === "queued" && isAnimationActive(batch)) {
    return "等待生成";
  }
  return "未开始";
}

function hasQueuedAnimationAction(batch) {
  return Boolean(batch?.actions?.some((action) => action.status === "queued"));
}

function canCancelPendingAnimations() {
  const batch = getDisplayAnimationBatch();
  return Boolean(
    batch &&
      !isTerminalAnimationBatch(batch) &&
      hasQueuedAnimationAction(batch) &&
      pendingAnimationCommand?.type !== "cancel"
  );
}

function canRetryFailedAnimations() {
  const batch = getDisplayAnimationBatch();
  return Boolean(
    batch &&
      batch.status === "failed" &&
      getFailedAnimationAction(batch) &&
      pendingAnimationCommand?.type !== "retry"
  );
}

// 批次是否真正在运行：有动作正处于 in_progress（已提交、正在轮询），或整批正在取消中。
// 注意：仅凭批次的派生状态是 "in_progress" 不够——被中途打断而残留的批次，
// 其状态可能停在 "in_progress"，但当前动作其实是 queued（从未提交），主进程并没有在跑。
// 这种残留批次不应算作忙碌，否则会把所有按钮永久锁死。
function isAnimationGenuinelyRunning(batch) {
  if (!batch) {
    return false;
  }
  if (batch.status === "cancelling") {
    return true;
  }
  return Boolean(batch.actions?.some((action) => action.status === "in_progress"));
}

function isBusy() {
  return Boolean(
    isGeneratingPet ||
      pendingAnimationCommand ||
      isAnimationGenuinelyRunning(currentAnimationBatch)
  );
}

function updateRegenerateVisibility() {
  if (regenerateButton) {
    regenerateButton.classList.toggle("is-visible", hasGeneratedPet);
  }
}

function finalizeCompletedAnimationState() {
  const batch = getDisplayAnimationBatch();
  if (!batch) {
    return;
  }

  if (activeAnimationVersion && batch.id === activeAnimationVersion) {
    hasGeneratedPet = true;
    updateRegenerateVisibility();
    refreshAnimationPreviews();
  }
}

// 动画切换到新版本后，重新拉取激活路径并刷新预览。
function refreshAnimationPreviews() {
  if (typeof window.desktopPet?.getPetProject !== "function") {
    return;
  }
  window.desktopPet
    .getPetProject()
    .then((project) => renderAnimationPreviews(project?.appearance?.activeAnimationPaths))
    .catch(() => {});
}

function renderButtons() {
  const busy = isBusy();
  setElementDisabled(generateButton, busy);
  setElementDisabled(regenerateButton, busy);

  if (generateButton) {
    generateButton.classList.toggle("is-loading", isGeneratingPet && loadingSource === "generate");
  }
  if (regenerateButton) {
    regenerateButton.classList.toggle(
      "is-loading",
      isGeneratingPet && loadingSource === "regenerate"
    );
  }

  setElementDisabled(cancelAnimationButton, !canCancelPendingAnimations());
  setElementDisabled(retryAnimationButton, !canRetryFailedAnimations());
  setElementHidden(cancelAnimationButton, !canCancelPendingAnimations());
  setElementHidden(retryAnimationButton, !canRetryFailedAnimations());
}

// 把动作进度写进对应进度条；完成/失败时给所在行加状态类切换填充色。
function renderProgressFill(actionId, action) {
  const fill = progressFills[actionId];
  if (!fill) {
    return;
  }
  const progress = Number.isFinite(action?.progress) ? action.progress : 0;
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const width = action?.status === "completed" ? 100 : clamped;
  fill.style.width = width + "%";

  const row = fill.closest(".flow-row");
  if (row) {
    row.classList.toggle("is-done", action?.status === "completed");
    row.classList.toggle("is-failed", action?.status === "failed");
  }
}

function renderAnimationProgress() {
  const batch = getDisplayAnimationBatch();
  const idleAction = getActionState(batch, "idle");
  const standSitAction = getActionState(batch, "stand-sit");
  const sleepAction = getActionState(batch, "sleep");

  if (imageGenerationState === "in_progress") {
    setElementText(animationSummary, "正在生成标准图，完成后会按顺序创建待机、站起、睡觉三段动画。");
  } else if (batch?.status === "failed") {
    setElementText(animationSummary, "动画生成失败，可直接重试失败动作。");
  } else if (batch?.status === "cancelling") {
    setElementText(animationSummary, "已取消后续动作，当前远端任务完成后会停止。");
  } else if (batch?.status === "cancelled") {
    setElementText(animationSummary, "已取消后续动作，当前批次不会继续创建新任务。");
  } else if (activeAnimationVersion && batch && batch.id === activeAnimationVersion && !currentAnimationBatch) {
    setElementText(animationSummary, "标准图和三段动画已保存到本地，可以直接使用。");
  } else if (batch || (pendingAnimationCommand && trackedAnimationCandidateId)) {
    setElementText(animationSummary, "正在生成动画，按顺序创建待机、站起、睡觉三段动作。");
  } else {
    setElementText(animationSummary, "当前没有待恢复的动画任务。");
  }

  if (imageGenerationState === "in_progress") {
    setElementText(canonicalStageStatus, "生成中");
  } else if (trackedAnimationCandidateId || batch) {
    setElementText(canonicalStageStatus, "已完成");
  } else {
    setElementText(canonicalStageStatus, "未开始");
  }

  setElementText(idleProgress, getActionProgressText(idleAction));
  setElementText(idleStatus, getActionStatusText(idleAction, batch));
  setElementText(standSitProgress, getActionProgressText(standSitAction));
  setElementText(standSitStatus, getActionStatusText(standSitAction, batch));
  setElementText(sleepProgress, getActionProgressText(sleepAction));
  setElementText(sleepStatus, getActionStatusText(sleepAction, batch));

  renderProgressFill("idle", idleAction);
  renderProgressFill("stand-sit", standSitAction);
  renderProgressFill("sleep", sleepAction);

  if (activeAnimationVersion && batch && batch.id === activeAnimationVersion) {
    setElementText(saveStageStatus, "已完成");
  } else if (batch?.status === "completed") {
    setElementText(saveStageStatus, "保存中");
  } else if (batch?.status === "failed") {
    setElementText(saveStageStatus, "未保存");
  } else if (batch?.status === "cancelled") {
    setElementText(saveStageStatus, "已取消");
  } else if (trackedAnimationCandidateId || batch) {
    setElementText(saveStageStatus, "等待保存");
  } else {
    setElementText(saveStageStatus, "未开始");
  }

  renderButtons();
}

function applyPhotoDataUrl(dataUrl, index) {
  if (!dataUrl) {
    return;
  }
  const slot = photoSlots[index];
  photoDataUrls[index] = dataUrl;
  if (slot?.querySelector) {
    const image = slot.querySelector("img");
    if (image) {
      image.src = dataUrl;
    }
  }
  slot?.classList?.add("has-photo");
}

function loadPhoto(file, index) {
  if (!file) {
    return;
  }

  if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
    setStatus("请选择 PNG、JPG 或 WebP 图片。", "error");
    return;
  }

  if (file.size > MAX_PHOTO_BYTES) {
    setStatus("照片不能超过 15MB。", "error");
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    applyPhotoDataUrl(reader.result, index);
    const readyCount = photoDataUrls.filter(Boolean).length;
    setStatus(`已准备 ${readyCount}/4 张照片。`, "success");
  });
  reader.readAsDataURL(file);
}

function registerPhotoEvents() {
  photoInputs.forEach((input) => {
    input.addEventListener("change", () => {
      loadPhoto(input.files[0], Number(input.dataset.index));
    });
  });

  photoSlots.forEach((slot) => {
    const index = Number(slot.dataset.index);
    slot.addEventListener("dragover", (event) => {
      event.preventDefault();
      slot.classList.add("is-dragging");
    });
    slot.addEventListener("dragleave", () => {
      slot.classList.remove("is-dragging");
    });
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      slot.classList.remove("is-dragging");
      loadPhoto(event.dataTransfer.files[0], index);
    });
  });
}

function registerApiGuideEvents() {
  const guideToggle = document.querySelector("#api-guide-toggle");
  const guideBody = document.querySelector("#api-guide-body");
  const guideTitle = document.querySelector('[data-i18n="guideTitle"]');
  const langButtons = document.querySelectorAll(".lang-button");
  const guideContents = document.querySelectorAll("[data-lang-content]");

  // 标题中英文文案
  const guideTitleText = {
    zh: "如何获取 API Key？",
    en: "How to get your API Key?"
  };

  // 折叠切换：toggle 引导内容显隐，并更新 aria-expanded 与 caret 方向
  guideToggle?.addEventListener("click", () => {
    if (!guideBody) {
      return;
    }
    const expanded = guideBody.hidden;
    guideBody.hidden = !expanded;
    guideToggle.setAttribute("aria-expanded", String(expanded));
    guideToggle.classList.toggle("is-open", expanded);
  });

  // 语言切换：按 data-lang 切换内容块与标题文案，默认中文
  langButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const lang = button.dataset.lang === "en" ? "en" : "zh";

      langButtons.forEach((item) => {
        item.classList.toggle("is-active", item.dataset.lang === lang);
      });

      guideContents.forEach((content) => {
        content.hidden = content.dataset.langContent !== lang;
      });

      if (guideTitle) {
        guideTitle.textContent = guideTitleText[lang];
      }
    });
  });
}

function syncAnimationBatch(batch) {
  if (batch) {
    currentAnimationBatch = batch;
    lastAnimationBatch = batch;
    trackedAnimationCandidateId = batch.id || trackedAnimationCandidateId;
    if (
      pendingAnimationCommand &&
      (!pendingAnimationCommand.candidateId || pendingAnimationCommand.candidateId === batch.id)
    ) {
      pendingAnimationCommand = null;
    }
    const failedAction = getFailedAnimationAction(batch);
    if (failedAction?.failure?.message) {
      setStatus(failedAction.failure.message, "error");
    } else if (batch.status === "cancelling") {
      setStatus("已取消后续动作，当前远端任务完成后会停止。", "success");
    } else if (batch.status === "cancelled") {
      setStatus("已取消后续动作，当前批次不会继续创建新任务。", "success");
    }
  } else {
    currentAnimationBatch = null;
  }

  finalizeCompletedAnimationState();
  renderAnimationProgress();
}

function applyAnimationRunResult(result) {
  if (result && typeof result.activeAnimationVersion === "string") {
    activeAnimationVersion = result.activeAnimationVersion;
  }
  if (result && Object.prototype.hasOwnProperty.call(result, "batch")) {
    currentAnimationBatch = result.batch || null;
    if (result.batch) {
      lastAnimationBatch = result.batch;
      trackedAnimationCandidateId = result.batch.id || trackedAnimationCandidateId;
    }
  }

  finalizeCompletedAnimationState();
  renderAnimationProgress();

  const batch = getDisplayAnimationBatch();
  if (!currentAnimationBatch && batch && activeAnimationVersion && batch.id === activeAnimationVersion) {
    setStatus("三段动画已保存到本地，新桌宠资源已可使用。", "success");
  } else if (batch?.status === "cancelled") {
    setStatus("已取消后续动作，当前批次不会继续创建新任务。", "success");
  }
}

function startPendingAnimationRun(candidateId, type = "start") {
  const generatePetAnimations = window.desktopPet?.generatePetAnimations;
  if (typeof generatePetAnimations !== "function") {
    renderAnimationProgress();
    return;
  }

  trackedAnimationCandidateId = candidateId || trackedAnimationCandidateId;
  pendingAnimationCommand = { type, candidateId: trackedAnimationCandidateId };
  renderAnimationProgress();

  generatePetAnimations(trackedAnimationCandidateId)
    .then((result) => {
      pendingAnimationCommand = null;
      applyAnimationRunResult(result || {});
    })
    .catch((error) => {
      pendingAnimationCommand = null;
      renderAnimationProgress();
      setStatus(error.message || "动画生成失败。", "error");
    });
}

async function runGeneration(source = "generate") {
  if (isBusy()) {
    setStatus("当前已有生成任务进行中，请等待当前任务结束。", "error");
    return;
  }

  if (photoDataUrls.some((photo) => !photo)) {
    setStatus("请添加正面、左侧、右侧和全身四张照片。", "error");
    return;
  }

  if (!apiKeyInput?.value && keyStatus?.dataset?.saved !== "true") {
    const provider = modelProviderSelect?.value || "openai";
    const providerName = provider === "bytedance" ? "Bytedance" : "OpenAI";
    setStatus(`生成宠物需要 ${providerName} API Key。`, "error");
    return;
  }

  isGeneratingPet = true;
  loadingSource = source;
  imageGenerationState = "in_progress";
  trackedAnimationCandidateId = "";
  pendingCandidateBatch = null;
  currentAnimationBatch = null;
  lastAnimationBatch = null;
  renderAnimationProgress();
  setStatus(
    `${source === "regenerate" ? "正在重新生成" : "正在生成"}桌面宠物，网络较慢时可能需要 10–30 分钟，请不要关闭窗口…`
  );

  try {
    const result = await window.desktopPet.generatePet({
      photoDataUrls,
      apiKey: apiKeyInput?.value || "",
      modelProvider: modelProviderSelect?.value || "openai",
      rememberApiKey: Boolean(rememberApiKeyInput?.checked)
    });
    pendingCandidateBatch = result.candidateBatch || null;
    trackedAnimationCandidateId = result.candidateBatch?.id || "";
    imageGenerationState = "completed";

    if (apiKeyInput?.value) {
      apiKeyInput.value = "";
      if (keyStatus) {
        keyStatus.dataset.saved = "true";
        keyStatus.textContent = "密钥已加密保存在本机并已验证";
      }
    }

    setStatus(
      hasGeneratedPet
        ? "标准图已完成，正在等待生成三段动画；旧宠物会继续显示。"
        : "标准图已完成，正在等待生成三段动画；动画完成后才会显示桌宠。",
      "success"
    );

    renderAnimationProgress();

    if (trackedAnimationCandidateId) {
      startPendingAnimationRun(trackedAnimationCandidateId, source === "regenerate" ? "retry" : "start");
    }
  } catch (error) {
    imageGenerationState = "idle";
    renderAnimationProgress();
    setStatus(
      error.message || "生成失败，之前保存的桌面宠物不会被替换。",
      "error"
    );
  } finally {
    if (apiKeyInput) {
      apiKeyInput.value = "";
    }
    isGeneratingPet = false;
    renderButtons();
  }
}

function resolveRetryCandidateId() {
  return pendingCandidateBatch?.id || getDisplayAnimationBatch()?.id || trackedAnimationCandidateId || "";
}

async function cancelPendingAnimations() {
  if (!canCancelPendingAnimations() || typeof window.desktopPet?.cancelPendingPetAnimations !== "function") {
    return;
  }

  pendingAnimationCommand = { type: "cancel", candidateId: trackedAnimationCandidateId };
  renderButtons();

  try {
    const result = await window.desktopPet.cancelPendingPetAnimations();
    pendingAnimationCommand = null;
    applyAnimationRunResult(result || {});
    const batch = getDisplayAnimationBatch();
    if (batch?.status === "cancelling" || batch?.status === "cancelled") {
      setStatus("已取消后续动作，当前批次不会继续创建新任务。", "success");
    }
  } catch (error) {
    pendingAnimationCommand = null;
    renderButtons();
    setStatus(error.message || "取消后续动作失败。", "error");
  }
}

function regenerateSingleAnimation(actionId) {
  if (!actionId || typeof actionId !== "string") {
    setStatus("无效的动作 ID。", "error");
    return;
  }

  if (pendingAnimationCommand || pendingCandidateBatch) {
    setStatus("已有动画任务进行中，请等待完成。", "error");
    return;
  }

  const regenerateSingleAnimationFn = window.desktopPet?.regenerateSingleAnimation;
  if (typeof regenerateSingleAnimationFn !== "function") {
    setStatus("当前版本缺少单个动作重生成接口，请重启应用后再试。", "error");
    return;
  }

  setStatus("正在重生成 " + actionId + " 动作...");
  regenerateSingleAnimationFn({ actionId })
    .then((result) => {
      applyAnimationRunResult(result || {});
      setStatus(actionId + " 动作已重生成完成。", "success");
    })
    .catch((error) => {
      setStatus("重生成 " + actionId + " 动作失败: " + (error?.message || "未知错误"), "error");
    });
}

function deleteAnimation(actionId) {
  if (!actionId || typeof actionId !== "string") {
    setStatus("无效的动作 ID。", "error");
    return;
  }

  if (pendingAnimationCommand || pendingCandidateBatch) {
    setStatus("已有动画任务进行中，请等待完成。", "error");
    return;
  }

  const deleteAnimationFn = window.desktopPet?.deleteAnimation;
  if (typeof deleteAnimationFn !== "function") {
    setStatus("当前版本缺少删除动作接口，请重启应用后再试。", "error");
    return;
  }

  setStatus("正在删除 " + actionId + " 动作...");
  deleteAnimationFn({ actionId })
    .then((result) => {
      renderAnimationPreviews(result?.activeAnimationPaths);
      setStatus(actionId + " 动作已删除。", "success");
    })
    .catch((error) => {
      setStatus("删除 " + actionId + " 动作失败: " + (error?.message || "未知错误"), "error");
    });
}

function openActionManager() {
  setElementHidden(actionManager, false);
  refreshAnimationPreviews();
}

// 重新抠图写回同名 webm，但 <video> 按 URL 缓存、renderAnimationPreviews 又会跳过
// 同 URL，故这里给指定动作（或全部）的预览 src 追加自增缓存破坏参数并强制 load，
// 让设置页立即看到新抠图效果。
function bustPreviewCache(activeAnimationPaths, actionIds) {
  cacheBuster += 1;
  const paths = activeAnimationPaths || {};
  const sources = {
    idle: paths.idle,
    "stand-sit": paths["stand-sit"] || paths.standSit,
    sleep: paths.sleep,
    "look-up": paths["look-up"],
    "roll-over": paths["roll-over"],
    run: paths.run,
    stretch: paths.stretch
  };
  for (const actionId of actionIds) {
    const video = previewVideos[actionId];
    const baseUrl = toFileUrl(sources[actionId]);
    if (video && baseUrl) {
      video.src = baseUrl + "?t=" + cacheBuster;
      video.load?.();
    }
  }
}

function rekeyAnimation(actionId) {
  if (pendingAnimationCommand || pendingCandidateBatch) {
    setStatus("已有动画任务进行中，请等待完成。", "error");
    return;
  }

  const rekeyAnimationFn = window.desktopPet?.rekeyAnimation;
  if (typeof rekeyAnimationFn !== "function") {
    setStatus("当前版本缺少重新抠图接口，请重启应用后再试。", "error");
    return;
  }

  const chromaSimilarity = chromaSlider ? Number(chromaSlider.value) : undefined;
  const target = actionId || "all";
  setStatus(target === "all" ? "正在用新强度重新抠图（全部动作）..." : "正在重新抠图 " + target + " ...");

  rekeyAnimationFn({ actionId: target, chromaSimilarity })
    .then((result) => {
      const touched = target === "all" ? Object.keys(previewVideos) : [target];
      bustPreviewCache(result?.activeAnimationPaths, touched);
      const failedCount = result?.failed?.length || 0;
      if (failedCount > 0) {
        setStatus("重新抠图完成，但有 " + failedCount + " 个动作失败。", "error");
      } else {
        setStatus("重新抠图完成。", "success");
      }
    })
    .catch((error) => {
      setStatus("重新抠图失败: " + (error?.message || "未知错误"), "error");
    });
}

function closeActionManager() {
  setElementHidden(actionManager, true);
  // 关闭时暂停所有预览视频，避免后台继续播放。
  for (const video of Object.values(previewVideos)) {
    video?.pause?.();
  }
}

function retryFailedAnimations() {
  if (!canRetryFailedAnimations()) {
    return;
  }

  const candidateId = resolveRetryCandidateId();
  if (!candidateId) {
    setStatus("缺少待重试的动画批次。", "error");
    return;
  }

  setStatus("正在重试失败动作；会复用当前标准图，不会重新生成图片。");
  const retryFailedPetAnimationAction = window.desktopPet?.retryFailedPetAnimationAction;
  if (typeof retryFailedPetAnimationAction !== "function") {
    setStatus("当前版本缺少失败动作重试接口，请重启应用后再试。", "error");
    return;
  }

  trackedAnimationCandidateId = candidateId;
  pendingAnimationCommand = { type: "retry", candidateId };
  renderAnimationProgress();

  retryFailedPetAnimationAction(candidateId)
    .then((result) => {
      pendingAnimationCommand = null;
      applyAnimationRunResult(result || {});
    })
    .catch((error) => {
      pendingAnimationCommand = null;
      renderAnimationProgress();
      setStatus(error.message || "重试失败动作失败。", "error");
    });
}

function registerDesktopPetEvents() {
  if (typeof window.desktopPet?.onPetGenerationProgress === "function") {
    window.desktopPet.onPetGenerationProgress((stage) => {
      if (stage === "image") {
        imageGenerationState = "in_progress";
        renderAnimationProgress();
      }
    });
  }

  if (typeof window.desktopPet?.onPetAnimationProgress === "function") {
    window.desktopPet.onPetAnimationProgress((batch) => {
      syncAnimationBatch(batch);
    });
  }
}

async function resumePendingAnimations() {
  if (typeof window.desktopPet?.resumePetAnimationJobs !== "function") {
    return;
  }

  pendingAnimationCommand = { type: "resume", candidateId: "" };
  renderButtons();

  try {
    const result = await window.desktopPet.resumePetAnimationJobs();
    pendingAnimationCommand = null;
    activeAnimationVersion = result?.activeAnimationVersion || activeAnimationVersion;
    if (result?.batch) {
      trackedAnimationCandidateId = result.batch.id || trackedAnimationCandidateId;
      currentAnimationBatch = result.batch;
      lastAnimationBatch = result.batch;
      pendingCandidateBatch = { id: trackedAnimationCandidateId };
    } else {
      currentAnimationBatch = null;
    }
    finalizeCompletedAnimationState();
    renderAnimationProgress();
  } catch (error) {
    pendingAnimationCommand = null;
    renderButtons();
    setStatus(error.message || "恢复动画任务失败。", "error");
  }
}

async function initialize() {
  registerDesktopPetEvents();

  const [settings, project] = await Promise.all([
    window.desktopPet.getApiSettings(),
    window.desktopPet.getPetProject()
  ]);

  if (keyStatus) {
    keyStatus.dataset.saved = String(settings.hasApiKey);
    keyStatus.textContent = settings.hasApiKey
      ? "密钥已加密保存在本机，生成前会验证"
      : "尚未保存密钥";
  }

  // 恢复上次保存的抠图强度到滑块与数值显示。
  if (chromaSlider && Number.isFinite(Number(settings.chromaSimilarity))) {
    chromaSlider.value = String(settings.chromaSimilarity);
    if (chromaValue) {
      chromaValue.textContent = Number(settings.chromaSimilarity).toFixed(2);
    }
  }

  // 恢复上次选择的模型提供商。
  if (modelProviderSelect && settings.modelProvider) {
    modelProviderSelect.value = settings.modelProvider;
    updateProviderDisplay(settings.modelProvider);
  }

  project.sourcePhotoDataUrls.slice(0, 4).forEach(applyPhotoDataUrl);
  hasGeneratedPet = project.hasPet;
  updateRegenerateVisibility();
  renderAnimationPreviews(project.appearance?.activeAnimationPaths);

  const readyCount = photoDataUrls.filter(Boolean).length;
  if (hasGeneratedPet) {
    setStatus(
      readyCount === 4
        ? "已恢复上次生成的宠物和四张原图，可直接重新生成。"
        : "已恢复上次生成的宠物；重新生成前请补齐四张照片。",
      "success"
    );
  }

  renderAnimationProgress();
  await resumePendingAnimations();
}

registerPhotoEvents();
registerApiGuideEvents();
registerPreviewEvents();
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  runGeneration("generate");
});
regenerateButton?.addEventListener("click", () => {
  runGeneration("regenerate");
});
cancelAnimationButton?.addEventListener("click", cancelPendingAnimations);
retryAnimationButton?.addEventListener("click", retryFailedAnimations);
openActionManagerButton?.addEventListener("click", openActionManager);
closeActionManagerButton?.addEventListener("click", closeActionManager);
chromaSlider?.addEventListener("input", () => {
  if (chromaValue) {
    chromaValue.textContent = Number(chromaSlider.value).toFixed(2);
  }
});
rekeyAllButton?.addEventListener("click", () => {
  rekeyAnimation("all");
});
// 模型提供商选择变化时，实时更新 UI 显示（图片和视频模型都会改）
modelProviderSelect?.addEventListener("change", () => {
  updateProviderDisplay(modelProviderSelect.value);
  if (apiKeyInput) {
    apiKeyInput.value = "";
  }
  window.desktopPet?.getApiSettings?.(modelProviderSelect.value)
    .then((providerSettings) => {
      if (!keyStatus) return;
      keyStatus.dataset.saved = String(Boolean(providerSettings?.hasApiKey));
      keyStatus.textContent = providerSettings?.hasApiKey
        ? "该供应商密钥已加密保存在本机"
        : "该供应商尚未保存密钥";
    })
    .catch(() => {
      if (keyStatus) {
        keyStatus.dataset.saved = "false";
        keyStatus.textContent = "无法读取该供应商的密钥状态";
      }
    });
});
actionManager?.addEventListener("click", (event) => {
  // 点击遮罩空白处（而非卡片内部）关闭模态。
  if (event.target === actionManager) {
    closeActionManager();
  }
});
document.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape" && actionManager && !actionManager.hidden) {
    closeActionManager();
  }
});

initialize().catch(() => {
  setStatus("无法读取本地设置。", "error");
});
