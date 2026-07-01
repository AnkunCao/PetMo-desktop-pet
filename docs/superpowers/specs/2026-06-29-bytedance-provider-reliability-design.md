# Bytedance 模型供应商可靠性修复设计

## 目标

让用户可以在 OpenAI 与 Bytedance 之间可靠切换，并确保图片生成、视频任务创建、轮询、下载和错误恢复都使用同一个明确的供应商配置。网络或远端任务异常必须在有限时间内失败并显示可操作的错误，不能无限停留在“生成中”。

## 范围

- 修正 Bytedance 视频任务状态与本地通用状态之间的转换。
- 为 Bytedance 图片、视频创建、轮询和下载请求增加超时。
- 生成请求显式携带当前界面选择的供应商。
- 按供应商分别加密保存 API Key，避免供应商切换后复用错误密钥。
- 在动画批次开始时固定供应商和模型，防止处理中修改设置导致同一批次混用客户端与模型。
- 为以上行为增加不调用真实付费 API 的自动化测试。

不在本次范围内：

- 更换火山引擎官方 SDK。
- 修改动画提示词、视频画质或透明化参数。
- 自动调用真实 OpenAI 或火山引擎 API。
- 清理用户现有宠物、动画候选目录或历史提交记录。

## 架构

### 供应商配置

配置文件新增按供应商分组的密钥字段：

```json
{
  "modelProvider": "bytedance",
  "encryptedApiKeys": {
    "openai": "...",
    "bytedance": "..."
  }
}
```

读取时兼容旧的 `encryptedApiKey`：旧字段只迁移为 OpenAI 密钥，不能推断它属于 Bytedance。首次保存新配置后继续保留兼容读取能力，但所有新写入使用 `encryptedApiKeys`。

设置页的 `hasApiKey` 只表示当前供应商是否已有密钥。切换下拉框后，界面立即重新读取或根据主进程返回的供应商密钥状态更新提示，不能沿用上一个供应商的“已保存”状态。

### 生成请求

设置页调用 `generatePet` 时同时提交：

```js
{
  photoDataUrls,
  apiKey,
  modelProvider
}
```

主进程验证 `modelProvider` 必须在允许列表中，并据此选择图片模型、校验密钥、创建客户端和持久化配置。主进程不依赖此前保存的供应商来解释本次请求。

### 动画批次快照

创建动画批次时记录：

```js
{
  provider: "bytedance",
  imageModel: "doubao-seedream-5-0-260128",
  videoModel: "doubao-seedance-2-0-fast-260128"
}
```

恢复、重试和后续动作生成使用批次快照，而不是每个动作重新读取当前设置。这样用户在动画处理中切换供应商不会让同一批次混用模型或 API Key。

旧批次没有快照时，按创建时可恢复的信息处理：OpenAI `video_*` 远端任务继续使用 OpenAI；没有远端任务且无法可靠判断供应商时，使用当前配置并在写回时补齐快照。

### Bytedance 客户端

客户端把火山引擎状态转换为现有通用状态：

| 火山状态 | 本地状态 |
| --- | --- |
| `queued` | `queued` |
| `running` | `in_progress` |
| `succeeded` | `completed` |
| `failed` | `failed` |
| `canceled` / `cancelled` | `failed` |

状态转换大小写不敏感。未知状态立即抛出包含原始状态的错误，不能继续无限轮询。

每个 HTTP 请求通过 `AbortController` 设置超时：

- 图片生成：30 分钟。
- 视频任务创建、状态查询：60 秒。
- 生成图片和视频文件下载：5 分钟。

超时错误包含请求阶段，不暴露 API Key、完整请求体或用户照片数据。

### 错误与恢复

- HTTP 非成功响应读取火山错误对象中的 `code`、`message` 和请求 ID，并保留 HTTP 状态供现有中文错误映射使用。
- 网络超时转换为明确的“Bytedance 请求超时”错误。
- 视频任务已经获得远端 ID 后，任何本地失败都继续保留提交记录，以便下次恢复，不重复计费创建。
- 设置页所有生成分支必须在成功或失败后解除忙碌状态。

## 测试

自动化测试使用注入的 `fetch` 和可控计时器，不访问真实 API：

1. Bytedance 状态 `queued → running → succeeded` 正确转换并完成轮询。
2. `failed` 和未知状态分别进入失败与明确错误路径。
3. 图片、任务创建、查询和下载请求超时后终止。
4. 选择 Bytedance 后生成请求显式传递 `modelProvider`。
5. OpenAI 与 Bytedance 密钥独立保存和读取；旧 `encryptedApiKey` 只兼容 OpenAI。
6. 动画批次在供应商设置变化后仍使用创建时快照。
7. 完整 `npm test` 保持通过，且 `node --check` 覆盖所有 JavaScript 文件。

## 验收标准

- 切换到 Bytedance、保存对应密钥后，图片和视频流程使用字节模型。
- 火山任务返回 `running` 或 `succeeded` 时不会报未知状态或永久等待。
- 任一 Bytedance HTTP 请求超过规定时间后可见错误并恢复按钮状态。
- 切回 OpenAI 后仍使用原 OpenAI 密钥，不会覆盖或发送 Bytedance 密钥。
- 动画生成过程中切换设置不会改变正在运行批次的供应商。
- 不进行真实付费 API 调用也能通过新增回归测试证明上述行为。
