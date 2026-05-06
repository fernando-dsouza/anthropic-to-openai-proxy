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
const express = require("express");
const { claudeToOpenAIRequest } = require("./claude-to-openai");
const {
  convertNonStreamingResponse,
  createStreamState,
  convertStreamChunk,
} = require("./openai-to-claude");

const app = express();

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const err = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);

// ── Config ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8082", 10);
const OMNIROUTE_URL = (process.env.OMNIROUTE_URL || "http://localhost:3000").replace(/\/+$/, "");
const TARGET_PATH = process.env.TARGET_PATH || "/v1/chat/completions";
const DIRECT_ANTHROPIC = process.env.DIRECT_ANTHROPIC === "true";
const ANTHROPIC_URL = (process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages").replace(/\/+$/, "");

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.text({ type: "text/plain" }));

// ── Health check ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    mode: DIRECT_ANTHROPIC ? "direct_anthropic" : "omniroute_translate",
    target: DIRECT_ANTHROPIC ? ANTHROPIC_URL : `${OMNIROUTE_URL}${TARGET_PATH}`,
  });
});

// ── Anthropic Messages API endpoint ───────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const claudeBody = req.body;
  const requestId = req.headers["x-request-id"] || `-`;

  if (!claudeBody || !claudeBody.model) {
    err("Missing model in request", { requestId });
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "Missing required field: model" },
    });
  }

  const { model, stream } = claudeBody;
  log("Incoming request", { requestId, model, stream, directAnthropic: DIRECT_ANTHROPIC });

  const isStreaming = stream === true;

  const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "") || "";

  // Direct Anthropic mode: forward Claude request as-is.
  if (DIRECT_ANTHROPIC) {
    const anthropicKey =
      apiKey ||
      req.headers["x-anthropic-api-key"] ||
      process.env.ANTHROPIC_API_KEY ||
      "";

    if (!anthropicKey) {
      return res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "Missing Anthropic API key" },
      });
    }

    const fetch = require("node-fetch");
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
    };
    if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = req.headers["anthropic-beta"];
    if (req.headers["x-request-id"]) headers["x-request-id"] = req.headers["x-request-id"];

    try {
      const upstreamResp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(claudeBody),
      });

      res.status(upstreamResp.status);
      const ct = upstreamResp.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);

      if (isStreaming) {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        upstreamResp.body.pipe(res);
        req.on("close", () => upstreamResp.body?.destroy());
        return;
      }

      const text = await upstreamResp.text();
      try {
        return res.send(JSON.parse(text));
      } catch {
        return res.send(text);
      }
    } catch (e) {
      err("Direct Anthropic proxy error:", e.message);
      return res.status(502).json({
        type: "error",
        error: { type: "api_error", message: `Proxy error: ${e.message}` },
      });
    }
  }

  // OmniRoute mode: translate Claude → OpenAI, forward, translate back.
  const openaiBody = claudeToOpenAIRequest(model, claudeBody, isStreaming);

  // Debug: log tool_calls with thought_signature for Gemini verification
  if (openaiBody.messages) {
    for (const msg of openaiBody.messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const hasSig = !!(tc.extra_content?.google?.thought_signature || tc.thought_signature);
          log("tool_call signature check", { id: tc.id, name: tc.function?.name, hasSignature: hasSig });
        }
      }
    }
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  for (const h of ["x-request-id", "anthropic-version", "anthropic-beta", "x-client-type", "x-client-version"]) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  const targetUrl = `${OMNIROUTE_URL}${TARGET_PATH}`;
  log("Forwarding to upstream", { requestId, targetUrl });

  try {
    const fetch = require("node-fetch");
    const upstreamResp = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(openaiBody),
    });

    log("Upstream response", { requestId, status: upstreamResp.status });

    if (!upstreamResp.ok && !isStreaming) {
      const errBody = await upstreamResp.text();
      const errJson = (() => {
        try { return JSON.parse(errBody); } catch { return { error: { message: errBody } }; }
      })();
      const anthropicError = convertError(errJson, upstreamResp.status);
      return res.status(upstreamResp.status >= 400 && upstreamResp.status < 500 ? upstreamResp.status : 502).json(anthropicError);
    }

    if (!isStreaming) {
      const openaiResp = await upstreamResp.json();
      if (!upstreamResp.ok) {
        const anthropicError = convertError(openaiResp, upstreamResp.status);
        return res.status(upstreamResp.status >= 400 && upstreamResp.status < 500 ? upstreamResp.status : 502).json(anthropicError);
      }
      const claudeResp = convertNonStreamingResponse(openaiResp);
      return res.json(claudeResp);
    }

    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text();
      const errJson = (() => {
        try { return JSON.parse(errBody); } catch { return { error: { message: errBody } }; }
      })();
      const anthropicError = convertError(errJson, upstreamResp.status);
      return res.status(upstreamResp.status >= 400 && upstreamResp.status < 500 ? upstreamResp.status : 502).json(anthropicError);
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const state = createStreamState();
    let buffer = "";

    upstreamResp.body.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (trimmed === "data: [DONE]") {
          if (state.messageStartSent && !state.finishReason) {
            stopThinkingBlock(state, []);
            stopTextBlock(state, []);
            const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: finalUsage,
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          }
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          if (!jsonStr) continue;

          let openaiChunk;
          try { openaiChunk = JSON.parse(jsonStr); } catch { continue; }

          const events = convertStreamChunk(openaiChunk, state);
          if (events) {
            for (const event of events) {
              const eventType = event.type;
              res.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
            }
          }
        }
      }
    });

    upstreamResp.body.on("end", () => {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          try {
            const openaiChunk = JSON.parse(trimmed.slice(6));
            const events = convertStreamChunk(openaiChunk, state);
            if (events) {
              for (const event of events) {
                res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
              }
            }
          } catch { }
        }
      }
      res.end();
    });

    upstreamResp.body.on("error", (err) => {
      err("Upstream stream error:", err.message);
      if (!state.messageStartSent) {
        res.write(`event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "Upstream stream error" },
        })}\n\n`);
      }
      res.end();
    });

    req.on("close", () => {
      upstreamResp.body?.destroy();
    });

  } catch (err) {
    err("Proxy error:", err.message);
    if (!res.headersSent) {
      return res.status(502).json({
        type: "error",
        error: {
          type: "api_error",
          message: `Proxy error: ${err.message}`,
        },
      });
    }
    res.end();
  }
});

// Helper: close blocks in stream (used for [DONE] fallback)
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  state.thinkingBlockStarted = false;
}
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  state.textBlockStarted = false;
}

// ── Error format conversion ───────────────────────────────────────
function convertError(openaiError, statusCode) {
  // OpenAI format: { error: { message, type, code } }
  const err = openaiError.error || openaiError;
  const message = err.message || err.msg || JSON.stringify(openaiError);
  const errType = err.type || "api_error";

  // Map to Anthropic error types
  let anthropicType = "api_error";
  if (statusCode === 400) anthropicType = "invalid_request_error";
  if (statusCode === 401) anthropicType = "authentication_error";
  if (statusCode === 403) anthropicType = "permission_error";
  if (statusCode === 404) anthropicType = "not_found_error";
  if (statusCode === 429) anthropicType = "rate_limit_error";
  if (statusCode === 500 || statusCode === 503) anthropicType = "api_error";

  return {
    type: "error",
    error: {
      type: anthropicType,
      message,
    },
  };
}

// ── Catch-all: return 404 for unknown routes ──────────────────────
app.use((_req, res) => {
  res.status(404).json({
    type: "error",
    error: {
      type: "not_found_error",
      message: "Not found. Use POST /v1/messages for Anthropic Messages API.",
    },
  });
});

// ── Start server ──────────────────────────────────────────────────
app.listen(PORT, () => {
  log("Listening on http://localhost:" + PORT);
  log("Forwarding to", OMNIROUTE_URL + TARGET_PATH);
  log("Endpoint: POST /v1/messages");
});
