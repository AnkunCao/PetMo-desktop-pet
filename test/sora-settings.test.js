const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createElement() {
  const listeners = new Map();
  const classes = new Set();

  return {
    checked: false,
    dataset: {},
    disabled: false,
    files: [],
    hidden: false,
    src: "",
    textContent: "",
    value: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (force) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      }
    },
    querySelector() {
      return createElement();
    },
    dispatch(type, event = {}) {
      return listeners.get(type)?.(event);
    }
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createBatch({
  id = "candidate-1",
  status = "in_progress",
  candidateReady = false,
  actions
} = {}) {
  return {
    id,
    status,
    candidateReady,
    actions:
      actions || [
        {
          id: "idle",
          remoteTaskId: "vid-idle",
          progress: 100,
          status: "completed",
          failure: null
        },
        {
          id: "stand-sit",
          remoteTaskId: "vid-stand",
          progress: 42,
          status: "in_progress",
          failure: null
        },
        {
          id: "sleep",
          remoteTaskId: null,
          progress: 0,
          status: "queued",
          failure: null
        }
      ]
  };
}

function createSettingsHarness(options = {}) {
  const form = createElement();
  const apiKeyInput = createElement();
  const keyStatus = createElement();
  const generateButton = createElement();
  const saveButton = createElement();
  const regenerateButton = createElement();
  const status = createElement();
  const animationSummary = createElement();
  const canonicalStageStatus = createElement();
  const idleProgress = createElement();
  const idleStatus = createElement();
  const standProgress = createElement();
  const standStatus = createElement();
  const sleepProgress = createElement();
  const sleepStatus = createElement();
  const saveStageStatus = createElement();
  const cancelAnimationButton = createElement();
  const retryAnimationButton = createElement();
  const photoInputs = Array.from({ length: 4 }, (_, index) => {
    const input = createElement();
    input.dataset.index = String(index);
    return input;
  });
  const photoSlots = Array.from({ length: 4 }, (_, index) => {
    const slot = createElement();
    slot.dataset.index = String(index);
    return slot;
  });
  const selectors = new Map([
    ["#pet-form", form],
    ["#api-key", apiKeyInput],
    ["#key-status", keyStatus],
    ["#generate-button", generateButton],
    ["#save-button", saveButton],
    ["#regenerate-button", regenerateButton],
    ["#status", status],
    ["#animation-summary", animationSummary],
    ["#canonical-stage-status", canonicalStageStatus],
    ["#idle-progress", idleProgress],
    ["#idle-status", idleStatus],
    ["#stand-sit-progress", standProgress],
    ["#stand-sit-status", standStatus],
    ["#sleep-progress", sleepProgress],
    ["#sleep-status", sleepStatus],
    ["#save-stage-status", saveStageStatus],
    ["#cancel-animation-button", cancelAnimationButton],
    ["#retry-animation-button", retryAnimationButton]
  ]);

  let animationProgressListener = null;
  let generationProgressListener = null;
  let generatePetCalls = 0;
  let generateAnimationCalls = [];
  let retryAnimationCalls = [];
  let cancelCalls = 0;
  let resumeCalls = 0;

  const desktopPet = {
    async generatePet() {
      generatePetCalls += 1;
      return options.generatePetResult || {
        generated: true,
        candidateBatch: {
          id: "candidate-new",
          referencePath: "/tmp/candidate-new/canonical-sit.png"
        }
      };
    },
    async generatePetAnimations(candidateId) {
      generateAnimationCalls.push(candidateId);
      return options.generateAnimationsResult || {
        batch: options.retryBatch || null,
        activeAnimationVersion: ""
      };
    },
    async retryFailedPetAnimationAction(candidateId) {
      retryAnimationCalls.push(candidateId);
      return options.retryAnimationResult || {
        batch: options.retryBatch || null,
        activeAnimationVersion: ""
      };
    },
    async resumePetAnimationJobs() {
      resumeCalls += 1;
      return options.resumeResult || {
        batch: null,
        activeAnimationVersion: ""
      };
    },
    async cancelPendingPetAnimations() {
      cancelCalls += 1;
      return options.cancelResult || {
        batch: null,
        activeAnimationVersion: ""
      };
    },
    async getApiSettings() {
      return options.settings || {
        model: "gpt-image-1.5",
        hasApiKey: true
      };
    },
    async getPetProject() {
      return options.project || {
        hasPet: true,
        sourcePhotoDataUrls: ["front", "left", "right", "full"]
      };
    },
    async saveApiSettings() {
      return { hasApiKey: true };
    },
    onPetAnimationProgress(listener) {
      animationProgressListener = listener;
    },
    onPetGenerationProgress(listener) {
      generationProgressListener = listener;
    }
  };

  const context = {
    console,
    FileReader: class {},
    document: {
      querySelector(selector) {
        return selectors.get(selector) || null;
      },
      querySelectorAll(selector) {
        if (selector === ".photo-input") {
          return photoInputs;
        }
        if (selector === ".photo-slot") {
          return photoSlots;
        }
        return [];
      }
    },
    window: { desktopPet },
    setImmediate
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "settings", "settings.js"), "utf8"),
    context
  );

  return {
    form,
    status,
    animationSummary,
    canonicalStageStatus,
    idleProgress,
    idleStatus,
    standProgress,
    standStatus,
    sleepProgress,
    sleepStatus,
    saveStageStatus,
    generateButton,
    saveButton,
    regenerateButton,
    cancelAnimationButton,
    retryAnimationButton,
    get generatePetCalls() {
      return generatePetCalls;
    },
    get generateAnimationCalls() {
      return generateAnimationCalls;
    },
    get retryAnimationCalls() {
      return retryAnimationCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get resumeCalls() {
      return resumeCalls;
    },
    emitAnimationProgress(batch) {
      animationProgressListener?.(batch);
    },
    emitGenerationProgress(stage) {
      generationProgressListener?.(stage);
    }
  };
}

test("设置页 HTML 明确列出五个阶段、三个动作进度行和费用提示", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "settings", "index.html"),
    "utf8"
  );

  assert.match(html, /标准图/);
  assert.match(html, /待机/);
  assert.match(html, /站起/);
  assert.match(html, /睡觉/);
  assert.match(html, /本地保存/);
  assert.match(html, /一次图片生成和三次视频生成/);
  assert.match(html, /取消后续动作/);
  assert.match(html, /重试失败动作/);
  assert.match(html, /id="remember-api-key"[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /id="save-button"/);
  assert.doesNotMatch(html, />保存配置</);
});

test("设置窗口打开时恢复动画任务，显示百分比并在处理中禁用重复提交", async () => {
  const harness = createSettingsHarness({
    resumeResult: {
      batch: createBatch(),
      activeAnimationVersion: "active-v1"
    }
  });

  await flushMicrotasks();

  assert.equal(harness.resumeCalls, 1);
  assert.equal(harness.generateButton.disabled, true);
  assert.equal(harness.regenerateButton.disabled, true);
  assert.equal(harness.cancelAnimationButton.disabled, false);
  assert.equal(harness.cancelAnimationButton.hidden, false);
  assert.equal(harness.retryAnimationButton.disabled, true);
  assert.equal(harness.retryAnimationButton.hidden, true);
  assert.match(harness.animationSummary.textContent, /正在生成动画/);
  assert.match(harness.canonicalStageStatus.textContent, /已完成/);
  assert.equal(harness.idleProgress.textContent, "100%");
  assert.equal(harness.standProgress.textContent, "42%");
  assert.equal(harness.sleepProgress.textContent, "0%");
  assert.match(harness.standStatus.textContent, /生成中/);
  assert.match(harness.saveStageStatus.textContent, /等待保存/);

  harness.form.dispatch("submit", { preventDefault() {} });
  await flushMicrotasks();

  assert.equal(harness.generatePetCalls, 0);
});

test("失败后显示重试按钮，并只重试当前 pending candidate 的失败动作", async () => {
  const failedBatch = createBatch({
    status: "failed",
    actions: [
      {
        id: "idle",
        remoteTaskId: "vid-idle",
        progress: 100,
        status: "completed",
        failure: null
      },
      {
        id: "stand-sit",
        remoteTaskId: "vid-stand",
        progress: 58,
        status: "failed",
        failure: { message: "网络中断" }
      },
      {
        id: "sleep",
        remoteTaskId: null,
        progress: 0,
        status: "queued",
        failure: null
      }
    ]
  });
  const harness = createSettingsHarness();

  await flushMicrotasks();
  harness.emitAnimationProgress(failedBatch);
  await flushMicrotasks();

  assert.equal(harness.retryAnimationButton.disabled, false);
  assert.equal(harness.retryAnimationButton.hidden, false);
  assert.equal(harness.cancelAnimationButton.disabled, true);
  assert.equal(harness.cancelAnimationButton.hidden, true);
  assert.match(harness.animationSummary.textContent, /动画生成失败/);
  assert.match(harness.standStatus.textContent, /失败/);
  assert.match(harness.status.textContent, /网络中断/);

  harness.retryAnimationButton.dispatch("click");
  await flushMicrotasks();

  assert.deepEqual(harness.retryAnimationCalls, ["candidate-1"]);
  assert.deepEqual(harness.generateAnimationCalls, []);
  assert.equal(harness.generatePetCalls, 0);
});

test("点击取消按钮会取消尚未创建的后续动作", async () => {
  const cancelledBatch = createBatch({
    status: "cancelling",
    actions: [
      {
        id: "idle",
        remoteTaskId: "vid-idle",
        progress: 100,
        status: "completed",
        failure: null
      },
      {
        id: "stand-sit",
        remoteTaskId: "vid-stand",
        progress: 73,
        status: "in_progress",
        failure: null
      },
      {
        id: "sleep",
        remoteTaskId: null,
        progress: 0,
        status: "cancelled",
        failure: null
      }
    ]
  });
  const harness = createSettingsHarness({
    resumeResult: {
      batch: createBatch(),
      activeAnimationVersion: "active-v1"
    },
    cancelResult: {
      batch: cancelledBatch,
      activeAnimationVersion: "active-v1"
    }
  });

  await flushMicrotasks();
  harness.cancelAnimationButton.dispatch("click");
  await flushMicrotasks();

  assert.equal(harness.cancelCalls, 1);
  assert.match(harness.animationSummary.textContent, /已取消后续动作/);
  assert.match(harness.sleepStatus.textContent, /已取消/);
});
