const test = require("node:test");
const assert = require("node:assert/strict");

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  function schedule(callback, delay = 0) {
    const id = nextId++;
    timers.set(id, {
      id,
      runAt: now + Math.max(0, delay),
      callback
    });
    return id;
  }

  function cancel(id) {
    timers.delete(id);
  }

  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const nextTimer = [...timers.values()]
        .sort((left, right) => left.runAt - right.runAt || left.id - right.id)[0];
      if (!nextTimer || nextTimer.runAt > target) {
        break;
      }
      timers.delete(nextTimer.id);
      now = nextTimer.runAt;
      nextTimer.callback();
    }
    now = target;
  }

  return {
    setTimeout: schedule,
    clearTimeout: cancel,
    advance
  };
}

test("动作控制器启动后保持 idle，仅在用户点击时过渡到随机动作", async () => {
  const { createAnimationController } = await import("../src/renderer/animation-controller.mjs");
  const clock = createFakeClock();
  const snapshots = [];
  const controller = createAnimationController({
    random: () => 0,
    transitionMs: 150,
    idleDelayRangeMs: { min: 1000, max: 1000 },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  controller.subscribe((state) => {
    snapshots.push({
      phase: state.phase,
      actionId: state.actionId,
      nextActionId: state.nextActionId ?? null,
      previousActionId: state.previousActionId ?? null,
      transitionMs: state.transitionMs
    });
  });

  controller.setAvailableActions({
    idle: "/tmp/idle.mp4",
    "stand-sit": "/tmp/stand-sit.mp4"
  });
  controller.start();

  assert.deepEqual(snapshots, [
    {
      phase: "idle",
      actionId: "idle",
      nextActionId: null,
      previousActionId: null,
      transitionMs: 150
    }
  ]);

  // 长时间等待，idle 状态不变（不再自动循环）
  clock.advance(5000);
  assert.equal(snapshots.length, 1);

  // 用户点击触发随机动作
  assert.equal(controller.triggerRandomAction(), "stand-sit");
  assert.deepEqual(snapshots[1], {
    phase: "transition-out",
    actionId: "idle",
    nextActionId: "stand-sit",
    previousActionId: null,
    transitionMs: 150
  });

  clock.advance(150);
  assert.deepEqual(snapshots[2], {
    phase: "action",
    actionId: "stand-sit",
    nextActionId: null,
    previousActionId: null,
    transitionMs: 150
  });

  // 动作完成，回到 idle
  assert.equal(controller.finishAction("stand-sit"), true);
  assert.deepEqual(snapshots[3], {
    phase: "transition-in",
    actionId: "idle",
    nextActionId: null,
    previousActionId: "stand-sit",
    transitionMs: 150
  });

  clock.advance(150);
  assert.deepEqual(snapshots[4], {
    phase: "idle",
    actionId: "idle",
    nextActionId: null,
    previousActionId: null,
    transitionMs: 150
  });

  // 回到 idle 后仍然不自动循环，再次等待无变化
  clock.advance(5000);
  assert.equal(snapshots.length, 5);
});

test("动作控制器只会从已下载动作中随机选择", async () => {
  const { createAnimationController } = await import("../src/renderer/animation-controller.mjs");
  const clock = createFakeClock();
  const snapshots = [];
  const controller = createAnimationController({
    random: () => 0.95,
    transitionMs: 150,
    idleDelayRangeMs: { min: 500, max: 500 },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  controller.subscribe((state) => snapshots.push(state));
  controller.setAvailableActions({
    idle: "/tmp/idle.mp4",
    "stand-sit": "",
    sleep: "/tmp/sleep.mp4"
  });
  controller.start();

  // 启动后保持 idle，不自动循环
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].phase, "idle");

  // 手动触发随机动作，应从已下载的动作中选择（sleep，idle 不算）
  assert.equal(controller.triggerRandomAction(), "sleep");
  assert.equal(snapshots[1].phase, "transition-out");
  assert.equal(snapshots[1].nextActionId, "sleep");
});
