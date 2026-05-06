/**
 * OpenAI Chat Completions → Claude Messages API response translator.
 * Handles both non-streaming and streaming (SSE) responses.
 * Based on OmniRoute's open-sse/translator/response/openai-to-claude.ts
 */

// Gemini/Antigravity requires thought_signature on functionCall parts.
// When upstream (OmniRoute) doesn't provide one, inject this fallback.
const DEFAULT_THOUGHT_SIGNATURE =
  "EuwGCukGAXLI2nxwZIq54WWSoL/YN0P3TsDZ7zRnLi8g0S4aVr2HUGxvaHKySuY6HAVzcE0GPGjXrytLIldxthSvfxgUlJh6Qa9Z+Oj5QZBlYdg6HaJ6yuY5R7waE6rdwBsRf7Ft2j3DJ9rMi9qhWFqApewYtPhls3VHtuvND3l8Rm09+lbAXQs6KKWEWrxNLKTBkfpMgXhRERc/TQRMZu1twAablm6/Zk1tsYRvfWKLsNbeKF+CCojJdXJKvnR/8Ouuoa+Y2Ti20hcW7aZIIjZDFYPU//k6Ybmhg69J/imbFai2ckhfLaisqdDkdoIiBJScTOUvYqP6AE9d4MsydSC+UlhIMk4hoP76R8vUSCZRMkjOaDXstf/QoVZKbt94wyRZgAJ1G0BqI8L5ow86kLpA4wJEtxsRGymOE4bKUvApveBakYDNM9APkf+LbtbzWSseGjoZcSlycF9iN8Q2XNYKRrHbv3Lr5Y8JjdH/5y/6SHkNehTEZugaeGnSPSyCTWto1kQgHpxdWmhkLfJGNUGLmue7Mesj4TSms4J33mRpYVhNB/J333FCqIP0hr/E7BkkjEn7yZ4X7SQlh+xKPurapsnHRwiKmtsilmEFrnTE9iQr+pMr6M29qqFNv1tr5yumbaJw8JW9sB15tNsRv+dW6BjNanbsKz7HCgKUBc8tGy+7YuhXzAfViyRefcjK7eZW0Fbyt7AbybJTKz78W8NH7ye6LAwzOebXpeZ4d43fNIt8bKh26qgduSQv/7o+pAflkuqHZ99YWgHQ8h8OkZFi3eOiSYjsjhdZ/czWOdoPI/OnqIldzMPF5YlrKBLFX8VhRKVmqgsmWf5PHGulHhMkVlS+XG2UIseGy69ARa93D78Gsa+1n1kJr7EEB7Rh+27vUMxVYLdz1yMSvE5nalTAlg/ZeG8+XQ0cHuAI3KbQpHW2Q++RdXfm5JzD5WdJZUU+Zn8t8UUn85BH4RxZLeE0qJikgSsKoYVBc6YhiMjhPgkR95ReimY4Z0xCJdRo1gjexOFeODZMpQF6Yxnoic7IrdgsFA3iePTbFnPp3IAM1fAThWhXJUn3QInUOTd5o1qmTmn6REbL15g/JQNl+dqUoPkhleeb2V3kjqp1okmO3wMZbPknR3S1LZNmlS72/iBQUm+n2b/RCn4PjmM2";

// ── Finish reason mapping ─────────────────────────────────────────
function convertFinishReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

// ── Non-streaming: convert full OpenAI response to Claude format ──
function convertNonStreamingResponse(openaiResp) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return {
      id: openaiResp.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: openaiResp.model || "unknown",
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];
  const message = choice.message || {};

  // Thinking/reasoning content
  if (message.reasoning_content) {
    content.push({
      type: "thinking",
      thinking: message.reasoning_content,
    });
  }

  // Text content
  if (message.content) {
    content.push({
      type: "text",
      text: message.content,
    });
  }

  // Tool calls
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      const _sig = tc.extra_content?.google?.thought_signature || tc.thought_signature || DEFAULT_THOUGHT_SIGNATURE;
	content.push({
	  type: "tool_use",
	  id: tc.id,
	  name: tc.function?.name || "",
	  input,
	  signature: _sig,
	  thought_signature: _sig,
	});
    }
  }

  // Usage
  const usage = openaiResp.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const cacheCreationTokens = usage.prompt_tokens_details?.cache_creation_tokens || 0;
  const inputTokens = promptTokens - cachedTokens - cacheCreationTokens;
  const outputTokens = usage.completion_tokens || 0;

  const claudeUsage = {
    input_tokens: Math.max(0, inputTokens),
    output_tokens: outputTokens,
  };
  if (cachedTokens > 0) claudeUsage.cache_read_input_tokens = cachedTokens;
  if (cacheCreationTokens > 0) claudeUsage.cache_creation_input_tokens = cacheCreationTokens;

  return {
    id: (openaiResp.id || "").replace("chatcmpl-", "") || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: openaiResp.model || "unknown",
    content,
    stop_reason: convertFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: claudeUsage,
  };
}

// ── Streaming: stateful converter ─────────────────────────────────
function createStreamState() {
  return {
    messageStartSent: false,
    messageId: null,
    model: null,
    nextBlockIndex: 0,
    thinkingBlockStarted: false,
    thinkingBlockIndex: null,
    textBlockStarted: false,
    textBlockClosed: false,
    textBlockIndex: null,
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
  };
}

function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex,
  });
  state.thinkingBlockStarted = false;
}

function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex,
  });
  state.textBlockStarted = false;
}

/**
 * Convert a single OpenAI SSE chunk to Claude streaming events.
 * Returns array of Claude SSE event objects, or null if nothing to emit.
 */
function convertStreamChunk(chunk, state) {
  if (!chunk || !chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens =
      typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens =
      typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens || 0;
    const inputTokens = promptTokens - cachedTokens - cacheCreationTokens;

    state.usage = {
      input_tokens: Math.max(0, inputTokens),
      output_tokens: outputTokens,
    };
    if (cachedTokens > 0) state.usage.cache_read_input_tokens = cachedTokens;
    if (cacheCreationTokens > 0) state.usage.cache_creation_input_tokens = cacheCreationTokens;
  }

  // First chunk — always send message_start
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = `msg_${Date.now()}`;
    }
    state.model = chunk.model || "unknown";
    state.nextBlockIndex = 0;

    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // Handle reasoning_content / reasoning / reasoning_details (thinking)
  let reasoningContent = delta?.reasoning_content || delta?.reasoning;
  if (!reasoningContent && Array.isArray(delta?.reasoning_details)) {
    const parts = [];
    for (const detail of delta.reasoning_details) {
      if (detail && typeof detail === "object") {
        const text = detail.text || detail.content;
        if (typeof text === "string" && text) parts.push(text);
      }
    }
    if (parts.length > 0) reasoningContent = parts.join("");
  }

  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent },
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: "text", text: "" },
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      if (tc.id) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, {
          id: tc.id,
          name: tc.function?.name || "",
          blockIndex: toolBlockIndex,
          signature: tc.extra_content?.google?.thought_signature || tc.thought_signature || DEFAULT_THOUGHT_SIGNATURE,
		  thought_signature: tc.extra_content?.google?.thought_signature || tc.thought_signature || DEFAULT_THOUGHT_SIGNATURE,
        });

        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "",
            input: {},
            signature: tc.extra_content?.google?.thought_signature || tc.thought_signature || DEFAULT_THOUGHT_SIGNATURE,
		  thought_signature: tc.extra_content?.google?.thought_signature || tc.thought_signature || DEFAULT_THOUGHT_SIGNATURE,
          },
        });
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          let deltaStr = tc.function.arguments;

          // Strip empty string and array placeholders (same logic as OmniRoute)
          if (deltaStr.includes('""') || deltaStr.includes("[]") || deltaStr.includes("[ ]")) {
            deltaStr = deltaStr
              .replace(/,"[a-zA-Z0-9_]+":""/g, "")
              .replace(/"[a-zA-Z0-9_]+":"",/g, "")
              .replace(/,"[a-zA-Z0-9_]+":\s*\[\s*\]/g, "")
              .replace(/"[a-zA-Z0-9_]+":\s*\[\s*\],?/g, "");
          }

          results.push({
            type: "content_block_delta",
            index: toolInfo.blockIndex,
            delta: { type: "input_json_delta", partial_json: deltaStr },
          });
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [, toolInfo] of state.toolCalls) {
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex,
      });
    }

    state.finishReason = choice.finish_reason;
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };

    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason), stop_sequence: null },
      usage: finalUsage,
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

module.exports = {
  convertNonStreamingResponse,
  convertFinishReason,
  createStreamState,
  convertStreamChunk,
};
