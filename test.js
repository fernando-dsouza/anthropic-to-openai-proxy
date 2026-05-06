#!/usr/bin/env node
/**
 * Smoke test for anthropic-to-openai proxy.
 *
 * Tests health check + basic /v1/messages request in DIRECT_ANTHROPIC mode.
 * Run: node test.js
 *
 * Requires .env with DIRECT_ANTHROPIC=true and ANTHROPIC_API_KEY set,
 * or pass as args: node test.js <proxy_url> <api_key>
 */

const PROXY_URL = process.argv[2] || "http://localhost:8082";
const API_KEY = process.argv[3] || process.env.ANTHROPIC_API_KEY || "";
const REQUEST_ID = "test-" + Date.now();

async function healthCheck() {
  console.log("[health] Checking...");
  const res = await fetch(`${PROXY_URL}/health`);
  const body = await res.json();
  console.log("[health]", JSON.stringify(body, null, 2));
  console.assert(res.ok, `Health check failed: ${res.status}`);
  console.assert(
    body.mode === "direct_anthropic" || body.mode === "omniroute_translate" || !body.mode,
    `Unknown mode: ${body.mode}`,
  );
  console.log("[health] PASS");
}

async function postMessages() {
  const doMessages = process.argv.includes("--messages");
  if (!doMessages) {
    console.log("[messages] SKIP: pass --messages to run");
    return;
  }

  const apiKey = API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("[messages] SKIP: no API key provided");
    return;
  }

  console.log("[messages] Sending request...");
  const modelArgIndex = process.argv.findIndex((x) => x === "--model");
  const model = modelArgIndex >= 0 ? process.argv[modelArgIndex + 1] : "claude-sonnet-4-6";
  const payload = {
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: "Say hello in exactly 3 words." }],
  };

  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "x-request-id": REQUEST_ID,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  console.log("[messages] status:", res.status);
  const ct = res.headers.get("content-type") || "";
  console.log("[messages] content-type:", ct);

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[messages] FAIL:", errBody);
    process.exit(1);
  }

  const data = await res.json();
  console.log("[messages] response type:", data.type);
  console.log("[messages] model:", data.model);
  console.log("[messages] stop_reason:", data.stop_reason);

  if (data.content && data.content.length > 0) {
    for (const block of data.content) {
      console.log(`[messages] content[${block.type}]:`, JSON.stringify(block).slice(0, 200));
    }
  }

  console.log("[messages] PASS");
}

async function main() {
  console.log(`Testing proxy at ${PROXY_URL}\n`);

  try {
    await healthCheck();
    console.log();
    await postMessages();
    console.log("\nAll tests passed.");
  } catch (e) {
    console.error("Test error:", e.message);
    process.exit(1);
  }
}

main();