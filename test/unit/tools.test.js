const test = require("node:test");
const assert = require("node:assert/strict");

const { claudeToOpenAIRequest } = require("../../claude-to-openai");

test("tools normalize schemas and map tool_choice tool", () => {
  const req = claudeToOpenAIRequest("gpt-4o", {
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "Use tool" }],
    tools: [{ name: "lookup", description: "Lookup data", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "lookup" },
  }, false);

  assert.equal(req.tools[0].type, "function");
  assert.equal(req.tools[0].function.name, "lookup");
  assert.deepEqual(req.tools[0].function.parameters, { type: "object", properties: {} });
  assert.deepEqual(req.tool_choice, { type: "function", function: { name: "lookup" } });
});

test("assistant tool_use followed by missing tool_result gets placeholder", () => {
  const req = claudeToOpenAIRequest("gpt-4o", {
    model: "claude-3-5-sonnet-20241022",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }] },
      { role: "user", content: "continue" },
    ],
  }, false);

  assert.equal(req.messages[0].role, "assistant");
  assert.equal(req.messages[1].role, "tool");
  assert.equal(req.messages[1].tool_call_id, "call_1");
  assert.equal(req.messages[1].content, "[No response received]");
});
