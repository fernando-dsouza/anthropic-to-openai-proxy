const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/app");
const { createMockUpstream } = require("../helpers/mock-upstream");
const { postJson } = require("../helpers/http");

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("MODEL_MAP maps Anthropic model before forwarding upstream", async () => {
  const upstream = await createMockUpstream((record, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl-model-map",
      model: record.body.model,
      choices: [{ message: { role: "assistant", content: record.body.model }, finish_reason: "stop" }],
      usage: {},
    }));
  });
  const appServer = await listen(createApp({
    port: 0,
    omnirouteUrl: upstream.url,
    targetPath: "/v1/chat/completions",
    targetApi: "chat",
    directAnthropic: false,
    anthropicUrl: `${upstream.url}/v1/messages`,
    anthropicApiKey: "",
    upstreamTimeoutMs: 300000,
    modelMap: { "claude-3-5-sonnet-20241022": "gpt-4o" },
  }));

  try {
    const res = await postJson(`${appServer.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      messages: [{ role: "user", content: "Oi" }],
    });

    assert.equal(res.status, 200);
    assert.equal(upstream.requests[0].body.model, "gpt-4o");
    assert.deepEqual(res.body.content, [{ type: "text", text: "gpt-4o" }]);
  } finally {
    await appServer.close();
    await upstream.close();
  }
});
