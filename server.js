/**
 * Anthropic-to-OpenAI Proxy Server
 *
 * Accepts Anthropic Messages API requests, converts to OpenAI Chat Completions,
 * forwards to OmniRoute (OpenAI-compatible endpoint), and converts responses back.
 *
 * This bypasses the OmniRoute bug where the Claude→Gemini path
 * (wrapInCloudCodeEnvelopeForClaude) skips thoughtSignature injection.
 */

require("dotenv").config();
const { createApp } = require("./src/app");
const { readConfig } = require("./src/config");

const config = readConfig();
const app = createApp(config);
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

app.listen(config.port, () => {
  log("Listening on http://localhost:" + config.port);
  log("Forwarding to", config.omnirouteUrl + config.targetPath);
  log("Endpoint: POST /v1/messages");
});
