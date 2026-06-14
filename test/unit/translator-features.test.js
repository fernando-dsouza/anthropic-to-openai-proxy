const test = require("node:test");
const assert = require("node:assert/strict");

const { claudeToOpenAIRequest } = require("../../claude-to-openai");
const { convertNonStreamingResponse } = require("../../openai-to-claude");

test("request preserves prompt cache control blocks", () => {
  const req = claudeToOpenAIRequest("gpt-4o", {
    model: "claude-3-5-sonnet-20241022",
    system: [{ type: "text", text: "cached system", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "cached user", cache_control: { type: "ephemeral" } }] }],
  }, false);

  assert.deepEqual(req.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(req.messages[1].content[0].cache_control, { type: "ephemeral" });
});

test("request converts document blocks to text parts", () => {
  const req = claudeToOpenAIRequest("gpt-4o", {
    model: "claude-3-5-sonnet-20241022",
    messages: [{
      role: "user",
      content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "doc body" }, title: "readme.txt" }],
    }],
  }, false);

  assert.match(req.messages[0].content[0].text, /readme\.txt/);
  assert.match(req.messages[0].content[0].text, /doc body/);
});

test("request forwards JSON schema response_format", () => {
  const req = claudeToOpenAIRequest("gpt-4o", {
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "Return JSON" }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" } },
    },
  }, false);

  assert.equal(req.response_format.type, "json_schema");
  assert.equal(req.response_format.json_schema.name, "answer");
});

test("response preserves thinking signature when upstream provides it", () => {
  const res = convertNonStreamingResponse({
    id: "chatcmpl-thinking",
    model: "gpt-4o",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", reasoning_content: "private thought", reasoning_signature: "sig-thinking", content: "done" },
    }],
    usage: {},
  });

  assert.deepEqual(res.content[0], { type: "thinking", thinking: "private thought", signature: "sig-thinking" });
});
