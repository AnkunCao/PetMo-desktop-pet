const test = require("node:test");
const assert = require("node:assert/strict");

test("渲染层动画路径只保留可播放动作，并把 standSit 映射为 stand-sit", async () => {
  const { normalizePlayableAnimationPaths } = await import("../src/renderer/animation-paths.mjs");

  assert.deepEqual(
    normalizePlayableAnimationPaths({
      directoryPath: "/tmp/active-v1",
      canonical: "/tmp/active-v1/canonical-sit.png",
      idle: "/tmp/active-v1/animation-idle.webm",
      standSit: "/tmp/active-v1/animation-stand-sit.webm",
      sleep: "/tmp/active-v1/animation-sleep.webm"
    }),
    {
      idle: "/tmp/active-v1/animation-idle.webm",
      "stand-sit": "/tmp/active-v1/animation-stand-sit.webm",
      sleep: "/tmp/active-v1/animation-sleep.webm"
    }
  );
});
