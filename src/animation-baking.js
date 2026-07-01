"use strict";

// 该模块负责把 Sora 输出的绿幕 H.264 MP4 一次性烘焙成带真透明通道的
// WebM（VP9, yuva420p）。渲染层直接播放透明视频，避免实时抠绿幕在压缩视频上
// 留下的绿色残留。buildBakingArgs 为纯函数，只拼参数不做任何 IO，便于测试。

const { spawn: defaultSpawn } = require("child_process");

// 抠绿相似度默认值。0.28 是实测甜区：既能把整片绿背景真正抠透，又不会误伤黑/白
// 毛边的主体颜色（≥0.32 会把黑/白毛当成绿幕一起抠掉）。用户可在区间内左右微调。
const DEFAULT_CHROMA_SIMILARITY = 0.28;
const MIN_CHROMA_SIMILARITY = 0.05;
const MAX_CHROMA_SIMILARITY = 0.5;

// 把 "#00ff00" 这类十六进制颜色统一成 ffmpeg 滤镜可用的 "0x00ff00" 形式。
function normalizeColor(backgroundColor) {
  const value = String(backgroundColor || "#00ff00").trim();
  const hex = value.replace(/^#/, "").replace(/^0x/i, "");
  return `0x${hex.toLowerCase()}`;
}

// 把抠绿相似度夹到合理区间并去掉尾零，保证滤镜字符串稳定可比较（纯函数输出稳定）。
function normalizeChromaSimilarity(chromaSimilarity) {
  const value = Number(chromaSimilarity);
  if (!Number.isFinite(value)) {
    return String(DEFAULT_CHROMA_SIMILARITY);
  }
  const clamped = Math.min(MAX_CHROMA_SIMILARITY, Math.max(MIN_CHROMA_SIMILARITY, value));
  return String(Number(clamped.toFixed(3)));
}

// 把 anchorSeconds 规整为非负数字，并去掉多余的尾零，保证滤镜字符串稳定可比较。
function normalizeAnchorSeconds(anchorSeconds) {
  const seconds = Number(anchorSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 0.25;
  }
  // 用 Number 再 String 去掉 1.0 -> 1 这类尾零，保证纯函数输出稳定。
  return String(Number(seconds.toFixed(3)));
}

// 解析 ffmpeg 可执行路径：优先用 ffmpeg-static 提供的二进制，失败则回退到系统 PATH。
function resolveFfmpegPath() {
  try {
    const staticPath = require("ffmpeg-static");
    if (typeof staticPath === "string" && staticPath.length > 0) {
      return staticPath;
    }
  } catch (error) {
    // ffmpeg-static 不可用时静默回退到系统 ffmpeg。
  }
  return "ffmpeg";
}

// 纯函数：拼出把绿幕 MP4 烘焙成透明 WebM 的 ffmpeg 参数数组。
function buildBakingArgs({
  inputPath,
  referencePath,
  outputPath,
  backgroundColor = "#00ff00",
  anchorSeconds = 0.25,
  chromaSimilarity = DEFAULT_CHROMA_SIMILARITY,
  fps = 24
} = {}) {
  const color = normalizeColor(backgroundColor);
  const anchor = normalizeAnchorSeconds(anchorSeconds);
  const similarity = normalizeChromaSimilarity(chromaSimilarity);
  const frameRate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? String(Number(fps)) : "24";

  // 滤镜链说明：
  // 1) chromakey：在 YUV 空间按背景色抠除绿幕并产生 alpha 通道。相似度可由用户在
  //    主菜单调节——越大抠得越干净（透得更多），但 ≥0.32 会把黑/白毛当成绿幕一起抠掉；
  //    越小越安全但可能残留绿边。blend 0.08 让边缘利落不糊。
  // 2) despill：消除宠物边缘残留的绿色光晕。关键是 expand=0——despill 默认会把去绿
  //    范围外扩到整只宠物，导致主体绿色通道被削、画面偏红；expand=0 让它只处理紧贴
  //    边缘的溢色，主体颜色几乎不受影响。mix=0.1 已足够去净边缘绿，再大只会加重偏红。
  //    不加 alpha=1——该选项会把已全透明的背景又拉回半透明，形成灰色膜。
  // 3) tpad：首尾各 clone 定格 anchor 秒，保证多段动画切换时停在标准坐姿不跳变。
  // 4) fps：统一帧率，便于循环与拼接。
  const filterChain = [
    `chromakey=${color}:${similarity}:0.08`,
    "despill=type=green:mix=0.1:expand=0",
    `tpad=start_mode=clone:start_duration=${anchor}:stop_mode=clone:stop_duration=${anchor}`,
    `fps=${frameRate}`
  ].join(",");

  return [
    "-y",
    "-i",
    inputPath,
    "-vf",
    filterChain,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-b:v",
    "0",
    "-crf",
    "30",
    outputPath
  ];
}

// 调用 ffmpeg 执行烘焙，返回 Promise<string>（成功时为 outputPath）。
function bakeAnimation(
  { inputPath, referencePath, outputPath, backgroundColor, anchorSeconds, chromaSimilarity, fps } = {},
  { spawn = defaultSpawn, ffmpegPath } = {}
) {
  const resolvedFfmpeg = ffmpegPath || resolveFfmpegPath();
  const args = buildBakingArgs({
    inputPath,
    referencePath,
    outputPath,
    backgroundColor,
    anchorSeconds,
    chromaSimilarity,
    fps
  });

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedFfmpeg, args);
    let stderr = "";

    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(outputPath);
        return;
      }
      // 只保留 stderr 末尾片段，避免错误信息过长。
      const tail = stderr.trim().slice(-500);
      reject(new Error(`动画透明处理失败：${tail}`));
    });
  });
}

module.exports = {
  resolveFfmpegPath,
  buildBakingArgs,
  bakeAnimation,
  DEFAULT_CHROMA_SIMILARITY,
  MIN_CHROMA_SIMILARITY,
  MAX_CHROMA_SIMILARITY
};
