const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/app");

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("POST /v1/messages/count_tokens returns Anthropic input_tokens shape", async () => {
  const appServer = await listen(createApp({
    port: 0,
    omnirouteUrl: "http://127.0.0.1:9",
    targetPath: "/v1/chat/completions",
    targetApi: "chat",
    directAnthropic: false,
    anthropicUrl: "http://127.0.0.1:9/v1/messages",
    anthropicApiKey: "",
    upstreamTimeoutMs: 300000,
    modelMap: {},
  }));

  try {
    const res = await fetch(`${appServer.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        system: "Você é útil.",
        messages: [{ role: "user", content: "Conte estes tokens" }],
      }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(typeof body.input_tokens, "number");
    assert.ok(body.input_tokens > 0);
    assert.deepEqual(Object.keys(body), ["input_tokens"]);
  } finally {
    await appServer.close();
  }
});
