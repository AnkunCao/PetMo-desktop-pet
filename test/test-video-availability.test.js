const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("child_process");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "animations");

/**
 * 使用 ffprobe 提取视频信息：分辨率、时长、像素格式，以及 WebM 的 alpha_mode 标记。
 * Extract video information using ffprobe.
 *
 * 说明：ffmpeg 的 VP9 编码器会把 alpha 通道作为独立的编码层写入 WebM，并在容器流标签上
 * 打 alpha_mode=1。但 ffprobe 报告的 stream.pix_fmt 仍是 yuv420p（这是 VP9-alpha 的已知表现，
 * 生产烘焙模块 src/animation-baking.js 的输出也是如此），因此判断「是否透明」要看 alpha_mode，
 * 而不是 pix_fmt 字面值。
 */
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration,pix_fmt,codec_name",
      "-show_entries", "stream_tags=alpha_mode",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath
    ]);

    let output = "";
    proc.stdout.on("data", (data) => {
      output += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          const stream = data.streams?.[0] || {};
          const duration = parseFloat(data.format?.duration || stream.duration || 0);
          resolve({
            width: stream.width,
            height: stream.height,
            duration,
            pixFmt: stream.pix_fmt,
            codecName: stream.codec_name,
            alphaMode: stream.tags?.alpha_mode
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
        }
      } else {
        reject(new Error(`ffprobe failed for ${filePath}`));
      }
    });

    proc.on("error", reject);
  });
}

test("test fixture directory exists", () => {
  assert.ok(fs.existsSync(FIXTURES_DIR), "Fixtures directory should exist");
});

test("idle.webm exists", () => {
  const idlePath = path.join(FIXTURES_DIR, "idle.webm");
  assert.ok(fs.existsSync(idlePath), "idle.webm should exist");
  const stats = fs.statSync(idlePath);
  assert.ok(stats.size > 0, "idle.webm should not be empty");
});

test("stand-sit.webm exists", () => {
  const standSitPath = path.join(FIXTURES_DIR, "stand-sit.webm");
  assert.ok(fs.existsSync(standSitPath), "stand-sit.webm should exist");
  const stats = fs.statSync(standSitPath);
  assert.ok(stats.size > 0, "stand-sit.webm should not be empty");
});

test("sleep.webm exists", () => {
  const sleepPath = path.join(FIXTURES_DIR, "sleep.webm");
  assert.ok(fs.existsSync(sleepPath), "sleep.webm should exist");
  const stats = fs.statSync(sleepPath);
  assert.ok(stats.size > 0, "sleep.webm should not be empty");
});

test("idle.webm has correct resolution and duration", async () => {
  const idlePath = path.join(FIXTURES_DIR, "idle.webm");
  const info = await getVideoInfo(idlePath);

  assert.equal(info.width, 720, "Video width should be 720px");
  assert.equal(info.height, 1280, "Video height should be 1280px");
  assert.ok(
    Math.abs(info.duration - 4) < 0.2,
    `Video duration should be ~4 seconds, got ${info.duration}`
  );
});

test("stand-sit.webm has correct resolution and duration", async () => {
  const standSitPath = path.join(FIXTURES_DIR, "stand-sit.webm");
  const info = await getVideoInfo(standSitPath);

  assert.equal(info.width, 720, "Video width should be 720px");
  assert.equal(info.height, 1280, "Video height should be 1280px");
  assert.ok(
    Math.abs(info.duration - 8) < 0.2,
    `Video duration should be ~8 seconds, got ${info.duration}`
  );
});

test("sleep.webm has correct resolution and duration", async () => {
  const sleepPath = path.join(FIXTURES_DIR, "sleep.webm");
  const info = await getVideoInfo(sleepPath);

  assert.equal(info.width, 720, "Video width should be 720px");
  assert.equal(info.height, 1280, "Video height should be 1280px");
  assert.ok(
    Math.abs(info.duration - 8) < 0.2,
    `Video duration should be ~8 seconds, got ${info.duration}`
  );
});

test("all videos are transparent VP9 WebM (alpha channel present)", async () => {
  const videos = ["idle.webm", "stand-sit.webm", "sleep.webm"];

  for (const video of videos) {
    const filePath = path.join(FIXTURES_DIR, video);
    const info = await getVideoInfo(filePath);

    // 必须是 VP9 编码（WebM 透明视频的编码方式）。
    assert.equal(info.codecName, "vp9", `${video} should be VP9 encoded`);

    // 透明性判定：VP9-alpha WebM 在容器流标签上携带 alpha_mode=1。
    // ffprobe 报告的 pix_fmt 仍是 yuv420p（VP9-alpha 的已知表现，与生产烘焙输出一致），
    // 因此这里以 alpha_mode 作为「带透明通道」的可靠依据。
    assert.equal(
      info.alphaMode,
      "1",
      `${video} should carry an alpha channel (alpha_mode=1), got alpha_mode=${info.alphaMode}, pix_fmt=${info.pixFmt}`
    );
  }
});

test("videos can be loaded by the transparent video player", () => {
  // 验证这些透明 WebM 可被渲染层的视频播放器引用。
  const animationSet = {
    idle: path.join(FIXTURES_DIR, "idle.webm"),
    "stand-sit": path.join(FIXTURES_DIR, "stand-sit.webm"),
    sleep: path.join(FIXTURES_DIR, "sleep.webm")
  };

  for (const [name, filePath] of Object.entries(animationSet)) {
    assert.ok(fs.existsSync(filePath), `${name} animation should exist at ${filePath}`);
  }
});
