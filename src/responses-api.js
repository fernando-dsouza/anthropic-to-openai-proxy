function chatToResponsesRequest(chatBody) {
  const request = {
    model: chatBody.model,
    input: chatBody.messages || [],
  };

  if (chatBody.max_tokens !== undefined) request.max_output_tokens = chatBody.max_tokens;
  if (chatBody.temperature !== undefined) request.temperature = chatBody.temperature;
  if (chatBody.top_p !== undefined) request.top_p = chatBody.top_p;
  if (chatBody.stream !== undefined) request.stream = chatBody.stream;
  if (chatBody.tools !== undefined) request.tools = chatBody.tools;
  if (chatBody.tool_choice !== undefined) request.tool_choice = chatBody.tool_choice;
  if (chatBody.response_format !== undefined) request.response_format = chatBody.response_format;
  if (chatBody.reasoning_effort !== undefined) request.reasoning = { effort: chatBody.reasoning_effort };
  return request;
}

function outputTextFromResponses(resp) {
  const content = [];
  for (const item of resp.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" || part.type === "text") {
          content.push({ type: "text", text: part.text || "" });
        }
      }
    } else if (item.type === "function_call") {
      let input = {};
      try { input = JSON.parse(item.arguments || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: item.call_id || item.id, name: item.name || "", input });
    }
  }
  return content;
}

function convertResponsesResponse(resp) {
  const usage = resp.usage || {};
  return {
    id: resp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model || "unknown",
    content: outputTextFromResponses(resp),
    stop_reason: resp.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
    },
  };
}

module.exports = { chatToResponsesRequest, convertResponsesResponse };
