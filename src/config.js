function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readConfig(env = process.env) {
  return {
    port: parseInt(env.PORT || "8082", 10),
    omnirouteUrl: (env.OMNIROUTE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    targetPath: env.TARGET_PATH || "/v1/chat/completions",
    targetApi: env.TARGET_API || "chat",
    directAnthropic: env.DIRECT_ANTHROPIC === "true",
    anthropicUrl: (env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages").replace(/\/+$/, ""),
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    upstreamTimeoutMs: parseInt(env.UPSTREAM_TIMEOUT_MS || "300000", 10),
    modelMap: parseJsonObject(env.MODEL_MAP, {}),
  };
}

module.exports = { readConfig, parseJsonObject };
