const express = require("express");
const { claudeToOpenAIRequest } = require("../claude-to-openai");
const {
  convertNonStreamingResponse,
  createStreamState,
  convertStreamChunk,
  finalizeStreamState,
} = require("../openai-to-claude");
const { chatToResponsesRequest, convertResponsesResponse } = require("./responses-api");

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const err = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);

function estimateInputTokens(body) {
  const text = JSON.stringify({ system: body.system || "", messages: body.messages || [], tools: body.tools || [] });
  return Math.max(1, Math.ceil(text.length / 4));
}

function convertError(openaiError, statusCode) {
  const source = openaiError && (openaiError.error || openaiError) || {};
  const message = source.message || source.msg || JSON.stringify(openaiError);

  let anthropicType = "api_error";
  if (statusCode === 400) anthropicType = "invalid_request_error";
  if (statusCode === 401) anthropicType = "authentication_error";
  if (statusCode === 403) anthropicType = "permission_error";
  if (statusCode === 404) anthropicType = "not_found_error";
  if (statusCode === 429) anthropicType = "rate_limit_error";

  return { type: "error", error: { type: anthropicType, message } };
}

function createApp(config) {
  const app = express();

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  app.use(express.text({ type: "text/plain" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: config.directAnthropic ? "direct_anthropic" : "omniroute_translate",
      target: config.directAnthropic ? config.anthropicUrl : `${config.omnirouteUrl}${config.targetPath}`,
    });
  });

  app.post("/v1/messages/count_tokens", (req, res) => {
    const body = req.body || {};
    if (!body.model) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "Missing required field: model" },
      });
    }
    return res.json({ input_tokens: estimateInputTokens(body) });
  });

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
    const upstreamModel = config.modelMap?.[model] || model;
    log("Incoming request", { requestId, model, upstreamModel, stream, directAnthropic: config.directAnthropic });

    const isStreaming = stream === true;
    const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "") || "";

    if (config.directAnthropic) {
      const anthropicKey = apiKey || req.headers["x-anthropic-api-key"] || config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";

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
        const upstreamResp = await fetch(config.anthropicUrl, {
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

    const chatBody = claudeToOpenAIRequest(upstreamModel, claudeBody, isStreaming);
    const openaiBody = config.targetApi === "responses" ? chatToResponsesRequest(chatBody) : chatBody;

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

    const targetUrl = `${config.omnirouteUrl}${config.targetPath}`;
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
        const claudeResp = config.targetApi === "responses"
          ? convertResponsesResponse(openaiResp)
          : convertNonStreamingResponse(openaiResp);
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
            const events = finalizeStreamState(state);
            if (events) {
              for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
              for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
                for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
              }
            } catch { }
          }
        }
        res.end();
      });

      upstreamResp.body.on("error", (error) => {
        err("Upstream stream error:", error.message);
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
    } catch (error) {
      err("Proxy error:", error.message);
      if (!res.headersSent) {
        return res.status(502).json({
          type: "error",
          error: { type: "api_error", message: `Proxy error: ${error.message}` },
        });
      }
      res.end();
    }
  });

  app.use((_req, res) => {
    res.status(404).json({
      type: "error",
      error: { type: "not_found_error", message: "Not found. Use POST /v1/messages for Anthropic Messages API." },
    });
  });

  return app;
}

module.exports = { createApp, convertError };
