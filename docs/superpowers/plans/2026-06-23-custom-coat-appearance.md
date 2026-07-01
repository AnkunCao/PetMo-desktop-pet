# 定制毛色与模型外观打磨实现计划

> **执行要求：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项执行。所有步骤使用复选框跟踪，并严格遵循测试先行。

**目标：** 从用户的四张宠物照片提取结构化毛色配置，将其持久化并应用到更细腻的关节边境牧羊犬模型。

**架构：** 主进程通过 Responses API 视觉请求生成经过 JSON Schema 约束的外观配置，并在本地标准化后保存。渲染进程根据配置生成确定性的 Canvas 毛色纹理，应用到细化后的 Three.js 模型；骨架和坐下状态机保持不变。

**技术栈：** Electron 31、OpenAI Node SDK 6.44、Responses API、Three.js 0.184、CanvasTexture、Node.js 内置测试框架。

## 全局约束

- 文档、界面文字和新增注释统一使用中文。
- 保留现有边境牧羊犬体型、骨架和自动坐下动作。
- 仅定制毛色、花纹分布和毛发表面效果。
- 启动应用时不得调用 OpenAI API。
- 外观分析失败时保留最后一次有效的 2D 图片和 3D 外观配置。
- 不增加 Blender、GLB 文件或第三方 3D 生成服务。
- `260x250` 和 `180x180` 窗口都必须完整显示模型。

---

### Task 1：外观配置标准化与校验

**文件：**
- 新建：`src/appearance-profile.js`
- 新建：`test/appearance-profile.test.js`

**接口：**
- 输出：`DEFAULT_APPEARANCE_PROFILE`
- 输出：`normalizeAppearanceProfile(input)`，返回完整且安全的 `PetAppearanceProfile`
- 输出：`isHexColor(value)`

- [ ] **步骤 1：编写失败测试**

```js
test("外观配置会限制范围并修复无效颜色", () => {
  const { normalizeAppearanceProfile } = require("../src/appearance-profile");
  const profile = normalizeAppearanceProfile({
    primaryColor: "black",
    secondaryColor: "#FAFAFA",
    confidence: 2,
    blaze: { width: -1, length: 4 },
    socks: { frontLeft: 0.3 }
  });
  assert.equal(profile.primaryColor, "#17191b");
  assert.equal(profile.secondaryColor, "#fafafa");
  assert.equal(profile.confidence, 1);
  assert.equal(profile.blaze.width, 0);
  assert.equal(profile.blaze.length, 1);
  assert.equal(profile.socks.frontRight, 0.72);
});

test("低置信度配置回退到默认花纹", () => {
  const { DEFAULT_APPEARANCE_PROFILE, normalizeAppearanceProfile } = require("../src/appearance-profile");
  const profile = normalizeAppearanceProfile({ confidence: 0.2, primaryColor: "#ff0000" });
  assert.deepEqual(profile, DEFAULT_APPEARANCE_PROFILE);
});
```

- [ ] **步骤 2：运行测试并确认缺少模块**

运行：`node --test test/appearance-profile.test.js`

预期：因 `src/appearance-profile.js` 不存在而失败。

- [ ] **步骤 3：实现默认配置和标准化函数**

```js
function clamp(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

function normalizeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value.toLowerCase() : fallback;
}

function normalizeAppearanceProfile(input = {}) {
  if (clamp(input.confidence, 0) < 0.45) return structuredClone(DEFAULT_APPEARANCE_PROFILE);
  // 对所有命名区域、四条腿和最多四个 bodyPatches 执行相同的范围限制。
}
```

默认配置必须与当前黑白边境牧羊犬相符，并冻结顶层对象，防止运行时意外修改。

- [ ] **步骤 4：验证测试**

运行：`node --test test/appearance-profile.test.js && npm test`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add src/appearance-profile.js test/appearance-profile.test.js
git commit -m "feat: 校验宠物外观配置"
```

### Task 2：OpenAI 视觉分析、持久化与 IPC

**文件：**
- 新建：`src/appearance-analysis.js`
- 修改：`src/main.js`
- 修改：`src/preload.js`
- 新建：`test/appearance-analysis.test.js`
- 新建：`test/appearance-persistence.test.js`

**接口：**
- 输入：四张 Base64 Data URL、API Key、可注入的 OpenAI 客户端。
- 输出：`analyzePetAppearance({ client, photoDataUrls, model })`
- IPC：`reanalyze-pet-appearance`
- 事件：`pet-appearance-updated`
- 事件：`pet-generation-progress`，值为 `image` 或 `appearance`

- [ ] **步骤 1：编写失败测试，锁定 Schema 和四图输入**

```js
test("外观分析把四张照片和严格 Schema 发送给 Responses API", async () => {
  let request;
  const client = { responses: { create: async (value) => {
    request = value;
    return { output_text: JSON.stringify(validProfile) };
  } } };
  const profile = await analyzePetAppearance({
    client,
    photoDataUrls: [front, left, right, fullBody],
    model: "gpt-5.4-mini"
  });
  assert.equal(request.input[0].content.filter((part) => part.type === "input_image").length, 4);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  assert.equal(profile.version, 1);
});
```

- [ ] **步骤 2：运行测试并确认缺少模块**

运行：`node --test test/appearance-analysis.test.js`

预期：因分析模块不存在而失败。

- [ ] **步骤 3：实现严格 JSON Schema 和分析请求**

```js
const response = await client.responses.create({
  model: model || "gpt-5.4-mini",
  input: [{
    role: "user",
    content: [
      { type: "input_text", text: APPEARANCE_PROMPT },
      ...photoDataUrls.map((imageUrl) => ({ type: "input_image", image_url: imageUrl, detail: "high" }))
    ]
  }],
  text: {
    format: {
      type: "json_schema",
      name: "pet_appearance_profile",
      strict: true,
      schema: PET_APPEARANCE_SCHEMA
    }
  }
});
return normalizeAppearanceProfile(JSON.parse(response.output_text));
```

Schema 中所有对象都设置 `additionalProperties: false`，并完整列出 `required` 字段。

- [ ] **步骤 4：编写失败的持久化和失败回退测试**

测试提取纯函数 `mergeAppearanceResult(config, result)`：成功时替换 `appearanceProfile`，失败时保留旧配置。测试 `getPetAppearance` 返回已保存配置，并验证启动路径没有 `responses.create` 调用。

- [ ] **步骤 5：接入主进程**

生成开始时发送 `pet-generation-progress: image`；2D 图片保存成功后发送 `pet-generation-progress: appearance` 并调用外观分析。仅当分析成功时写入 `config.appearanceProfile`；发送：

```js
mainWindow?.webContents.send("pet-appearance-updated", profile);
```

新增 `reanalyze-pet-appearance` IPC，读取已保存的四张原图、解密 API Key，只执行视觉分析。网络超时沿用现有系统代理和 30 分钟超时策略。

- [ ] **步骤 6：扩展 preload API**

```js
reanalyzePetAppearance: () => ipcRenderer.invoke("reanalyze-pet-appearance"),
onPetAppearanceUpdated: (callback) => {
  ipcRenderer.on("pet-appearance-updated", (_event, profile) => callback(profile));
},
onPetGenerationProgress: (callback) => {
  ipcRenderer.on("pet-generation-progress", (_event, stage) => callback(stage));
}
```

- [ ] **步骤 7：运行测试并提交**

运行：`node --test test/appearance-analysis.test.js test/appearance-persistence.test.js && npm test`

预期：全部通过。

```bash
git add src/appearance-analysis.js src/main.js src/preload.js test/appearance-analysis.test.js test/appearance-persistence.test.js
git commit -m "feat: 从照片分析并保存毛色配置"
```

### Task 3：确定性程序化毛色纹理

**文件：**
- 新建：`src/renderer/coat-pattern.mjs`
- 修改：`src/renderer/border-collie-model.mjs`
- 新建：`test/coat-pattern.test.js`

**接口：**
- 输出：`createCoatDescriptor(profile, region)`
- 输出：`createCoatTexture(THREE, profile, region, size = 512)`
- 模型新增：`applyAppearance(profile)` 和 `disposeAppearance()`

- [ ] **步骤 1：编写失败测试**

```js
test("相同配置生成相同纹理描述", async () => {
  const { createCoatDescriptor } = await import("../src/renderer/coat-pattern.mjs");
  assert.deepEqual(
    createCoatDescriptor(profile, "torso"),
    createCoatDescriptor(structuredClone(profile), "torso")
  );
});

test("不同袜高会改变对应腿部描述", async () => {
  const left = createCoatDescriptor(profile, "frontLeftLeg");
  const changed = createCoatDescriptor({ ...profile, socks: { ...profile.socks, frontLeft: 0.2 } }, "frontLeftLeg");
  assert.notDeepEqual(left.layers, changed.layers);
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`node --test test/coat-pattern.test.js`

预期：缺少 `coat-pattern.mjs`。

- [ ] **步骤 3：实现描述器和固定种子噪声**

每个描述器包含 `baseColor`、`layers`、`grainSeed`、`grainStrength`。种子由规范化配置和区域名的稳定字符串哈希产生，禁止使用 `Math.random()`。

- [ ] **步骤 4：实现 CanvasTexture**

创建离屏 Canvas，依次绘制底色、柔边椭圆花纹和方向性毛发噪声。设置：

```js
texture.colorSpace = THREE.SRGBColorSpace;
texture.wrapS = THREE.RepeatWrapping;
texture.wrapT = THREE.RepeatWrapping;
texture.needsUpdate = true;
```

- [ ] **步骤 5：把纹理应用到命名模型区域**

`border-collie-model.mjs` 保存头部、躯干、四肢和尾巴主网格引用。`applyAppearance` 释放旧纹理后生成并应用新纹理，同时根据 `fur` 调整粗糙度和法线强度。删除与纹理冲突的 `belly-marking`、`rump-white-accent`、`neck-white`、独立脸颊和白袜硬边网格。

- [ ] **步骤 6：验证并提交**

运行：`node --test test/coat-pattern.test.js test/border-collie-model.test.js && npm test`

预期：全部通过且 `dispose()` 不泄漏纹理。

```bash
git add src/renderer/coat-pattern.mjs src/renderer/border-collie-model.mjs test/coat-pattern.test.js test/border-collie-model.test.js
git commit -m "feat: 生成定制宠物毛色纹理"
```

### Task 4：模型网格和毛发材质细化

**文件：**
- 修改：`src/renderer/border-collie-model.mjs`
- 修改：`src/renderer/three-pet.js`
- 修改：`test/border-collie-model.test.js`
- 新建：`test/model-refinement.test.js`

**接口：**
- 保持：`createBorderCollieModel(THREE)` 返回现有 `root`、`joints`、`dispose`
- 新增：模型返回值包含 `appearance.apply(profile)`

- [ ] **步骤 1：编写失败测试**

验证主要球体横向分段不少于 `32`，胶囊径向分段不少于 `16`；验证存在 `left-shoulder-transition`、`right-shoulder-transition`、`left-hip-transition`、`right-hip-transition`、`left-eyelid` 和 `right-eyelid`。

- [ ] **步骤 2：运行测试确认当前低面数模型失败**

运行：`node --test test/model-refinement.test.js`

预期：网格分段和过渡体断言失败。

- [ ] **步骤 3：提高网格精度并改善解剖过渡**

球体使用 `32x24` 或更高分段；胶囊使用不少于 `8` 个帽分段和 `16` 个径向分段。肩、髋、肘、腕和踝增加平滑过渡网格，保持各关节枢轴不变。

- [ ] **步骤 4：细化头部和脚掌**

缩小当前过大的口鼻体积；增加眼睑、鼻梁和鼻翼轮廓；耳朵改为带轻微厚度的自定义 `BufferGeometry`；脚掌增加趾部起伏。所有网格使用平滑法线。

- [ ] **步骤 5：升级材质**

把毛发区域改为 `MeshPhysicalMaterial`，使用高粗糙度、低 sheen 和本地生成的法线纹理。只在躯干、颈部、脸颊和尾巴使用一层透明壳层，壳层缩放不超过 `1.015`，防止出现发光边缘。

- [ ] **步骤 6：确认坐下动作未回归并提交**

运行：`node --test test/model-refinement.test.js test/dog-motion.test.js && npm test`

预期：模型测试和原坐下动作测试全部通过。

```bash
git add src/renderer/border-collie-model.mjs src/renderer/three-pet.js test/border-collie-model.test.js test/model-refinement.test.js
git commit -m "feat: 细化宠物模型和毛发材质"
```

### Task 5：设置流程与 Electron 视觉验证

**文件：**
- 修改：`src/settings/index.html`
- 修改：`src/settings/settings.js`
- 修改：`src/settings/styles.css`
- 修改：`src/renderer/renderer.js`
- 修改：`test/electron-visual-harness.js`
- 新建：`test/custom-appearance-visual.test.js`
- 修改：`README.md`

**接口：**
- 消费：`appearance` 中的 `appearanceProfile`
- 消费：`onPetAppearanceUpdated(callback)`
- 设置命令：`重新分析 3D 外观`

- [ ] **步骤 1：编写失败的界面与渲染集成测试**

验证设置页存在 `reanalyze-appearance-button`，生成状态包含两个阶段；验证渲染器在初始化和更新事件中调用 `threePet.applyAppearance(profile)`。

- [ ] **步骤 2：接入渲染器即时更新**

`createThreePet` 暴露：

```js
applyAppearance(profile) {
  dog.appearance.apply(profile);
}
```

渲染器缓存当前配置，在 Three.js 初始化后立即应用，并监听 `pet-appearance-updated`。

- [ ] **步骤 3：实现重新分析按钮和分阶段状态**

监听 `onPetGenerationProgress`：`image` 显示“正在生成 2D 图片”，`appearance` 显示“正在分析 3D 毛色”。重新分析按钮只调用 `window.desktopPet.reanalyzePetAppearance()`，没有四张本地原图时禁用并显示原因。

- [ ] **步骤 4：扩展 Electron 视觉 harness**

使用两套固定配置：黑白高额纹与棕白窄额纹。分别捕获站立和坐下截图，输出像素哈希、可见像素和关节坐标。断言：

```js
assert.notEqual(results.blackWhite.standing.hash, results.brownWhite.standing.hash);
assert.ok(results.blackWhite.seated.pelvisY < results.blackWhite.standing.pelvisY - 0.35);
assert.ok(results.compact.visiblePixels > 3000);
```

- [ ] **步骤 5：运行完整验证并人工检查截图**

运行：`npm test && ./node_modules/.bin/electron test/electron-visual-harness.js && git diff --check`

预期：全部测试通过；两套毛色清晰不同；花纹边缘柔和；站立、坐下和紧凑窗口不裁切；动画持续流畅。

- [ ] **步骤 6：更新中文 README 并提交**

记录视觉分析模型、额外 API 费用、外观本地持久化和重新分析流程。

```bash
git add src/settings src/renderer/renderer.js test/electron-visual-harness.js test/custom-appearance-visual.test.js README.md
git commit -m "feat: 完成个性化三维宠物外观流程"
```
