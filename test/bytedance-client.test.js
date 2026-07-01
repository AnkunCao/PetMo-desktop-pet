const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createBytedanceClient,
  normalizeBytedanceVideoStatus
} = require("../src/bytedance-client");

function jsonResponse(body, { status = 200, statusText = "OK" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      return body;
    },
    async arrayBuffer() {
      return Buffer.from("video");
    }
  };
}

test("maps Volcengine task statuses to the animation service contract", () => {
  assert.equal(normalizeBytedanceVideoStatus("queued"), "queued");
  assert.equal(normalizeBytedanceVideoStatus("RUNNING"), "in_progress");
  assert.equal(normalizeBytedanceVideoStatus("succeeded"), "completed");
  assert.equal(normalizeBytedanceVideoStatus("failed"), "failed");
  assert.equal(normalizeBytedanceVideoStatus("canceled"), "failed");
});

test("rejects unknown Volcengine task status", () => {
  assert.throws(
    () => normalizeBytedanceVideoStatus("mystery"),
    /未知的 Bytedance 视频状态：mystery/
  );
});

test("retrieves a completed task and preserves its video URL", async () => {
  const client = createBytedanceClient({
    apiKey: "byte-key",
    fetch: async () =>
      jsonResponse({
        id: "task-1",
        status: "succeeded",
        content: { video_url: "https://example.test/video.mp4" }
      })
  });

  const task = await client.videos.retrieve("task-1");
  assert.deepEqual(task, {
    id: "task-1",
    status: "completed",
    error: undefined,
    video_url: "https://example.test/video.mp4",
    created_at: undefined,
    finished_at: undefined
  });
});

test("aborts a hanging task request with a phase-specific timeout", async () => {
  const fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  const client = createBytedanceClient({
    apiKey: "byte-key",
    fetch,
    requestTimeoutMs: 5
  });

  await assert.rejects(client.videos.retrieve("task-1"), /Bytedance 视频任务查询超时/);
});
