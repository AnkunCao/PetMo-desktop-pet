const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  safeStorage,
  nativeImage,
  session,
  net
} = require("electron");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { pathToFileURL } = require("url");
const OpenAI = require("openai");
const { toFile } = require("openai");
const {
  ANIMATION_DEFINITIONS,
  ANIMATION_DEFINITION_BY_ID,
  buildAnimationDefinitions,
  createAnimationBatch,
  advanceAnimationBatch,
  getAnimationDefinition,
  getNextPendingAction
} = require("./animation-config");
const { prepareCanonicalReference } = require("./canonical-reference");
const {
  createSoraAnimationJob,
  pollSoraAnimationJob,
  downloadSoraAnimation
} = require("./sora-animation-service");
const {
  bakeAnimation,
  DEFAULT_CHROMA_SIMILARITY,
  MIN_CHROMA_SIMILARITY,
  MAX_CHROMA_SIMILARITY
} = require("./animation-baking");
const {
  AVAILABLE_PROVIDERS,
  DEFAULT_MODEL_PROVIDER,
  normalizeProviderId,
  getProviderDefinition,
  getEncryptedApiKey,
  setEncryptedApiKey,
  deleteEncryptedApiKey,
  hasEncryptedApiKey,
  validateApiKeyFormat: validateProviderApiKeyFormat
} = require("./model-providers");
const {
  createBytedanceClient: createReliableBytedanceClient
} = require("./bytedance-client");
const { nodeHttpFetch } = require("./node-http-fetch");

// 打包后的产品名是 PetMo，但继续使用开发版的稳定数据目录，
// 让用户从 npm 启动迁移到 Finder App 时保留宠物、动画和本地设置。
if (app.isPackaged && typeof app.setPath === "function") {
  app.setPath("userData", path.join(app.getPath("appData"), "desktop-pet"));
}

const DEFAULT_MODEL = "gpt-image-1.5";
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CANONICAL_BACKGROUND_COLOR = "#00ff00";
const CANONICAL_REFERENCE_NAME = "canonical-sit.png";
const CANDIDATE_RESOURCE_ROOT = "animation-candidates";
const ANIMATION_SUBMISSIONS_NAME = "animation-submissions.json";
const SOURCE_PHOTO_ROOT = "source-photo-sets";
const ANIMATION_FILES = Object.freeze({
  idle: "animation-idle.mp4",
  "stand-sit": "animation-stand-sit.mp4",
  sleep: "animation-sleep.mp4",
  "look-up": "animation-look-up.mp4",
  "roll-over": "animation-roll-over.mp4",
  run: "animation-run.mp4",
  stretch: "animation-stretch.mp4"
});
// 烘焙后的透明视频文件名（VP9/yuva420p WebM）。原始 mp4 仅作为下载中转，
// 真正激活并交给渲染层的是这些 webm。
const BAKED_ANIMATION_FILES = Object.freeze({
  idle: "animation-idle.webm",
  "stand-sit": "animation-stand-sit.webm",
  sleep: "animation-sleep.webm",
  "look-up": "animation-look-up.webm",
  "roll-over": "animation-roll-over.webm",
  run: "animation-run.webm",
  stretch: "animation-stretch.webm"
});
const CANDIDATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let mainWindow;
let settingsWindow;
let animationRunState = null;
let animationShutdownRequested = false;
let animationQuitPending = false;
let animationQuitReady = false;

function sendWindowEvent(channel, ...args) {
  for (const window of [mainWindow, settingsWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  }
}

function getConfigPath() {
  return path.join(app.getPath("userData"), "pet-config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  } catch {
    return {
      modelProvider: DEFAULT_MODEL_PROVIDER,
      encryptedApiKey: "",
      currentPetPath: "",
      sourcePhotoPaths: []
    };
  }
}

function writeConfig(config) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

function encryptApiKey(apiKey) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法安全保存 API Key。");
  }

  return safeStorage.encryptString(apiKey).toString("base64");
}

function validateApiKeyFormat(apiKey, provider = DEFAULT_MODEL_PROVIDER) {
  return validateProviderApiKeyFormat(apiKey, provider);
}

function decryptApiKey(encryptedApiKey) {
  if (!encryptedApiKey || !safeStorage.isEncryptionAvailable()) {
    return "";
  }

  return safeStorage.decryptString(Buffer.from(encryptedApiKey, "base64"));
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("无法读取上传的照片。");
  }

  const buffer = Buffer.from(match[2], "base64");
  if (!ALLOWED_PHOTO_TYPES.has(match[1])) {
    throw new Error("只支持 PNG、JPG 或 WebP 照片。");
  }

  if (buffer.length > MAX_PHOTO_BYTES) {
    throw new Error("照片不能超过 15MB。");
  }

  return { buffer, mimeType: match[1] };
}

function petImageUrl(filePath) {
  return filePath && fs.existsSync(filePath)
    ? pathToFileURL(filePath).toString()
    : "";
}

function getStoredAppearanceProfile(config = readConfig()) {
  // 毛色分析已弃用，返回 null
  return null;
}

function extractPetColor(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }

  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    return "";
  }

  const bitmap = image.resize({ width: 48, height: 48, quality: "good" }).toBitmap();
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;

  for (let index = 0; index < bitmap.length; index += 32) {
    const pixel = index / 4;
    const x = pixel % 48;
    const y = Math.floor(pixel / 48);
    const normalizedX = (x - 24) / 22;
    const normalizedY = (y - 24) / 23;
    if (normalizedX ** 2 + normalizedY ** 2 > 1) {
      continue;
    }

    const pixelBlue = bitmap[index];
    const pixelGreen = bitmap[index + 1];
    const pixelRed = bitmap[index + 2];
    const alpha = bitmap[index + 3];
    const brightness = pixelRed + pixelGreen + pixelBlue;
    if (alpha < 100 || brightness < 80 || brightness > 700) {
      continue;
    }
    red += pixelRed;
    green += pixelGreen;
    blue += pixelBlue;
    count += 1;
  }

  if (!count) {
    return "";
  }

  return `#${[red, green, blue]
    .map((channel) => Math.round(channel / count).toString(16).padStart(2, "0"))
    .join("")}`;
}

function getPetAppearance(filePath, config = readConfig()) {
  return {
    imageUrl: petImageUrl(filePath),
    furColor: extractPetColor(filePath),
    appearanceProfile: getStoredAppearanceProfile(config),
    activeAnimationVersion: config.activeAnimationVersion || "",
    activeAnimationPaths: config.activeAnimationPaths || null
  };
}

function mimeTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[extension];
}

function fileAsDataUrl(filePath) {
  const mimeType = mimeTypeForPath(filePath);
  if (!mimeType || !fs.existsSync(filePath)) {
    return "";
  }
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function stageSourcePhotos(photoDataUrls, options = {}) {
  const fsOps = options.fsOps || fs;
  const userDataPath = options.userDataPath || app.getPath("userData");
  const batchId = options.batchId || randomUUID();
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp"
  };
  const photos = photoDataUrls.map(parseDataUrl);
  const sourceRoot = path.join(userDataPath, SOURCE_PHOTO_ROOT);
  const temporaryDir = path.join(sourceRoot, `.tmp-${batchId}`);
  const sourceDir = path.join(sourceRoot, batchId);
  const paths = photos.map(({ mimeType }, index) =>
    path.join(sourceDir, `source-photo-${index + 1}.${extensions[mimeType]}`)
  );

  fsOps.mkdirSync(sourceRoot, { recursive: true });
  fsOps.mkdirSync(temporaryDir);

  try {
    photos.forEach(({ buffer, mimeType }, index) => {
      fsOps.writeFileSync(
        path.join(temporaryDir, `source-photo-${index + 1}.${extensions[mimeType]}`),
        buffer
      );
    });
  } catch (error) {
    fsOps.rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }

  return {
    id: batchId,
    temporaryDir,
    directoryPath: sourceDir,
    paths
  };
}

function cleanupSourcePhotoStage(stage, fsOps = fs) {
  if (!stage) {
    return;
  }
  fsOps.rmSync(stage.temporaryDir, { recursive: true, force: true });
  fsOps.rmSync(stage.directoryPath, { recursive: true, force: true });
}

function writeConfigAtomically(config, options = {}) {
  const fsOps = options.fsOps || fs;
  const configPath = options.configPath || getConfigPath();
  const transactionId = options.transactionId || randomUUID();
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.pet-config-${transactionId}.tmp`
  );

  try {
    fsOps.writeFileSync(temporaryPath, JSON.stringify(config, null, 2));
    fsOps.renameSync(temporaryPath, configPath);
  } catch (error) {
    fsOps.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function commitSourcePhotos(stage, config, options = {}) {
  const fsOps = options.fsOps || fs;

  try {
    fsOps.renameSync(stage.temporaryDir, stage.directoryPath);
    writeConfigAtomically(
      {
        ...config,
        sourcePhotoPaths: stage.paths,
        ...(options.candidateBatch
          ? { pendingCandidateBatch: { id: options.candidateBatch.id } }
          : {})
      },
      {
        fsOps,
        configPath: options.configPath,
        transactionId: stage.id
      }
    );
  } catch (error) {
    cleanupSourcePhotoStage(stage, fsOps);
    throw error;
  }

  return stage.paths;
}

function readSourcePhotoDataUrls(config = readConfig()) {
  if (!Array.isArray(config.sourcePhotoPaths)) {
    return [];
  }

  return config.sourcePhotoPaths.map(fileAsDataUrl).filter(Boolean);
}

function getPetProject() {
  const config = readConfig();
  return {
    appearance: getPetAppearance(config.currentPetPath, config),
    appearanceProfile: getStoredAppearanceProfile(config),
    sourcePhotoDataUrls: readSourcePhotoDataUrls(config),
    hasPet: Boolean(petImageUrl(config.currentPetPath))
  };
}

function savePetImage(buffer, extension = "png") {
  const filePath = path.join(app.getPath("userData"), `current-pet.${extension}`);
  fs.writeFileSync(filePath, buffer);

  const config = readConfig();
  config.currentPetPath = filePath;
  writeConfig(config);

  const appearance = getPetAppearance(filePath, config);
  sendWindowEvent("pet-updated", appearance);
  return appearance;
}

function saveCanonicalReferenceAssets(sourcePng, options = {}) {
  const fsOps = options.fsOps || fs;
  const userDataPath = options.userDataPath || app.getPath("userData");
  const batchId = options.batchId || randomUUID();
  const candidateRoot = path.join(userDataPath, CANDIDATE_RESOURCE_ROOT);
  const temporaryDir = path.join(candidateRoot, `.tmp-${batchId}`);
  const candidateDir = path.join(candidateRoot, batchId);
  const sourcePath = path.join(temporaryDir, "generated-pet.png");
  const referencePath = path.join(temporaryDir, CANONICAL_REFERENCE_NAME);

  fsOps.mkdirSync(candidateRoot, { recursive: true });
  fsOps.mkdirSync(temporaryDir);

  try {
    fsOps.writeFileSync(sourcePath, sourcePng);
    fsOps.writeFileSync(
      referencePath,
      prepareCanonicalReference(sourcePng, { backgroundColor: CANONICAL_BACKGROUND_COLOR })
    );
    fsOps.renameSync(temporaryDir, candidateDir);
  } catch (error) {
    fsOps.rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }

  return {
    id: batchId,
    directoryPath: candidateDir,
    sourcePath: path.join(candidateDir, "generated-pet.png"),
    referencePath: path.join(candidateDir, CANONICAL_REFERENCE_NAME),
    backgroundColor: CANONICAL_BACKGROUND_COLOR
  };
}

function createLocalAnimationStopError() {
  return Object.assign(new Error("动画任务已停止。"), {
    code: "SORA_POLL_STOPPED"
  });
}

function isAnimationStopError(error) {
  return error?.code === "SORA_POLL_STOPPED";
}

function createPersistedAnimationBatch(candidateBatch) {
  const config = readConfig();
  const provider = getModelProvider(config);
  return {
    id: candidateBatch.id,
    directoryPath: candidateBatch.directoryPath,
    sourcePath: candidateBatch.sourcePath,
    provider,
    imageModel: getProviderDefinition(provider).imageModel,
    videoModel: getProviderDefinition(provider).videoModel,
    ...createAnimationBatch(candidateBatch.referencePath, candidateBatch.backgroundColor)
  };
}

function stripAnimationBatchPaths(batch) {
  const {
    directoryPath: _directoryPath,
    referencePath: _referencePath,
    sourcePath: _sourcePath,
    ...persistedBatch
  } = batch;
  return persistedBatch;
}

function resolveCandidateFilesystem(candidateId) {
  if (typeof candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error("候选批次 ID 无效。");
  }

  const userDataPath = app.getPath("userData");
  const expectedRoot = path.resolve(fs.realpathSync(userDataPath), CANDIDATE_RESOURCE_ROOT);
  const candidateRoot = path.resolve(userDataPath, CANDIDATE_RESOURCE_ROOT);
  const expectedDirectory = path.join(expectedRoot, candidateId);
  const expectedReference = path.join(expectedDirectory, CANONICAL_REFERENCE_NAME);
  const expectedSource = path.join(expectedDirectory, "generated-pet.png");

  try {
    const directoryStat = fs.lstatSync(expectedDirectory);
    const referenceStat = fs.lstatSync(expectedReference);
    const sourceStat = fs.lstatSync(expectedSource);
    if (
      fs.realpathSync(candidateRoot) !== expectedRoot ||
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      fs.realpathSync(expectedDirectory) !== expectedDirectory ||
      referenceStat.isSymbolicLink() ||
      !referenceStat.isFile() ||
      fs.realpathSync(expectedReference) !== expectedReference ||
      sourceStat.isSymbolicLink() ||
      !sourceStat.isFile() ||
      fs.realpathSync(expectedSource) !== expectedSource
    ) {
      throw new Error("unsafe candidate path");
    }
  } catch {
    throw new Error("候选动画资源路径无效或已被替换。");
  }

  return {
    id: candidateId,
    directoryPath: expectedDirectory,
    referencePath: expectedReference,
    sourcePath: expectedSource,
    backgroundColor: CANONICAL_BACKGROUND_COLOR
  };
}

function resolvePendingCandidateBatch(candidateId, config = readConfig()) {
  const pendingCandidate = config.pendingCandidateBatch;
  if (!pendingCandidate || pendingCandidate.id !== candidateId) {
    throw new Error("候选批次与主进程配置不一致。");
  }
  return resolveCandidateFilesystem(candidateId);
}

function rebuildAnimationBatch(persistedBatch) {
  return applyAnimationSubmissions({
    ...stripAnimationBatchPaths(persistedBatch),
    ...resolveCandidateFilesystem(persistedBatch.id)
  });
}

function advancePersistedAnimationBatch(batch, event) {
  return {
    ...batch,
    ...advanceAnimationBatch(batch, event),
    id: batch.id,
    directoryPath: batch.directoryPath,
    sourcePath: batch.sourcePath
  };
}

function failQueuedAnimationAction(batch, actionId, message) {
  return {
    ...batch,
    status: "failed",
    candidateReady: false,
    actions: batch.actions.map((action) =>
      action.id === actionId
        ? {
            ...action,
            status: "failed",
            failure: { message }
          }
        : action
    )
  };
}

function getAnimationDestinationPaths(directoryPath) {
  const paths = {
    directoryPath,
    canonical: path.join(directoryPath, CANONICAL_REFERENCE_NAME),
    idle: path.join(directoryPath, BAKED_ANIMATION_FILES.idle),
    standSit: path.join(directoryPath, BAKED_ANIMATION_FILES["stand-sit"]),
    sleep: path.join(directoryPath, BAKED_ANIMATION_FILES.sleep)
  };
  // 额外动作（抬头/翻肚皮/奔跑/伸懒腰）只在磁盘已烘焙时才纳入激活集，
  // 这样只生成基础三个动作的宠物在 finalize 时不会因缺文件被断言拒绝。
  for (const actionId of ["look-up", "roll-over", "run", "stretch"]) {
    const filePath = path.join(directoryPath, BAKED_ANIMATION_FILES[actionId]);
    if (fs.existsSync(filePath)) {
      paths[actionId] = filePath;
    }
  }
  return paths;
}

function getActionDestinationPath(batch, actionId) {
  const fileName = ANIMATION_FILES[actionId];
  if (!fileName) {
    throw new Error(`未知动画动作：${actionId}`);
  }

  return path.join(batch.directoryPath, fileName);
}

function getActionBakedPath(batch, actionId) {
  const fileName = BAKED_ANIMATION_FILES[actionId];
  if (!fileName) {
    throw new Error(`未知动画动作：${actionId}`);
  }

  return path.join(batch.directoryPath, fileName);
}

// 读取用户设定的抠绿相似度，缺省/非法时回退默认值。供生成流水线与重新抠图复用。
function getChromaSimilarity(config = readConfig()) {
  const value = Number(config?.chromaSimilarity);
  return Number.isFinite(value) ? clampChromaSimilarity(value) : DEFAULT_CHROMA_SIMILARITY;
}

// 把抠绿相似度夹到与烘焙模块一致的合法区间，避免持久化非法值。
function clampChromaSimilarity(value) {
  return Math.min(MAX_CHROMA_SIMILARITY, Math.max(MIN_CHROMA_SIMILARITY, value));
}

// 读取用户选定的模型提供商（品牌），基于它返回图片和视频模型。
function getModelProvider(config = readConfig()) {
  return normalizeProviderId(config?.modelProvider);
}

// 根据提供商获取图片模型。
function getImageModel(config = readConfig()) {
  return getProviderDefinition(getModelProvider(config)).imageModel;
}

// 根据提供商获取视频模型。
function getVideoModel(config = readConfig()) {
  return getProviderDefinition(getModelProvider(config)).videoModel;
}

// 获取当前有效的动画定义（根据提供商中的视频模型）。
function getCurrentAnimationDefinitions(config = readConfig()) {
  const videoModel = getVideoModel(config);
  return videoModel === "sora-2" ? ANIMATION_DEFINITIONS : buildAnimationDefinitions(videoModel);
}

// 根据配置获取对应的动画定义。
function getAnimationDefinitionFromConfig(actionId, config = readConfig()) {
  const defs = getCurrentAnimationDefinitions(config);
  const def = ANIMATION_DEFINITION_BY_ID.get(actionId);
  if (!def) return null;
  return defs.find((d) => d.id === actionId) || def;
}

function getAnimationDefinitionForVideoModel(actionId, videoModel) {
  return buildAnimationDefinitions(videoModel).find((definition) => definition.id === actionId) || null;
}

function getCurrentInProgressAction(batch) {
  return batch.actions.find((action) => action.status === "in_progress") || null;
}

function batchNeedsRemoteWork(batch, allowCreate) {
  if (!batch || isTerminalAnimationBatch(batch)) {
    return false;
  }

  if (getCurrentInProgressAction(batch)) {
    return true;
  }

  return Boolean(allowCreate && getNextPendingAction(batch));
}

function createRetryFailedAnimationBatch(batch) {
  if (!batch || batch.status !== "failed") {
    throw new Error("当前没有失败的动画动作可重试。");
  }

  const failedIndex = batch.actions.findIndex((action) => action.status === "failed");
  if (failedIndex === -1) {
    throw new Error("当前没有失败的动画动作可重试。");
  }

  if (!batch.actions.slice(0, failedIndex).every((action) => action.status === "completed")) {
    throw new Error("失败动作前仍有未完成动作，无法单独重试。");
  }

  return {
    ...batch,
    status: "in_progress",
    candidateReady: false,
    cancellationRequested: false,
    actions: batch.actions.map((action, index) => {
      if (index < failedIndex) {
        return action;
      }
      return {
        ...action,
        status: "queued",
        remoteTaskId: null,
        progress: 0,
        failure: null
      };
    })
  };
}

function writeAnimationBatch(config, batch) {
  const nextConfig = {
    ...config,
    ...(config.pendingCandidateBatch
      ? { pendingCandidateBatch: { id: config.pendingCandidateBatch.id } }
      : {}),
    pendingAnimationBatch: stripAnimationBatchPaths(batch)
  };
  writeConfigAtomically(nextConfig);
  sendWindowEvent("pet-animation-progress", batch);
  return nextConfig;
}

function isPathWithinRoot(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function createUnsafeCandidatePathError() {
  return new Error("候选动画资源路径无效或已被替换。");
}

function createAnimationReceiptError() {
  return new Error("动画远端任务记录无效或已被替换。");
}

function writeFileNoFollow(filePath, content, validateBeforeWrite) {
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag;
  const descriptor = fs.openSync(filePath, flags, 0o600);
  try {
    if (typeof validateBeforeWrite === "function") {
      validateBeforeWrite(descriptor);
    }
    fs.writeSync(descriptor, content, 0, content.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertSafeCandidateFile(candidate, filePath, options = {}) {
  const { mustExist = true } = options;
  const safeCandidate = resolveCandidateFilesystem(candidate.id);
  const candidateDirectory = safeCandidate.directoryPath;
  const resolvedFilePath = path.resolve(filePath);
  const parentDirectory = path.dirname(resolvedFilePath);

  if (
    !isPathWithinRoot(candidateDirectory, resolvedFilePath) ||
    path.dirname(resolvedFilePath) !== candidateDirectory
  ) {
    throw createUnsafeCandidatePathError();
  }

  try {
    const parentStat = fs.lstatSync(parentDirectory);
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      fs.realpathSync(parentDirectory) !== parentDirectory ||
      !isPathWithinRoot(candidateDirectory, parentDirectory)
    ) {
      throw createUnsafeCandidatePathError();
    }

    let fileStat = null;
    try {
      fileStat = fs.lstatSync(resolvedFilePath);
    } catch (error) {
      if (!mustExist && error?.code === "ENOENT") {
        return {
          candidate: safeCandidate,
          filePath: resolvedFilePath,
          parentPath: parentDirectory,
          parentStat,
          stat: null
        };
      }
      throw error;
    }

    if (
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fs.realpathSync(resolvedFilePath) !== resolvedFilePath ||
      !isPathWithinRoot(candidateDirectory, resolvedFilePath)
    ) {
      throw createUnsafeCandidatePathError();
    }

    fs.accessSync(resolvedFilePath, fs.constants.R_OK);
    return {
      candidate: safeCandidate,
      filePath: resolvedFilePath,
      parentPath: parentDirectory,
      parentStat,
      stat: fileStat
    };
  } catch (error) {
    if (error.message === "候选动画资源路径无效或已被替换。") {
      throw error;
    }
    throw createUnsafeCandidatePathError();
  }
}

function readSafeCandidateBuffer(candidate, filePath) {
  const mimeType = mimeTypeForPath(filePath);
  if (!mimeType) {
    return null;
  }

  const safeFile = assertSafeCandidateFile(candidate, filePath, { mustExist: true });
  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;

  try {
    descriptor = fs.openSync(safeFile.filePath, fs.constants.O_RDONLY | noFollowFlag);
    const descriptorStat = fs.fstatSync(descriptor);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== safeFile.stat.dev ||
      descriptorStat.ino !== safeFile.stat.ino
    ) {
      throw createUnsafeCandidatePathError();
    }

    const buffer = fs.readFileSync(descriptor);
    return { buffer, mimeType, fileName: path.basename(safeFile.filePath) };
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOENT") {
      throw createUnsafeCandidatePathError();
    }
    if (error.message === "候选动画资源路径无效或已被替换。") {
      throw error;
    }
    throw createUnsafeCandidatePathError();
  } finally {
    if (typeof descriptor === "number") {
      fs.closeSync(descriptor);
    }
  }
}

function createCandidateWriteGuard(candidate, destination) {
  const snapshot = assertSafeCandidateFile(candidate, destination, { mustExist: false });

  return (filePath, options = {}) => {
    const resolvedFilePath = path.resolve(filePath);
    if (path.dirname(resolvedFilePath) !== snapshot.parentPath) {
      throw createUnsafeCandidatePathError();
    }

    const currentTarget = assertSafeCandidateFile(candidate, resolvedFilePath, {
      mustExist: options.mustExist === true
    });
    if (
      currentTarget.parentStat.dev !== snapshot.parentStat.dev ||
      currentTarget.parentStat.ino !== snapshot.parentStat.ino
    ) {
      throw createUnsafeCandidatePathError();
    }
    if (typeof options.descriptor === "number") {
      if (!currentTarget.stat) {
        throw createUnsafeCandidatePathError();
      }
      const descriptorStat = fs.fstatSync(options.descriptor);
      if (
        !descriptorStat.isFile() ||
        descriptorStat.dev !== currentTarget.stat.dev ||
        descriptorStat.ino !== currentTarget.stat.ino
      ) {
        throw createUnsafeCandidatePathError();
      }
    }
    return currentTarget;
  };
}

function getAnimationSubmissionPath(candidate) {
  return path.join(candidate.directoryPath, ANIMATION_SUBMISSIONS_NAME);
}

function readAnimationSubmissions(candidate) {
  const receiptPath = getAnimationSubmissionPath(candidate);
  let safeFile;
  try {
    const receiptStat = fs.lstatSync(receiptPath);
    if (receiptStat.isSymbolicLink()) {
      throw createAnimationReceiptError();
    }
    safeFile = assertSafeCandidateFile(candidate, receiptPath, { mustExist: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { batchId: candidate.id, actions: {} };
    }
    if (error.message === "动画远端任务记录无效或已被替换。") {
      throw error;
    }
    throw createAnimationReceiptError();
  }

  const noFollowFlag = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(safeFile.filePath, fs.constants.O_RDONLY | noFollowFlag);
    const descriptorStat = fs.fstatSync(descriptor);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.dev !== safeFile.stat.dev ||
      descriptorStat.ino !== safeFile.stat.ino
    ) {
      throw createAnimationReceiptError();
    }

    const parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (parsed?.batchId !== candidate.id || !parsed.actions || typeof parsed.actions !== "object") {
      throw createAnimationReceiptError();
    }
    const actions = {};
    for (const [actionId, value] of Object.entries(parsed.actions)) {
      if (!getAnimationDefinition(actionId) || typeof value?.remoteTaskId !== "string" || !value.remoteTaskId) {
        throw createAnimationReceiptError();
      }
      actions[actionId] = { remoteTaskId: value.remoteTaskId };
    }
    return { batchId: candidate.id, actions };
  } catch (error) {
    if (error.message === "动画远端任务记录无效或已被替换。") {
      throw error;
    }
    throw createAnimationReceiptError();
  } finally {
    if (typeof descriptor === "number") {
      fs.closeSync(descriptor);
    }
  }
}

function writeAnimationSubmission(candidate, actionId, remoteTaskId) {
  if (!getAnimationDefinition(actionId) || typeof remoteTaskId !== "string" || !remoteTaskId) {
    throw createAnimationReceiptError();
  }

  const receiptPath = getAnimationSubmissionPath(candidate);
  const temporaryPath = path.join(
    candidate.directoryPath,
    `.animation-submissions-${randomUUID()}.tmp`
  );
  const existingSubmissions = readAnimationSubmissions(candidate);
  const actionIndex = ANIMATION_DEFINITIONS.findIndex((definition) => definition.id === actionId);
  const allowedActionIds = new Set(
    ANIMATION_DEFINITIONS.slice(0, actionIndex + 1).map((definition) => definition.id)
  );
  const submissions = { batchId: candidate.id, actions: {} };
  for (const [existingActionId, submission] of Object.entries(existingSubmissions.actions)) {
    if (allowedActionIds.has(existingActionId)) {
      submissions.actions[existingActionId] = submission;
    }
  }
  submissions.actions[actionId] = { remoteTaskId };
  const assertDestinationSafe = createCandidateWriteGuard(candidate, receiptPath);

  try {
    assertDestinationSafe(receiptPath);
    assertDestinationSafe(temporaryPath);
    writeFileNoFollow(
      temporaryPath,
      Buffer.from(JSON.stringify(submissions, null, 2)),
      (descriptor) => assertDestinationSafe(temporaryPath, { mustExist: true, descriptor })
    );
    assertDestinationSafe(temporaryPath);
    assertDestinationSafe(receiptPath);
    fs.renameSync(temporaryPath, receiptPath);
    assertSafeCandidateFile(candidate, receiptPath, { mustExist: true });
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (error.message === "候选动画资源路径无效或已被替换。") {
      throw error;
    }
    throw createAnimationReceiptError();
  }
}

function applyAnimationSubmissions(batch) {
  const candidate = resolveCandidateFilesystem(batch.id);
  const submissions = readAnimationSubmissions(candidate);
  let nextBatch = batch;

  for (const action of batch.actions) {
    const remoteTaskId = submissions.actions[action.id]?.remoteTaskId;
    if (!remoteTaskId) {
      continue;
    }
    if (action.remoteTaskId) {
      if (action.status === "failed" && action.remoteTaskId !== remoteTaskId) {
        const actionIndex = nextBatch.actions.findIndex((item) => item.id === action.id);
        if (
          actionIndex === -1 ||
          !nextBatch.actions.slice(0, actionIndex).every((item) => item.status === "completed")
        ) {
          throw createAnimationReceiptError();
        }
        nextBatch = {
          ...nextBatch,
          status: "in_progress",
          candidateReady: false,
          actions: nextBatch.actions.map((item) =>
            item.id === action.id
              ? {
                  ...item,
                  remoteTaskId,
                  progress: 0,
                  status: "in_progress",
                  failure: null
                }
              : item
          )
        };
      }
      continue;
    }
    if (action.status !== "queued") {
      throw createAnimationReceiptError();
    }
    nextBatch = advancePersistedAnimationBatch(nextBatch, {
      type: "submitted",
      actionId: action.id,
      remoteTaskId
    });
  }

  return {
    ...nextBatch,
    ...candidate
  };
}

function assertReadyAnimationFiles(candidate) {
  const activeAnimationPaths = getAnimationDestinationPaths(candidate.directoryPath);
  for (const filePath of Object.values(activeAnimationPaths)) {
    if (filePath === candidate.directoryPath) {
      continue;
    }
    assertSafeCandidateFile(candidate, filePath, { mustExist: true });
  }
  return activeAnimationPaths;
}

function finalizeActiveAnimationVersion(batch) {
  const latestConfig = readConfig();
  const candidate = resolveCandidateFilesystem(batch.id);
  const activeAnimationPaths = assertReadyAnimationFiles(candidate);

  const nextConfig = {
    ...latestConfig,
    activeAnimationVersion: batch.id,
    activeAnimationPaths,
    pendingAnimationBatch: latestConfig.pendingAnimationBatch?.id === batch.id
      ? null
      : latestConfig.pendingAnimationBatch,
    pendingCandidateBatch: latestConfig.pendingCandidateBatch?.id === batch.id
      ? null
      : latestConfig.pendingCandidateBatch
  };
  writeConfigAtomically(nextConfig);
  sendWindowEvent("pet-animation-progress", null);
  return nextConfig;
}

function getOpenAIApiKey(config = readConfig()) {
  const provider = getModelProvider(config);
  const providerLabel = AVAILABLE_PROVIDERS.find((p) => p.id === provider)?.label || "OpenAI";
  const apiKey = decryptApiKey(getEncryptedApiKey(config, provider));
  if (!apiKey) {
    throw new Error(`请先填写并保存 ${providerLabel} API Key。`);
  }
  validateApiKeyFormat(apiKey, provider);
  return apiKey;
}

function isTerminalAnimationBatch(batch) {
  return ["cancelled", "failed", "completed"].includes(batch?.status);
}

function assertPendingBatchIdsMatch(config) {
  if (
    config.pendingAnimationBatch &&
    config.pendingCandidateBatch?.id !== config.pendingAnimationBatch.id
  ) {
    throw new Error("候选批次与动画批次 ID 不一致，已保留现有状态。");
  }
}

function prepareConfigForPetGeneration(config) {
  if (animationRunState?.promise) {
    throw new Error("已有动画任务进行中，请先等待或取消当前动画任务。");
  }

  const pendingBatch = config.pendingAnimationBatch;
  if (!pendingBatch) {
    return config;
  }

  // 没有正在运行的动画任务（animationRunState 为空）却残留 pendingAnimationBatch，
  // 说明上次生成被中途打断。重新生成时应丢弃这个残留批次，而不是永久阻塞用户。
  const nextConfig = { ...config };
  delete nextConfig.pendingAnimationBatch;
  if (nextConfig.pendingCandidateBatch?.id === pendingBatch.id) {
    delete nextConfig.pendingCandidateBatch;
  }
  writeConfigAtomically(nextConfig);
  return nextConfig;
}

function isAnimationWorkActive(runState) {
  return !animationShutdownRequested && !(runState?.stopRequested);
}

function stopAnimationWait(runState) {
  if (!runState?.pendingWait) {
    return;
  }

  const { timeoutId, reject } = runState.pendingWait;
  runState.pendingWait = null;
  clearTimeout(timeoutId);
  reject(createLocalAnimationStopError());
}

function requestAnimationShutdown() {
  animationShutdownRequested = true;
  if (animationRunState) {
    animationRunState.stopRequested = true;
    stopAnimationWait(animationRunState);
  }
}

function getAnimationPersistenceBarrier() {
  return animationRunState?.criticalPersistencePromise || null;
}

function finishQuitAfterAnimationPersistence() {
  if (animationQuitPending) {
    return;
  }

  const barrier = getAnimationPersistenceBarrier();
  if (!barrier) {
    return;
  }

  animationQuitPending = true;
  Promise.resolve(barrier)
    .catch(() => {})
    .finally(() => {
      animationQuitReady = true;
      app.quit();
    });
}

function createAnimationWait(runState) {
  return (milliseconds) =>
    new Promise((resolve, reject) => {
      if (!isAnimationWorkActive(runState)) {
        reject(createLocalAnimationStopError());
        return;
      }

      const timeoutId = setTimeout(() => {
        if (runState.pendingWait?.timeoutId === timeoutId) {
          runState.pendingWait = null;
        }
        resolve();
      }, milliseconds);

      runState.pendingWait = {
        timeoutId,
        reject
      };
    });
}

function getProviderApiName(provider = DEFAULT_MODEL_PROVIDER) {
  // 返回 API 平台名称用于错误消息
  if (provider === "bytedance") {
    return "字节跳动（火山引擎）";
  }
  return "OpenAI";
}

function toProviderError(error, message, provider = DEFAULT_MODEL_PROVIDER) {
  if (message) {
    return new Error(message);
  }
  return error;
}

function createRemoteAnimationFailedError(video) {
  return Object.assign(new Error(video.error?.message || "远端任务失败。"), {
    code: "SORA_REMOTE_FAILED"
  });
}

function humanizeAnimationError(error, { provider = DEFAULT_MODEL_PROVIDER, proxyRule, phase }) {
  const errorType = error.name || error.constructor?.name;
  const providerName = getProviderApiName(provider);

  if (isAnimationStopError(error)) {
    return error;
  }
  if (errorType === "AuthenticationError" || error.status === 401) {
    return toProviderError(
      error,
      `${providerName} API Key 无效。请检查密钥是否正确并重新填写。`,
      provider
    );
  }
  if (error.status === 403) {
    if (provider === "bytedance") {
      return toProviderError(error, `当前账号没有必要的模型权限。请检查字节 API 账户配置。`, provider);
    }
    return toProviderError(
      error,
      "当前 OpenAI 账号没有 Videos API 或 Sora 模型访问权限。",
      provider
    );
  }
  if (error.status === 429) {
    if (provider === "bytedance") {
      return toProviderError(error, "字节 API 请求过于频繁，已限流。请稍后重试。", provider);
    }
    return toProviderError(
      error,
      "Sora 视频生成请求过于频繁，OpenAI 暂时限流。请稍后重试。",
      provider
    );
  }
  if (errorType === "APIConnectionTimeoutError") {
    const route = proxyRule === "DIRECT" ? "直连" : `系统代理（${proxyRule}）`;
    const apiName = provider === "bytedance" ? "API" : "Videos API";
    return toProviderError(error, `无法通过${route}连接 ${providerName} ${apiName}，请检查网络后重试。`, provider);
  }
  if (error.code === "SORA_REMOTE_FAILED") {
    const actionName = provider === "bytedance" ? "字节视频生成" : "Sora 动画生成";
    return toProviderError(error, `${actionName}失败：${error.message}`, provider);
  }
  if (phase === "download") {
    const actionName = provider === "bytedance" ? "字节视频下载" : "Sora 动画下载";
    return toProviderError(error, `${actionName}失败：${error.message || "请稍后重试。"}`, provider);
  }
  if (phase === "bake") {
    return toProviderError(error, `动画透明处理失败：${error.message || "请稍后重试。"}`, provider);
  }
  return error;
}

function mergeSubmittedRemoteTask(batch, actionId, remoteTaskId, runState) {
  const action = batch.actions.find((item) => item.id === actionId);
  if (!action) {
    throw new Error(`找不到当前动作：${actionId}`);
  }

  if (action.status === "queued") {
    runState.cancelledCreateActionId = null;
    return advancePersistedAnimationBatch(batch, {
      type: "submitted",
      actionId,
      remoteTaskId
    });
  }

  if (batch.cancellationRequested && action.status === "cancelled") {
    runState.cancelledCreateActionId = actionId;
    return {
      ...batch,
      status: "cancelling",
      candidateReady: false,
      actions: batch.actions.map((item) =>
        item.id === actionId
          ? {
              ...item,
              remoteTaskId,
              progress: 0,
              status: "in_progress",
              failure: null
            }
          : item
      )
    };
  }

  throw new Error(`动作 ${actionId} 不能再次提交。`);
}

async function runAnimationBatch({ batch, allowCreate, client, proxyRule, runState }) {
  let currentBatch = runState.currentBatch || batch;
  let currentConfig = readConfig();
  const provider = runState.provider || currentBatch.provider || getModelProvider(currentConfig);
  const videoModel =
    runState.videoModel ||
    currentBatch.videoModel ||
    getProviderDefinition(provider).videoModel;

  while (isAnimationWorkActive(runState)) {
    currentBatch = runState.currentBatch || currentBatch;
    let currentAction = getCurrentInProgressAction(currentBatch);

    if (!currentAction) {
      const nextPendingAction = getNextPendingAction(currentBatch);
      if (!nextPendingAction || !allowCreate) {
        break;
      }
      const nextDefinition = getAnimationDefinitionForVideoModel(nextPendingAction.id, videoModel);
      if (!nextDefinition) {
        const definitionError = new Error(
          `找不到动作 ${nextPendingAction.id} 对应的动画定义。`
        );
        const failedBatch = failQueuedAnimationAction(
          currentBatch,
          nextPendingAction.id,
          definitionError.message
        );
        currentConfig = writeAnimationBatch(readConfig(), failedBatch);
        runState.currentBatch = failedBatch;
        throw definitionError;
      }

      const candidate = resolveCandidateFilesystem(currentBatch.id);
      currentBatch = { ...currentBatch, ...candidate };
      runState.currentBatch = currentBatch;
      const reference = readSafeCandidateBuffer(candidate, candidate.referencePath);
      if (!reference) {
        throw new Error("无法读取标准坐姿参考图。");
      }
      const referenceFile = await toFile(reference.buffer, reference.fileName, {
        type: reference.mimeType
      });

      runState.createInFlight = true;
      try {
        runState.criticalPersistencePromise = (async () => {
          const video = await createSoraAnimationJob({
            client,
            definition: nextDefinition,
            referenceFile
          });
          currentBatch = mergeSubmittedRemoteTask(
            runState.currentBatch || currentBatch,
            nextPendingAction.id,
            video.id,
            runState
          );
          runState.currentBatch = currentBatch;
          writeAnimationSubmission(candidate, nextPendingAction.id, video.id);
          currentConfig = writeAnimationBatch(readConfig(), currentBatch);
          return video;
        })();
        await runState.criticalPersistencePromise;
      } catch (error) {
        currentBatch = runState.currentBatch || currentBatch;
        if (!isAnimationWorkActive(runState)) {
          return {
            batch: currentBatch,
            activeAnimationVersion: readConfig().activeAnimationVersion || ""
          };
        }
        const persistedAction = currentBatch.actions.find(
          (action) => action.id === nextPendingAction.id
        );
        if (persistedAction?.remoteTaskId) {
          throw humanizeAnimationError(error, { provider, proxyRule, phase: "create" });
        }
        const failedBatch = failQueuedAnimationAction(
          currentBatch,
          nextPendingAction.id,
          humanizeAnimationError(error, { provider, proxyRule, phase: "create" }).message
        );
        writeAnimationBatch(readConfig(), failedBatch);
        throw humanizeAnimationError(error, { provider, proxyRule, phase: "create" });
      } finally {
        runState.createInFlight = false;
        runState.criticalPersistencePromise = null;
      }

      if (!isAnimationWorkActive(runState)) {
        return {
          batch: currentBatch,
          activeAnimationVersion: currentConfig.activeAnimationVersion || ""
        };
      }
      currentAction = getCurrentInProgressAction(currentBatch);
    }

    let video;
    try {
      video = await pollSoraAnimationJob({
        client,
        videoId: currentAction.remoteTaskId,
        wait: createAnimationWait(runState),
        shouldContinue: () => isAnimationWorkActive(runState),
        onProgress: (progressVideo) => {
          currentBatch = runState.currentBatch || currentBatch;
          if (progressVideo.status !== "queued" && progressVideo.status !== "in_progress") {
            return;
          }

          currentBatch = advancePersistedAnimationBatch(currentBatch, {
            type: "progress",
            actionId: currentAction.id,
            progress: progressVideo.progress
          });
          currentConfig = writeAnimationBatch(readConfig(), currentBatch);
          runState.currentBatch = currentBatch;
        }
      });
    } catch (error) {
      currentBatch = runState.currentBatch || currentBatch;
      if (currentBatch.cancellationRequested) {
        const cancelledBatch = advancePersistedAnimationBatch(currentBatch, {
          type: "cancelled",
          actionId: currentAction.id
        });
        const cancelledConfig = writeAnimationBatch(readConfig(), cancelledBatch);
        runState.currentBatch = cancelledBatch;
        return {
          batch: cancelledConfig.pendingAnimationBatch,
          activeAnimationVersion: cancelledConfig.activeAnimationVersion || ""
        };
      }
      if (isAnimationStopError(error) || !isAnimationWorkActive(runState)) {
        return {
          batch: currentBatch,
          activeAnimationVersion: readConfig().activeAnimationVersion || ""
        };
      }

      const failedBatch = advancePersistedAnimationBatch(currentBatch, {
        type: "failed",
        actionId: currentAction.id,
        message: humanizeAnimationError(error, { provider, proxyRule, phase: "poll" }).message
      });
      writeAnimationBatch(readConfig(), failedBatch);
      runState.currentBatch = failedBatch;
      throw humanizeAnimationError(error, { provider, proxyRule, phase: "poll" });
    }

    if (!isAnimationWorkActive(runState)) {
      return {
        batch: currentBatch,
        activeAnimationVersion: readConfig().activeAnimationVersion || ""
      };
    }

    currentBatch = runState.currentBatch || currentBatch;
    currentAction = getCurrentInProgressAction(currentBatch) || currentAction;

    if (video.status === "failed") {
      if (currentBatch.cancellationRequested) {
        currentBatch = advancePersistedAnimationBatch(currentBatch, {
          type: "cancelled",
          actionId: currentAction.id
        });
        currentConfig = writeAnimationBatch(readConfig(), currentBatch);
        runState.currentBatch = currentBatch;
        break;
      }
      const remoteError = createRemoteAnimationFailedError(video);
      currentBatch = advancePersistedAnimationBatch(currentBatch, {
        type: "failed",
        actionId: currentAction.id,
        message: humanizeAnimationError(remoteError, { provider, proxyRule, phase: "poll" }).message
      });
      writeAnimationBatch(readConfig(), currentBatch);
      runState.currentBatch = currentBatch;
      throw humanizeAnimationError(remoteError, { provider, proxyRule, phase: "poll" });
    }

    try {
      const candidate = resolveCandidateFilesystem(currentBatch.id);
      currentBatch = { ...currentBatch, ...candidate };
      runState.currentBatch = currentBatch;
      const destination = assertSafeCandidateFile(
        candidate,
        getActionDestinationPath(candidate, currentAction.id),
        { mustExist: false }
      ).filePath;
      const assertDestinationSafe = createCandidateWriteGuard(candidate, destination);
      await downloadSoraAnimation({
        client,
        videoId: currentAction.remoteTaskId,
        destination,
        assertDestinationSafe
      });
      assertSafeCandidateFile(candidate, destination, { mustExist: true });

      // 下载得到的是绿幕 mp4，仅作中转；在这里一次性烘焙成带透明通道的 webm，
      // 渲染层直接播放透明视频，避免实时抠像残留绿色。烘焙产物才是激活用的文件。
      const bakedDestination = assertSafeCandidateFile(
        candidate,
        getActionBakedPath(candidate, currentAction.id),
        { mustExist: false }
      ).filePath;
      try {
        await bakeAnimation({
          inputPath: destination,
          referencePath: candidate.referencePath,
          outputPath: bakedDestination,
          backgroundColor: currentBatch.backgroundColor || CANONICAL_BACKGROUND_COLOR,
          chromaSimilarity: getChromaSimilarity(readConfig())
        });
      } catch (bakeError) {
        bakeError.animationPhase = "bake";
        throw bakeError;
      }
      assertSafeCandidateFile(candidate, bakedDestination, { mustExist: true });
    } catch (error) {
      currentBatch = runState.currentBatch || currentBatch;
      if (!isAnimationWorkActive(runState)) {
        return {
          batch: currentBatch,
          activeAnimationVersion: readConfig().activeAnimationVersion || ""
        };
      }
      if (currentBatch.cancellationRequested) {
        if (runState.cancelledCreateActionId === currentAction.id) {
          runState.cancelledCreateActionId = null;
        }
        const cancelledBatch = advancePersistedAnimationBatch(currentBatch, {
          type: "cancelled",
          actionId: currentAction.id
        });
        const cancelledConfig = writeAnimationBatch(readConfig(), cancelledBatch);
        runState.currentBatch = cancelledBatch;
        return {
          batch: cancelledConfig.pendingAnimationBatch,
          activeAnimationVersion: cancelledConfig.activeAnimationVersion || ""
        };
      }
      const failurePhase = error.animationPhase === "bake" ? "bake" : "download";
      const failedBatch = advancePersistedAnimationBatch(currentBatch, {
        type: "failed",
        actionId: currentAction.id,
        message: humanizeAnimationError(error, { provider, proxyRule, phase: failurePhase }).message
      });
      writeAnimationBatch(readConfig(), failedBatch);
      runState.currentBatch = failedBatch;
      throw humanizeAnimationError(error, { provider, proxyRule, phase: failurePhase });
    }

    currentBatch = advancePersistedAnimationBatch(currentBatch, {
      type:
        currentBatch.cancellationRequested && runState.cancelledCreateActionId === currentAction.id
          ? "cancelled"
          : "completed",
      actionId: currentAction.id
    });
    if (runState.cancelledCreateActionId === currentAction.id) {
      runState.cancelledCreateActionId = null;
    }
    currentConfig = writeAnimationBatch(readConfig(), currentBatch);
    runState.currentBatch = currentBatch;
  }

  if (currentBatch.status === "completed" && isAnimationWorkActive(runState)) {
    currentConfig = finalizeActiveAnimationVersion(currentBatch);
  }

  return {
    batch: currentConfig.pendingAnimationBatch,
    activeAnimationVersion: currentConfig.activeAnimationVersion || ""
  };
}

async function startAnimationRun({ batch, allowCreate, persistOnStart = true }) {
  if (animationRunState?.promise) {
    if (animationRunState.batchId === batch.id) {
      return animationRunState.promise;
    }
    throw new Error("已有动画生成任务进行中，请等待当前任务完成。");
  }

  animationShutdownRequested = false;
  const runState = {
    allowCreate,
    batchId: batch.id,
    cancelledCreateActionId: null,
    currentBatch: batch,
    createInFlight: false,
    criticalPersistencePromise: null,
    pendingWait: null,
    promise: null,
    stopRequested: false
  };

  animationRunState = runState;
  if (persistOnStart) {
    try {
      writeAnimationBatch(readConfig(), batch);
    } catch (error) {
      if (animationRunState === runState) {
        animationRunState = null;
      }
      throw error;
    }
  }
  runState.promise = (async () => {
    let proxyRule = "DIRECT";
    let client = null;
    if (batchNeedsRemoteWork(batch, allowCreate)) {
      const config = readConfig();
      const provider = batch.provider || getModelProvider(config);
      const videoModel = batch.videoModel || getProviderDefinition(provider).videoModel;
      runState.provider = provider;
      runState.videoModel = videoModel;
      const providerConfig = { ...config, modelProvider: provider };
      const apiKey = getOpenAIApiKey(providerConfig);
      proxyRule = await getOpenAIProxyRule();
      client = provider === "bytedance"
        ? createReliableBytedanceClient({ apiKey, fetch: nodeHttpFetch })
        : createOpenAIClient(apiKey);
    }
    return runAnimationBatch({
      batch,
      allowCreate,
      client,
      proxyRule,
      runState
    });
  })().finally(() => {
    if (runState.pendingWait) {
      clearTimeout(runState.pendingWait.timeoutId);
      runState.pendingWait = null;
    }
    if (animationRunState === runState) {
      animationRunState = null;
    }
  });
  return runState.promise;
}

async function getOpenAIProxyRule() {
  return session.defaultSession.resolveProxy("https://api.openai.com");
}

// 读取环境变量里的代理（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY），显式应用到
// Electron 默认 session。net.fetch 跟随 Electron 的代理配置，而不读环境变量，
// 因此必须在这里手动桥接，否则在「系统代理未开、仅终端代理」的环境下会连不上
// OpenAI（表现为 Connection error）。
async function applyEnvironmentProxy() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";

  if (!proxyUrl) {
    return "";
  }

  try {
    const normalized = proxyUrl.replace(/^socks5?:\/\//i, "socks5://");
    // 直连 OpenAI 域名走代理；本地回环地址绕过代理。
    await session.defaultSession.setProxy({
      proxyRules: normalized,
      proxyBypassRules: "<local>"
    });
    return proxyUrl;
  } catch (error) {
    console.warn("应用环境变量代理失败，将回退到系统代理设置：", error?.message || error);
    return "";
  }
}

function createOpenAIClient(apiKey) {
  return new OpenAI({
    apiKey,
    timeout: 30 * 60 * 1000,
    maxRetries: 0,
    fetch: net.fetch
  });
}

function createBytedanceClient(apiKey) {
  const baseURL = "https://ark.cn-beijing.volces.com/api/v3";

  const makeRequest = async (endpoint, method, body) => {
    const response = await net.fetch(`${baseURL}${endpoint}`, {
      method,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      ...(body && { body: JSON.stringify(body) })
    });

    if (!response.ok) {
      const error = new Error();
      error.status = response.status;
      error.message = response.statusText;
      try {
        const errorBody = await response.json();
        error.message = errorBody.message || errorBody.error?.message || response.statusText;
      } catch {}
      throw error;
    }

    return response.json();
  };

  const statusMap = {
    "PENDING": "in_progress",
    "PROCESSING": "in_progress",
    "RUNNING": "in_progress",
    "SUCCEED": "completed",
    "FAILED": "failed",
    "RETRY": "in_progress",
    "CANCEL": "failed"
  };

  const fileToDataUrl = async (file) => {
    const buffer = await file.arrayBuffer();
    const mimeType = file.type || "image/png";
    return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
  };

  // 把 "720x1280" 这类像素尺寸换算成火山引擎视频接口要的 ratio（如 "9:16"）
  const sizeToRatio = (size) => {
    const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
    if (!match) {
      return "9:16";
    }
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(width, height) || 1;
    return `${width / divisor}:${height / divisor}`;
  };

  const retrieveTask = async (taskId) => {
    const data = await makeRequest(`/contents/generations/tasks/${taskId}`, "GET", null);
    const task = data.data || data;
    const status = statusMap[task.status] || task.status;

    return {
      id: task.id,
      status,
      error: task.error,
      // 视频结果挂在 task.content.video_url（火山引擎结构），同时兼容扁平字段
      video_url:
        task.content?.video_url || task.video_url || task.output_video_url || null,
      created_at: task.created_at,
      finished_at: task.updated_at || task.finished_at
    };
  };

  return {
    models: {
      retrieve: async (modelName) => {
        return { id: modelName };
      }
    },
    images: {
      edit: async (payload) => {
        // seedream 图生图：把参考照片作为 image 字段（data URL 数组）传入
        const imageDataUrls = await Promise.all(
          payload.image.map((file) => fileToDataUrl(file))
        );

        const requestBody = {
          model: payload.model,
          prompt: payload.prompt,
          image: imageDataUrls,
          sequential_image_generation: "disabled",
          response_format: "url",
          size: "2K",
          watermark: false
        };

        const data = await makeRequest("/images/generations", "POST", requestBody);
        const first = Array.isArray(data.data) ? data.data[0] : data.data;
        const imageUrl = first?.url;
        const inlineB64 = first?.b64_json;

        if (inlineB64) {
          return { data: [{ b64_json: inlineB64 }] };
        }

        if (!imageUrl) {
          throw new Error("字节图片接口未返回图片 URL。");
        }

        // response_format=url 时下载图片再转 base64，与上层消费方保持一致
        const imageResponse = await net.fetch(imageUrl, { method: "GET" });
        if (!imageResponse.ok) {
          throw new Error(`下载生成图片失败：${imageResponse.statusText}`);
        }
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        return { data: [{ b64_json: imageBuffer.toString("base64") }] };
      }
    },
    videos: {
      create: async (payload) => {
        const content = [{ type: "text", text: payload.prompt }];

        // 首帧锚定到标准坐姿参考图；如提供尾帧参考则一并锚定
        if (payload.input_reference) {
          content.push({
            type: "image_url",
            image_url: { url: await fileToDataUrl(payload.input_reference) },
            role: "first_frame"
          });
        }
        if (payload.end_reference) {
          content.push({
            type: "image_url",
            image_url: { url: await fileToDataUrl(payload.end_reference) },
            role: "last_frame"
          });
        }

        const requestBody = {
          model: payload.model,
          content,
          ratio: sizeToRatio(payload.size),
          duration: parseInt(payload.seconds, 10),
          watermark: false
        };

        const data = await makeRequest("/contents/generations/tasks", "POST", requestBody);
        const taskId = data.data?.id || data.id;

        if (!taskId) {
          throw new Error("字节 API 响应缺少任务 ID");
        }

        return { id: taskId };
      },

      retrieve: retrieveTask,

      downloadContent: async (taskId) => {
        const taskInfo = await retrieveTask(taskId);

        if (!taskInfo.video_url) {
          throw new Error("视频 URL 不可用");
        }

        const response = await net.fetch(taskInfo.video_url, {
          method: "GET"
        });

        if (!response.ok) {
          throw new Error(`下载视频失败: ${response.statusText}`);
        }

        return response;
      }
    }
  };
}

function humanizeApiError(error, { provider = DEFAULT_MODEL_PROVIDER, model, proxyRule, purpose }) {
  const errorType = error.name || error.constructor?.name;
  const providerName = getProviderApiName(provider);

  if (errorType === "AuthenticationError" || error.status === 401) {
    return toProviderError(
      error,
      `${providerName} API Key 无效。请检查密钥是否正确并重新填写。`,
      provider
    );
  }
  if (error.status === 404) {
    return toProviderError(
      error,
      `当前账号无法使用模型 ${model}，请检查模型名称或账号权限。`,
      provider
    );
  }
  if (error.status === 403) {
    if (provider === "bytedance") {
      return toProviderError(
        error,
        "当前字节账号没有必要的模型权限，可能需要升级或联系管理员。",
        provider
      );
    }
    return toProviderError(
      error,
      purpose === "appearance"
        ? "当前 OpenAI 账号没有视觉分析模型权限，可能需要完成组织验证。"
        : "当前 OpenAI 账号没有图片模型权限，可能需要完成组织验证。",
      provider
    );
  }
  if (errorType === "APIConnectionTimeoutError") {
    const route = proxyRule === "DIRECT" ? "直连" : `系统代理（${proxyRule}）`;
    const apiName = provider === "bytedance" ? "API" : "Videos API";
    return toProviderError(error, `无法通过${route}连接 ${providerName} ${apiName}，请检查网络后重试。`, provider);
  }
  return error;
}


function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 260,
    height: 250,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  Menu.setApplicationMenu(null);
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 680,
    minHeight: 620,
    title: "创建我的桌面宠物",
    backgroundColor: "#f4f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, "settings", "index.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

async function requestGeneratedPet({ photoDataUrls, model, apiKey, batchId, provider = DEFAULT_MODEL_PROVIDER }) {
  const providerLabel = AVAILABLE_PROVIDERS.find((p) => p.id === provider)?.label || "OpenAI";
  if (!apiKey) {
    throw new Error(`请先填写并保存 ${providerLabel} API Key。`);
  }
  validateApiKeyFormat(apiKey, provider);

  if (!Array.isArray(photoDataUrls) || photoDataUrls.length !== 4 || photoDataUrls.some((photo) => !photo)) {
    throw new Error("需要正面、左侧、右侧和全身四张宠物照片。");
  }

  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp"
  };
  const photos = photoDataUrls.map(parseDataUrl);
  const imageFiles = await Promise.all(
    photos.map(({ buffer, mimeType }, index) =>
      toFile(buffer, `pet-view-${index + 1}.${extensions[mimeType]}`, {
        type: mimeType
      })
    )
  );

  const proxyRule = await getOpenAIProxyRule();
  const configuredModel = model || DEFAULT_MODEL;
  const client = provider === "bytedance"
    ? createReliableBytedanceClient({ apiKey, fetch: nodeHttpFetch })
    : createOpenAIClient(apiKey);
  let result;
  try {
    await client.models.retrieve(configuredModel);
    result = await client.images.edit({
      model: configuredModel,
      image: imageFiles,
      prompt:
        "The four input images show the same real pet from the front, left side, right side, and full body, in that order. Create one realistic full-body pet portrait of this exact animal with very high fidelity to its anatomy, proportions, face shape, muzzle length, ear shape, eye color, fur length, fur texture, coat colors, and distinctive markings. Show the pet in a standard seated pose from a fixed three-quarter view. Keep the full body fully visible, centered, and facing the same camera angle every time. Use fixed, soft, even studio lighting with no directional lighting changes. Use natural realistic fur detail, no props, no collar, no toy, no scenery, no extra animals, no text, no border, and no cast shadow. The background must be a pure opaque #00ff00 solid color with no gradient, reflections, or texture.",
      size: "1024x1536",
      quality: "medium",
      background: "opaque",
      output_format: "png",
      input_fidelity: "high"
    });
  } catch (error) {
    throw humanizeApiError(error, {
      provider,
      model: configuredModel,
      proxyRule,
      purpose: "image"
    });
  }

  const imageBase64 = result.data?.[0]?.b64_json;
  if (!imageBase64) {
    const providerName = getProviderApiName(provider);
    throw new Error(`${providerName} 没有返回可用的宠物图片。`);
  }

  const imageBuffer = Buffer.from(imageBase64, "base64");
  return {
    candidateBatch: saveCanonicalReferenceAssets(imageBuffer, { batchId })
  };
}

app.whenReady().then(async () => {
  await applyEnvironmentProxy();
  const config = readConfig();
  const hasPet = petImageUrl(config.currentPetPath);

  if (hasPet) {
    if (!config.preferGeneratedImageSet) {
      config.preferGeneratedImageSet = true;
      writeConfig(config);
    }
    createWindow();
  } else {
    openSettingsWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openSettingsWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (animationQuitReady) {
    return;
  }

  requestAnimationShutdown();
  if (getAnimationPersistenceBarrier()) {
    event?.preventDefault();
    finishQuitAfterAnimationPersistence();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("quit-app", () => {
  requestAnimationShutdown();
  app.quit();
});
ipcMain.handle("open-settings", () => openSettingsWindow());
ipcMain.handle("get-current-pet", () => {
  const config = readConfig();
  return getPetAppearance(config.currentPetPath, config);
});
ipcMain.handle("get-pet-project", () => getPetProject());
ipcMain.handle("get-api-settings", (_event, payload = {}) => {
  const config = readConfig();
  const provider = normalizeProviderId(payload.modelProvider || getModelProvider(config));
  return {
    modelProvider: provider,
    imageModel: getImageModel(config),
    chromaSimilarity: getChromaSimilarity(config),
    availableProviders: AVAILABLE_PROVIDERS,
    hasApiKey: hasEncryptedApiKey(config, provider)
  };
});
ipcMain.handle("generate-pet", async (_event, payload) => {
  const currentConfig = prepareConfigForPetGeneration(readConfig());
  const provider = normalizeProviderId(payload.modelProvider || currentConfig.modelProvider);
  let nextConfig = {
    ...currentConfig,
    modelProvider: provider,
    model: getProviderDefinition(provider).imageModel
  };
  let apiKey = payload.apiKey?.trim() || "";

  if (apiKey) {
    validateApiKeyFormat(apiKey, provider);
  } else {
    apiKey = decryptApiKey(getEncryptedApiKey(currentConfig, provider));
  }
  if (!apiKey) {
    throw new Error(`请填写 ${getProviderDefinition(provider).label} API Key。`);
  }
  validateApiKeyFormat(apiKey, provider);
  nextConfig = payload.rememberApiKey === true
    ? setEncryptedApiKey(nextConfig, provider, encryptApiKey(apiKey))
    : deleteEncryptedApiKey(nextConfig, provider);
  const transactionId = randomUUID();
  const sourcePhotoStage = stageSourcePhotos(payload.photoDataUrls, {
    batchId: transactionId
  });
  let candidateBatch;

  try {
    sendWindowEvent("pet-generation-progress", "image");
    ({ candidateBatch } = await requestGeneratedPet({
      ...payload,
      apiKey,
      provider,
      model: nextConfig.model,
      batchId: transactionId
    }));
    commitSourcePhotos(sourcePhotoStage, nextConfig, {
      configPath: getConfigPath(),
      candidateBatch
    });
  } catch (error) {
    cleanupSourcePhotoStage(sourcePhotoStage);
    if (candidateBatch?.directoryPath) {
      fs.rmSync(candidateBatch.directoryPath, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    generated: true,
    candidateBatch,
    appearanceAnalyzed: false
  };
});
ipcMain.handle("generate-pet-animations", async (_event, payload = {}) => {
  const candidateId = payload.candidateId;
  if (typeof candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error("候选批次 ID 无效。");
  }
  if (animationRunState?.promise) {
    if (animationRunState.batchId === candidateId) {
      return animationRunState.promise;
    }
    throw new Error("已有动画生成任务进行中，请等待当前任务完成。");
  }

  let config = readConfig();
  if (config.pendingAnimationBatch) {
    assertPendingBatchIdsMatch(config);
    if (!isTerminalAnimationBatch(config.pendingAnimationBatch)) {
      if (config.pendingAnimationBatch.id !== candidateId) {
        throw new Error("已有动画任务待恢复，请先恢复或取消当前任务。");
      }
      return startAnimationRun({
        batch: rebuildAnimationBatch(config.pendingAnimationBatch),
        allowCreate: true
      });
    }
    config = { ...config };
    delete config.pendingAnimationBatch;
    writeConfigAtomically(config);
  }

  const batch = createPersistedAnimationBatch(
    resolvePendingCandidateBatch(candidateId, config)
  );
  return startAnimationRun({
    batch,
    allowCreate: true
  });
});
ipcMain.handle("resume-pet-animation-jobs", async () => {
  const config = readConfig();
  if (!config.pendingAnimationBatch) {
    return {
      batch: null,
      activeAnimationVersion: config.activeAnimationVersion || ""
    };
  }

  assertPendingBatchIdsMatch(config);
  const batch = rebuildAnimationBatch(config.pendingAnimationBatch);

  return startAnimationRun({
    batch,
    allowCreate: false
  });
});
ipcMain.handle("retry-failed-pet-animation-action", async (_event, payload = {}) => {
  const candidateId = payload.candidateId;
  if (typeof candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error("候选批次 ID 无效。");
  }
  if (animationRunState?.promise) {
    throw new Error("已有动画生成任务进行中，请等待当前任务完成。");
  }

  const config = readConfig();
  if (!config.pendingAnimationBatch || config.pendingAnimationBatch.id !== candidateId) {
    throw new Error("当前没有可重试的失败动画任务。");
  }
  assertPendingBatchIdsMatch(config);

  const batch = createRetryFailedAnimationBatch(rebuildAnimationBatch(config.pendingAnimationBatch));
  return startAnimationRun({
    batch,
    allowCreate: true,
    persistOnStart: false
  });
});
ipcMain.handle("cancel-pending-pet-animations", async () => {
  const config = readConfig();
  if (!config.pendingAnimationBatch) {
    return {
      batch: null,
      activeAnimationVersion: config.activeAnimationVersion || ""
    };
  }

  assertPendingBatchIdsMatch(config);

  const nextBatch = advancePersistedAnimationBatch(config.pendingAnimationBatch, {
    type: "cancel-remaining"
  });
  const nextConfig = writeAnimationBatch(config, nextBatch);
  if (animationRunState) {
    animationRunState.currentBatch = nextBatch;
  }
  return {
    batch: nextConfig.pendingAnimationBatch,
    activeAnimationVersion: nextConfig.activeAnimationVersion || ""
  };
});

ipcMain.handle("move-window", async (_event, delta) => {
  if (mainWindow && typeof delta === "object" && delta !== null) {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + (delta.x || 0), y + (delta.y || 0));
  }
});

ipcMain.handle("show-context-menu", async () => {
  const { Menu } = require("electron");
  const menu = Menu.buildFromTemplate([
    {
      label: "设置",
      click: () => {
        openSettingsWindow();
      }
    },
    {
      label: "退出",
      click: () => {
        app.quit();
      }
    }
  ]);
  menu.popup();
});

ipcMain.handle("regenerate-single-animation", async (_event, payload = {}) => {
  const actionId = payload.actionId;
  if (!actionId || typeof actionId !== "string") {
    throw new Error("无效的动作 ID。");
  }

  const config = readConfig();
  if (!config.currentPetPath || !config.activeAnimationVersion) {
    throw new Error("尚未生成宠物，无法重生成动作。");
  }

  const targetDefinition = getAnimationDefinition(actionId);
  if (!targetDefinition) {
    throw new Error("找不到动作 " + actionId + " 的定义。");
  }

  // 使用现有的候选批次 ID（activeAnimationVersion）
  const candidateBatch = resolveCandidateFilesystem(config.activeAnimationVersion);

  // 创建仅包含该动作的批次
  const batch = createPersistedAnimationBatch(candidateBatch);
  batch.actions = [
    { id: actionId, remoteTaskId: null, progress: 0, status: "queued", failure: null }
  ];

  return startAnimationRun({
    batch,
    allowCreate: true
  });
});

ipcMain.handle("generate-more-animations", async (_event, payload = {}) => {
  const config = readConfig();
  if (!config.currentPetPath || !config.activeAnimationVersion) {
    throw new Error("尚未生成宠物，无法生成更多动作。");
  }

  // 使用现有的候选批次 ID（activeAnimationVersion）
  const candidateBatch = resolveCandidateFilesystem(config.activeAnimationVersion);

  // 创建仅包含新 4 个动作的批次
  const batch = createPersistedAnimationBatch(candidateBatch);
  batch.actions = [
    { id: "look-up", remoteTaskId: null, progress: 0, status: "queued", failure: null },
    { id: "roll-over", remoteTaskId: null, progress: 0, status: "queued", failure: null },
    { id: "run", remoteTaskId: null, progress: 0, status: "queued", failure: null },
    { id: "stretch", remoteTaskId: null, progress: 0, status: "queued", failure: null }
  ];

  return startAnimationRun({
    batch,
    allowCreate: true
  });
});

const CORE_ANIMATION_ACTIONS = new Set(["idle", "stand-sit", "sleep"]);

ipcMain.handle("delete-animation", async (_event, payload = {}) => {
  const actionId = payload.actionId;
  if (!actionId || typeof actionId !== "string") {
    throw new Error("无效的动作 ID。");
  }
  if (CORE_ANIMATION_ACTIONS.has(actionId)) {
    throw new Error("待机、站起、睡觉是核心动作，不能删除。");
  }
  if (!ANIMATION_FILES[actionId]) {
    throw new Error("未知动画动作：" + actionId);
  }

  const config = readConfig();
  if (!config.currentPetPath || !config.activeAnimationVersion) {
    throw new Error("尚未生成宠物，无法删除动作。");
  }

  const candidate = resolveCandidateFilesystem(config.activeAnimationVersion);

  // 删除烘焙产物（webm）和下载中转（mp4，若残留）。都经候选目录安全校验，
  // mustExist:false 表示文件不存在时静默跳过，删除幂等。
  for (const filePath of [
    getActionBakedPath(candidate, actionId),
    getActionDestinationPath(candidate, actionId)
  ]) {
    const safeFile = assertSafeCandidateFile(candidate, filePath, { mustExist: false });
    if (safeFile.stat) {
      fs.rmSync(safeFile.filePath, { force: true });
    }
  }

  // 删除后重算激活集（getAnimationDestinationPaths 只纳入磁盘存在的额外动作，
  // 故已删动作自然消失），写回配置并通知桌宠刷新。
  const activeAnimationPaths = assertReadyAnimationFiles(candidate);
  const nextConfig = {
    ...readConfig(),
    activeAnimationPaths
  };
  writeConfigAtomically(nextConfig);
  sendWindowEvent("pet-updated", getPetAppearance(nextConfig.currentPetPath, nextConfig));

  return { activeAnimationPaths };
});

ipcMain.handle("rekey-animation", async (_event, payload = {}) => {
  const requested = typeof payload.actionId === "string" ? payload.actionId : "all";

  const config = readConfig();
  if (!config.currentPetPath || !config.activeAnimationVersion) {
    throw new Error("尚未生成宠物，无法重新抠图。");
  }

  // 先持久化用户设定的抠图强度——滑块值即设置值，后续生成也沿用。
  let chromaSimilarity = getChromaSimilarity(config);
  if (Number.isFinite(Number(payload.chromaSimilarity))) {
    chromaSimilarity = clampChromaSimilarity(Number(payload.chromaSimilarity));
    config.chromaSimilarity = chromaSimilarity;
    writeConfig(config);
  }

  const candidate = resolveCandidateFilesystem(config.activeAnimationVersion);

  // 目标动作：单个则只处理该动作；"all" 则处理所有源 mp4 仍在磁盘上的动作。
  const targetIds =
    requested === "all"
      ? Object.keys(ANIMATION_FILES)
      : [requested];
  if (requested !== "all" && !ANIMATION_FILES[requested]) {
    throw new Error("未知动画动作：" + requested);
  }

  const failed = [];
  let processed = 0;
  for (const actionId of targetIds) {
    // 源绿幕 mp4 是重新抠图的输入；不存在则跳过（可能该动作未生成或 mp4 已清理）。
    const sourcePath = getActionDestinationPath(candidate, actionId);
    const safeSource = assertSafeCandidateFile(candidate, sourcePath, { mustExist: false });
    if (!safeSource.stat) {
      if (requested !== "all") {
        throw new Error("找不到 " + actionId + " 的源视频，无法重新抠图。");
      }
      continue;
    }

    const bakedDestination = assertSafeCandidateFile(
      candidate,
      getActionBakedPath(candidate, actionId),
      { mustExist: false }
    ).filePath;

    try {
      await bakeAnimation({
        inputPath: safeSource.filePath,
        referencePath: candidate.referencePath,
        outputPath: bakedDestination,
        backgroundColor: CANONICAL_BACKGROUND_COLOR,
        chromaSimilarity
      });
      assertSafeCandidateFile(candidate, bakedDestination, { mustExist: true });
      processed += 1;
    } catch (error) {
      failed.push({ actionId, message: error?.message || "未知错误" });
    }
  }

  if (processed === 0 && failed.length === 0) {
    throw new Error("没有可重新抠图的动作。");
  }

  // 重算激活集并通知桌宠刷新（同名 webm 已被覆盖，桌宠收到 pet-updated 会重载）。
  const activeAnimationPaths = assertReadyAnimationFiles(candidate);
  const nextConfig = {
    ...readConfig(),
    activeAnimationPaths
  };
  writeConfigAtomically(nextConfig);
  sendWindowEvent("pet-updated", getPetAppearance(nextConfig.currentPetPath, nextConfig));

  return { activeAnimationPaths, chromaSimilarity, failed };
});

module.exports = {
  __testing: {
    saveCanonicalReferenceAssets,
    stageSourcePhotos,
    commitSourcePhotos,
    createPersistedAnimationBatch,
    getAnimationDestinationPaths,
    getAnimationRunState() {
      return animationRunState;
    }
  }
};
