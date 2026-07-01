# Remember API Key Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual configuration saving with an opt-in “remember API” checkbox and reject invalid header characters before network requests.

**Architecture:** Keep provider selection authoritative in each generation payload. Centralize API key character validation and provider-key deletion in pure helpers, then make the main process apply remember/delete behavior atomically with successful generation setup.

**Tech Stack:** Electron 31, Node.js CommonJS, Node test runner, safeStorage.

## Global Constraints

- “记住 API” defaults to unchecked.
- A non-remembered key must not be written to configuration.
- No test may call a real paid API.
- Existing user pet and animation files must remain untouched.

---

### Task 1: API Key Validation and Deletion Helpers

**Files:**
- Modify: `src/model-providers.js`
- Modify: `test/model-providers.test.js`
- Modify: `src/main.js`

**Interfaces:**
- Produce `deleteEncryptedApiKey(config, provider)`.
- `validateApiKeyFormat` rejects every character outside visible ASCII `0x21..0x7E`.

- [ ] Write failing tests for deleting one provider key without changing the other.
- [ ] Run `node --test test/model-providers.test.js` and confirm RED.
- [ ] Implement immutable provider-key deletion.
- [ ] Add a failing main-process validation test or focused exported helper test for Chinese `自`, spaces, and newlines.
- [ ] Implement visible-ASCII validation before provider-specific validation.
- [ ] Run focused tests and confirm PASS.

### Task 2: Main-Process Remember Policy

**Files:**
- Modify: `src/main.js`
- Modify: `test/sora-animation-integration.test.js`

**Interfaces:**
- `generate-pet` consumes `rememberApiKey: boolean`.
- Remembered keys are saved only when true.
- False deletes the selected provider’s saved key while still allowing the supplied key for the current request.

- [ ] Write failing tests for remember true, remember false, and deletion of an existing selected-provider key.
- [ ] Run focused tests and confirm RED.
- [ ] Apply remember/delete behavior to the generation transaction.
- [ ] Remove the obsolete `save-api-settings` key-saving path while retaining automatic non-secret settings persistence.
- [ ] Run focused tests and confirm PASS.

### Task 3: Settings Page Interaction

**Files:**
- Modify: `src/settings/index.html`
- Modify: `src/settings/settings.js`
- Modify: `src/settings/styles.css`
- Modify: `test/settings-generation-state.test.js`
- Modify: `test/sora-settings.test.js`

**Interfaces:**
- Add `#remember-api-key`.
- Remove `#save-button`.
- Generation payload includes `rememberApiKey`.

- [ ] Write failing DOM and generation-payload tests.
- [ ] Run settings tests and confirm RED.
- [ ] Replace the save button with a default-unchecked checkbox.
- [ ] Remove save-state code and submit the checkbox value during generation.
- [ ] Clear the key field on provider changes and after every generation result.
- [ ] Refresh provider-specific remembered-key status on selection changes.
- [ ] Run settings tests and confirm PASS.

### Task 4: Verification

**Files:**
- Modify only files required to resolve verification failures.

- [ ] Run `git diff --check`.
- [ ] Run `node --check` for all source and test JavaScript.
- [ ] Run `npm test`.
- [ ] Confirm the diff contains no real API keys or user-generated resources.
