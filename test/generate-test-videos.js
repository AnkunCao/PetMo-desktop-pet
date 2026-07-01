#!/usr/bin/env node
/**
 * 为 Sora 桌面宠物项目生成测试动画夹具。
 *
 * Generate test videos for the Sora desktop pet project.
 *
 * 改造后渲染层直接播放带透明通道的 WebM（不再实时抠绿幕），
 * 因此这里直接生成 **透明背景 + 黑白宠物形状** 的 VP9/yuva420p WebM：
 * - idle.webm: 4 秒，宠物头部轻微左右摇摆
 * - stand-sit.webm: 8 秒，宠物坐姿（站起占位）
 * - sleep.webm: 8 秒，宠物趴下睡觉并轻微晃动
 *
 * 分辨率：720x1280（竖屏）
 * 格式：WebM（VP9, yuva420p，真透明通道）
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "animations");
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 24;

function ensureDirectoryExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 使用 ffmpeg 滤镜图生成一段透明背景的 WebM。
 * Generate a transparent WebM using an ffmpeg filter graph.
 *
 * @param {string} outputPath - 输出视频路径
 * @param {number} durationSeconds - 视频时长（秒）
 * @param {string} filterGraph - 在透明背景上叠加宠物形状的滤镜
 */
function generateVideo(outputPath, durationSeconds, filterGraph) {
  return new Promise((resolve, reject) => {
    // 输入：完全透明的背景画布（black@0.0），随后通过 format 转到带 alpha 的像素格式，
    // 再叠加宠物形状。drawbox 使用不透明颜色填充，保证宠物区域 alpha=255。
    const fullFilter = `format=rgba,${filterGraph},format=yuva420p`;

    const args = [
      "-f", "lavfi",
      "-i", `color=c=black@0.0:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${durationSeconds}`,
      "-vf", fullFilter,
      "-an",
      "-c:v", "libvpx-vp9",
      "-pix_fmt", "yuva420p",
      "-b:v", "0",
      "-crf", "30",
      "-y", // 覆盖已有文件 / Overwrite without asking
      outputPath
    ];

    console.log(`Generating ${path.basename(outputPath)}...`);
    const proc = spawn("ffmpeg", args, { stdio: "pipe" });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        const stats = fs.statSync(outputPath);
        console.log(`✓ ${path.basename(outputPath)} created (${Math.round(stats.size / 1024)}KB)`);
        resolve();
      } else {
        reject(new Error(`ffmpeg failed: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * 待机动画：宠物头部轻微左右摇摆。
 * 用不透明的方块构成宠物身体和两只眼睛。
 */
async function generateIdle() {
  const outputPath = path.join(FIXTURE_DIR, "idle.webm");

  // 身体：黑色方块随时间左右摆动；眼睛：两个白色小方块。
  const filterGraph = "drawbox=x=320+20*sin(2*PI*t/4):y=200:w=80:h=100:c=black@1.0:thickness=fill,drawbox=x=330+20*sin(2*PI*t/4):y=220:w=15:h=15:c=white@1.0:thickness=fill,drawbox=x=375+20*sin(2*PI*t/4):y=220:w=15:h=15:c=white@1.0:thickness=fill";

  await generateVideo(outputPath, 4, filterGraph);
}

/**
 * 站起动画：宠物从坐姿站起后重新坐下（测试夹具用静态身体占位）。
 */
async function generateStandSit() {
  const outputPath = path.join(FIXTURE_DIR, "stand-sit.webm");

  // 静态身体 + 两只眼睛（测试夹具，无需精确动作）。
  const filterGraph = "drawbox=x=310:y=500:w=100:h=100:c=black@1.0:thickness=fill,drawbox=x=325:y=520:w=20:h=20:c=white@1.0:thickness=fill,drawbox=x=375:y=520:w=20:h=20:c=white@1.0:thickness=fill";

  await generateVideo(outputPath, 8, filterGraph);
}

/**
 * 睡觉动画：宠物趴下并轻微晃动，眼睛闭合（细横条）。
 */
async function generateSleep() {
  const outputPath = path.join(FIXTURE_DIR, "sleep.webm");

  // 身体随时间轻微上下/左右晃动；闭合的眼睛用白色细横条表示。
  const filterGraph = "drawbox=x=310+10*sin(2*PI*t/2):y=400+5*sin(2*PI*t/3):w=100:h=100:c=black@1.0:thickness=fill,drawbox=x=320+10*sin(2*PI*t/2):y=440:w=30:h=5:c=white@1.0:thickness=fill,drawbox=x=370+10*sin(2*PI*t/2):y=440:w=30:h=5:c=white@1.0:thickness=fill";

  await generateVideo(outputPath, 8, filterGraph);
}

async function main() {
  try {
    console.log("🎬 Generating transparent test videos for Sora desktop pet...\n");

    ensureDirectoryExists(FIXTURE_DIR);

    console.log(`Video specifications:
  Resolution: ${WIDTH}x${HEIGHT}
  FPS: ${FPS}
  Background: transparent (alpha=0, no green)
  Codec: VP9 / yuva420p (WebM with real alpha channel)
  Output directory: ${FIXTURE_DIR}\n`);

    await generateIdle();
    await generateStandSit();
    await generateSleep();

    console.log("\n✅ All transparent test videos generated successfully!");
    console.log(`📁 Videos are located in: ${FIXTURE_DIR}`);

    // 列出生成的文件 / List generated files
    const files = fs.readdirSync(FIXTURE_DIR);
    console.log("\n📋 Generated files:");
    files.forEach(file => {
      const filePath = path.join(FIXTURE_DIR, file);
      const stats = fs.statSync(filePath);
      console.log(`   - ${file} (${Math.round(stats.size / 1024)}KB)`);
    });

  } catch (error) {
    console.error("❌ Error generating videos:", error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { generateVideo, generateIdle, generateStandSit, generateSleep };
