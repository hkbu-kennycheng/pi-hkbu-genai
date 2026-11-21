# HKBU GenAI API (OpenAI-Compatible Endpoint)

Documentation for integrating with the Hong Kong Baptist University (HKBU) GenAI OpenAI-compatible API gateway.

- **Base URL:** `https://genai.hkbu.edu.hk/api/v1`
- **Protocol:** OpenAI-compatible REST API (JSON + Server-Sent Events for streaming)
- **Authentication:** Bearer token (`Authorization: Bearer <YOUR_API_KEY>`)

> [!IMPORTANT]
> Never hardcode or commit your API key into source control or shared documentation. Store it in an environment variable (`OPENAI_API_KEY`) or a `.env` file excluded via `.gitignore`.

---

## Quick Setup

Export your API key and base URL as environment variables so standard OpenAI SDKs and compatible CLI tools pick them up automatically:

```bash
export OPENAI_API_KEY="<YOUR_API_KEY>"
export OPENAI_BASE_URL="https://genai.hkbu.edu.hk/api/v1"
```

### Authentication Notes

- Requests **must** authenticate using the standard `Authorization: Bearer <YOUR_API_KEY>` header.
- Azure-style `api-key: <YOUR_API_KEY>` headers are **not** accepted on `/api/v1` and return `401 invalid_api_key`.

---

## Supported Endpoints

| Method | Endpoint | Description | Status |
| --- | --- | --- | --- |
| `GET` | `/models` | List all available models | Supported |
| `GET` | `/models/{model}` | Retrieve metadata for a specific model | Supported |
| `POST` | `/chat/completions` | Create chat completions (supports `stream: true`) | Supported |
| `POST` | `/responses` | OpenAI Responses API (`input`, `max_output_tokens`) | Supported |
| `POST` | `/embeddings` | Generate vector embeddings | Supported |
| `POST` | `/completions` | Legacy text completions | Not supported (`404`) |
| `POST` | `/images/generations` | Image generation | Not supported (`404`) |
| `POST` | `/audio/transcriptions` | Audio transcription | Not supported (`404`) |
| `GET` | `/moderations`, `/files`, `/batches` | Moderation, files, and batch endpoints | Not supported (`404`) |

---

## Available Models

Models observed from `GET /api/v1/models` (query `GET /models` for the live list, as availability may change over time):

### Chat & Reasoning Models

| Model ID | Provider (`owned_by`) |
| --- | --- |
| `gpt-6-luna` | Microsoft Azure AI Foundry |
| `gpt-6.1-terra` | Microsoft Azure AI Foundry |
| `gpt-6.1-sol` | Microsoft Azure AI Foundry |
| `gpt-6-astra` | Microsoft Azure AI Foundry |
| `grok-4.7` | Microsoft Azure AI Foundry |
| `gemini-3.1-pro-preview` | Google Cloud Platform |
| `gemini-3.8-flash` | Google Cloud Platform |
| `kimi-k3` | Alibaba Cloud |
| `glm-5.2` | Alibaba Cloud |
| `qwen3.8-max` | Alibaba Cloud |
| `qwen3.7-plus` | Alibaba Cloud |
| `deepseek-v4.1-flash` | Microsoft Azure AI Service |
| `deepSeek-V4-Pro-hkbu` | Microsoft Azure |

> **Note:** Model IDs are case-sensitive (for example, `deepSeek-V4-Pro-hkbu`).

### Embedding Models

| Model ID | Provider (`owned_by`) | Notes |
| --- | --- | --- |
| `text-embedding-3-large` | Azure OpenAI | High-dimensional text embeddings |
| `text-embedding-3-small` | Azure OpenAI | 1536-dimensional embeddings |

---

## Usage Examples

### 1. cURL

#### List Models

```bash
curl -sS https://genai.hkbu.edu.hk/api/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

#### Chat Completions

```bash
curl -sS https://genai.hkbu.edu.hk/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain cosine similarity in one sentence."}
    ],
    "max_tokens": 256
  }'
```

#### Streaming Chat Completions (SSE)

```bash
curl -sS -N https://genai.hkbu.edu.hk/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [
      {"role": "user", "content": "Write a haiku about Hong Kong."}
    ],
    "max_tokens": 256,
    "stream": true
  }'
```

#### Responses API

```bash
curl -sS https://genai.hkbu.edu.hk/api/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "input": "Summarize the purpose of unit testing in two bullet points.",
    "max_output_tokens": 256
  }'
```

#### Embeddings

```bash
curl -sS https://genai.hkbu.edu.hk/api/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "Hong Kong Baptist University"
  }'
```

---

### 2. Python (`openai` SDK)

Install the official OpenAI Python package:

```bash
pip install openai
```

#### Chat, Streaming, Responses, and Embeddings

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.environ.get("OPENAI_BASE_URL", "https://genai.hkbu.edu.hk/api/v1"),
)

# 1. Chat Completion
chat_resp = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
    max_tokens=256,
)
print(chat_resp.choices[0].message.content)

# 2. Streaming Chat Completion
stream = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": "Count from 1 to 5."}],
    max_tokens=256,
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()

# 3. Responses API
resp = client.responses.create(
    model="gpt-6-luna",
    input="Give me one productivity tip.",
    max_output_tokens=256,
)
print(resp.output_text)

# 4. Embeddings
emb = client.embeddings.create(
    model="text-embedding-3-small",
    input="Vector search example",
)
print(f"Embedding dimensions: {len(emb.data[0].embedding)}")
```

---

### 3. Node.js / TypeScript (`openai` SDK)

Install the official OpenAI Node SDK:

```bash
npm install openai
```

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL ?? "https://genai.hkbu.edu.hk/api/v1",
});

async function main() {
  const completion = await client.chat.completions.create({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "Hello from Node.js!" }],
    max_tokens: 256,
  });

  console.log(completion.choices[0]?.message?.content);
}

main();
```

---

## Tool & IDE Integration

Because this gateway implements the standard OpenAI `/v1` schema, any client supporting custom OpenAI-compatible endpoints (such as Pi coding agent, OpenAI Codex CLI, Cline, Continue, Cursor, LiteLLM, or LangChain) can be configured with:

- **Base URL / Endpoint:** `https://genai.hkbu.edu.hk/api/v1`
- **API Key:** `$OPENAI_API_KEY` (or `$HKBU_GENAI_API_KEY` for the included Pi extension)
- **Model:** Any model ID from `GET /models` (e.g., `gpt-6-luna`, `gpt-6.1-terra`, `gemini-3.8-flash`, `qwen3.8-max`, `deepSeek-V4-Pro-hkbu`)

### Pi Coding Agent Extension (`pi-hkbu-genai`)

This repository is a [Pi](https://github.com/earendil-works/pi) package ([package.json](package.json), [extensions/hkbu-genai.ts](extensions/hkbu-genai.ts), [lib/hkbu-genai-helpers.ts](lib/hkbu-genai-helpers.ts), [lib/hkbu-genai-web.ts](lib/hkbu-genai-web.ts)) built specifically to avoid Akamai `403`, backend `400`, and `429` retry/quota pitfalls on `/api/v1`, and to provide a second provider (`hkbu-genai-web`) backed by the HKBU GenAI web-chat `/api/v0` endpoint.

#### Install from GitHub

```bash
# Install globally into Pi
pi install git:github.com/hkbu-kennycheng/pi-hkbu-genai
# (or using the full HTTPS URL)
pi install https://github.com/hkbu-kennycheng/pi-hkbu-genai

# Set your HKBU GenAI API key
export HKBU_GENAI_API_KEY="<YOUR_API_KEY>"

# Run Pi with the hkbu-genai provider
pi --provider hkbu-genai --model gpt-6.1-terra
```

#### Try Without Installing (or from Local Clone)

```bash
export HKBU_GENAI_API_KEY="<YOUR_API_KEY>"

# Try directly from GitHub
pi -e git:github.com/hkbu-kennycheng/pi-hkbu-genai --provider hkbu-genai --model gpt-6.1-terra

# Or clone and run locally / run unit tests
git clone https://github.com/hkbu-kennycheng/pi-hkbu-genai.git
cd pi-hkbu-genai
npm test
pi -e . --provider hkbu-genai --model gpt-6.1-terra
```

#### Second Provider: `hkbu-genai-web` (`/api/v0/general/chat/completions`)

`pi-hkbu-genai` also registers **`hkbu-genai-web`**, which connects to HKBU GenAI's web-chat backend (`https://genai.hkbu.edu.hk/api/v0/general/chat/completions`) using your ~30-day HKBU GenAI web Bearer JWT (separate quota pool from `/api/v1` API keys):

```bash
# Option 1: Browser SSO login (opens Chrome via CDP, captures JWT into ~/.pi/agent/auth.json)
# Run /login inside Pi and select hkbu-genai-web (or `pi auth login hkbu-genai-web` once installed)

# Option 2: Or pass the Bearer JWT directly via environment variable
export HKBU_GENAI_WEB_TOKEN="<YOUR_WEB_BEARER_JWT>"

pi -e . --provider hkbu-genai-web --model gpt-6-luna
```

Optional environment variables:

- `HKBU_GENAI_CHROME_PATH`: custom path to Chrome/Chromium/Brave/Edge for SSO login.
- `HKBU_GENAI_NO_BROWSER=1`: skip launching Chrome and prompt to paste the Bearer JWT manually.
- `HKBU_GENAI_WEB_USE_GOOGLE=1`: enables HKBU's built-in hosted web search (`useGoogle: true`).
- `HKBU_GENAI_WEB_DEBUG=1`: logs per-turn diagnostics (tool count, session reuse, upload count, instruction/prompt lengths) to `stderr`.

What `hkbu-genai-web` handles automatically:

1. **Non-OpenAI Request Translation & Hybrid Sessions:** Extracts Pi's system prompt and active tool definitions into `instructions`, omits `chat_session_id` on turn 1 to create a conversation, reuses the returned `conversation_uuid` with delta-only prompts on subsequent turns, and automatically rotates to a fresh session with serialized history on model switches (since `/api/v0` locks `model` per session), context compaction/rewind, or `404 Conversation not found`.
2. **Full Prompt-Emulated Tool Calling:** Because `/api/v0/general/chat/completions` ignores OpenAI `tools`, the adapter injects a compact JSON tool-calling protocol into `instructions` (instructing reasoning models to emit calls in the final visible reply), formats Pi `toolResult` messages as structured tool-result blocks, and parses streamed tool calls into native Pi `toolCall` events (`stopReason: "toolUse"`).
3. **Automatic Image Uploads (Vision):** Extracts `PNG`, `JPEG`, `WEBP`, and `TIFF` image blocks from user messages and tool results (such as `read` on image files or computer-use screenshots), uploads them via the 2-step `/api/v0/general/chat/uploads` flow (`POST /chat/uploads` -> `PUT /chat/uploads/{id}/content` with `x-upload-token` and `multipart/form-data`), and attaches the resulting `uploadIds` alongside a fresh `idempotency-key`. Text and code tool outputs remain inline in `prompt` for speed and token efficiency.
4. **Streaming Normalization, Token Checks & Status:** Parses inline reasoning blocks into Pi thinking events, ignores non-OpenAI `tool_status` frames, decodes the JWT `exp` claim locally to fail fast with a clear message when expired, skips `/api/v1`-only Akamai WAF preflight blocks, and reports session UUID and token expiry via `/hkbu-status`.

What the extension configures and guards against (`hkbu-genai` / `/api/v1`):

1. **Uses `/chat/completions` (`openai-completions`) instead of `/responses` (`openai-responses`):**
   - Akamai WAF blocks shell commands/code inside `/responses` `function_call_output.output` and string `input`, whereas `/chat/completions` `messages[*].content` (including `role: "tool"`) allows standard command outputs.
   - Avoids `"OpenAI Responses stream ended before a terminal response event"`.
2. **Prevents `403` from `tool_calls[].function.arguments` and large tool outputs / doc reads:**
   - Steers the agent toward structured tools (`read`, `ls`, `find`, `grep`, `edit`, `write`) and direct MCP tools (`mcp__*`), advising against wrapping `tools.read` or verbose `JSON.stringify` dumps inside `codemode` and blocking `;`, `&&`, `||`, HTML/CSS/script tags (`<script`, `<style`, `<html`, `<!doctype`), large heredocs, `eval(`, and `alert(` inside `bash`/`codemode` arguments before execution.
   - Compacts completed `write` and `edit` `tool_calls[].function.arguments` payloads (> `350` chars or containing HTML/CSS/script patterns) into concise path/byte summaries on history replay (while leaving the files written cleanly on disk), preventing Akamai WAF `403` when agents generate HTML, CSS, or multi-KB JS/code files.
   - Strips ANSI codes and bounds every text tool output (`codemode`: `3.5 KB` / `45` lines, `read`: `3.5 KB` / `36` lines, `bash`: `6 KB` / `100` lines, MCP & other tools: `5 KB` / `90` lines), saves full logs locally under `/tmp/pi-hkbu-genai/`, and transparently omits command/`codemode`/`mcp__*` lines containing `<script`, `eval(`, or `alert(`.
   - Automatically unbricks sessions on `403`/`400` via `turn_end` `context_edit` + `context` cleanup across active projected entries (`event.context.contextEntries`), compacting older large `toolResult` and `toolCall` entries even across `continue` turns and never un-omitting previously omitted entries.
3. **Prevents `400` errors across all 13 chat models:**
   - Sets `supportsStrictMode: false`, `supportsOpenAIGrammarTools: false`, `supportsMidConvoSystemMessages: false`, `promptCacheKeyMode: "disabled"`, and strips `strict` from function tool schemas (`400 'additionalProperties' is required`).
   - Enforces a `max_completion_tokens` floor of `256` and deletes `content-encoding` headers (`gzip` requests fail with `400`).
   - Normalizes cross-model `tool_calls` when switching models mid-session (shortens Gemini's ~600-char `call_gctx_v1_...` IDs for Azure/GPT models to prevent `400 string too long`, and folds non-Gemini `tool_calls` to text for Gemini models to prevent `400 missing a thought_signature`).
   - Keeps at most the 2 most recent `toolResult` messages verbatim (within a `6500`-char combined recent-window budget via `recentToolResultBudgetChars`), compacts older `toolResult` messages (`600` chars) to avoid cumulative WAF scoring shifts, and drops orphaned `toolResult` / `tool_calls` entries so `403`/`400` recovery never causes `No tool call found for function call output`.

> **Tip for Computer Use (Paseo / Pi):** If you use `open-computer-use`, configure it as a local stdio MCP server (`"open-computer-use": { "command": "open-computer-use", "args": ["mcp"] }`) inside `~/.pi/agent/mcp.json`. Giving Pi direct MCP tools avoids falling back to CLI/JS-REPL docs (`usage.md`), which otherwise pull large code-heavy documentation into conversation history.

---

## Response Metadata, Token Limits, and Troubleshooting

### Response Headers & Usage Details

- **Diagnostic Headers:** Responses expose `x-request-id`, `x-chat-run-id`, and `Retry-After` (useful when debugging issues or handling rate limits).
- **Usage Payload:** Responses include standard token counts plus:
  - `prompt_tokens_details`: `cached_tokens`, `cache_write_tokens`
  - `completion_tokens_details`: `reasoning_tokens`
  - `quota_used_percent_threshold`: quota threshold indicator (may be `null`)

### Practical Tips & Common Errors

- **Akamai WAF `403 Access Denied` (`Server: AkamaiGHost`, `Denied Reason: WP`):**
  - `genai.hkbu.edu.hk` is fronted by Akamai WAF (`edgesuite.net`).
  - `/api/v1/responses` blocks shell/code patterns in `function_call.arguments`, `function_call_output.output`, and plain string `input`. Prefer `/api/v1/chat/completions`.
  - On `/api/v1/chat/completions`, Akamai still blocks `;`, `&&`, `||`, `alert(...)`, `eval(...)`, and `<script...>` inside `tool_calls[].function.arguments`, and `<script...>` / `eval(...)` inside `messages[].content`.
  - If an agentic session receives `403`, remove or prune the offending `toolCall`/`toolResult` turn from history (otherwise every subsequent turn re-sends it and keeps hitting `403`), or contact HKBU ITO (`hotline@hkbu.edu.hk`) with the `Reference Code` from the block page.
- **Very small `max_tokens` values:** Some models (such as `gemini-3.8-flash`) may stop with `"finish_reason": "length"` and empty text if `max_tokens` is set too low (e.g., `16`). Use a larger budget (e.g., `256` or higher) for normal completions.
- **`401 invalid_api_key`:** Ensure you pass `Authorization: Bearer <YOUR_API_KEY>` rather than an `api-key` header, and verify your key is active.
- **`400 invalid_parameter` / schema / cross-model errors:**
  - Ensure `strict: true` is omitted unless every object schema sets `"additionalProperties": false`.
  - Do not send `Content-Encoding: gzip` (the backend rejects compressed JSON bodies with `400`).
  - When switching between Gemini and GPT models in the same transcript, adapt or fold `tool_calls` IDs (`call_gctx_v1_...` exceeds GPT's 64-char `call_id` limit, while Gemini rejects `tool_calls` lacking a `call_gctx_` thought signature).
- **`404 Not Found`:** Returned if calling unsupported OpenAI routes such as `/completions`, `/images/generations`, `/audio/transcriptions`, `/files`, `/batches`, or `/moderations`.
- **`429 Too Many Requests` (`rate_limit_error` / `MODEL_DAILY_QUOTA_IN_FLIGHT` / `COST_QUOTA_EXCEEDED`):** Honor `Retry-After` / `retryAfterSeconds` once when slots are in flight (`gpt-6-astra` enforces a strict account-wide `limit: 3` quota with `Retry-After: 15`), serialize concurrent in-process requests per model, skip pointless retry waits on hard daily exhaustion (`used >= limit && reserved === 0`) or account-wide monthly cost cap (`COST_QUOTA_EXCEEDED` / `quota_exceeded`), and suggest model or provider fallback accordingly.
- **Upstream stream drops (`Provider stream ended before completion.` / `other side closed`):** Upstream HKBU streaming models (e.g., `gpt-6.1-sol`) occasionally terminate SSE streams before sending `finish_reason`. `pi-hkbu-genai` automatically retries pre-content stream drops up to 2 times inside `streamSimple`, normalizes mid-stream drop messages so Pi's outer retry handles them, and keeps session history clean if an error persists.
