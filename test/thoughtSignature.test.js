const assert = require('assert');
const { claudeToOpenAIRequest } = require('../claude-to-openai');
const { convertNonStreamingResponse } = require('../openai-to-claude');

// Claude message with tool_use including thought_signature
const claudeBody = {
  model: 'gpt-4o',
  messages: [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool1',
          name: 'testTool',
          input: {},
          thought_signature: 'sig123',
        },
      ],
    },
  ],
};

// Convert to OpenAI request
const openaiReq = claudeToOpenAIRequest(claudeBody.model, claudeBody, false);
assert.ok(openaiReq.messages[0].tool_calls, 'OpenAI request should contain tool_calls');
const tc = openaiReq.messages[0].tool_calls[0];
assert.strictEqual(tc.thought_signature, 'sig123', 'thought_signature preserved in request');

// Simulate OpenAI response echoing the tool call with signature
const openaiResp = {
  id: 'chatcmpl-123',
  model: 'gpt-4o',
  choices: [
    {
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'tool1',
            type: 'function',
            function: { name: 'testTool', arguments: '{}' },
            thought_signature: 'sig123',
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {},
};

// Convert back to Claude format
const claudeResp = convertNonStreamingResponse(openaiResp);
const toolBlock = claudeResp.content.find(c => c.type === 'tool_use');
assert.ok(toolBlock, 'Claude response should contain tool_use');
assert.strictEqual(toolBlock.thought_signature, 'sig123', 'thought_signature preserved in response');

// ── Fallback test: upstream omits thought_signature ──────────────
const openaiRespNoSig = {
  id: 'chatcmpl-456',
  model: 'gemini-3.1-pro-high',
  choices: [
    {
      message: {
        role: 'assistant',
        tool_calls: [
          {
            id: 'tool2',
            type: 'function',
            function: { name: 'fallbackTool', arguments: '{}' },
            // no thought_signature — proxy must inject fallback
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {},
};

const claudeRespNoSig = convertNonStreamingResponse(openaiRespNoSig);
const toolBlockNoSig = claudeRespNoSig.content.find(c => c.type === 'tool_use');
assert.ok(toolBlockNoSig, 'Claude response should contain tool_use (fallback)');
assert.ok(toolBlockNoSig.thought_signature, 'thought_signature must be injected when missing');
assert.strictEqual(typeof toolBlockNoSig.thought_signature, 'string');
assert.ok(toolBlockNoSig.thought_signature.length > 100, 'Fallback signature must be substantial');

console.log('All thought signature tests passed');
