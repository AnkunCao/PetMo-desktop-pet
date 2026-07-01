const test = require("node:test");
const assert = require("node:assert/strict");

function createMockElement(tagName) {
  return {
    tagName: tagName.toUpperCase(),
    className: "",
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    prepend(child) {
      child.parentNode = this;
      this.children.unshift(child);
      return child;
    },
    remove() {
      if (!this.parentNode) {
        return;
      }
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) {
        this.parentNode.children.splice(index, 1);
      }
      this.parentNode = null;
    }
  };
}

function createMockVideo() {
  const element = createMockElement("video");
  const listeners = new Map();

  return Object.assign(element, {
    muted: true,
    loop: false,
    playsInline: true,
    preload: "auto",
    readyState: 4,
    src: "",
    currentTime: 0,
    load() {
      queueMicrotask(() => this.dispatchEvent("loadeddata"));
    },
    play() {
      return Promise.resolve();
    },
    pause() {},
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      const callbacks = listeners.get(type) || [];
      listeners.set(
        type,
        callbacks.filter((item) => item !== callback)
      );
    },
    dispatchEvent(type) {
      const callbacks = listeners.get(type) || [];
      callbacks.slice().forEach((callback) => callback());
    }
  });
}

function createMockDocument() {
  const createdVideos = [];
  return {
    createdVideos,
    createElement(tagName) {
      if (tagName === "video") {
        const video = createMockVideo();
        createdVideos.push(video);
        return video;
      }
      return createMockElement(tagName);
    }
  };
}

test("视频播放器 API 会加载 idle，并拒绝未下载动作", async () => {
  const { createChromaVideoPlayer } = await import("../src/renderer/chroma-video-player.mjs");
  const document = createMockDocument();
  const container = createMockElement("div");
  container.clientWidth = 260;
  container.clientHeight = 250;

  const player = createChromaVideoPlayer({
    container,
    backgroundColor: "#00ff00",
    document
  });

  const loaded = await player.loadAnimationSet({
    idle: "/tmp/idle.webm",
    sleep: "/tmp/sleep.webm"
  });

  assert.deepEqual(loaded, {
    idle: "/tmp/idle.webm",
    sleep: "/tmp/sleep.webm"
  });
  assert.equal(document.createdVideos.length, 2);
  assert.equal(document.createdVideos[0].src, "/tmp/idle.webm");
  assert.equal(await player.playAction("stand-sit"), false);

  const playing = player.playAction("sleep");
  setImmediate(() => {
    document.createdVideos[1].dispatchEvent("ended");
  });
  await playing;
});

test("交叉淡化切换：动作播放时 action 层不透明，回到 idle 时 idle 层不透明", async () => {
  const { createChromaVideoPlayer } = await import("../src/renderer/chroma-video-player.mjs");
  const document = createMockDocument();
  const container = createMockElement("div");
  container.clientWidth = 260;
  container.clientHeight = 250;

  const player = createChromaVideoPlayer({ container, document });
  await player.loadAnimationSet({ idle: "/tmp/idle.webm", sleep: "/tmp/sleep.webm" });

  const [idleVideo, actionVideo] = document.createdVideos;
  // 初始：显示 idle 层。
  assert.equal(idleVideo.style.opacity, "1");
  assert.equal(actionVideo.style.opacity, "0");

  const playing = player.playAction("sleep");
  // playAction 内部有 await（加载、play），等微任务跑完后再断言淡化结果。
  await new Promise((resolve) => setImmediate(resolve));
  // 动作开始后淡入 action 层。
  assert.equal(actionVideo.style.opacity, "1");
  assert.equal(idleVideo.style.opacity, "0");
  actionVideo.dispatchEvent("ended");
  await playing;

  await player.playAction("idle");
  // 回到待机后淡回 idle 层。
  assert.equal(idleVideo.style.opacity, "1");
  assert.equal(actionVideo.style.opacity, "0");
});
