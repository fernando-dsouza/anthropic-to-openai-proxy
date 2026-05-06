#!/usr/bin/env node
/**
 * Teste unitário: verifica se claude-to-openai injeta thought_signature
 * em cada tool_use quando FORCE_GEMINI_MODE=true.
 * Não precisa de servidor rodando nem API key.
 */

// Ativar modo Gemini para o teste
process.env.FORCE_GEMINI_MODE = "true";

const { claudeToOpenAIRequest } = require("./claude-to-openai");

let pass = 0;
let fail = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    pass++;
  } else {
    console.error(`  FAIL: ${msg}`);
    fail++;
  }
}

// ── Teste 1: tool_use sem signature deve receber fallback ─────────
console.log("\n[Teste 1] tool_use sem signature → fallback injetado");
{
  const body = {
    model: "antigravity/claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "get time" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to call the time tool" },
          { type: "tool_use", id: "toolu_1", name: "get_time", input: {} },
          { type: "tool_use", id: "toolu_2", name: "get_date", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12:00" }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "2026-05-06" }],
      },
    ],
    tools: [
      { name: "get_time", description: "Get time", input_schema: { type: "object", properties: {} } },
      { name: "get_date", description: "Get date", input_schema: { type: "object", properties: {} } },
    ],
  };

  const result = claudeToOpenAIRequest(body.model, body, false);

  // Encontrar mensagens assistant com tool_calls
  const assistantMsgs = result.messages.filter((m) => m.role === "assistant" && m.tool_calls);
  assert(assistantMsgs.length >= 1, "deve ter mensagem assistant com tool_calls");

  if (assistantMsgs.length > 0) {
    const msg = assistantMsgs[0];
    assert(msg.tool_calls.length === 2, `deve ter 2 tool_calls (tem ${msg.tool_calls.length})`);

    for (const tc of msg.tool_calls) {
      const hasSig = tc.extra_content?.google?.thought_signature;
      assert(!!hasSig, `tool_call ${tc.function.name} deve ter extra_content.google.thought_signature`);
    }
  }
}

// ── Teste 2: tool_use com signature existente deve preservar ──────
console.log("\n[Teste 2] tool_use com signature existente → preservado");
{
  const body = {
    model: "antigravity/claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "get time" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking...", signature: "original_sig_123" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_time",
            input: {},
            signature: "my_custom_sig",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12:00" }],
      },
    ],
    tools: [
      { name: "get_time", description: "Get time", input_schema: { type: "object", properties: {} } },
    ],
  };

  const result = claudeToOpenAIRequest(body.model, body, false);
  const assistantMsgs = result.messages.filter((m) => m.role === "assistant" && m.tool_calls);

  if (assistantMsgs.length > 0) {
    const tc = assistantMsgs[0].tool_calls[0];
    const sig = tc.extra_content?.google?.thought_signature;
    assert(sig === "my_custom_sig", `signature deve ser 'my_custom_sig' (é '${sig}')`);
  }
}

// ── Teste 3: thinking block signature propaga para tool_use ───────
console.log("\n[Teste 3] thinking block signature → propaga para tool_use sem signature");
{
  const body = {
    model: "antigravity/claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "get time" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need to call the time tool", signature: "thinking_block_sig" },
          { type: "tool_use", id: "toolu_1", name: "get_time", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12:00" }],
      },
    ],
    tools: [
      { name: "get_time", description: "Get time", input_schema: { type: "object", properties: {} } },
    ],
  };

  const result = claudeToOpenAIRequest(body.model, body, false);
  const assistantMsgs = result.messages.filter((m) => m.role === "assistant" && m.tool_calls);

  if (assistantMsgs.length > 0) {
    const tc = assistantMsgs[0].tool_calls[0];
    const sig = tc.extra_content?.google?.thought_signature;
    assert(sig === "thinking_block_sig", `signature do tool_use deve vir do thinking block (é '${sig}')`);
  }
}

// ── Teste 4: múltiplos tool_calls paralelos — todos recebem signature ─
console.log("\n[Teste 4] múltiplos tool_calls paralelos → todos com signature");
{
  const body = {
    model: "antigravity/claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "multi tool call" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need multiple tools" },
          { type: "tool_use", id: "toolu_1", name: "tool_a", input: {} },
          { type: "tool_use", id: "toolu_2", name: "tool_b", input: {} },
          { type: "tool_use", id: "toolu_3", name: "tool_c", input: {} },
          { type: "tool_use", id: "toolu_4", name: "tool_d", input: {} },
          { type: "tool_use", id: "toolu_5", name: "tool_e", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "b" },
          { type: "tool_result", tool_use_id: "toolu_3", content: "c" },
          { type: "tool_result", tool_use_id: "toolu_4", content: "d" },
          { type: "tool_result", tool_use_id: "toolu_5", content: "e" },
        ],
      },
    ],
    tools: [
      { name: "tool_a", description: "A", input_schema: { type: "object", properties: {} } },
      { name: "tool_b", description: "B", input_schema: { type: "object", properties: {} } },
      { name: "tool_c", description: "C", input_schema: { type: "object", properties: {} } },
      { name: "tool_d", description: "D", input_schema: { type: "object", properties: {} } },
      { name: "tool_e", description: "E", input_schema: { type: "object", properties: {} } },
    ],
  };

  const result = claudeToOpenAIRequest(body.model, body, false);
  const assistantMsgs = result.messages.filter((m) => m.role === "assistant" && m.tool_calls);

  if (assistantMsgs.length > 0) {
    const tcs = assistantMsgs[0].tool_calls;
    assert(tcs.length === 5, `deve ter 5 tool_calls (tem ${tcs.length})`);

    let allHaveSig = true;
    for (const tc of tcs) {
      if (!tc.extra_content?.google?.thought_signature) {
        allHaveSig = false;
        console.error(`    ${tc.function.name} SEM signature!`);
      }
    }
    assert(allHaveSig, "todos 5 tool_calls devem ter extra_content.google.thought_signature");
  }
}

// ── Teste 5: modo não-Gemini não injeta extra_content ─────────────
console.log("\n[Teste 5] modo não-Gemini → não injeta extra_content");
{
  delete process.env.FORCE_GEMINI_MODE;
  process.env.OMNIROUTE_URL = "http://localhost:3000"; // não é Gemini

  const body = {
    model: "cc/claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      { role: "user", content: "get time" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "get_time", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12:00" }],
      },
    ],
    tools: [
      { name: "get_time", description: "Get time", input_schema: { type: "object", properties: {} } },
    ],
  };

  const result = claudeToOpenAIRequest(body.model, body, false);
  const assistantMsgs = result.messages.filter((m) => m.role === "assistant" && m.tool_calls);

  if (assistantMsgs.length > 0) {
    const tc = assistantMsgs[0].tool_calls[0];
    const hasExtra = !!tc.extra_content;
    assert(!hasExtra, `modo não-Gemini não deve injetar extra_content (extra_content=${JSON.stringify(tc.extra_content)})`);
  }
}

// ── Resumo ────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Resultados: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);