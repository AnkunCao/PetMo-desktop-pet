const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeProviderId,
  getProviderDefinition,
  getEncryptedApiKey,
  setEncryptedApiKey,
  deleteEncryptedApiKey,
  hasEncryptedApiKey,
  validateApiKeyFormat
} = require("../src/model-providers");

test("normalizes supported providers and falls back to OpenAI", () => {
  assert.equal(normalizeProviderId("bytedance"), "bytedance");
  assert.equal(normalizeProviderId("openai"), "openai");
  assert.equal(normalizeProviderId("unknown"), "openai");
  assert.equal(getProviderDefinition("bytedance").videoModel, "doubao-seedance-2-0-fast-260128");
});

test("rejects API keys containing Chinese, spaces, or newlines", () => {
  for (const apiKey of [
    "ark-fake自",
    "ark-fake key",
    "ark-fake\nkey"
  ]) {
    assert.throws(
      () => validateApiKeyFormat(apiKey, "bytedance"),
      /包含中文、空格或换行/
    );
  }
});

test("deleting one provider key preserves the other provider", () => {
  const config = {
    encryptedApiKeys: { openai: "openai-key", bytedance: "byte-key" }
  };
  const next = deleteEncryptedApiKey(config, "bytedance");

  assert.deepEqual(next.encryptedApiKeys, { openai: "openai-key" });
  assert.equal(getEncryptedApiKey(next, "bytedance"), "");
});

test("legacy encryptedApiKey is only used for OpenAI", () => {
  const config = { encryptedApiKey: "legacy" };
  assert.equal(getEncryptedApiKey(config, "openai"), "legacy");
  assert.equal(getEncryptedApiKey(config, "bytedance"), "");
  assert.equal(hasEncryptedApiKey(config, "openai"), true);
  assert.equal(hasEncryptedApiKey(config, "bytedance"), false);
});

test("provider keys remain independent", () => {
  let config = setEncryptedApiKey({}, "openai", "openai-key");
  config = setEncryptedApiKey(config, "bytedance", "byte-key");

  assert.equal(getEncryptedApiKey(config, "openai"), "openai-key");
  assert.equal(getEncryptedApiKey(config, "bytedance"), "byte-key");
  assert.deepEqual(config.encryptedApiKeys, {
    openai: "openai-key",
    bytedance: "byte-key"
  });
});
