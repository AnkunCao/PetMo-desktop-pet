import { createAnimationController } from "./animation-controller.mjs";
import { normalizePlayableAnimationPaths } from "./animation-paths.mjs";
import { createChromaVideoPlayer } from "./chroma-video-player.mjs";

const pet = document.querySelector("#pet");
const petMedia = document.querySelector("#pet-media");
const stage = document.querySelector(".pet-stage");
const customPetImage = document.querySelector("#custom-pet-image");

let player = null;
let lastPhase = "";
let refreshToken = 0;
let isDragging = false;
let dragStart = { x: 0, y: 0 };

const animationController = createAnimationController({
  random: Math.random,
  transitionMs: 150
});

function normalizeAppearance(appearance) {
  if (typeof appearance === "string") {
    return {
      imageUrl: appearance,
      activeAnimationPaths: {},
      activeAnimationVersion: ""
    };
  }

  return {
    imageUrl: appearance?.imageUrl || "",
    activeAnimationPaths: normalizePlayableAnimationPaths(appearance?.activeAnimationPaths),
    activeAnimationVersion: appearance?.activeAnimationVersion || ""
  };
}

function applyCustomPet(appearance) {
  const imageUrl = typeof appearance === "string" ? appearance : appearance?.imageUrl;
  if (!imageUrl) {
    customPetImage.removeAttribute("src");
    pet.classList.remove("has-custom-image");
    return;
  }

  customPetImage.src = imageUrl;
  pet.classList.add("has-custom-image");
}

function setRenderMode(mode) {
  stage.dataset.renderMode = mode;
  pet.classList.toggle("is-video-mode", mode === "video");
}

function ensurePlayer() {
  if (!player) {
    player = createChromaVideoPlayer({
      container: petMedia,
      backgroundColor: "#00ff00"
    });
    // Expose for testing
    window.__chromaPlayer = player;
  }
  return player;
}

function resetToStaticImage() {
  animationController.stop();
  animationController.setAvailableActions({});
  setRenderMode(customPetImage.src ? "image" : "placeholder");
}

function handleVideoFailure(error) {
  console.warn("透明动画播放失败，已切换到标准坐姿图。", error);
  refreshToken += 1;
  resetToStaticImage();
}

animationController.subscribe((state) => {
  stage.dataset.action = state.phase === "action" ? state.actionId : "idle";

  if (stage.dataset.renderMode !== "video" || !player) {
    lastPhase = state.phase;
    return;
  }

  if (state.phase === "transition-out") {
    player.playAction(state.nextActionId).then(() => {
      animationController.finishAction(state.nextActionId);
    }).catch(handleVideoFailure);
    lastPhase = state.phase;
    return;
  }

  if (state.phase === "transition-in") {
    player.playAction("idle").catch(handleVideoFailure);
    lastPhase = state.phase;
    return;
  }

  if (state.phase === "idle" && lastPhase !== "idle") {
    player.playAction("idle").catch(handleVideoFailure);
  }

  lastPhase = state.phase;
});

async function applyAnimationAppearance(appearance) {
  const normalized = normalizeAppearance(appearance);
  const activePaths = normalizePlayableAnimationPaths(normalized.activeAnimationPaths);
  const token = ++refreshToken;

  applyCustomPet(normalized);

  if (!activePaths.idle) {
    resetToStaticImage();
    return;
  }

  try {
    const chromaPlayer = ensurePlayer();
    const loadedPaths = await chromaPlayer.loadAnimationSet(activePaths);
    if (token !== refreshToken) {
      return;
    }

    setRenderMode("video");
    animationController.stop();
    animationController.setAvailableActions(loadedPaths);
    await chromaPlayer.playAction("idle");
    animationController.start();
  } catch (error) {
    if (token !== refreshToken) {
      return;
    }
    handleVideoFailure(error);
  }
}

async function refreshCurrentPet() {
  const appearance = await window.desktopPet.getCurrentPet();
  return applyAnimationAppearance(appearance);
}

pet.addEventListener("click", () => {
  if (stage.dataset.renderMode === "video") {
    animationController.triggerRandomAction();
    return;
  }
});

pet.addEventListener("dblclick", (event) => {
  event.stopPropagation();
  window.desktopPet.showContextMenu();
});

pet.addEventListener("mousedown", (event) => {
  if (!isDragging) {
    isDragging = true;
    dragStart = { x: event.clientX, y: event.clientY };
  }
});

document.addEventListener("mousemove", (event) => {
  if (isDragging) {
    const deltaX = event.clientX - dragStart.x;
    const deltaY = event.clientY - dragStart.y;
    window.desktopPet.moveWindow({ x: deltaX, y: deltaY });
    dragStart = { x: event.clientX, y: event.clientY };
  }
});

document.addEventListener("mouseup", () => {
  isDragging = false;
});

pet.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.desktopPet.showContextMenu();
});

stage.dataset.action = "idle";
stage.dataset.renderMode = "placeholder";

window.desktopPet.onPetUpdated(() => {
  refreshCurrentPet().catch(() => {});
});
window.desktopPet.onPetAnimationProgress(() => {
  refreshCurrentPet().catch(() => {});
});

Promise.all([
  window.desktopPet.getCurrentPet(),
  window.desktopPet.getApiSettings()
]).then(([appearance, settings]) => {
  applyAnimationAppearance(appearance);
});
