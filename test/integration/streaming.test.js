const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/app");
const { createMockUpstream } = require("../helpers/mock-upstream");

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("streaming chat chunks are converted to Anthropic SSE events", async () => {
  const upstream = await createMockUpstream((_record, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream",
      model: "gpt-4o",
      choices: [{ delta: { role: "assistant", content: "Olá" }, finish_reason: null }],
    }) + "\n\n");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream",
      model: "gpt-4o",
      choices: [{ delta: { content: " mundo" }, finish_reason: null }],
    }) + "\n\n");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream",
      model: "gpt-4o",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
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
    modelMap: {},
  }));

  try {
    const res = await fetch(`${appServer.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", max_tokens: 32, stream: true, messages: [{ role: "user", content: "Oi" }] }),
    });
    const text = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /"text":"Olá"/);
    assert.match(text, /"text":" mundo"/);
    assert.match(text, /event: message_stop/);
  } finally {
    await appServer.close();
    await upstream.close();
  }
});
