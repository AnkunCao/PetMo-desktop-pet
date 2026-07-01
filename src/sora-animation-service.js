const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const DEFAULT_POLL_WAIT_MS = 10_000;
const RETRY_DELAYS_MS = [10_000, 20_000, 40_000];
const ACTIVE_STATUSES = new Set(["queued", "in_progress"]);
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function toSecondsString(seconds) {
  return String(seconds);
}

function isRetryablePollError(error) {
  if (!error) {
    return false;
  }

  if (error.status === 429) {
    return true;
  }

  return ["APIConnectionError", "APIConnectionTimeoutError", "TypeError"].includes(
    error.name
  );
}

function createStopError() {
  return Object.assign(new Error("Sora 动画轮询已停止。"), {
    code: "SORA_POLL_STOPPED"
  });
}

function writeFileNoFollow(fsOps, filePath, content, validateBeforeWrite) {
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag;
  const descriptor = fsOps.openSync(filePath, flags, 0o600);
  try {
    if (typeof validateBeforeWrite === "function") {
      validateBeforeWrite(descriptor);
    }
    fsOps.writeSync(descriptor, content, 0, content.length, 0);
  } finally {
    fsOps.closeSync(descriptor);
  }
}

function assertCanContinue(shouldContinue) {
  if (typeof shouldContinue === "function" && !shouldContinue()) {
    throw createStopError();
  }
}

async function createSoraAnimationJob({ client, definition, referenceFile }) {
  const payload = {
    model: definition.model,
    prompt: definition.prompt,
    size: definition.size,
    seconds: toSecondsString(definition.seconds),
    input_reference: referenceFile
  };

  // seedance 系列（火山引擎）需要首尾帧都锚定到标准坐姿参考图，
  // 保证动画从坐姿开始、回到坐姿结束。
  if (definition.model && definition.model.toLowerCase().includes("seedance")) {
    payload.end_reference = referenceFile;
  }

  return client.videos.create(payload);
}

async function pollSoraAnimationJob({
  client,
  videoId,
  wait = async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onProgress,
  shouldContinue
}) {
  let retryCount = 0;

  while (true) {
    assertCanContinue(shouldContinue);

    let video;
    try {
      video = await client.videos.retrieve(videoId);
      retryCount = 0;
    } catch (error) {
      if (!isRetryablePollError(error)) {
        throw error;
      }

      const retryDelay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
      retryCount += 1;
      assertCanContinue(shouldContinue);
      await wait(retryDelay);
      continue;
    }

    if (typeof onProgress === "function") {
      onProgress(video);
    }

    if (TERMINAL_STATUSES.has(video.status)) {
      return video;
    }

    if (!ACTIVE_STATUSES.has(video.status)) {
      throw new Error(`未知的 Sora 视频状态：${video.status}`);
    }

    assertCanContinue(shouldContinue);
    await wait(DEFAULT_POLL_WAIT_MS);
  }
}

async function downloadSoraAnimation({
  client,
  videoId,
  destination,
  fsOps = fs,
  tempSuffix = `.tmp-${randomUUID()}`,
  assertDestinationSafe
}) {
  const response = await client.videos.downloadContent(videoId);
  const content = Buffer.from(await response.arrayBuffer());
  const temporaryPath = `${destination}${tempSuffix}`;

  if (typeof assertDestinationSafe === "function") {
    assertDestinationSafe(destination);
    assertDestinationSafe(temporaryPath);
  }

  fsOps.mkdirSync(path.dirname(destination), { recursive: true });

  try {
    if (typeof assertDestinationSafe === "function") {
      assertDestinationSafe(temporaryPath);
    }
    writeFileNoFollow(fsOps, temporaryPath, content, (descriptor) => {
      if (typeof assertDestinationSafe === "function") {
        assertDestinationSafe(temporaryPath, { mustExist: true, descriptor });
      }
    });
    if (typeof assertDestinationSafe === "function") {
      assertDestinationSafe(temporaryPath);
      assertDestinationSafe(destination);
    }
    fsOps.renameSync(temporaryPath, destination);
  } catch (error) {
    fsOps.rmSync(temporaryPath, { force: true });
    throw error;
  }

  return destination;
}

module.exports = {
  createSoraAnimationJob,
  pollSoraAnimationJob,
  downloadSoraAnimation,
  __testing: {
    DEFAULT_POLL_WAIT_MS,
    RETRY_DELAYS_MS,
    createStopError,
    isRetryablePollError
  }
};
