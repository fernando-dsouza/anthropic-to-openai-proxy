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

function chatConfig(upstream, overrides = {}) {
  return {
    port: 0,
    omnirouteUrl: upstream.url,
    targetPath: "/v1/chat/completions",
    targetApi: "chat",
    directAnthropic: false,
    anthropicUrl: `${upstream.url}/v1/messages`,
    anthropicApiKey: "",
    upstreamTimeoutMs: 300000,
    modelMap: {},
    ...overrides,
  };
}

function parseSseEvents(text) {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      return {
        event: eventLine ? eventLine.slice(7) : null,
        data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
      };
    });
}

test("OmniRoute v3.8.21 reasoning_content response becomes Anthropic thinking block before text", async () => {
  const upstream = await createMockUpstream((record, res) => {
    assert.equal(record.url, "/v1/chat/completions");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl-reasoning",
      model: record.body.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          reasoning_content: "vou raciocinar antes da resposta",
          content: "resposta final",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    }));
  });
  const appServer = await listen(createApp(chatConfig(upstream)));

  try {
    const res = await postJson(`${appServer.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "Oi" }],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.content, [
      { type: "thinking", thinking: "vou raciocinar antes da resposta" },
      { type: "text", text: "resposta final" },
    ]);
    assert.equal(res.body.stop_reason, "end_turn");
  } finally {
    await appServer.close();
    await upstream.close();
  }
});

test("OmniRoute v3.8.21 streaming reasoning_content becomes Anthropic thinking deltas before text deltas", async () => {
  const upstream = await createMockUpstream((_record, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream-reasoning",
      model: "gemini-3.5-flash-high",
      choices: [{ delta: { role: "assistant", reasoning_content: "penso " }, finish_reason: null }],
    }) + "\n\n");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream-reasoning",
      model: "gemini-3.5-flash-high",
      choices: [{ delta: { reasoning_content: "logo respondo" }, finish_reason: null }],
    }) + "\n\n");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream-reasoning",
      model: "gemini-3.5-flash-high",
      choices: [{ delta: { content: "resposta" }, finish_reason: null }],
    }) + "\n\n");
    res.write("data: " + JSON.stringify({
      id: "chatcmpl-stream-reasoning",
      model: "gemini-3.5-flash-high",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const appServer = await listen(createApp(chatConfig(upstream)));

  try {
    const res = await fetch(`${appServer.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "Oi" }],
      }),
    });
    const text = await res.text();
    const events = parseSseEvents(text);

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    assert.deepEqual(events.map((item) => item.event), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    assert.deepEqual(events[1].data.content_block, { type: "thinking", thinking: "" });
    assert.deepEqual(events[2].data.delta, { type: "thinking_delta", thinking: "penso " });
    assert.deepEqual(events[3].data.delta, { type: "thinking_delta", thinking: "logo respondo" });
    assert.deepEqual(events[5].data.content_block, { type: "text", text: "" });
    assert.deepEqual(events[6].data.delta, { type: "text_delta", text: "resposta" });
    assert.equal(events[8].data.delta.stop_reason, "end_turn");
  } finally {
    await appServer.close();
    await upstream.close();
  }
});

test("MODEL_MAP can forward Anthropic aliases to OmniRoute v3.8.21 Gemini 3.5 Flash public IDs", async () => {
  const upstream = await createMockUpstream((record, res) => {
    assert.equal(record.body.model, "gemini-3.5-flash-high");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl-gemini-map",
      model: record.body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: record.body.model },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
  });
  const appServer = await listen(createApp(chatConfig(upstream, {
    modelMap: {
      "claude-3-5-sonnet-20241022": "gemini-3.5-flash-high",
    },
  })));

  try {
    const res = await postJson(`${appServer.url}/v1/messages`, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 32,
      messages: [{ role: "user", content: "Oi" }],
    });

    assert.equal(res.status, 200);
    assert.equal(upstream.requests[0].body.model, "gemini-3.5-flash-high");
    assert.deepEqual(res.body.content, [{ type: "text", text: "gemini-3.5-flash-high" }]);
  } finally {
    await appServer.close();
    await upstream.close();
  }
});
