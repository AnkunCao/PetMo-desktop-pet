const DEFAULT_MODEL_PROVIDER = "openai";

const AVAILABLE_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "openai",
    label: "OpenAI (ChatGPT)",
    imageModel: "gpt-image-1.5",
    videoModel: "sora-2"
  }),
  Object.freeze({
    id: "bytedance",
    label: "Bytedance",
    imageModel: "doubao-seedream-5-0-260128",
    videoModel: "doubao-seedance-2-0-fast-260128"
  })
]);

function normalizeProviderId(value) {
  return AVAILABLE_PROVIDERS.some((provider) => provider.id === value)
    ? value
    : DEFAULT_MODEL_PROVIDER;
}

function getProviderDefinition(value) {
  const providerId = normalizeProviderId(value);
  return AVAILABLE_PROVIDERS.find((provider) => provider.id === providerId);
}

function getEncryptedApiKey(config, providerId) {
  const provider = normalizeProviderId(providerId);
  const providerKey = config?.encryptedApiKeys?.[provider];
  if (typeof providerKey === "string" && providerKey) {
    return providerKey;
  }
  if (provider === "openai" && typeof config?.encryptedApiKey === "string") {
    return config.encryptedApiKey;
  }
  return "";
}

function setEncryptedApiKey(config, providerId, encryptedKey) {
  const provider = normalizeProviderId(providerId);
  return {
    ...config,
    encryptedApiKeys: {
      ...(config?.encryptedApiKeys || {}),
      [provider]: encryptedKey
    }
  };
}

function deleteEncryptedApiKey(config, providerId) {
  const provider = normalizeProviderId(providerId);
  const encryptedApiKeys = { ...(config?.encryptedApiKeys || {}) };
  delete encryptedApiKeys[provider];
  const next = { ...config, encryptedApiKeys };
  if (provider === "openai") {
    delete next.encryptedApiKey;
  }
  return next;
}

function hasEncryptedApiKey(config, providerId) {
  return Boolean(getEncryptedApiKey(config, providerId));
}

function validateApiKeyFormat(apiKey, providerId) {
  const provider = normalizeProviderId(providerId);
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed || !/^[\x21-\x7e]+$/.test(trimmed)) {
    throw new Error("API Key 包含中文、空格或换行，请只粘贴密钥本身。");
  }
  if (provider === "openai" && (!trimmed.startsWith("sk-") || trimmed.length < 30)) {
    throw new Error("OpenAI API Key 格式不正确，应以 sk- 开头。");
  }
  if (provider === "bytedance" && trimmed.length < 16) {
    throw new Error("Bytedance API Key 格式不正确，请填写有效的 API Key。");
  }
  return trimmed;
}

module.exports = {
  AVAILABLE_PROVIDERS,
  DEFAULT_MODEL_PROVIDER,
  normalizeProviderId,
  getProviderDefinition,
  getEncryptedApiKey,
  setEncryptedApiKey,
  deleteEncryptedApiKey,
  hasEncryptedApiKey,
  validateApiKeyFormat
};
