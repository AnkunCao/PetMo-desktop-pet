const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANIMATION_DEFINITIONS,
  createAnimationBatch,
  advanceAnimationBatch,
  getNextPendingAction
} = require("../src/animation-config");

test("ANIMATION_DEFINITIONS lock the seven Sora actions and request shape", () => {
  assert.deepEqual(
    ANIMATION_DEFINITIONS.map((item) => item.id),
    ["idle", "stand-sit", "sleep", "look-up", "roll-over", "run", "stretch"]
  );
  assert.deepEqual(
    ANIMATION_DEFINITIONS.map((item) => item.model),
    ["sora-2", "sora-2", "sora-2", "sora-2", "sora-2", "sora-2", "sora-2"]
  );
  assert.deepEqual(
    ANIMATION_DEFINITIONS.map((item) => item.size),
    ["720x1280", "720x1280", "720x1280", "720x1280", "720x1280", "720x1280", "720x1280"]
  );
  assert.deepEqual(
    ANIMATION_DEFINITIONS.map((item) => item.seconds),
    [4, 8, 8, 6, 8, 6, 5]
  );
  assert.ok(ANIMATION_DEFINITIONS.every((item) => typeof item.prompt === "string"));
  assert.ok(
    ANIMATION_DEFINITIONS.every((item) =>
      [
        "同一只宠物",
        "固定镜头",
        "固定光线",
        "#00ff00",
        "不离开画面",
        "不增加道具",
        "回到标准坐姿"
      ].every((phrase) => item.prompt.includes(phrase))
    )
  );
});

test("createAnimationBatch seeds queued action state with remote task fields", () => {
  const batch = createAnimationBatch("canonical.png", "#00ff00");

  assert.equal(batch.referencePath, "canonical.png");
  assert.equal(batch.backgroundColor, "#00ff00");
  assert.equal(batch.status, "queued");
  assert.equal(batch.candidateReady, false);
  assert.equal(batch.cancellationRequested, false);
  assert.equal(batch.actions.length, 3);
  assert.deepEqual(batch.actions[0], {
    id: "idle",
    remoteTaskId: null,
    progress: 0,
    status: "queued",
    failure: null
  });
  assert.deepEqual(getNextPendingAction(batch), batch.actions[0]);
});

test("getNextPendingAction returns null while any action is active", () => {
  const batch = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });

  assert.equal(batch.actions[0].status, "in_progress");
  assert.equal(getNextPendingAction(batch), null);
});

test("getNextPendingAction returns the next queued action only after the previous one completes", () => {
  const submittedIdle = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });
  const completedIdle = advanceAnimationBatch(submittedIdle, {
    type: "completed",
    actionId: "idle"
  });

  assert.equal(getNextPendingAction(completedIdle).id, "stand-sit");
});

test("advanceAnimationBatch preserves remote ids, progress, and failure details", () => {
  const submitted = advanceAnimationBatch(
    createAnimationBatch("canonical.png", "#00ff00"),
    { type: "submitted", actionId: "idle", remoteTaskId: "vt_123" }
  );
  const progressed = advanceAnimationBatch(submitted, {
    type: "progress",
    actionId: "idle",
    progress: 37
  });
  const failed = advanceAnimationBatch(progressed, {
    type: "failed",
    actionId: "idle",
    message: "denied"
  });

  assert.equal(submitted.actions[0].remoteTaskId, "vt_123");
  assert.equal(submitted.actions[0].status, "in_progress");
  assert.equal(progressed.actions[0].progress, 37);
  assert.equal(progressed.actions[0].status, "in_progress");
  assert.equal(failed.status, "failed");
  assert.equal(failed.candidateReady, false);
  assert.deepEqual(failed.actions[0].failure, {
    message: "denied"
  });
});

test("advanceAnimationBatch rejects failed events while the action is still queued", () => {
  assert.throws(
    () =>
      advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
        type: "failed",
        actionId: "idle",
        message: "denied"
      }),
    /只有在进行中时才能失败/
  );
});

test("advanceAnimationBatch rejects out-of-order and non-current action events", () => {
  const batch = createAnimationBatch("canonical.png", "#00ff00");
  const submitted = advanceAnimationBatch(batch, {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });

  assert.throws(
    () =>
      advanceAnimationBatch(batch, {
        type: "submitted",
        actionId: "stand-sit",
        remoteTaskId: "vt_456"
      }),
    /当前动作/
  );

  assert.throws(
    () =>
      advanceAnimationBatch(submitted, {
        type: "completed",
        actionId: "stand-sit"
      }),
    /当前动作/
  );
});

test("advanceAnimationBatch cancel-remaining cancels every queued action in an idle batch", () => {
  const batch = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "cancel-remaining"
  });

  assert.equal(batch.status, "cancelled");
  assert.equal(batch.candidateReady, false);
  assert.deepEqual(
    batch.actions.map((action) => action.status),
    ["cancelled", "cancelled", "cancelled"]
  );
  assert.ok(batch.actions.every((action) => action.remoteTaskId === null));
  assert.equal(batch.cancellationRequested, true);
  assert.equal(getNextPendingAction(batch), null);
});

test("advanceAnimationBatch cancel-remaining keeps the current action alive until it finishes", () => {
  const submittedIdle = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });
  const cancelling = advanceAnimationBatch(submittedIdle, { type: "cancel-remaining" });
  const progressed = advanceAnimationBatch(cancelling, {
    type: "progress",
    actionId: "idle",
    progress: 37
  });
  const cancelled = advanceAnimationBatch(progressed, {
    type: "completed",
    actionId: "idle"
  });

  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.actions[0].status, "in_progress");
  assert.deepEqual(
    cancelling.actions.map((action) => action.status),
    ["in_progress", "cancelled", "cancelled"]
  );
  assert.equal(getNextPendingAction(cancelling), null);
  assert.equal(progressed.actions[0].progress, 37);
  assert.equal(progressed.status, "cancelling");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.candidateReady, false);
  assert.deepEqual(
    cancelled.actions.map((action) => action.status),
    ["completed", "cancelled", "cancelled"]
  );
});

test("advanceAnimationBatch cancel-remaining settles a final active action as cancelled", () => {
  const batch = advanceAnimationBatch(
    advanceAnimationBatch(
      advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
        type: "submitted",
        actionId: "idle",
        remoteTaskId: "vt_123"
      }),
      {
        type: "completed",
        actionId: "idle"
      }
    ),
    {
      type: "submitted",
      actionId: "stand-sit",
      remoteTaskId: "vt_456"
    }
  );
  const completedSecond = advanceAnimationBatch(batch, {
    type: "completed",
    actionId: "stand-sit"
  });
  const submittedThird = advanceAnimationBatch(completedSecond, {
    type: "submitted",
    actionId: "sleep",
    remoteTaskId: "vt_789"
  });
  const cancelling = advanceAnimationBatch(submittedThird, { type: "cancel-remaining" });
  const cancelled = advanceAnimationBatch(cancelling, {
    type: "completed",
    actionId: "sleep"
  });

  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.cancellationRequested, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.candidateReady, false);
  assert.equal(cancelled.cancellationRequested, true);
  assert.deepEqual(
    cancelled.actions.map((action) => action.status),
    ["completed", "completed", "completed"]
  );
});

test("advanceAnimationBatch cancel-remaining settles to cancelled when the current action fails", () => {
  const submittedIdle = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });
  const cancelling = advanceAnimationBatch(submittedIdle, { type: "cancel-remaining" });
  const failed = advanceAnimationBatch(cancelling, {
    type: "failed",
    actionId: "idle",
    message: "denied"
  });

  assert.equal(cancelling.status, "cancelling");
  assert.equal(failed.status, "cancelled");
  assert.equal(failed.candidateReady, false);
  assert.deepEqual(failed.actions[0].failure, {
    message: "denied"
  });
  assert.equal(failed.actions[0].status, "failed");
  assert.deepEqual(
    failed.actions.map((action) => action.status),
    ["failed", "cancelled", "cancelled"]
  );
});

test("advanceAnimationBatch cancelled settles an active action after cancellation was requested", () => {
  const submitted = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "video-idle"
  });
  const cancelling = advanceAnimationBatch(submitted, { type: "cancel-remaining" });
  const cancelled = advanceAnimationBatch(cancelling, {
    type: "cancelled",
    actionId: "idle"
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.candidateReady, false);
  assert.deepEqual(cancelled.actions.map((action) => action.status), [
    "cancelled",
    "cancelled",
    "cancelled"
  ]);
});

test("advanceAnimationBatch leaves no queued actions behind after cancel-remaining", () => {
  const submittedIdle = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });
  const cancelling = advanceAnimationBatch(submittedIdle, { type: "cancel-remaining" });
  const cancelled = advanceAnimationBatch(cancelling, {
    type: "completed",
    actionId: "idle"
  });

  assert.equal(cancelling.actions.some((action) => action.status === "queued"), false);
  assert.equal(cancelled.actions.some((action) => action.status === "queued"), false);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(getNextPendingAction(cancelled), null);
});

test("completed batches stay completed when late events arrive", () => {
  const submittedIdle = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });
  const completedIdle = advanceAnimationBatch(submittedIdle, {
    type: "completed",
    actionId: "idle"
  });
  const submittedStandSit = advanceAnimationBatch(completedIdle, {
    type: "submitted",
    actionId: "stand-sit",
    remoteTaskId: "vt_456"
  });
  const completedStandSit = advanceAnimationBatch(submittedStandSit, {
    type: "completed",
    actionId: "stand-sit"
  });
  const submittedSleep = advanceAnimationBatch(completedStandSit, {
    type: "submitted",
    actionId: "sleep",
    remoteTaskId: "vt_789"
  });
  const finished = advanceAnimationBatch(submittedSleep, {
    type: "completed",
    actionId: "sleep"
  });
  const stillFinished = advanceAnimationBatch(finished, { type: "cancel-remaining" });

  assert.equal(finished.status, "completed");
  assert.equal(finished.candidateReady, true);
  assert.equal(stillFinished.status, "completed");
  assert.equal(stillFinished.candidateReady, true);
  assert.deepEqual(stillFinished, finished);
});

test("advanceAnimationBatch marks candidateReady only after all actions complete", () => {
  const submittedIdle = advanceAnimationBatch(createAnimationBatch("canonical.png", "#00ff00"), {
    type: "submitted",
    actionId: "idle",
    remoteTaskId: "vt_123"
  });
  const afterIdle = advanceAnimationBatch(submittedIdle, {
    type: "completed",
    actionId: "idle"
  });
  const submittedStandSit = advanceAnimationBatch(afterIdle, {
    type: "submitted",
    actionId: "stand-sit",
    remoteTaskId: "vt_456"
  });
  const afterStandSit = advanceAnimationBatch(submittedStandSit, {
    type: "completed",
    actionId: "stand-sit"
  });
  const submittedSleep = advanceAnimationBatch(afterStandSit, {
    type: "submitted",
    actionId: "sleep",
    remoteTaskId: "vt_789"
  });
  const finished = advanceAnimationBatch(submittedSleep, {
    type: "completed",
    actionId: "sleep"
  });

  assert.equal(afterIdle.candidateReady, false);
  assert.equal(afterStandSit.candidateReady, false);
  assert.equal(finished.status, "completed");
  assert.equal(finished.candidateReady, true);
  assert.equal(getNextPendingAction(finished), null);
});

test("advanceAnimationBatch does not mutate the input batch deeply", () => {
  const batch = createAnimationBatch("canonical.png", "#00ff00");
  const before = JSON.parse(JSON.stringify(batch));

  advanceAnimationBatch(batch, {
    type: "cancel-remaining"
  });

  assert.deepEqual(batch, before);
});
