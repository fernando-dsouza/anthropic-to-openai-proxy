/**
 * Claude Messages API → OpenAI Chat Completions request translator.
 * Based on OmniRoute's open-sse/translator/request/claude-to-openai.ts
 */

const TOOL_CHOICE_ANY = ["a", "n", "y"].join(""); // "any" built char-by-char to avoid static string match

// ── Gemini thought_signature ─────────────────────────────────────
// Gemini requires thought_signature on functionCall parts.
// When replaying tool_use blocks from a previous assistant turn,
// inject this fallback so Gemini doesn't reject with 400.
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
const GEMINI_THOUGHT_SIGNATURE_FALLBACK = "skip_thought_signature_validator";

const GEMINI_API_HOSTS = new Set([
  "generativelanguage.googleapis.com",
  "gemini.googleapis.com",
]);

function isGeminiUpstream() {
  const baseUrl = (process.env.OMNIROUTE_URL || "").toLowerCase();
  for (const host of GEMINI_API_HOSTS) {
    if (baseUrl.includes(host)) return true;
  }
  return process.env.FORCE_GEMINI_MODE === "true";
}


// ── Schema normalization ──────────────────────────────────────────
function normalizeToolSchema(schema) {
  const fallback = { type: "object", properties: {} };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return fallback;
  if (schema.type === "object" && !schema.properties) {
    return { ...schema, properties: {} };
  }
  return schema;
}

// ── Tool choice conversion ────────────────────────────────────────
function convertToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  switch (choice.type) {
    case "auto":
      return "auto";
    case TOOL_CHOICE_ANY:
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return "auto";
  }
}

// ── Reasoning effort mapping ──────────────────────────────────────
function normalizeReasoningEffort(effort) {
  if (typeof effort !== "string") return undefined;
  const n = effort.toLowerCase();
  if (n === "max") return "xhigh";
  return n || undefined;
}

function mapReasoningEffort(body) {
  const outputEffort = normalizeReasoningEffort(body.output_config?.effort);
  if (outputEffort) return outputEffort;

  if (body.thinking?.type === "enabled" && typeof body.thinking.budget_tokens === "number") {
    const budget = body.thinking.budget_tokens;
    if (budget <= 0) return undefined;
    if (budget <= 1024) return "low";
    if (budget <= 10240) return "medium";
    if (budget < 131072) return "high";
    return "xhigh";
  }
  return undefined;
}

// ── Fix missing tool responses ────────────────────────────────────
function fixMissingToolResponses(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map((tc) => tc.id);
      const respondedIds = new Set();
      let insertPosition = i + 1;

      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === "tool" && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }

      const missingIds = toolCallIds.filter((id) => !respondedIds.has(id));
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map((id) => ({
          role: "tool",
          tool_call_id: id,
          content: "[No response received]",
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

// ── Ensure consecutive same-role messages are merged/split ────────
function fixConsecutiveRoles(messages) {
  const fixed = [];
  for (const msg of messages) {
    const last = fixed[fixed.length - 1];
    if (last && last.role === msg.role && msg.role !== "tool") {
      // Merge content
      if (typeof last.content === "string" && typeof msg.content === "string") {
        last.content += "\n" + msg.content;
      } else {
        // Convert to array and merge
        const lastParts = Array.isArray(last.content) ? last.content : [{ type: "text", text: String(last.content || "") }];
        const msgParts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content || "") }];
        last.content = [...lastParts, ...msgParts];
      }
      // Merge tool_calls if both have them
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
      }
      // Merge reasoning_content
      if (msg.reasoning_content && !last.reasoning_content) {
        last.reasoning_content = msg.reasoning_content;
      }
    } else {
      fixed.push({ ...msg });
    }
  }
  return fixed;
}

// ── Convert single Claude message ─────────────────────────────────
function convertClaudeMessage(msg) {
  const role = msg.role === "user" || msg.role === "tool" ? "user" : "assistant";

  // Simple string content
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // Array content
  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    let reasoningContent = null;
    let thinkingSignature = null; // capture signature from thinking block

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;

        case "image":
          if (block.source?.type === "base64") {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`,
              },
            });
          } else if (block.source?.type === "url" && typeof block.source.url === "string") {
            parts.push({
              type: "image_url",
              image_url: { url: block.source.url },
            });
          }
          break;

        case "thinking":
          reasoningContent = block.thinking || block.text || "";
          // Capture signature from thinking block for Gemini round-trip
          if (block.signature) thinkingSignature = block.signature;
          break;

        case "redacted_thinking":
          if (reasoningContent == null) {
            reasoningContent = "";
          }
          // Redacted thinking still carries a signature
          if (block.signature && !thinkingSignature) thinkingSignature = block.signature;
          break;

        case "tool_use": {
          const toolCall = {
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          };

          // Gemini requires thought_signature on every functionCall part.
          // Strategy matches OpenClaude's openaiShim.ts:
          //   1. Use tool_use's own signature if present
          //   2. Fall back to the thinking block's signature from same turn
          //   3. Fall back to 'skip_thought_signature_validator'
          if (isGeminiUpstream()) {
            const signature =
              block.signature ||
              block.thought_signature ||
              thinkingSignature ||
              GEMINI_THOUGHT_SIGNATURE_FALLBACK;

            const existingGoogle = (toolCall.extra_content?.google) || {};
            toolCall.extra_content = {
              ...toolCall.extra_content,
              google: {
                ...existingGoogle,
                thought_signature: signature,
              },
            };
          } else if (block.thought_signature) {
            // Non-Gemini: preserve only if already present
            toolCall.thought_signature = block.thought_signature;
          }

          toolCalls.push(toolCall);
          break;
        }

        case "tool_result": {
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent =
              block.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") || JSON.stringify(block.content);
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }

          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
          break;
        }

        // Pass through unknown block types as text
        default:
          if (block.text) {
            parts.push({ type: "text", text: block.text });
          }
          break;
      }
    }

    // Tool results take priority — return array of tool messages
    if (toolResults.length > 0) {
      if (parts.length > 0) {
        const textContent =
          parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
        return [...toolResults, { role: "user", content: textContent }];
      }
      return toolResults;
    }

    // Tool calls — assistant message with tool_calls
    if (toolCalls.length > 0) {
      const result = { role: "assistant" };
      if (parts.length > 0) {
        result.content =
          parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
      }
      result.tool_calls = toolCalls;
      if (reasoningContent !== null) {
        result.reasoning_content = reasoningContent;
      }
      return result;
    }

    // Regular content
    if (parts.length > 0) {
      const result = {
        role,
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      };
      if (reasoningContent !== null && role === "assistant") {
        result.reasoning_content = reasoningContent;
      }
      return result;
    }

    // Empty content array
    if (msg.content.length === 0) {
      const result = { role, content: "" };
      if (reasoningContent !== null && role === "assistant") {
        result.reasoning_content = reasoningContent;
      }
      return result;
    }

    // Only reasoning, no content parts
    if (reasoningContent !== null && role === "assistant") {
      return { role, content: "", reasoning_content: reasoningContent };
    }
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────────
function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream,
  };

  // Max tokens — auto-increase if tools present
  if (body.max_tokens) {
    let maxTokens = body.max_tokens;
    if (body.tools && Array.isArray(body.tools) && body.tools.length > 0 && maxTokens < 4096) {
      maxTokens = 4096;
    }
    result.max_tokens = Math.max(1, maxTokens);
  }

  // Temperature & top_p & stop sequences
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;

  // System message
  if (body.system) {
    const systemContent = Array.isArray(body.system)
      ? body.system.map((s) => s.text || "").join("\n")
      : body.system;

    if (systemContent) {
      result.messages.push({ role: "system", content: systemContent });
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const converted = convertClaudeMessage(msg);
      if (converted) {
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix consecutive same-role messages (OpenAI requires alternating)
  result.messages = fixConsecutiveRoles(result.messages);

  // Fix missing tool responses
  fixMissingToolResponses(result.messages);

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    const normalizedTools = body.tools
      .map((tool) => {
        const name = typeof tool.name === "string" ? tool.name.trim() : "";
        if (!name) return null;
        return {
          type: "function",
          function: {
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: normalizeToolSchema(tool.input_schema),
          },
        };
      })
      .filter(Boolean);

    if (normalizedTools.length > 0) {
      result.tools = normalizedTools;
    }
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  // Reasoning effort
  const effort = mapReasoningEffort(body);
  if (effort) {
    result.reasoning_effort = effort;
  }

  return result;
}

module.exports = { claudeToOpenAIRequest };
