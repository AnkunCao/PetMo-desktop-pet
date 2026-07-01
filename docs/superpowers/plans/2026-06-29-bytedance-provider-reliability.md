# Bytedance Model Provider Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenAI/Bytedance switching deterministic, prevent cross-provider API key reuse, and make Bytedance image/video requests terminate correctly on success, failure, or timeout.

**Architecture:** Extract provider-specific configuration and Bytedance HTTP adaptation into testable pure modules while preserving the existing animation service contract. Snapshot provider/model data into persisted animation batches so later settings changes cannot alter an active or resumed run.

**Tech Stack:** Electron 31, Node.js CommonJS, Node test runner, OpenAI SDK, Electron `net.fetch`, ffmpeg.

## Global Constraints

- Do not call real OpenAI or Volcengine APIs in automated tests.
- Do not delete or rewrite existing user pet resources or animation candidate directories.
- Preserve backward compatibility for existing OpenAI `encryptedApiKey` configuration and persisted animation batches.
- Use test-first red-green-refactor cycles for every behavior change.
- Keep current OpenAI generation and animation behavior passing.

---

### Task 1: Provider Configuration and Per-Provider API Keys

**Files:**
- Create: `src/model-providers.js`
- Test: `test/model-providers.test.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces: `normalizeProviderId(value)`, `getProviderDefinition(value)`, `getEncryptedApiKey(config, provider)`, `setEncryptedApiKey(config, provider, encryptedKey)`, and `hasEncryptedApiKey(config, provider)`.
- Legacy rule: `config.encryptedApiKey` is readable only for provider `openai`.

- [ ] **Step 1: Write failing provider configuration tests**

Cover valid/invalid provider normalization, distinct OpenAI and Bytedance keys, and legacy OpenAI-only fallback:

```js
test("legacy encryptedApiKey is only used for OpenAI", () => {
  const config = { encryptedApiKey: "legacy" };
  assert.equal(getEncryptedApiKey(config, "openai"), "legacy");
  assert.equal(getEncryptedApiKey(config, "bytedance"), "");
});

test("provider keys remain independent", () => {
  let config = setEncryptedApiKey({}, "openai", "openai-key");
  config = setEncryptedApiKey(config, "bytedance", "byte-key");
  assert.equal(getEncryptedApiKey(config, "openai"), "openai-key");
  assert.equal(getEncryptedApiKey(config, "bytedance"), "byte-key");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/model-providers.test.js`

Expected: FAIL because `src/model-providers.js` does not exist.

- [ ] **Step 3: Implement the pure provider module**

Move the provider definitions and normalization rules from `animation-config.js`/`main.js` into `src/model-providers.js`. Implement immutable updates for `encryptedApiKeys`, retaining legacy read compatibility without copying a legacy OpenAI key into Bytedance.

- [ ] **Step 4: Integrate per-provider keys in main-process settings handlers**

Update `get-api-settings`, `save-api-settings`, `generate-pet`, and animation client construction to read or write the selected provider’s key. Return `hasApiKey` for only the selected provider.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/model-providers.test.js test/sora-settings.test.js
npm test
```

Expected: all tests PASS.

### Task 2: Testable Bytedance Client with Correct Status Mapping

**Files:**
- Create: `src/bytedance-client.js`
- Test: `test/bytedance-client.test.js`
- Modify: `src/main.js`

**Interfaces:**
- Produces: `createBytedanceClient({ apiKey, fetch, timeoutMs })`.
- Implements the existing `models.retrieve`, `images.edit`, `videos.create`, `videos.retrieve`, and `videos.downloadContent` contract.
- Exports `normalizeBytedanceVideoStatus(status)` for focused tests.

- [ ] **Step 1: Write failing status mapping tests**

```js
test("maps Volcengine task statuses to the animation service contract", () => {
  assert.equal(normalizeBytedanceVideoStatus("queued"), "queued");
  assert.equal(normalizeBytedanceVideoStatus("running"), "in_progress");
  assert.equal(normalizeBytedanceVideoStatus("succeeded"), "completed");
  assert.equal(normalizeBytedanceVideoStatus("failed"), "failed");
});

test("rejects unknown Volcengine task status", () => {
  assert.throws(
    () => normalizeBytedanceVideoStatus("mystery"),
    /未知的 Bytedance 视频状态：mystery/
  );
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test test/bytedance-client.test.js`

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement status normalization and client extraction**

Move `createBytedanceClient` out of `main.js`. Normalize status case, map `queued/running/succeeded/failed/canceled/cancelled`, preserve `content.video_url`, and retain HTTP status/error metadata.

- [ ] **Step 4: Add request-shape tests**

Use an injected fake `fetch` to assert:

- image requests use `/images/generations` and include multiple data-URL references;
- video creation uses `/contents/generations/tasks`;
- task retrieval reads top-level `id`, `status`, `content.video_url`;
- no Authorization value is included in thrown errors.

- [ ] **Step 5: Replace the inline main-process client**

Import `createBytedanceClient` in `main.js` and remove the inline implementation. Keep Electron `net.fetch` injected at the call site.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/bytedance-client.test.js test/sora-animation-service.test.js
npm test
```

Expected: all tests PASS.

### Task 3: Abortable Bytedance HTTP Requests

**Files:**
- Modify: `src/bytedance-client.js`
- Modify: `test/bytedance-client.test.js`
- Modify: `src/main.js`

**Interfaces:**
- `createBytedanceClient` accepts timeout values:

```js
{
  requestTimeoutMs: 60_000,
  imageTimeoutMs: 1_800_000,
  downloadTimeoutMs: 300_000
}
```

- [ ] **Step 1: Write a failing timeout test**

Inject a fetch implementation that waits for `options.signal` to abort:

```js
test("aborts a hanging task request with a phase-specific timeout", async () => {
  const client = createBytedanceClient({
    apiKey: "test-key",
    fetch: abortOnlyFetch,
    requestTimeoutMs: 5
  });
  await assert.rejects(
    client.videos.retrieve("task-1"),
    /Bytedance 视频任务查询超时/
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/bytedance-client.test.js --test-name-pattern timeout`

Expected: FAIL because requests are not aborted.

- [ ] **Step 3: Implement an abortable request helper**

Use `AbortController`, clear timers in `finally`, attach the request phase to timeout errors, and use separate image/create-query/download limits. Never include API keys or request bodies in error messages.

- [ ] **Step 4: Add image and download timeout coverage**

Verify both the initial image generation request and the subsequent generated-file download terminate with phase-specific errors.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/bytedance-client.test.js
npm test
```

Expected: all tests PASS with no lingering timers.

### Task 4: Explicit Provider Selection from Renderer to Main Process

**Files:**
- Modify: `src/settings/settings.js`
- Modify: `src/main.js`
- Modify: `test/settings-generation-state.test.js`
- Modify: `test/sora-settings.test.js`

**Interfaces:**
- `desktopPet.generatePet(payload)` receives `payload.modelProvider`.
- Main process validates the provider and derives the image model from that provider.

- [ ] **Step 1: Write failing renderer contract test**

Assert the settings page calls:

```js
generatePet({
  photoDataUrls,
  apiKey: "...",
  modelProvider: "bytedance"
});
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `node --test test/settings-generation-state.test.js`

Expected: FAIL because `modelProvider` is absent.

- [ ] **Step 3: Pass provider from the renderer**

Include `modelProviderSelect.value` in both generation and settings-save payloads. On selection change, refresh the key status for that provider instead of retaining the previous provider’s saved state.

- [ ] **Step 4: Write and run a failing main-process provider test**

Verify a Bytedance payload derives `doubao-seedream-5-0-260128` even when persisted config previously selected OpenAI.

- [ ] **Step 5: Implement authoritative payload validation**

Validate `payload.modelProvider`, choose its model and API key, and persist the provider only as part of the successful generation/config transaction.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/settings-generation-state.test.js test/sora-settings.test.js
npm test
```

Expected: all tests PASS.

### Task 5: Persisted Animation Provider Snapshot

**Files:**
- Modify: `src/animation-config.js`
- Modify: `src/main.js`
- Modify: `test/animation-config.test.js`
- Modify: `test/sora-animation-integration.test.js`

**Interfaces:**
- New batches persist `provider`, `imageModel`, and `videoModel`.
- `runAnimationBatch` and `startAnimationRun` use the snapshot for client creation and action definitions.

- [ ] **Step 1: Write failing batch snapshot tests**

Verify `createAnimationBatch` preserves supplied provider/model metadata and that subsequent config changes do not change definitions used by the batch.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/animation-config.test.js test/sora-animation-integration.test.js
```

Expected: FAIL because batches do not contain provider metadata.

- [ ] **Step 3: Extend batch creation and rebuild**

Add immutable provider/model fields to new batches and preserve them in `rebuildAnimationBatch`, retry batches, persistence writes, and progress events.

- [ ] **Step 4: Use the snapshot throughout animation execution**

Create the API client from `batch.provider`, select definitions using `batch.videoModel`, and retrieve the matching provider key. Do not reread `modelProvider` between actions.

- [ ] **Step 5: Add legacy recovery rules**

For old batches, infer OpenAI when an existing remote task ID begins with `video_`; otherwise snapshot the currently selected provider before creating the first remote task.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/animation-config.test.js test/sora-animation-integration.test.js
npm test
```

Expected: all tests PASS.

### Task 6: Final Verification and Runtime Diagnostics

**Files:**
- Modify: `README.md`
- Modify only if required by verification: affected source/test files from Tasks 1–5.

**Interfaces:**
- Document provider-specific key behavior and non-secret diagnostics.

- [ ] **Step 1: Add safe phase diagnostics**

Log provider, operation phase, task status, and task ID prefix where useful. Never log API keys, Authorization headers, prompts, image data URLs, or complete user file paths.

- [ ] **Step 2: Update README**

Document how to select a provider, that each provider needs its own API key, expected generation duration, timeout behavior, and how interrupted animation jobs resume.

- [ ] **Step 3: Run complete static and automated verification**

Run:

```bash
git diff --check
for f in src/*.js src/renderer/*.js src/settings/*.js test/*.js; do node --check "$f" || exit 1; done
npm test
```

Expected: zero syntax/diff errors and all tests PASS.

- [ ] **Step 4: Inspect the final diff**

Confirm no secrets, user-generated resources, config files, cache files, or unrelated existing changes were staged or modified.

