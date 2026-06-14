const test = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/app");
const { createMockUpstream } = require("../helpers/mock-upstream");
const { postJson } = require("../helpers/http");

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function chatConfig(upstream) {
  return {
    port: 0,
    omnirouteUrl: upstream.url,
    targetPath: "/v1/chat/completions",
    targetApi: "chat",
    directAnthropic: false,
    anthropicUrl: `${upstream.url}/v1/messages`,
    anthropicApiKey: "",
    upstreamTimeoutMs: 300000,
  };
}

test("createApp exposes health without listening", async () => {
  const upstream = await createMockUpstream((_record, res) => res.end());
  const appServer = await listen(createApp(chatConfig(upstream)));

  try {
    const res = await fetch(`${appServer.url}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.target, `${upstream.url}/v1/chat/completions`);
  } finally {
    await appServer.close();
    await upstream.close();
  }
});

test("POST /v1/messages forwards translated chat request and converts response", async () => {
  const upstream = await createMockUpstream((record, res) => {
    assert.equal(record.method, "POST");
    assert.equal(record.url, "/v1/chat/completions");
    assert.equal(record.headers.authorization, "Bearer test-key");
    assert.equal(record.body.model, "claude-3-5-sonnet-20241022");
    assert.equal(record.body.messages[0].role, "user");

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      model: record.body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Olá" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  const appServer = await listen(createApp(chatConfig(upstream)));

  try {
    const res = await postJson(`${appServer.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 32,
      messages: [{ role: "user", content: "Oi" }],
    }, { "x-api-key": "test-key" });

    assert.equal(res.status, 200);
    assert.equal(res.body.type, "message");
    assert.deepEqual(res.body.content, [{ type: "text", text: "Olá" }]);
    assert.equal(upstream.requests.length, 1);
  } finally {
    await appServer.close();
    await upstream.close();
  }
});

test("POST /v1/messages maps OpenAI error bodies to Anthropic errors", async () => {
  const upstream = await createMockUpstream((_record, res) => {
    res.statusCode = 429;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "rate limited upstream", type: "rate_limit_exceeded" } }));
  });
  const appServer = await listen(createApp(chatConfig(upstream)));

  try {
    const res = await postJson(`${appServer.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 32,
      messages: [{ role: "user", content: "Oi" }],
    });

    assert.equal(res.status, 429);
    assert.equal(res.body.type, "error");
    assert.equal(res.body.error.type, "rate_limit_error");
    assert.equal(res.body.error.message, "rate limited upstream");
  } finally {
    await appServer.close();
    await upstream.close();
  }
});
