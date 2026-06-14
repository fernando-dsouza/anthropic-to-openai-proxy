# Anthropic to OpenAI Proxy

Proxy Express que recebe requisições Anthropic Messages API em `POST /v1/messages`, converte para OpenAI-compatible upstream e converte respostas de volta para formato Anthropic.

## Uso

```bash
npm install
npm start
```

Servidor padrão:

```text
http://localhost:8082
```

## Endpoints

```text
GET  /health
POST /v1/messages
POST /v1/messages/count_tokens
```

`POST /v1/messages` aceita chamadas Anthropic Messages API. `POST /v1/messages/count_tokens` retorna estimativa local em formato Anthropic:

```json
{ "input_tokens": 123 }
```

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `8082` | Porta do proxy. |
| `OMNIROUTE_URL` | `http://localhost:3000` | Base URL do upstream OpenAI-compatible. |
| `TARGET_PATH` | `/v1/chat/completions` | Caminho no upstream. Use `/v1/responses` com `TARGET_API=responses`. |
| `TARGET_API` | `chat` | `chat` para Chat Completions ou `responses` para OpenAI Responses API. |
| `MODEL_MAP` | `{}` | JSON object para mapear modelo Anthropic recebido para modelo upstream. Ex.: `{"claude-3-5-sonnet-20241022":"gpt-4o"}`. |
| `DIRECT_ANTHROPIC` | `false` | Se `true`, encaminha Anthropic → Anthropic sem converter. |
| `ANTHROPIC_URL` | `https://api.anthropic.com/v1/messages` | URL usada no modo direto. |
| `ANTHROPIC_API_KEY` | vazio | Chave usada como fallback no modo direto. |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Timeout configurável reservado para chamadas upstream. |

## Recursos suportados

- Conversão Anthropic Messages → OpenAI Chat Completions.
- Conversão Anthropic Messages → OpenAI Responses API (`TARGET_API=responses`).
- Respostas não-streaming.
- Streaming SSE Chat Completions → Anthropic SSE.
- Tools/function calls, `tool_choice`, tool results e preenchimento de tool results ausentes.
- `thinking`/`reasoning_content` e preservação de assinatura quando upstream fornece.
- Fallback de `thought_signature` para Gemini.
- Prompt caching via `cache_control` em blocos `system` e `text`.
- Blocos `image` base64/URL.
- Blocos `document` convertidos para partes textuais.
- `response_format` / structured outputs repassados ao upstream.
- Mapeamento de erros OpenAI para erro Anthropic.

## Exemplos

Modo Chat Completions:

```bash
PORT=8082 OMNIROUTE_URL=http://localhost:3000 npm start
```

Modo Responses API:

```bash
TARGET_API=responses TARGET_PATH=/v1/responses OMNIROUTE_URL=http://localhost:3000 npm start
```

Mapeamento de modelo:

```bash
MODEL_MAP='{"claude-3-5-sonnet-20241022":"gpt-4o"}' npm start
```

Modo Anthropic direto:

```bash
DIRECT_ANTHROPIC=true ANTHROPIC_API_KEY=sk-ant-... npm start
```

## Testes

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:legacy
```

`npm test` usa `node:test` e cobre tradutores, endpoints locais, mock upstream, SSE, count_tokens, model mapping e Responses API. `npm run test:legacy` executa o teste antigo de thought signatures.
