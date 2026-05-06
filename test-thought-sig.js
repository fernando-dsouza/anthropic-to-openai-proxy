#!/usr/bin/env node
/**
 * Teste de thought_signature no proxy.
 * Simula request com tool_use e verifica se extra_content.google.thought_signature é injetado.
 */

const PROXY_URL = process.argv[2] || "http://localhost:8082";
const API_KEY = process.argv[3] || "";

async function testToolUseWithSignature() {
  console.log("[test] Enviando request com tool_use para verificar thought_signature...");

  const payload = {
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: "Use a tool to get current time",
      },
    ],
    tools: [
      {
        name: "get_time",
        description: "Get current time",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
    "x-request-id": "test-thought-sig-" + Date.now(),
    "anthropic-version": "2023-06-01",
  };

  try {
    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    console.log("[test] status:", res.status);
    const ct = res.headers.get("content-type") || "";
    console.log("[test] content-type:", ct);

    if (!res.ok) {
      const errBody = await res.text();
      console.error("[test] FAIL:", errBody);
      process.exit(1);
    }

    const data = await res.json();
    console.log("[test] response type:", data.type);
    console.log("[test] model:", data.model);
    console.log("[test] stop_reason:", data.stop_reason);

    if (data.content && data.content.length > 0) {
      for (const block of data.content) {
        console.log(`[test] content[${block.type}]:`, JSON.stringify(block).slice(0, 300));
        if (block.type === "tool_use") {
          console.log(`[test]   - id: ${block.id}`);
          console.log(`[test]   - name: ${block.name}`);
          console.log(`[test]   - thought_signature: ${block.thought_signature ? "present" : "MISSING"}`);
          console.log(`[test]   - signature: ${block.signature ? "present" : "MISSING"}`);
        }
      }
    }

    console.log("[test] PASS");
  } catch (e) {
    console.error("[test] error:", e.message);
    process.exit(1);
  }
}

async function main() {
  console.log(`Testando thought_signature em ${PROXY_URL}\n`);

  try {
    await testToolUseWithSignature();
    console.log("\nTeste concluído. Verifique logs do proxy para ver se 'hasSignature: true' apareceu.");
  } catch (e) {
    console.error("Erro no teste:", e.message);
    process.exit(1);
  }
}

main();