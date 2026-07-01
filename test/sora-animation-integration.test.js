const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const {
  ANIMATION_DEFINITIONS,
  createAnimationBatch,
  advanceAnimationBatch
} = require("../src/animation-config");
const {
  downloadSoraAnimation: downloadSoraAnimationWithRealService
} = require("../src/sora-animation-service");

function candidateId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function createCandidateBatch(userDataPath, batchId = candidateId(2)) {
  const directoryPath = path.join(userDataPath, "animation-candidates", batchId);
  fs.mkdirSync(directoryPath, { recursive: true });
  const referencePath = path.join(directoryPath, "canonical-sit.png");
  const sourcePath = path.join(directoryPath, "generated-pet.png");
  fs.writeFileSync(referencePath, Buffer.from("canonical"));
  fs.writeFileSync(sourcePath, Buffer.from("source"));
  return {
    id: batchId,
    directoryPath,
    referencePath,
    sourcePath,
    backgroundColor: "#00ff00"
  };
}

function loadMainModule(options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-task3-"));
  const configPath = path.join(userDataPath, "pet-config.json");
  const initialConfig = {
    model: "gpt-image-1.5",
    encryptedApiKey: Buffer.from("sk-" + "test-placeholder-abcdefghijklmnopqrstuvwxyz", "utf8").toString("base64"),
    currentPetPath: "",
    sourcePhotoPaths: [],
    activeAnimationVersion: "active-v1",
    activeAnimationPaths: {
      directoryPath: "/tmp/active-v1",
      canonical: "/tmp/active-v1/canonical-sit.png",
      idle: "/tmp/active-v1/animation-idle.mp4",
      standSit: "/tmp/active-v1/animation-stand-sit.mp4",
      sleep: "/tmp/active-v1/animation-sleep.mp4"
    },
    ...options.initialConfig
  };
  fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));

  const handlers = {};
  const sentEvents = [];
  const service = options.soraService || {};
  const openAIConstructorCalls = [];
  const quitListeners = {};
  let quitCalls = 0;
  const mainPath = path.join(__dirname, "..", "src", "main.js");
  delete require.cache[mainPath];

  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false;
      this.webContents = {
        send: (channel, ...args) => {
          sentEvents.push({ channel, args });
        }
      };
    }

    isDestroyed() {
      return this.destroyed;
    }

    show() {}

    focus() {}

    loadFile() {}

    on() {}

    setAlwaysOnTop() {}
  }

  FakeBrowserWindow.getAllWindows = () => [];

  const fakeElectron = {
    app: {
      getPath(name) {
        assert.equal(name, "userData");
        return userDataPath;
      },
      whenReady() {
        return {
          then(callback) {
            return Promise.resolve().then(callback);
          }
        };
      },
      on(event, listener) {
        quitListeners[event] = listener;
      },
      quit() {
        quitCalls += 1;
      },
      isReady() {
        return true;
      }
    },
    BrowserWindow: FakeBrowserWindow,
    Menu: { setApplicationMenu() {} },
    ipcMain: {
      handle(channel, handler) {
        handlers[channel] = handler;
      }
    },
    safeStorage: {
      isEncryptionAvailable() {
        return true;
      },
      encryptString(value) {
        return Buffer.from(value, "utf8");
      },
      decryptString(buffer) {
        return buffer.toString("utf8");
      }
    },
    nativeImage: {
      createFromPath() {
        return {
          isEmpty() {
            return true;
          }
        };
      }
    },
    session: {
      defaultSession: {
        resolveProxy: options.resolveProxy || (async () => "DIRECT")
      }
    },
    net: {
      fetch: async () => {
        throw new Error("fetch should not be called in tests");
      }
    }
  };

  class FakeOpenAI {
    constructor(configuration) {
      openAIConstructorCalls.push(configuration);
      this.videos = {};
    }
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, parent, isMain) {
    if (request === "electron") {
      return fakeElectron;
    }
    if (request === "openai") {
      // 主进程现在用 toFile 把标准坐姿图转成 Uploadable 传给 videos.create，
      // 所以这里委托给真实的 openai.toFile（用原始 loader 加载，避免递归）。
      const realOpenAI = originalLoad(request, parent, isMain);
      return Object.assign(FakeOpenAI, {
        toFile: realOpenAI.toFile
      });
    }
    if (request === "./sora-animation-service") {
      return {
        createSoraAnimationJob: service.createSoraAnimationJob || (async () => {
          throw new Error("missing createSoraAnimationJob stub");
        }),
        pollSoraAnimationJob: service.pollSoraAnimationJob || (async () => {
          throw new Error("missing pollSoraAnimationJob stub");
        }),
        downloadSoraAnimation: service.downloadSoraAnimation || (async () => {
          throw new Error("missing downloadSoraAnimation stub");
        })
      };
    }
    if (request === "./animation-baking") {
      // 测试里默认把烘焙替换成"把下载到的 mp4 复制成 webm"，
      // 避免对伪造的视频内容真正运行 ffmpeg。需要真实烘焙的用例可通过 options.baker 注入。
      return {
        bakeAnimation: options.baker || (async ({ inputPath, outputPath }) => {
          fs.copyFileSync(inputPath, outputPath);
          return outputPath;
        })
      };
    }
    return originalLoad(request, parent, isMain);
  };

  let mainModule;
  try {
    mainModule = require(mainPath);
  } finally {
    Module._load = originalLoad;
  }

  return {
    configPath,
    handlers,
    mainModule,
    openAIConstructorCalls,
    quitListeners,
    get quitCalls() {
      return quitCalls;
    },
    sentEvents,
    userDataPath,
    readConfig() {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("generate-pet-animations 严格串行生成并在全部文件可读后原子切换 activeAnimationVersion", async () => {
  let harness;
  const sequence = [];
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        sequence.push(`create:${definition.id}`);
        return {
          id: `vid-${definition.id}`,
          status: "queued"
        };
      },
      async pollSoraAnimationJob({ videoId, onProgress }) {
        sequence.push(`poll:${videoId}`);
        onProgress({
          id: videoId,
          status: "queued",
          progress: 0,
          error: null
        });
        assert.equal(
          harness.readConfig().pendingAnimationBatch.actions.find((action) => action.remoteTaskId === videoId)
            .status,
          "in_progress"
        );
        onProgress({
          id: videoId,
          status: "in_progress",
          progress: 57,
          error: null
        });
        assert.equal(
          harness.readConfig().pendingAnimationBatch.actions.find((action) => action.remoteTaskId === videoId)
            .progress,
          57
        );
        return {
          id: videoId,
          status: "completed",
          progress: 100,
          error: null
        };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        sequence.push(`download:${videoId}`);
        fs.writeFileSync(destination, Buffer.from(videoId));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(2));
  const configBeforeGenerate = harness.readConfig();
  configBeforeGenerate.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(configBeforeGenerate, null, 2));
  await flushMicrotasks();

  const result = await harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });

  assert.equal(result.activeAnimationVersion, candidateBatch.id);
  assert.deepEqual(sequence, [
    "create:idle",
    "poll:vid-idle",
    "download:vid-idle",
    "create:stand-sit",
    "poll:vid-stand-sit",
    "download:vid-stand-sit",
    "create:sleep",
    "poll:vid-sleep",
    "download:vid-sleep"
  ]);
  const config = harness.readConfig();
  const realCandidateDirectory = fs.realpathSync(candidateBatch.directoryPath);
  assert.equal(config.activeAnimationVersion, candidateBatch.id);
  assert.deepEqual(config.activeAnimationPaths, {
    directoryPath: realCandidateDirectory,
    canonical: path.join(realCandidateDirectory, "canonical-sit.png"),
    idle: path.join(realCandidateDirectory, "animation-idle.webm"),
    standSit: path.join(realCandidateDirectory, "animation-stand-sit.webm"),
    sleep: path.join(realCandidateDirectory, "animation-sleep.webm")
  });
  assert.equal(config.pendingAnimationBatch, null);
});

test("generate-pet-animations 向服务层传递完整动画 definition", async () => {
  const receivedDefinitions = [];
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        receivedDefinitions.push({ ...definition });
        return {
          id: `vid-${definition.id}`,
          status: "queued"
        };
      },
      async pollSoraAnimationJob({ videoId }) {
        return {
          id: videoId,
          status: "completed",
          progress: 100,
          error: null
        };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        fs.writeFileSync(destination, Buffer.from(videoId));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(30));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });

  assert.deepEqual(receivedDefinitions[0], {
    id: "idle",
    model: "sora-2",
    prompt: ANIMATION_DEFINITIONS[0].prompt,
    size: "720x1280",
    seconds: 4
  });
  assert.deepEqual(
    receivedDefinitions.map(({ id, seconds }) => ({ id, seconds })),
    [
      { id: "idle", seconds: 4 },
      { id: "stand-sit", seconds: 8 },
      { id: "sleep", seconds: 8 }
    ]
  );
});

test("resume-pet-animation-jobs 只补完已有远端任务，不自动创建 queued 动作", async () => {
  const pendingBatch = advanceAnimationBatch(
    createAnimationBatch("canonical-sit.png", "#00ff00"),
    { type: "submitted", actionId: "idle", remoteTaskId: "vid-idle" }
  );
  const sequence = [];
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...pendingBatch,
        id: candidateId(3),
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob({ definition }) {
        sequence.push(`create:${definition.id}`);
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        sequence.push(`poll:${videoId}`);
        return {
          id: videoId,
          status: "completed",
          progress: 100,
          error: null
        };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        sequence.push(`download:${videoId}`);
        fs.writeFileSync(destination, Buffer.from(videoId));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(3));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  config.pendingAnimationBatch.directoryPath = "/tmp/renderer-controlled-directory";
  config.pendingAnimationBatch.referencePath = "/tmp/renderer-controlled-reference.png";
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const result = await harness.handlers["resume-pet-animation-jobs"]();

  assert.equal(result.batch.actions[0].status, "completed");
  assert.equal(result.batch.actions[1].status, "queued");
  assert.equal(result.batch.actions[2].status, "queued");
  assert.equal(result.activeAnimationVersion, "active-v1");
  assert.deepEqual(sequence, [
    "poll:vid-idle",
    "download:vid-idle"
  ]);
  const saved = harness.readConfig();
  assert.equal(saved.pendingAnimationBatch.actions[0].status, "completed");
  assert.equal(saved.pendingAnimationBatch.actions[1].status, "queued");
  assert.equal(saved.pendingAnimationBatch.actions[2].status, "queued");
  assert.equal(saved.activeAnimationVersion, "active-v1");
});

test("resume-pet-animation-jobs 对全 queued 批次不创建远端任务", async () => {
  let createCalls = 0;
  const pendingBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...pendingBatch,
        id: candidateId(36),
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "unexpected" };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(36));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const result = await harness.handlers["resume-pet-animation-jobs"]();

  assert.equal(createCalls, 0);
  assert.equal(result.batch.actions[0].status, "queued");
  assert.equal(result.activeAnimationVersion, "active-v1");
});

test("generate-pet-animations 接管 pending batch 时找不到动作 definition 会失败且不发起 create", async () => {
  const pendingBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  pendingBatch.actions[0].id = "missing-definition";
  let createCalls = 0;
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...pendingBatch,
        id: candidateId(31),
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "vid-should-not-exist" };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(31));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  config.pendingAnimationBatch.directoryPath = candidateBatch.directoryPath;
  config.pendingAnimationBatch.referencePath = candidateBatch.referencePath;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /找不到动作 missing-definition 对应的动画定义/
  );

  assert.equal(createCalls, 0);
  const saved = harness.readConfig().pendingAnimationBatch;
  assert.equal(saved.status, "failed");
  assert.equal(saved.actions[0].status, "failed");
  assert.equal(saved.actions[0].failure.message, "找不到动作 missing-definition 对应的动画定义。");
});

test("cancel-pending-pet-animations 只取消未提交动作，当前远端任务继续收尾", async () => {
  const pendingBatch = advanceAnimationBatch(
    createAnimationBatch("canonical-sit.png", "#00ff00"),
    { type: "submitted", actionId: "idle", remoteTaskId: "vid-idle" }
  );
  let releasePoll;
  const created = [];
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...pendingBatch,
        id: candidateId(4),
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob({ definition }) {
        created.push(definition.id);
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        await new Promise((resolve) => {
          releasePoll = resolve;
        });
        return {
          id: videoId,
          status: "completed",
          progress: 100,
          error: null
        };
      },
      async downloadSoraAnimation({ destination }) {
        fs.writeFileSync(destination, Buffer.from("done"));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(4));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  config.pendingAnimationBatch.directoryPath = candidateBatch.directoryPath;
  config.pendingAnimationBatch.referencePath = candidateBatch.referencePath;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["resume-pet-animation-jobs"]();
  await flushMicrotasks();
  const cancelled = await harness.handlers["cancel-pending-pet-animations"]();
  releasePoll();
  const result = await running;

  assert.equal(cancelled.batch.status, "cancelling");
  assert.deepEqual(created, []);
  assert.equal(result.batch.status, "cancelled");
  assert.deepEqual(
    result.batch.actions.map((action) => action.status),
    ["completed", "cancelled", "cancelled"]
  );
  assert.equal(harness.readConfig().activeAnimationVersion, "active-v1");
});

test("create 未返回时 cancel-pending-pet-animations 仍保留取消状态且不会继续创建后续动作", async () => {
  let releaseCreate;
  const createCalls = [];
  const pollCalls = [];
  const downloadCalls = [];
  let harness;
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createCalls.push(definition.id);
        await new Promise((resolve) => {
          releaseCreate = resolve;
        });
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId, onProgress }) {
        pollCalls.push(videoId);
        const duringPoll = harness.readConfig().pendingAnimationBatch;
        assert.equal(duringPoll.cancellationRequested, true);
        assert.deepEqual(
          duringPoll.actions.map((action) => action.status),
          ["in_progress", "cancelled", "cancelled"]
        );
        onProgress({
          id: videoId,
          status: "in_progress",
          progress: 61,
          error: null
        });
        return {
          id: videoId,
          status: "completed",
          progress: 100,
          error: null
        };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        downloadCalls.push(videoId);
        fs.writeFileSync(destination, Buffer.from(videoId));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(29));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });
  await flushMicrotasks();

  const cancelled = await harness.handlers["cancel-pending-pet-animations"]();
  assert.equal(cancelled.batch.status, "cancelled");
  assert.deepEqual(
    cancelled.batch.actions.map((action) => action.status),
    ["cancelled", "cancelled", "cancelled"]
  );

  releaseCreate();
  const result = await running;
  const saved = harness.readConfig();

  assert.deepEqual(createCalls, ["idle"]);
  assert.deepEqual(pollCalls, ["vid-idle"]);
  assert.deepEqual(downloadCalls, ["vid-idle"]);
  assert.equal(result.activeAnimationVersion, "active-v1");
  assert.equal(saved.activeAnimationVersion, "active-v1");
  assert.equal(result.batch.status, "cancelled");
  assert.equal(saved.pendingAnimationBatch.status, "cancelled");
  assert.equal(saved.pendingAnimationBatch.cancellationRequested, true);
  assert.deepEqual(
    result.batch.actions.map((action) => action.status),
    ["cancelled", "cancelled", "cancelled"]
  );
  assert.equal(result.batch.actions[0].remoteTaskId, "vid-idle");
});

test("代理解析挂起时已落盘 pending batch，可立即取消且不会创建远端任务", async () => {
  let releaseProxy;
  const createCalls = [];
  const harness = loadMainModule({
    resolveProxy: async () =>
      new Promise((resolve) => {
        releaseProxy = () => resolve("DIRECT");
      }),
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createCalls.push(definition.id);
        return { id: `vid-${definition.id}` };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(32));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });
  await flushMicrotasks();

  const persistedBeforeCancel = harness.readConfig().pendingAnimationBatch;
  assert.equal(persistedBeforeCancel.id, candidateBatch.id);
  assert.equal(persistedBeforeCancel.status, "queued");

  const cancelled = await harness.handlers["cancel-pending-pet-animations"]();
  assert.equal(cancelled.batch.status, "cancelled");
  assert.deepEqual(
    cancelled.batch.actions.map((action) => action.status),
    ["cancelled", "cancelled", "cancelled"]
  );

  releaseProxy();
  const result = await running;
  const saved = harness.readConfig();

  assert.deepEqual(createCalls, []);
  assert.equal(result.activeAnimationVersion, "active-v1");
  assert.equal(result.batch.status, "cancelled");
  assert.equal(saved.activeAnimationVersion, "active-v1");
  assert.equal(saved.pendingAnimationBatch.status, "cancelled");
});

test("generate-pet-animations 将 403 映射为 Videos/Sora 权限中文错误", async () => {
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(5));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /Videos API 或 Sora 模型访问权限/
  );
  assert.equal(harness.readConfig().activeAnimationVersion, "active-v1");
});

test("generate-pet-animations 将 401 映射为 API Key 中文错误", async () => {
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(6));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /API Key 无效/
  );
});

test("generate-pet-animations 将 429 映射为限流中文错误且不重复创建任务", async () => {
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(7));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /暂时限流/
  );
  assert.equal(createCalls, 1);
});

test("generate-pet-animations 将网络超时映射为中文错误并保留旧 active 版本", async () => {
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob() {
        throw Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(8));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /无法通过直连连接 OpenAI Videos API/
  );
  assert.equal(harness.readConfig().activeAnimationVersion, "active-v1");
});

test("generate-pet-animations 将远端 failed 状态映射为中文错误", async () => {
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return {
          id: videoId,
          status: "failed",
          progress: 81,
          error: { message: "pose mismatch" }
        };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(9));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /Sora 动画生成失败：pose mismatch/
  );
});

test("generate-pet-animations 将下载失败映射为中文错误", async () => {
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return {
          id: videoId,
          status: "completed",
          progress: 100,
          error: null
        };
      },
      async downloadSoraAnimation() {
        throw new Error("disk full");
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(10));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /Sora 动画下载失败：disk full/
  );
});

test("应用退出会停止后续 wait 和 create，保留当前远端任务 ID 供下次恢复", async () => {
  const created = [];
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        created.push(definition.id);
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ wait }) {
        await wait(30_000);
        return {
          id: "vid-idle",
          status: "completed",
          progress: 100,
          error: null
        };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(11));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });
  await flushMicrotasks();
  harness.quitListeners["before-quit"]?.();
  const result = await running;

  assert.deepEqual(created, ["idle"]);
  assert.equal(result.batch.actions[0].remoteTaskId, "vid-idle");
  assert.equal(result.batch.actions[0].status, "in_progress");
  assert.equal(result.batch.actions[1].status, "queued");
  assert.equal(result.activeAnimationVersion, "active-v1");
});

test("generate-pet-animations 忽略 renderer 传入路径并只使用配置中的候选目录", async () => {
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-external-"));
  const externalReference = path.join(externalDir, "uploaded-secret.png");
  const externalOutput = path.join(externalDir, "animation-idle.mp4");
  fs.writeFileSync(externalReference, Buffer.from("renderer-controlled-secret"));
  const referencePayloads = [];
  const downloadDestinations = [];
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition, referenceFile }) {
        const bytes = referenceFile ? Buffer.from(await referenceFile.arrayBuffer()) : Buffer.alloc(0);
        referencePayloads.push(bytes);
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        downloadDestinations.push(destination);
        fs.writeFileSync(destination, Buffer.from(videoId));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(12));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id,
    candidateBatch: {
      id: candidateBatch.id,
      directoryPath: externalDir,
      referencePath: externalReference,
      sourcePath: externalReference
    },
    directoryPath: externalDir,
    referencePath: externalReference
  });

  assert.equal(referencePayloads.every((value) => value.equals(Buffer.from("canonical"))), true);
  assert.equal(referencePayloads.some((value) => value.equals(Buffer.from("renderer-controlled-secret"))), false);
  const realCandidateDirectory = fs.realpathSync(candidateBatch.directoryPath);
  assert.equal(downloadDestinations.every((value) => value.startsWith(realCandidateDirectory)), true);
  assert.equal(fs.existsSync(externalOutput), false);
  assert.deepEqual(fs.readFileSync(externalReference), Buffer.from("renderer-controlled-secret"));
});

test("generate-pet-animations 拒绝路径穿越形式的候选 id", async () => {
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "unexpected" };
      }
    }
  });
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: "../../outside" }),
    /候选批次 ID 无效/
  );
  assert.equal(createCalls, 0);
});

test("generate-pet-animations 拒绝指向同根其他批次的目录 symlink", async () => {
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "unexpected" };
      }
    }
  });
  const sourceBatch = createCandidateBatch(harness.userDataPath, candidateId(19));
  const targetBatch = createCandidateBatch(harness.userDataPath, candidateId(20));
  fs.rmSync(sourceBatch.directoryPath, { recursive: true, force: true });
  fs.symlinkSync(targetBatch.directoryPath, sourceBatch.directoryPath, "dir");
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: sourceBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: sourceBatch.id }),
    /候选动画资源路径无效或已被替换/
  );
  assert.equal(createCalls, 0);
});

test("generate-pet-animations 拒绝 symlink canonical 参考图", async () => {
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "unexpected" };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(27));
  const alternateReference = path.join(candidateBatch.directoryPath, "alternate.png");
  fs.writeFileSync(alternateReference, Buffer.from("alternate"));
  fs.rmSync(candidateBatch.referencePath);
  fs.symlinkSync(alternateReference, candidateBatch.referencePath);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /候选动画资源路径无效或已被替换/
  );
  assert.equal(createCalls, 0);
});

test("generate-pet-animations 在读 reference 前若文件被替换为 symlink，则拒绝 create", async () => {
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "vid-idle" };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ destination }) {
        fs.writeFileSync(destination, Buffer.from("unexpected"));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(28));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-reference-swap-"));
  const externalReference = path.join(externalDir, "outside.png");
  fs.writeFileSync(externalReference, Buffer.from("outside"));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const originalOpenSync = fs.openSync;
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  const candidateReferencePaths = new Set([
    candidateBatch.referencePath,
    path.join(fs.realpathSync(candidateBatch.directoryPath), "canonical-sit.png")
  ]);
  function swapReferenceIfNeeded(filePath) {
    if (!swapped && candidateReferencePaths.has(filePath)) {
      swapped = true;
      fs.rmSync(candidateBatch.referencePath);
      fs.symlinkSync(externalReference, candidateBatch.referencePath);
    }
  }
  fs.openSync = function patchedOpenSync(filePath, ...args) {
    swapReferenceIfNeeded(filePath);
    return originalOpenSync.call(this, filePath, ...args);
  };
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    swapReferenceIfNeeded(filePath);
    return originalReadFileSync.call(this, filePath, ...args);
  };

  let rejection;
  try {
    await harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id });
  } catch (error) {
    rejection = error;
  } finally {
    fs.openSync = originalOpenSync;
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(swapped, true);
  assert.match(rejection?.message || "", /候选动画资源路径无效或已被替换/);
  assert.equal(createCalls, 0);
});

test("resume-pet-animation-jobs 在 candidate 与 animation id 不一致时拒绝并保留配置", async () => {
  const pendingBatch = advanceAnimationBatch(
    createAnimationBatch("malicious.png", "#00ff00"),
    { type: "submitted", actionId: "idle", remoteTaskId: "vid-idle" }
  );
  const harness = loadMainModule({
    initialConfig: {
      pendingCandidateBatch: { id: candidateId(21) },
      pendingAnimationBatch: { ...pendingBatch, id: candidateId(22) }
    }
  });
  const before = harness.readConfig();
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["resume-pet-animation-jobs"](),
    /候选批次与动画批次 ID 不一致/
  );
  assert.deepEqual(harness.readConfig(), before);
});

test("下载前候选目录被替换为 symlink 时拒绝写入", async () => {
  let downloadCalls = 0;
  let harness;
  const batchId = candidateId(23);
  const targetId = candidateId(24);
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        return { id: "vid-idle" };
      },
      async pollSoraAnimationJob({ videoId }) {
        const candidateDir = path.join(harness.userDataPath, "animation-candidates", batchId);
        const targetDir = path.join(harness.userDataPath, "animation-candidates", targetId);
        fs.rmSync(candidateDir, { recursive: true, force: true });
        fs.symlinkSync(targetDir, candidateDir, "dir");
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation() {
        downloadCalls += 1;
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  createCandidateBatch(harness.userDataPath, targetId);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /候选动画资源路径无效或已被替换/
  );
  assert.equal(downloadCalls, 0);
  assert.equal(
    fs.existsSync(path.join(harness.userDataPath, "animation-candidates", targetId, "animation-idle.mp4")),
    false
  );
});

test("主流程预检后候选目录被替换为 symlink 时不会越界写入 temp 或 mp4", async () => {
  const batchId = candidateId(30);
  const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-download-target-"));
  let downloadAttempts = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        return { id: "vid-idle" };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation(options) {
        downloadAttempts += 1;
        const candidateDir = path.join(harness.userDataPath, "animation-candidates", batchId);
        fs.rmSync(candidateDir, { recursive: true, force: true });
        fs.symlinkSync(symlinkTarget, candidateDir, "dir");
        return downloadSoraAnimationWithRealService({
          ...options,
          client: {
            videos: {
              async downloadContent() {
                return {
                  async arrayBuffer() {
                    return Uint8Array.from([1, 2, 3]).buffer;
                  }
                };
              }
            }
          },
          tempSuffix: ".tmp-escape"
        });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /候选动画资源路径无效或已被替换/
  );

  assert.equal(downloadAttempts, 1);
  assert.equal(fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4")), false);
  assert.equal(fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4.tmp-escape")), false);
  assert.equal(harness.readConfig().activeAnimationVersion, "active-v1");
});

test("视频临时文件写入时候选目录被替换为 symlink 也不会越界写入", async (t) => {
  const originalWriteSync = fs.writeSync;
  t.after(() => {
    fs.writeSync = originalWriteSync;
  });

  const batchId = candidateId(37);
  const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-download-write-target-"));
  let downloadAttempts = 0;
  let harness;
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        return { id: "vid-idle" };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation(options) {
        downloadAttempts += 1;
        return downloadSoraAnimationWithRealService({
          ...options,
          client: {
            videos: {
              async downloadContent() {
                return {
                  async arrayBuffer() {
                    return Buffer.from("video-bytes").buffer;
                  }
                };
              }
            }
          },
          tempSuffix: ".tmp-write-race"
        });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  fs.writeSync = function patchedWriteSync(descriptor, buffer, ...rest) {
    if (Buffer.isBuffer(buffer) && buffer.includes(Buffer.from("video-bytes"))) {
      const candidateDir = path.join(harness.userDataPath, "animation-candidates", batchId);
      fs.rmSync(candidateDir, { recursive: true, force: true });
      fs.symlinkSync(symlinkTarget, candidateDir, "dir");
    }
    return originalWriteSync.call(fs, descriptor, buffer, ...rest);
  };
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: batchId }),
    /候选动画资源路径无效或已被替换|Sora 动画下载失败/
  );
  assert.equal(downloadAttempts, 1);
  assert.equal(fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4.tmp-write-race")), false);
  assert.equal(fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4")), false);
});

test("视频临时文件 open 前候选目录被替换为 symlink 也不会写入外部内容", async (t) => {
  const originalOpenSync = fs.openSync;
  const originalWriteSync = fs.writeSync;
  t.after(() => {
    fs.openSync = originalOpenSync;
    fs.writeSync = originalWriteSync;
  });

  const batchId = candidateId(38);
  const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-download-open-target-"));
  let swapped = false;
  let wroteExternalContent = false;
  let harness;
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        return { id: "vid-idle" };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation(options) {
        return downloadSoraAnimationWithRealService({
          ...options,
          client: {
            videos: {
              async downloadContent() {
                return {
                  async arrayBuffer() {
                    return Buffer.from("video-bytes").buffer;
                  }
                };
              }
            }
          },
          tempSuffix: ".tmp-open-race"
        });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  fs.openSync = function patchedOpenSync(filePath, flags, ...rest) {
    if (
      !swapped &&
      typeof filePath === "string" &&
      filePath.endsWith("animation-idle.mp4.tmp-open-race")
    ) {
      swapped = true;
      const candidateDir = path.join(harness.userDataPath, "animation-candidates", batchId);
      fs.rmSync(candidateDir, { recursive: true, force: true });
      fs.symlinkSync(symlinkTarget, candidateDir, "dir");
    }
    return originalOpenSync.call(fs, filePath, flags, ...rest);
  };
  fs.writeSync = function patchedWriteSync(descriptor, buffer, ...rest) {
    if (
      Buffer.isBuffer(buffer) &&
      buffer.includes(Buffer.from("video-bytes")) &&
      fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4.tmp-open-race"))
    ) {
      wroteExternalContent = true;
    }
    return originalWriteSync.call(fs, descriptor, buffer, ...rest);
  };
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: batchId }),
    /候选动画资源路径无效或已被替换|Sora 动画下载失败/
  );
  assert.equal(wroteExternalContent, false);
  assert.equal(fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4.tmp-open-race")), false);
  assert.equal(fs.existsSync(path.join(symlinkTarget, "animation-idle.mp4")), false);
});

test("generate-pet-animations 并发时复用同批次，拒绝不同批次", async () => {
  let releasePoll;
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createCalls += 1;
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        await new Promise((resolve) => {
          releasePoll = resolve;
        });
        return { id: videoId, status: "failed", progress: 10, error: { message: "stop" } };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(13));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const first = harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id });
  const sameBatch = harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id });
  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateId(14) }),
    /已有动画生成任务进行中/
  );
  await flushMicrotasks();
  assert.equal(createCalls, 1);
  releasePoll();
  await assert.rejects(first, /Sora 动画生成失败/);
  await assert.rejects(sameBatch, /Sora 动画生成失败/);
});

test("cancel 后 poll 异常使当前动作收敛为 cancelled", async () => {
  const pendingBatch = advanceAnimationBatch(
    createAnimationBatch("canonical-sit.png", "#00ff00"),
    { type: "submitted", actionId: "idle", remoteTaskId: "vid-idle" }
  );
  let rejectPoll;
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...pendingBatch,
        id: candidateId(15),
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async pollSoraAnimationJob() {
        return new Promise((_resolve, reject) => {
          rejectPoll = reject;
        });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(15));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  config.pendingAnimationBatch.directoryPath = candidateBatch.directoryPath;
  config.pendingAnimationBatch.referencePath = candidateBatch.referencePath;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["resume-pet-animation-jobs"]();
  await flushMicrotasks();
  await harness.handlers["cancel-pending-pet-animations"]();
  rejectPoll(new Error("connection reset after cancel"));
  const result = await running;

  assert.equal(result.batch.status, "cancelled");
  assert.equal(result.batch.candidateReady, false);
  assert.deepEqual(result.batch.actions.map((action) => action.status), [
    "cancelled",
    "cancelled",
    "cancelled"
  ]);
});

test("create 进行中退出会等待远端 ID 持久化后再 quit", async () => {
  let resolveCreate;
  let pollCalls = 0;
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      },
      async pollSoraAnimationJob() {
        pollCalls += 1;
        throw new Error("poll must not run during shutdown");
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(16));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id });
  await flushMicrotasks();
  let prevented = false;
  harness.quitListeners["before-quit"]?.({
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(harness.quitCalls, 0);
  resolveCreate({ id: "vid-created-before-quit" });
  const result = await running;
  await flushMicrotasks();

  const saved = harness.readConfig().pendingAnimationBatch;
  assert.equal(saved.actions[0].remoteTaskId, "vid-created-before-quit");
  assert.equal(saved.actions[0].status, "in_progress");
  assert.equal("directoryPath" in saved, false);
  assert.equal("referencePath" in saved, false);
  assert.equal("sourcePath" in saved, false);
  assert.equal(result.batch.actions[0].remoteTaskId, "vid-created-before-quit");
  assert.equal(createCalls, 1);
  assert.equal(pollCalls, 0);
  assert.equal(harness.quitCalls, 1);
});

test("create 成功后配置写入失败时恢复使用已记录 remoteTaskId 且不重复 create", async (t) => {
  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  const createdActions = [];
  const pollCalls = [];
  let sawInMemoryRemoteTaskId = false;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createdActions.push(definition.id);
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        pollCalls.push(videoId);
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        fs.writeFileSync(destination, Buffer.from(videoId));
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(33));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  fs.renameSync = function patchedRenameSync(fromPath, toPath, ...rest) {
    if (toPath === harness.configPath) {
      const pendingConfig = JSON.parse(fs.readFileSync(fromPath, "utf8"));
      const remoteTaskId = pendingConfig.pendingAnimationBatch?.actions?.[0]?.remoteTaskId;
      if (remoteTaskId === "vid-idle") {
        const runState = harness.mainModule.__testing.getAnimationRunState();
        assert.equal(runState.currentBatch.actions[0].remoteTaskId, "vid-idle");
        assert.equal(runState.currentBatch.actions[0].status, "in_progress");
        sawInMemoryRemoteTaskId = true;
        throw new Error("config rename failed");
      }
    }
    return originalRenameSync.call(fs, fromPath, toPath, ...rest);
  };

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /config rename failed/
  );

  const saved = harness.readConfig().pendingAnimationBatch;
  assert.equal(sawInMemoryRemoteTaskId, true);
  assert.deepEqual(createdActions, ["idle"]);
  assert.equal(saved.actions[0].status, "queued");
  assert.equal(saved.actions[0].remoteTaskId, null);

  fs.renameSync = originalRenameSync;
  const result = await harness.handlers["resume-pet-animation-jobs"]();

  assert.deepEqual(createdActions, ["idle"]);
  assert.equal(pollCalls[0], "vid-idle");
  assert.equal(result.activeAnimationVersion, "active-v1");
  assert.equal(result.batch.actions[0].status, "completed");
  assert.equal(result.batch.actions[1].status, "queued");

  const completed = await harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });
  assert.deepEqual(createdActions, ["idle", "stand-sit", "sleep"]);
  assert.equal(completed.activeAnimationVersion, candidateBatch.id);
});

test("retry-failed-pet-animation-action 保留已完成动作并只从失败动作继续生成", async () => {
  const batchId = candidateId(40);
  const failedBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  failedBatch.id = batchId;
  failedBatch.actions[0] = {
    ...failedBatch.actions[0],
    status: "completed",
    remoteTaskId: "old-idle",
    progress: 100
  };
  failedBatch.actions[1] = {
    ...failedBatch.actions[1],
    status: "failed",
    remoteTaskId: "old-stand",
    progress: 61,
    failure: { message: "pose mismatch" }
  };
  failedBatch.status = "failed";
  const createdActions = [];
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...failedBatch,
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createdActions.push(definition.id);
        return { id: `new-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ destination }) {
        fs.writeFileSync(destination, Buffer.from("video"));
        return destination;
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  fs.writeFileSync(path.join(candidateBatch.directoryPath, "animation-idle.webm"), Buffer.from("old-idle"));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const result = await harness.handlers["retry-failed-pet-animation-action"](null, {
    candidateId: batchId
  });

  assert.deepEqual(createdActions, ["stand-sit", "sleep"]);
  assert.equal(result.activeAnimationVersion, batchId);
  const saved = harness.readConfig();
  assert.equal(saved.pendingAnimationBatch, null);
  assert.equal(saved.activeAnimationVersion, batchId);
});

test("retry-failed-pet-animation-action 在首个 create 返回前会保留 failed 批次供下次重试", async () => {
  const batchId = candidateId(42);
  let releaseCreate;
  let createCalls = 0;
  const failedBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  failedBatch.id = batchId;
  failedBatch.actions[0] = {
    ...failedBatch.actions[0],
    status: "completed",
    remoteTaskId: "old-idle",
    progress: 100
  };
  failedBatch.actions[1] = {
    ...failedBatch.actions[1],
    status: "failed",
    remoteTaskId: "old-stand",
    progress: 61,
    failure: { message: "pose mismatch" }
  };
  failedBatch.status = "failed";
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...failedBatch,
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        if (createCalls === 1) {
          await new Promise((resolve) => {
            releaseCreate = resolve;
          });
          return { id: "new-stand" };
        }
        return { id: "new-sleep" };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ destination }) {
        fs.writeFileSync(destination, Buffer.from("video"));
        return destination;
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  fs.writeFileSync(path.join(candidateBatch.directoryPath, "animation-idle.webm"), Buffer.from("old-idle"));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["retry-failed-pet-animation-action"](null, {
    candidateId: batchId
  });
  await flushMicrotasks();

  const savedDuringCreate = harness.readConfig();
  assert.equal(savedDuringCreate.pendingAnimationBatch.status, "failed");
  assert.equal(savedDuringCreate.pendingAnimationBatch.actions[1].status, "failed");

  releaseCreate();
  await running;
});

test("retry-failed-pet-animation-action 配置写失败后恢复使用新 receipt 且不重复 create", async (t) => {
  const originalRenameSync = fs.renameSync;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  const batchId = candidateId(43);
  const failedBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  failedBatch.id = batchId;
  failedBatch.actions[0] = {
    ...failedBatch.actions[0],
    status: "completed",
    remoteTaskId: "old-idle",
    progress: 100
  };
  failedBatch.actions[1] = {
    ...failedBatch.actions[1],
    status: "failed",
    remoteTaskId: "old-stand",
    progress: 61,
    failure: { message: "pose mismatch" }
  };
  failedBatch.status = "failed";
  const createdActions = [];
  const pollCalls = [];
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...failedBatch,
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createdActions.push(definition.id);
        return { id: `new-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        pollCalls.push(videoId);
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ destination }) {
        fs.writeFileSync(destination, Buffer.from("video"));
        return destination;
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  fs.writeFileSync(path.join(candidateBatch.directoryPath, "animation-idle.mp4"), Buffer.from("old-idle"));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  fs.renameSync = function patchedRenameSync(fromPath, toPath, ...rest) {
    if (toPath === harness.configPath) {
      const pendingConfig = JSON.parse(fs.readFileSync(fromPath, "utf8"));
      const retryAction = pendingConfig.pendingAnimationBatch?.actions?.[1];
      if (retryAction?.remoteTaskId === "new-stand-sit") {
        throw new Error("retry config rename failed");
      }
    }
    return originalRenameSync.call(fs, fromPath, toPath, ...rest);
  };

  await assert.rejects(
    harness.handlers["retry-failed-pet-animation-action"](null, { candidateId: batchId }),
    /retry config rename failed/
  );
  assert.deepEqual(createdActions, ["stand-sit"]);
  assert.equal(harness.readConfig().pendingAnimationBatch.actions[1].status, "failed");

  fs.renameSync = originalRenameSync;
  const result = await harness.handlers["resume-pet-animation-jobs"]();

  assert.deepEqual(createdActions, ["stand-sit"]);
  assert.equal(pollCalls[0], "new-stand-sit");
  assert.equal(result.batch.actions[1].status, "completed");
  assert.equal(result.batch.actions[2].status, "queued");
});

test("resume-pet-animation-jobs 拒绝悬空 symlink 远端提交记录且不创建新任务", async () => {
  let createCalls = 0;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "unexpected" };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(34));
  const pendingBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  config.pendingAnimationBatch = {
    ...pendingBatch,
    id: candidateBatch.id,
    directoryPath: "",
    referencePath: ""
  };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  fs.symlinkSync(
    path.join(candidateBatch.directoryPath, "missing-receipt.json"),
    path.join(candidateBatch.directoryPath, "animation-submissions.json")
  );
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["resume-pet-animation-jobs"](),
    /动画远端任务记录无效或已被替换/
  );
  assert.equal(createCalls, 0);
});

test("远端提交记录写入时候选目录被替换为 symlink 也不会越界写入", async (t) => {
  const originalWriteSync = fs.writeSync;
  t.after(() => {
    fs.writeSync = originalWriteSync;
  });

  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-receipt-symlink-"));
  let createCalls = 0;
  const batchId = candidateId(35);
  let harness;
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        createCalls += 1;
        return { id: "vid-idle" };
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  fs.writeSync = function patchedWriteSync(descriptor, buffer, ...rest) {
    if (Buffer.isBuffer(buffer) && buffer.includes(Buffer.from("vid-idle"))) {
      const candidateDir = path.join(harness.userDataPath, "animation-candidates", batchId);
      fs.rmSync(candidateDir, { recursive: true, force: true });
      fs.symlinkSync(externalDir, candidateDir, "dir");
    }
    return originalWriteSync.call(fs, descriptor, buffer, ...rest);
  };
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: batchId }),
    /候选动画资源路径无效或已被替换|动画远端任务记录无效或已被替换/
  );
  assert.equal(createCalls, 1);
  assert.equal(fs.existsSync(path.join(externalDir, "animation-submissions.json")), false);
  assert.equal(
    fs.readdirSync(externalDir).some((item) => item.startsWith(".animation-submissions-")),
    false
  );
});

test("同 candidate 终态重试写入新 receipt 时会丢弃旧后续远端任务", async () => {
  const batchId = candidateId(39);
  const createdActions = [];
  let staleReceiptObserved = false;
  const pendingBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  const terminalBatch = {
    ...pendingBatch,
    id: batchId,
    status: "failed",
    actions: pendingBatch.actions.map((action) => ({
      ...action,
      status: "failed",
      remoteTaskId: `old-${action.id}`
    }))
  };
  const harness = loadMainModule({
    initialConfig: {
      pendingAnimationBatch: {
        ...terminalBatch,
        directoryPath: "",
        referencePath: ""
      }
    },
    soraService: {
      async createSoraAnimationJob({ definition }) {
        createdActions.push(definition.id);
        if (definition.id === "stand-sit") {
          const receipt = JSON.parse(fs.readFileSync(
            path.join(harness.userDataPath, "animation-candidates", batchId, "animation-submissions.json"),
            "utf8"
          ));
          staleReceiptObserved = Boolean(
            receipt.actions["stand-sit"]?.remoteTaskId === "old-stand" ||
            receipt.actions.sleep?.remoteTaskId === "old-sleep"
          );
          throw new Error("stop before second action");
        }
        return { id: `new-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ destination }) {
        fs.writeFileSync(destination, Buffer.from("video"));
        return destination;
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, batchId);
  const receiptPath = path.join(candidateBatch.directoryPath, "animation-submissions.json");
  fs.writeFileSync(receiptPath, JSON.stringify({
    batchId,
    actions: {
      idle: { remoteTaskId: "old-idle" },
      "stand-sit": { remoteTaskId: "old-stand" },
      sleep: { remoteTaskId: "old-sleep" }
    }
  }));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: batchId }),
    /stop before second action/
  );
  assert.deepEqual(createdActions, ["idle", "stand-sit"]);
  assert.equal(staleReceiptObserved, false);
});

test("退出期间下载异常不会把已提交动作误标为 failed", async () => {
  let rejectDownload;
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob() {
        return { id: "vid-idle" };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation() {
        return new Promise((_resolve, reject) => {
          rejectDownload = reject;
        });
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(18));
  const config = harness.readConfig();
  config.pendingCandidateBatch = candidateBatch;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const running = harness.handlers["generate-pet-animations"](null, {
    candidateId: candidateBatch.id
  });
  await flushMicrotasks();
  harness.quitListeners["before-quit"]?.({ preventDefault() {} });
  rejectDownload(new Error("download interrupted by shutdown"));
  const result = await running;

  assert.equal(result.batch.actions[0].status, "in_progress");
  assert.equal(result.batch.actions[0].failure, null);
  assert.equal(harness.readConfig().pendingAnimationBatch.status, "in_progress");
});

test("旧 batch finalize 不会清理不同 id 的新 pendingCandidateBatch", async () => {
  let harness;
  const oldId = candidateId(25);
  const newId = candidateId(26);
  harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        fs.writeFileSync(destination, Buffer.from(videoId));
        if (videoId === "vid-sleep") {
          const config = harness.readConfig();
          config.pendingCandidateBatch = { id: newId };
          fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
        }
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, oldId);
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: oldId };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await harness.handlers["generate-pet-animations"](null, { candidateId: oldId });

  const saved = harness.readConfig();
  assert.equal(saved.activeAnimationVersion, oldId);
  assert.deepEqual(saved.pendingCandidateBatch, { id: newId });
  assert.equal(saved.pendingAnimationBatch, null);
  assert.equal(candidateBatch.id, oldId);
});

test("finalize 前如果 candidate 内 webm 被替换为 symlink，则拒绝激活并保留旧 active", async () => {
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-finalize-symlink-"));
  const externalVideo = path.join(externalDir, "outside.mp4");
  fs.writeFileSync(externalVideo, Buffer.from("outside-video"));
  const harness = loadMainModule({
    soraService: {
      async createSoraAnimationJob({ definition }) {
        return { id: `vid-${definition.id}` };
      },
      async pollSoraAnimationJob({ videoId }) {
        return { id: videoId, status: "completed", progress: 100, error: null };
      },
      async downloadSoraAnimation({ videoId, destination }) {
        fs.writeFileSync(destination, Buffer.from(videoId));
        if (videoId === "vid-sleep") {
          const idlePath = path.join(path.dirname(destination), "animation-idle.webm");
          fs.rmSync(idlePath);
          fs.symlinkSync(externalVideo, idlePath);
        }
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(29));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  await assert.rejects(
    harness.handlers["generate-pet-animations"](null, { candidateId: candidateBatch.id }),
    /候选动画资源路径无效或已被替换/
  );

  const saved = harness.readConfig();
  assert.equal(saved.activeAnimationVersion, "active-v1");
  assert.deepEqual(saved.activeAnimationPaths, {
    directoryPath: "/tmp/active-v1",
    canonical: "/tmp/active-v1/canonical-sit.png",
    idle: "/tmp/active-v1/animation-idle.mp4",
    standSit: "/tmp/active-v1/animation-stand-sit.mp4",
    sleep: "/tmp/active-v1/animation-sleep.mp4"
  });
  assert.equal(saved.pendingAnimationBatch.status, "completed");
  assert.equal(saved.pendingAnimationBatch.id, candidateBatch.id);
});

test("resume-pet-animation-jobs 对仅差 finalize 的 completed batch 不要求 API Key", async () => {
  let completedBatch = createAnimationBatch("canonical-sit.png", "#00ff00");
  for (const definition of ANIMATION_DEFINITIONS) {
    completedBatch = advanceAnimationBatch(completedBatch, {
      type: "submitted",
      actionId: definition.id,
      remoteTaskId: `vid-${definition.id}`
    });
    completedBatch = advanceAnimationBatch(completedBatch, {
      type: "completed",
      actionId: definition.id
    });
  }

  const harness = loadMainModule({
    initialConfig: {
      encryptedApiKey: "",
      pendingAnimationBatch: {
        ...completedBatch,
        id: candidateId(32),
        directoryPath: "",
        referencePath: ""
      }
    }
  });
  const candidateBatch = createCandidateBatch(harness.userDataPath, candidateId(32));
  fs.writeFileSync(path.join(candidateBatch.directoryPath, "animation-idle.webm"), Buffer.from("idle"));
  fs.writeFileSync(
    path.join(candidateBatch.directoryPath, "animation-stand-sit.webm"),
    Buffer.from("stand-sit")
  );
  fs.writeFileSync(path.join(candidateBatch.directoryPath, "animation-sleep.webm"), Buffer.from("sleep"));
  const config = harness.readConfig();
  config.pendingCandidateBatch = { id: candidateBatch.id };
  config.pendingAnimationBatch.directoryPath = candidateBatch.directoryPath;
  config.pendingAnimationBatch.referencePath = candidateBatch.referencePath;
  fs.writeFileSync(harness.configPath, JSON.stringify(config, null, 2));
  await flushMicrotasks();

  const result = await harness.handlers["resume-pet-animation-jobs"]();

  assert.equal(result.batch, null);
  assert.equal(result.activeAnimationVersion, candidateBatch.id);
  assert.equal(harness.openAIConstructorCalls.length, 0);
  const saved = harness.readConfig();
  assert.equal(saved.pendingAnimationBatch, null);
  assert.equal(saved.activeAnimationVersion, candidateBatch.id);
});

test("preload generatePetAnimations 只向主进程传递 candidate id", async () => {
  const preloadPath = path.join(__dirname, "..", "src", "preload.js");
  delete require.cache[preloadPath];
  const invocations = [];
  let exposedApi;
  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, parent, isMain) {
    if (request === "electron") {
      return {
        contextBridge: {
          exposeInMainWorld(_name, api) {
            exposedApi = api;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            invocations.push({ channel, payload });
          },
          on() {}
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
  }

  exposedApi.generatePetAnimations(candidateId(17));
  exposedApi.retryFailedPetAnimationAction(candidateId(41));
  assert.deepEqual(invocations, [
    {
      channel: "generate-pet-animations",
      payload: { candidateId: candidateId(17) }
    },
    {
      channel: "retry-failed-pet-animation-action",
      payload: { candidateId: candidateId(41) }
    }
  ]);
});
