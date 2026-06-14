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

test("TARGET_API=responses forwards /v1/responses request and converts output_text", async () => {
  const upstream = await createMockUpstream((record, res) => {
    assert.equal(record.url, "/v1/responses");
    assert.equal(record.body.model, "gpt-4o");
    assert.ok(Array.isArray(record.body.input));
    assert.equal(record.body.max_output_tokens, 64);

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_123",
      model: "gpt-4o",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Resposta via Responses" }] }],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }));
  });
  const appServer = await listen(createApp({
    port: 0,
    omnirouteUrl: upstream.url,
    targetPath: "/v1/responses",
    targetApi: "responses",
    directAnthropic: false,
    anthropicUrl: `${upstream.url}/v1/messages`,
    anthropicApiKey: "",
    upstreamTimeoutMs: 300000,
    modelMap: { "claude-3-5-sonnet-20241022": "gpt-4o" },
  }));

  try {
    const res = await postJson(`${appServer.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "Oi" }],
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.id, "resp_123");
    assert.deepEqual(res.body.content, [{ type: "text", text: "Resposta via Responses" }]);
    assert.deepEqual(res.body.usage, { input_tokens: 7, output_tokens: 3 });
  } finally {
    await appServer.close();
    await upstream.close();
  }
});
