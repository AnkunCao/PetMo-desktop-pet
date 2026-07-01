const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ANIMATION_DEFINITIONS } = require("../src/animation-config");
const {
  createSoraAnimationJob,
  pollSoraAnimationJob,
  downloadSoraAnimation
} = require("../src/sora-animation-service");

function createVideo(overrides = {}) {
  return {
    id: "vid_123",
    object: "video",
    created_at: 1,
    completed_at: null,
    expires_at: null,
    error: null,
    model: "sora-2",
    progress: 0,
    prompt: "prompt",
    remixed_from_video_id: null,
    seconds: "4",
    size: "720x1280",
    status: "queued",
    ...overrides
  };
}

test("createSoraAnimationJob 使用 SDK 6.44 videos.create 支持的参考图参数", async () => {
  const requests = [];
  const client = {
    videos: {
      async create(payload) {
        requests.push(payload);
        return createVideo({ id: "vid_idle" });
      }
    }
  };

  const referenceFile = { name: "canonical-sit.png", __isUploadable: true };
  const video = await createSoraAnimationJob({
    client,
    definition: ANIMATION_DEFINITIONS[0],
    referenceFile
  });

  assert.equal(video.id, "vid_idle");
  assert.deepEqual(requests, [
    {
      model: "sora-2",
      prompt: ANIMATION_DEFINITIONS[0].prompt,
      size: "720x1280",
      seconds: "4",
      input_reference: referenceFile
    }
  ]);
});

test("pollSoraAnimationJob 按 queued -> in_progress -> completed 轮询，并默认每次等待 10 秒", async () => {
  const retrievedIds = [];
  const waits = [];
  const progressEvents = [];
  const responses = [
    createVideo({ status: "queued", progress: 0 }),
    createVideo({ status: "in_progress", progress: 45 }),
    createVideo({ status: "completed", progress: 100, completed_at: 2 })
  ];
  const client = {
    videos: {
      async retrieve(videoId) {
        retrievedIds.push(videoId);
        return responses.shift();
      }
    }
  };

  const result = await pollSoraAnimationJob({
    client,
    videoId: "vid_queued",
    wait: async (ms) => {
      waits.push(ms);
    },
    onProgress: (video) => {
      progressEvents.push({ status: video.status, progress: video.progress });
    }
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(retrievedIds, ["vid_queued", "vid_queued", "vid_queued"]);
  assert.deepEqual(waits, [10000, 10000]);
  assert.deepEqual(progressEvents, [
    { status: "queued", progress: 0 },
    { status: "in_progress", progress: 45 },
    { status: "completed", progress: 100 }
  ]);
});

test("pollSoraAnimationJob 对网络错误按 10/20/40 秒退避并在 429 时只继续 retrieve", async () => {
  const retrieves = [];
  const waits = [];
  const errors = [
    Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }),
    Object.assign(new Error("rate limited"), { status: 429 }),
    Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" })
  ];
  const client = {
    videos: {
      async retrieve(videoId) {
        retrieves.push(videoId);
        if (errors.length) {
          throw errors.shift();
        }
        return createVideo({ id: videoId, status: "completed", progress: 100, completed_at: 2 });
      }
    }
  };

  const result = await pollSoraAnimationJob({
    client,
    videoId: "vid_retry",
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(retrieves, ["vid_retry", "vid_retry", "vid_retry", "vid_retry"]);
  assert.deepEqual(waits, [10000, 20000, 40000]);
});

test("pollSoraAnimationJob 在远端 failed 时返回失败状态和错误详情", async () => {
  const progressEvents = [];
  const client = {
    videos: {
      async retrieve() {
        return createVideo({
          id: "vid_failed",
          status: "failed",
          progress: 72,
          error: {
            code: "video_generation_failed",
            message: "pose mismatch"
          }
        });
      }
    }
  };

  const result = await pollSoraAnimationJob({
    client,
    videoId: "vid_failed",
    wait: async () => {},
    onProgress: (video) => progressEvents.push(video.status)
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.message, "pose mismatch");
  assert.deepEqual(progressEvents, ["failed"]);
});

test("downloadSoraAnimation 先写临时文件再原子替换正式文件", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-sora-download-"));
  const destination = path.join(tempDir, "animation-idle.mp4");
  const opened = [];
  const renames = [];
  const client = {
    videos: {
      async downloadContent(videoId) {
        assert.equal(videoId, "vid_download");
        return {
          async arrayBuffer() {
            return Uint8Array.from([1, 2, 3, 4]).buffer;
          }
        };
      }
    }
  };

  fs.writeFileSync(destination, Buffer.from("old-video"));

  const fsOps = {
    ...fs,
    openSync(filePath, flags, mode) {
      opened.push(path.basename(filePath));
      return fs.openSync(filePath, flags, mode);
    },
    renameSync(fromPath, toPath) {
      renames.push([path.basename(fromPath), path.basename(toPath)]);
      return fs.renameSync(fromPath, toPath);
    }
  };

  await downloadSoraAnimation({
    client,
    videoId: "vid_download",
    destination,
    fsOps,
    tempSuffix: ".tmp-download"
  });

  assert.deepEqual(opened, ["animation-idle.mp4.tmp-download"]);
  assert.deepEqual(renames, [["animation-idle.mp4.tmp-download", "animation-idle.mp4"]]);
  assert.deepEqual(fs.readFileSync(destination), Buffer.from([1, 2, 3, 4]));
});

test("downloadSoraAnimation 写入失败时保留旧文件不变", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-sora-download-fail-"));
  const destination = path.join(tempDir, "animation-sleep.mp4");
  const client = {
    videos: {
      async downloadContent() {
        return {
          async arrayBuffer() {
            return Uint8Array.from([9, 8, 7]).buffer;
          }
        };
      }
    }
  };

  fs.writeFileSync(destination, Buffer.from("stable-old-video"));

  await assert.rejects(
    downloadSoraAnimation({
      client,
      videoId: "vid_download_fail",
      destination,
      fsOps: {
        ...fs,
        writeSync(descriptor, contents, offset, length, position) {
          fs.writeSync(descriptor, contents, offset, length, position);
          throw new Error("disk full");
        }
      },
      tempSuffix: ".tmp-fail"
    }),
    /disk full/
  );

  assert.deepEqual(fs.readFileSync(destination), Buffer.from("stable-old-video"));
  assert.equal(fs.existsSync(`${destination}.tmp-fail`), false);
});

test("downloadSoraAnimation 在写入和重命名前调用安全钩子", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-sora-download-hook-"));
  const destination = path.join(tempDir, "animation-idle.mp4");
  const checks = [];
  const client = {
    videos: {
      async downloadContent() {
        return {
          async arrayBuffer() {
            return Uint8Array.from([4, 3, 2, 1]).buffer;
          }
        };
      }
    }
  };

  await downloadSoraAnimation({
    client,
    videoId: "vid_hook",
    destination,
    tempSuffix: ".tmp-hook",
    assertDestinationSafe(filePath, options = {}) {
      checks.push({
        file: path.basename(filePath),
        mustExist: options.mustExist === true,
        hasDescriptor: typeof options.descriptor === "number"
      });
    }
  });

  assert.deepEqual(checks, [
    { file: "animation-idle.mp4", mustExist: false, hasDescriptor: false },
    { file: "animation-idle.mp4.tmp-hook", mustExist: false, hasDescriptor: false },
    { file: "animation-idle.mp4.tmp-hook", mustExist: false, hasDescriptor: false },
    { file: "animation-idle.mp4.tmp-hook", mustExist: true, hasDescriptor: true },
    { file: "animation-idle.mp4.tmp-hook", mustExist: false, hasDescriptor: false },
    { file: "animation-idle.mp4", mustExist: false, hasDescriptor: false }
  ]);
  assert.deepEqual(fs.readFileSync(destination), Buffer.from([4, 3, 2, 1]));
});

test("downloadSoraAnimation 安全钩子拒绝时不写入任何文件", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-sora-download-unsafe-"));
  const destination = path.join(tempDir, "animation-idle.mp4");
  const writes = [];
  const client = {
    videos: {
      async downloadContent() {
        return {
          async arrayBuffer() {
            return Uint8Array.from([7, 7, 7]).buffer;
          }
        };
      }
    }
  };

  await assert.rejects(
    downloadSoraAnimation({
      client,
      videoId: "vid_unsafe",
      destination,
      tempSuffix: ".tmp-unsafe",
      fsOps: {
        ...fs,
        writeFileSync(filePath, contents) {
          writes.push(path.basename(filePath));
          return fs.writeFileSync(filePath, contents);
        }
      },
      assertDestinationSafe() {
        throw new Error("unsafe destination");
      }
    }),
    /unsafe destination/
  );

  assert.deepEqual(writes, []);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(`${destination}.tmp-unsafe`), false);
});
