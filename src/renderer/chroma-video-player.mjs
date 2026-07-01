// 透明视频播放器：视频在下载后已被 ffmpeg 预烘焙为带真透明通道的 WebM
// （VP9, yuva420p）。Chromium 在普通 <video> 元素里能正确合成透明 WebM，
// 但用 WebGL VideoTexture 采样透明 VP9 会丢失 alpha（控制台报
// “Unsupported pixel format: -1”），导致背景退化为不透明灰底。
// 因此这里直接用两个堆叠的原生 <video> 元素 + CSS opacity 交叉淡化，
// 既保证背景真透明，又比 WebGL 更省资源。
//
// 保持公开接口不变：createChromaVideoPlayer / loadAnimationSet /
// playAction / getCurrentAction / dispose，渲染层无需改动。

const DEFAULT_TRANSITION_MS = 150;

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function normalizeAnimationPaths(paths) {
  if (!paths || typeof paths !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(paths).filter(([, value]) => typeof value === "string" && value.trim())
  );
}

function createVideoElement(documentRef) {
  const video = documentRef.createElement("video");
  video.muted = true;
  video.loop = false;
  video.playsInline = true;
  video.preload = "auto";
  video.className = "chroma-video-layer";
  return video;
}

function waitForVideoReady(video) {
  if (video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("视频资源加载失败。"));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
    video.load?.();
  });
}

function waitForVideoEnd(video) {
  return new Promise((resolve, reject) => {
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("动作视频播放失败。"));
    };
    const cleanup = () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };

    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
  });
}

export function createChromaVideoPlayer(options = {}) {
  const container = options.container;
  if (!container) {
    throw new Error("缺少视频播放器容器。");
  }

  const documentRef = options.document || globalThis.document;

  // backgroundColor 仅为兼容旧接口保留，透明视频不再需要它来抠像。
  void options.backgroundColor;
  const root = documentRef.createElement("div");
  root.className = "chroma-video-player";
  container.appendChild(root);

  // 两个堆叠层：idleVideo 承载循环待机，actionVideo 承载一次性动作。
  // 通过 CSS opacity 交叉淡化在两层之间切换，避免动作切换时画面跳变。
  const idleVideo = createVideoElement(documentRef);
  const actionVideo = createVideoElement(documentRef);
  idleVideo.style.opacity = "1";
  actionVideo.style.opacity = "0";
  root.appendChild(idleVideo);
  root.appendChild(actionVideo);

  let disposed = false;
  let availablePaths = {};
  let idlePath = "";
  let currentActionId = "idle";

  // 交叉淡化：用 CSS transition 控制两层 opacity。mixAmount=0 显示 idle 层，
  // mixAmount=1 显示 action 层。
  function setTransitionDuration(durationMs) {
    const seconds = `${Math.max(0, durationMs) / 1000}s`;
    idleVideo.style.transition = `opacity ${seconds} linear`;
    actionVideo.style.transition = `opacity ${seconds} linear`;
  }

  function applyMix(amount) {
    const mix = clamp01(amount);
    actionVideo.style.opacity = String(mix);
    idleVideo.style.opacity = String(1 - mix);
  }

  function animateMixTo(targetValue, durationMs = DEFAULT_TRANSITION_MS) {
    setTransitionDuration(durationMs);
    applyMix(targetValue);
  }

  async function assignVideoSource(video, sourcePath) {
    if (video.src !== sourcePath) {
      video.src = sourcePath;
      video.currentTime = 0;
    }
    await waitForVideoReady(video);
  }

  return {
    async loadAnimationSet(paths) {
      if (disposed) {
        throw new Error("视频播放器已销毁。");
      }

      const normalized = normalizeAnimationPaths(paths);
      if (!normalized.idle) {
        throw new Error("缺少 idle 视频资源。");
      }

      availablePaths = normalized;
      idlePath = normalized.idle;
      await assignVideoSource(idleVideo, idlePath);
      idleVideo.loop = true;
      currentActionId = "idle";
      await idleVideo.play?.();
      setTransitionDuration(0);
      applyMix(0);
      return { ...availablePaths };
    },
    async playAction(actionId) {
      if (disposed || !actionId) {
        return false;
      }

      if (actionId === "idle") {
        if (!idlePath) {
          return false;
        }

        await assignVideoSource(idleVideo, idlePath);
        idleVideo.loop = true;
        currentActionId = "idle";
        await idleVideo.play?.();
        animateMixTo(0, DEFAULT_TRANSITION_MS);
        return Promise.resolve();
      }

      const sourcePath = availablePaths[actionId];
      if (!sourcePath) {
        return false;
      }

      actionVideo.loop = false;
      await assignVideoSource(actionVideo, sourcePath);
      currentActionId = actionId;
      const playback = waitForVideoEnd(actionVideo);
      await actionVideo.play?.();
      animateMixTo(1, DEFAULT_TRANSITION_MS);
      return playback;
    },
    getCurrentAction() {
      return currentActionId;
    },
    dispose() {
      disposed = true;
      idleVideo.pause?.();
      actionVideo.pause?.();
      root.remove();
    }
  };
}
