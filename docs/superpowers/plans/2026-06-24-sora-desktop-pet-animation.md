# Sora 桌面宠物动画实现计划

> **执行要求：** 必须使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项执行，所有功能遵循测试先行。

**目标：** 用统一标准坐姿图和三段 Sora MP4 替换程序化 3D 模型，实现写实、可持久化、可自然切换的桌面宠物动画。

**架构：** 主进程负责标准图生成、Sora 异步任务、轮询、下载和原子版本切换；渲染进程使用双视频播放器和 WebGL 色键 Shader 去除纯色背景。所有动作以坐姿待机为共同连接状态，下载完成后离线复用。

**技术栈：** Electron 31、OpenAI Node SDK 6.44、GPT Image、Sora 2 Videos API、Three.js VideoTexture、WebGL Shader、Node.js 内置测试框架。

## 全局约束

- 新增文档、界面文字和代码注释统一使用中文。
- 第一版模型使用 `sora-2`。
- 视频尺寸固定为 `720x1280`。
- 待机时长 `4` 秒，站起和睡觉时长各 `8` 秒。
- 三段视频顺序生成，禁止并发创建任务。
- 重启时优先使用本地视频，不得自动创建新任务或产生 API 费用。
- 新资源全部完成前继续使用旧资源版本。
- 任何失败都不得删除最后一次有效宠物。
- `260x250` 和 `180x180` 窗口必须完整显示宠物且无大块纯色背景。

---

### Task 1：动画配置、提示词和任务状态机

**文件：**
- 新建：`src/animation-config.js`
- 新建：`test/animation-config.test.js`

**接口：**
- `ANIMATION_DEFINITIONS`
- `createAnimationBatch(referencePath, backgroundColor)`
- `advanceAnimationBatch(batch, event)`
- `getNextPendingAction(batch)`

- [ ] **步骤 1：编写失败测试**

```js
test("三段动画按待机、站起、睡觉顺序创建", () => {
  assert.deepEqual(ANIMATION_DEFINITIONS.map((item) => item.id), ["idle", "stand-sit", "sleep"]);
  assert.deepEqual(ANIMATION_DEFINITIONS.map((item) => item.seconds), ["4", "8", "8"]);
  assert.ok(ANIMATION_DEFINITIONS.every((item) => item.size === "720x1280"));
});

test("动作失败不会推进到资源切换", () => {
  const batch = createAnimationBatch("canonical.png", "#00ff00");
  const failed = advanceAnimationBatch(batch, { type: "failed", action: "idle", message: "denied" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.candidateReady, false);
});
```

- [ ] **步骤 2：运行测试确认缺少模块**

运行：`node --test test/animation-config.test.js`

预期：`ERR_MODULE_NOT_FOUND` 或 `MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现确定性配置和纯状态机**

三个提示词都必须包含：同一宠物、固定镜头、固定光线、纯色背景、不离开画面、不增加道具、结束回到标准坐姿。状态机支持 `queued`、`in_progress`、`completed`、`failed`、`cancel-remaining`，并保留每段远端任务 ID 和进度。

- [ ] **步骤 4：运行聚焦与完整测试**

运行：`node --test test/animation-config.test.js && npm test`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add src/animation-config.js test/animation-config.test.js
git commit -m "feat: 定义 Sora 动画任务状态机"
```

### Task 2：标准坐姿图和 Sora 输入参考图

**文件：**
- 新建：`src/canonical-reference.js`
- 修改：`src/main.js`
- 修改：`package.json`
- 修改：`package-lock.json`
- 新建：`test/canonical-reference.test.js`

**接口：**
- `prepareCanonicalReference(sourcePng, options)` 返回 `720x1280` PNG Buffer
- 标准图保存为候选资源目录中的 `canonical-sit.png`

- [ ] **步骤 1：运行 `npm install pngjs@7.0.0` 并编写失败测试**

测试输入一张小尺寸 PNG，断言输出宽高为 `720x1280`、宠物区域保持比例、留白像素严格等于色键背景色 `#00ff00`。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/canonical-reference.test.js`

预期：缺少模块或函数。

- [ ] **步骤 3：实现 PNG 等比缩放和居中留白**

使用 `pngjs` 解码和编码；实现双线性缩放，不调用 macOS 专有 `sips`。输出必须准确为 `720x1280`，并保留纯色背景。

- [ ] **步骤 4：修改标准坐姿生成提示词**

现有 GPT Image 请求改为写实标准坐姿、固定三分之四角度、无道具、无阴影、`#00ff00` 纯色背景；请求尺寸固定为 `1024x1536`，背景模式为不透明。输出先保存候选原图，再通过 `prepareCanonicalReference` 生成 Sora 输入图。

- [ ] **步骤 5：移除生成流程中的结构化毛色分析调用**

保留已保存照片和 API Key；`generate-pet` 不再调用 `responses.create` 分析毛色，避免额外费用。外观配置代码可保留用于历史配置读取，但不得在新流程中触发。

- [ ] **步骤 6：验证并提交**

运行：`node --test test/canonical-reference.test.js test/appearance-persistence.test.js && npm test`

预期：标准图测试通过，启动零 API 调用测试保持通过。

```bash
git add package.json package-lock.json src/canonical-reference.js src/main.js test/canonical-reference.test.js test/appearance-persistence.test.js
git commit -m "feat: 生成 Sora 标准坐姿参考图"
```

### Task 3：Sora 任务创建、轮询、下载和恢复

**文件：**
- 新建：`src/sora-animation-service.js`
- 修改：`src/main.js`
- 修改：`src/preload.js`
- 新建：`test/sora-animation-service.test.js`
- 新建：`test/sora-animation-integration.test.js`

**接口：**
- `createSoraAnimationJob({ client, definition, referenceDataUrl })`
- `pollSoraAnimationJob({ client, videoId, wait, onProgress })`
- `downloadSoraAnimation({ client, videoId, destination })`
- IPC：`generate-pet-animations`、`resume-pet-animation-jobs`、`cancel-pending-pet-animations`
- 事件：`pet-animation-progress`

- [ ] **步骤 1：编写失败的服务测试**

```js
test("创建任务使用统一参考图和正确参数", async () => {
  await createSoraAnimationJob({ client, definition: idle, referenceDataUrl });
  assert.deepEqual(request, {
    model: "sora-2",
    prompt: idle.prompt,
    size: "720x1280",
    seconds: "4",
    input_reference: { image_url: referenceDataUrl }
  });
});
```

测试轮询间隔初始为 `10000` 毫秒，网络错误按 `10/20/40` 秒退避并设置上限；`429` 不创建新任务；完成后下载内容写入临时文件再原子重命名。

- [ ] **步骤 2：运行测试确认失败**

运行：`node --test test/sora-animation-service.test.js`

预期：缺少服务模块。

- [ ] **步骤 3：实现服务层**

使用 OpenAI SDK 的 `videos.create`、`videos.retrieve` 和 `videos.downloadContent`。所有方法支持注入 client、wait 和文件操作，测试不访问网络。

- [ ] **步骤 4：实现顺序批处理和持久化**

主进程只在上一动作完成下载后创建下一动作。每次状态变化立即写入配置；应用退出时停止等待。重新启动只恢复已有 ID 的查询，绝不重新调用 `videos.create`。

- [ ] **步骤 5：实现候选资源原子切换**

候选目录包含参考图和三段视频。四个文件全部存在且可读取时，更新 `activeAnimationVersion`；失败时旧版本路径保持不变。

- [ ] **步骤 6：错误映射与权限提示**

`401`、`403`、`429`、超时、远端任务失败、下载失败分别映射成中文错误；`403` 明确提示 Videos 权限或 Sora 模型访问权限。

- [ ] **步骤 7：验证并提交**

运行：`node --test test/sora-animation-service.test.js test/sora-animation-integration.test.js && npm test`

预期：全部通过。

```bash
git add src/sora-animation-service.js src/main.js src/preload.js test/sora-animation-service.test.js test/sora-animation-integration.test.js
git commit -m "feat: 生成并持久化 Sora 宠物动画"
```

### Task 4：设置窗口生成流程和进度界面

**文件：**
- 修改：`src/settings/index.html`
- 修改：`src/settings/settings.js`
- 修改：`src/settings/styles.css`
- 新建：`test/sora-settings.test.js`

**接口：**
- 消费：`onPetAnimationProgress(callback)`
- 命令：开始生成、取消未提交动作、单独重试失败动作、恢复任务

- [ ] **步骤 1：编写失败的界面契约测试**

验证存在三个动作进度行、百分比、取消按钮和重试按钮；验证开始前费用提示明确写出“一次图片生成和三次视频生成”。

- [ ] **步骤 2：实现分阶段状态**

界面按顺序显示：标准图、待机、站起、睡觉、本地保存。处理中禁用重复提交，但允许取消尚未创建的后续任务。

- [ ] **步骤 3：实现恢复和重试**

设置窗口打开时调用恢复 IPC；已有远端任务 ID 时继续轮询。重试只重建失败动作，不能重建已成功动作。

- [ ] **步骤 4：验证并提交**

运行：`node --test test/sora-settings.test.js && npm test`

预期：全部通过。

```bash
git add src/settings test/sora-settings.test.js
git commit -m "feat: 显示 Sora 动画生成进度"
```

### Task 5：WebGL 色键视频播放器和动作切换

**文件：**
- 新建：`src/renderer/chroma-video-player.mjs`
- 新建：`src/renderer/animation-controller.mjs`
- 修改：`src/renderer/index.html`
- 修改：`src/renderer/renderer.js`
- 修改：`src/renderer/styles.css`
- 新建：`test/animation-controller.test.js`
- 新建：`test/chroma-video-player.test.js`

**接口：**
- `createChromaVideoPlayer({ container, backgroundColor })`
- `loadAnimationSet(paths)`
- `playAction(actionId)`
- `createAnimationController({ random, transitionMs: 150 })`

- [ ] **步骤 1：编写动作控制器失败测试**

验证初始循环待机；动作只能从已下载集合选择；动作顺序为 `idle -> transition-out -> action -> transition-in -> idle`；交叉淡化固定 `150` 毫秒。

- [ ] **步骤 2：编写 Shader 数学测试**

把色差和 Alpha 计算提取为纯函数，测试纯绿色背景得到 Alpha `0`、黑白宠物主体接近 `1`、边缘值位于 `0..1`。

- [ ] **步骤 3：实现双视频 WebGL 播放器**

两个隐藏 `<video>` 元素分别承载待机和动作。Three.js 使用 `VideoTexture` 和自定义 ShaderMaterial 去除背景、羽化边缘和抑制色溢；画布全屏透明，不显示装饰容器。

- [ ] **步骤 4：实现过渡和降级**

动作结束前淡出到待机；视频解码或 WebGL 失败时显示标准坐姿图，不显示纯色背景。禁止回退到旧程序化 3D 模型。

- [ ] **步骤 5：接入本地资源和随机动作**

启动读取 `activeAnimationVersion`，没有有效视频时显示标准坐姿图；有视频时循环待机，并随机触发站起或睡觉。

- [ ] **步骤 6：验证并提交**

运行：`node --test test/animation-controller.test.js test/chroma-video-player.test.js && npm test`

预期：全部通过。

```bash
git add src/renderer test/animation-controller.test.js test/chroma-video-player.test.js
git commit -m "feat: 播放透明背景宠物动画"
```

### Task 6：Electron 视觉验证、旧 3D 清理和中文文档

**文件：**
- 修改：`test/electron-visual-harness.js`
- 新建：`test/sora-player-visual.test.js`
- 删除：`src/renderer/three-pet.js`
- 删除：`src/renderer/border-collie-model.mjs`
- 删除：`src/renderer/dog-motion.mjs`
- 删除或更新对应旧模型测试
- 删除：`src/appearance-analysis.js`
- 删除：`src/appearance-profile.js`
- 删除或更新对应外观分析测试和 IPC
- 修改：`README.md`

- [ ] **步骤 1：准备不依赖 API 的测试视频夹具**

生成短小本地视频或使用 Canvas 驱动的测试帧，包含纯绿色背景和移动的黑白宠物形状，确保测试不访问 Sora。

- [ ] **步骤 2：扩展 Electron harness**

验证桌面和紧凑窗口中画面非空、背景角落 Alpha 接近 `0`、主体像素保留；连续执行待机、站起、待机、睡觉、待机，检查没有空白帧。

- [ ] **步骤 3：验证布局与性能**

检查 `260x250` 和 `180x180` 截图无裁切、设置按钮不遮挡宠物主体；采样动画帧确认画面持续变化且布局尺寸稳定。

- [ ] **步骤 4：删除旧程序化模型**

确认新播放器和静态参考图降级路径通过后，删除旧 Three.js 犬模型、坐下状态机及只服务旧模型的测试，避免两个渲染系统并存。同时删除新方向不再使用的结构化毛色分析模块、重新分析 IPC 和相关测试，保留配置读取对历史字段的容错但不再产生该项 API 费用。

- [ ] **步骤 5：更新中文 README**

说明 Sora 权限、API 费用、生成耗时、本地持久化、失败恢复和 MP4/WebGL 去背景流程。

- [ ] **步骤 6：最终验证并提交**

运行：`npm test && ./node_modules/.bin/electron test/electron-visual-harness.js && git diff --check`

预期：所有测试通过；两种窗口尺寸画面非空透明；动作切换无空白；启动测试确认零 API 调用。

```bash
git add -A src/renderer test README.md
git commit -m "feat: 完成 Sora 桌面宠物动画"
```
