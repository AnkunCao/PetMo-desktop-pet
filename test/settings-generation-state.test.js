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

async function runSuccessfulGeneration({ hasPet }) {
  const form = createElement();
  const apiKeyInput = createElement();
  const keyStatus = createElement();
  const generateButton = createElement();
  const saveButton = createElement();
  const regenerateButton = createElement();
  const status = createElement();
  const modelProviderSelect = createElement();
  modelProviderSelect.value = "bytedance";
  let generatePayload = null;
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
    ["#status", status]
    ,["#model-provider-select", modelProviderSelect]
  ]);
  const candidateBatch = {
    id: "candidate-1",
    referencePath: "/tmp/candidate-1/canonical-sit.png"
  };

  const context = {
    console,
    FileReader: class {},
    document: {
      querySelector(selector) {
        return selectors.get(selector);
      },
      querySelectorAll(selector) {
        return selector === ".photo-input" ? photoInputs : photoSlots;
      }
    },
    window: {
      desktopPet: {
        async generatePet(payload) {
          generatePayload = payload;
          return { generated: true, candidateBatch };
        },
        async getApiSettings() {
          return { model: "gpt-image-1.5", hasApiKey: true };
        },
        async getPetProject() {
          return {
            hasPet,
            sourcePhotoDataUrls: ["front", "left", "right", "full"]
          };
        },
        async saveApiSettings() {
          return { hasApiKey: true };
        }
      }
    },
    setImmediate
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "settings", "settings.js"), "utf8"),
    context
  );
  await flushMicrotasks();

  form.dispatch("submit", { preventDefault() {} });
  await flushMicrotasks();

  return { regenerateButton, status, generatePayload };
}

test("设置页没有旧宠物时说明动画完成后才显示桌宠", async () => {
  const { regenerateButton, status } = await runSuccessfulGeneration({ hasPet: false });

  assert.equal(regenerateButton.classList.contains("is-visible"), false);
  assert.match(status.textContent, /标准图已完成/);
  assert.match(status.textContent, /等待生成三段动画/);
  assert.match(status.textContent, /动画完成后才会显示桌宠/);
  assert.doesNotMatch(status.textContent, /旧宠物/);
  assert.doesNotMatch(status.textContent, /已开启|当前显示|已生成并保存/);
});

test("设置页生成请求显式携带当前模型供应商", async () => {
  const { generatePayload } = await runSuccessfulGeneration({ hasPet: true });
  assert.equal(generatePayload.modelProvider, "bytedance");
  assert.equal(generatePayload.rememberApiKey, false);
});

test("设置页有旧宠物时说明旧宠物继续显示", async () => {
  const { regenerateButton, status } = await runSuccessfulGeneration({ hasPet: true });

  assert.equal(regenerateButton.classList.contains("is-visible"), true);
  assert.match(status.textContent, /标准图已完成/);
  assert.match(status.textContent, /等待生成三段动画/);
  assert.match(status.textContent, /旧宠物会继续显示/);
  assert.doesNotMatch(status.textContent, /动画完成后才会显示桌宠/);
});
