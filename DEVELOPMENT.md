# Developer & API Reference (`pi-hkbu-genai`)

Technical documentation for developing `pi-hkbu-genai` and integrating directly with the Hong Kong Baptist University (HKBU) GenAI API gateways (`/api/v1` and `/api/v0`).

For general end-user installation and usage instructions in Pi, see [README.md](README.md).

---

## Project Structure & Local Development

- `extensions/hkbu-genai.ts` — Pi extension entrypoint registering both `hkbu-genai` (`/api/v1`) and `hkbu-genai-web` (`/api/v0`), hooks, and `/hkbu-status`.
- `lib/hkbu-genai-helpers.ts` — `/api/v1` Akamai WAF preflight guards, output sanitization/truncation, context compaction, payload normalization, and `403`/`400`/`429`/stream-drop diagnostics.
- `lib/hkbu-genai-web.ts` — `/api/v0/general/chat/completions` adapter (Pi 1.5 `TranscriptContext` extraction, hybrid `chat_session_id` reuse/rotation, prompt-emulated tool calling, inline `<think>` stream parsing, 2-step `/api/v0/general/chat/uploads` image uploads, JWT expiry inspection).
- `lib/hkbu-genai-web-auth.ts` — Hybrid browser SSO OAuth flow (local Chromium CDP capture via Node's built-in `WebSocket` with manual paste fallback).
- `test/hkbu-genai.test.ts` & `test/hkbu-genai-web.test.ts` — Node test suite (`node --test`).

### Run Locally & Test

```bash
git clone https://github.com/hkbu-kennycheng/pi-hkbu-genai.git
cd pi-hkbu-genai
npm test

# Try extension without installing globally
pi -e . --provider hkbu-genai --model gpt-6.1-terra
pi -e . --provider hkbu-genai-web --model gpt-6-luna
```

### Debug & Configuration Environment Variables

| Variable | Provider | Description |
| --- | --- | --- |
| `HKBU_GENAI_API_KEY` (or `OPENAI_API_KEY`) | `hkbu-genai` | Bearer API key for `https://genai.hkbu.edu.hk/api/v1`. |
| `HKBU_GENAI_WEB_TOKEN` | `hkbu-genai-web` | Bearer JWT for `https://genai.hkbu.edu.hk/api/v0/general/chat/completions` (alternative to `/login`). |
| `HKBU_GENAI_CHROME_PATH` | `hkbu-genai-web` | Custom Chromium/Chrome/Brave/Edge executable path for CDP SSO login. |
| `HKBU_GENAI_NO_BROWSER=1` | `hkbu-genai-web` | Skip launching Chrome during `/login` and prompt to paste the Bearer JWT manually. |
| `HKBU_GENAI_WEB_USE_GOOGLE=1` | `hkbu-genai-web` | Enable HKBU's built-in hosted web search (`useGoogle: true`). |
| `HKBU_GENAI_WEB_DEBUG=1` | `hkbu-genai-web` | Log per-turn diagnostics (tool count, session reuse, upload count, instruction/prompt lengths) to `stderr`. |

---

## Architecture Notes

### 1. `hkbu-genai` (`/api/v1` OpenAI-Compatible Provider)

Built to avoid Akamai `403`, backend `400`, `429` retry/quota pitfalls, and transient stream drops in long-running agentic tasks:

1. **Uses `/chat/completions` (`openai-completions`) instead of `/responses` (`openai-responses`):**
   - Akamai WAF blocks shell commands/code inside `/responses` `function_call_output.output` and string `input`, whereas `/chat/completions` `messages[*].content` (including `role: "tool"`) allows standard command outputs.
   - Avoids `"OpenAI Responses stream ended before a terminal response event"`.
2. **Prevents `403` from `tool_calls[].function.arguments` and large tool outputs / doc reads:**
   - Steers the agent toward structured tools (`read`, `ls`, `find`, `grep`, `edit`, `write`) and direct MCP tools (`mcp__*`), advising against wrapping `tools.read` or verbose `JSON.stringify` dumps inside `codemode` and blocking `;`, `&&`, `||`, HTML/CSS/script tags (`<script`, `<style`, `<html`, `<!doctype`), large heredocs, `eval(`, and `alert(` inside `bash`/`codemode` arguments before execution.
   - Compacts completed `write` and `edit` `tool_calls[].function.arguments` payloads (> `350` chars or containing HTML/CSS/script patterns) into concise path/byte summaries on history replay (while leaving files written cleanly on disk).
   - Strips ANSI codes and bounds every text tool output (`codemode`: `3.5 KB` / `45` lines, `read`: `3.5 KB` / `36` lines, `bash`: `6 KB` / `100` lines, MCP & other tools: `5 KB` / `90` lines), saves full logs locally under `/tmp/pi-hkbu-genai/`, and omits command/`codemode`/`mcp__*` lines containing `<script`, `eval(`, or `alert(`.
   - Automatically unbricks sessions on `403`/`400` via `turn_end` `context_edit` + `context` cleanup across active projected entries (`event.context.contextEntries`), compacting older large `toolResult` and `toolCall` entries even across `continue` turns and never un-omitting previously omitted entries.
3. **Prevents `400` errors across all 13 chat models:**
   - Sets `supportsStrictMode: false`, `supportsOpenAIGrammarTools: false`, `supportsMidConvoSystemMessages: false`, `promptCacheKeyMode: "disabled"`, and strips `strict` from function tool schemas (`400 'additionalProperties' is required`).
   - Enforces a `max_completion_tokens` floor of `256` and deletes `content-encoding` headers (`gzip` requests fail with `400`).
   - Normalizes cross-model `tool_calls` when switching models mid-session (shortens Gemini's ~600-char `call_gctx_v1_...` IDs for Azure/GPT models to prevent `400 string too long`, and folds non-Gemini `tool_calls` to text for Gemini models to prevent `400 missing a thought_signature`).
   - Keeps at most the 2 most recent `toolResult` messages verbatim (within a `6500`-char combined recent-window budget via `recentToolResultBudgetChars`), compacts older `toolResult` messages (`600` chars), and drops orphaned `toolResult` / `tool_calls` entries.
4. **Rate-limit & stream-drop handling:**
   - Serializes concurrent in-process requests per model, honors `Retry-After` / `retryAfterSeconds` once when slots are in flight (`MODEL_DAILY_QUOTA_IN_FLIGHT`), skips pointless retry waits on hard daily exhaustion (`used >= limit && reserved === 0`) or account-wide monthly cost cap (`COST_QUOTA_EXCEEDED`), and retries pre-content stream drops up to 2 times inside `streamSimple`.

### 2. `hkbu-genai-web` (`/api/v0/general/chat/completions` Web-Chat Provider)

Targets HKBU GenAI's NestJS web-chat backend (`https://genai.hkbu.edu.hk/api/v0/general/chat/completions`, `x-upstream: aiuf_backend`) using the ~30-day NextAuth Bearer JWT (separate quota pool from `/api/v1` API keys):

1. **Non-OpenAI Request Translation & Hybrid Sessions:**
   - Extracts Pi 1.5 `role: "system"` `sections`, `toolsAdded`, and `toolsRemoved` (as well as legacy `systemPrompt`/`tools`) into `instructions`.
   - Omits `chat_session_id` on turn 1 to create a conversation, captures `conversation_uuid`, and reuses it with delta-only prompts on subsequent turns.
   - Automatically rotates to a fresh session with serialized transcript on model switches (because `/api/v0` locks `model` per `chat_session_id`), Pi context compaction/rewind (detected via prefix fingerprint), or `404 Conversation not found`.
2. **Full Prompt-Emulated Tool Calling:**
   - Because `/api/v0/general/chat/completions` ignores OpenAI `tools`, the adapter injects a compact JSON tool-calling protocol into `instructions` (instructing reasoning models to emit calls after closing their reasoning block), formats Pi `toolResult` messages as structured tool-result blocks, and parses streamed tool calls into native Pi `toolCall` events (`stopReason: "toolUse"`).
3. **Automatic Image Uploads (Vision):**
   - Extracts `PNG`, `JPEG`, `WEBP`, and `TIFF` image blocks from user messages and tool results (such as `read` on image files or computer-use screenshots).
   - Uploads them via the 2-step `/api/v0/general/chat/uploads` flow:
     1. `POST /api/v0/general/chat/uploads` with `{ filename, mimeType, size }` -> `{ id, uploadToken }`
     2. `PUT /api/v0/general/chat/uploads/{id}/content` with `x-upload-token` and `multipart/form-data` (`file`)
   - Attaches the resulting `uploadIds` alongside a fresh `idempotency-key` header (required by the backend whenever `uploadIds` is non-empty). Text/code files stay inline in `prompt` because code extensions (`.ts`, `.json`, `.md`) are rejected by `/chat/uploads` and text uploads add ~636 prompt tokens of overhead.
4. **Browser SSO OAuth Capture:**
   - Launches local Chrome/Chromium/Brave/Edge with `--remote-debugging-port=0` and a reusable `~/.pi/agent/hkbu-chrome-profile` directory opened to `https://genai.hkbu.edu.hk`.
   - Connects to the browser's CDP WebSocket via Node's built-in `WebSocket`, attaches to page targets, and captures the Bearer JWT from `Network.requestWillBeSent` (`Authorization: Bearer ...`) or `/api/auth/session` polling.
   - Saves `{ access, refresh, expires }` into `~/.pi/agent/auth.json` and falls back to a manual paste prompt when no Chromium browser is available or `HKBU_GENAI_NO_BROWSER=1` is set.
5. **Stream Normalization & Guard Scoping:**
   - Parses inline reasoning blocks into Pi thinking events, ignores non-OpenAI `tool_status` frames, decodes the JWT `exp` claim locally to fail fast when expired, and is excluded from `/api/v1`-only Akamai WAF preflight blocks (`isHkbuEndpointModel` returns `false` for `hkbu-genai-web`).

> **Tip for Computer Use (Paseo / Pi):** If you use `open-computer-use`, configure it as a local stdio MCP server (`"open-computer-use": { "command": "open-computer-use", "args": ["mcp"] }`) inside `~/.pi/agent/mcp.json` so Pi calls direct MCP tools instead of loading large CLI documentation into context.

---

## HKBU GenAI `/api/v1` Direct API Reference

- **Base URL:** `https://genai.hkbu.edu.hk/api/v1`
- **Protocol:** OpenAI-compatible REST API (JSON + Server-Sent Events for streaming)
- **Authentication:** `Authorization: Bearer <YOUR_API_KEY>` (Azure-style `api-key` headers return `401 invalid_api_key`).

### Supported Endpoints (`/api/v1`)

| Method | Endpoint | Description | Status |
| --- | --- | --- | --- |
| `GET` | `/models` | List all available models | Supported |
| `GET` | `/models/{model}` | Retrieve metadata for a specific model | Supported |
| `POST` | `/chat/completions` | Create chat completions (supports `stream: true`) | Supported |
| `POST` | `/responses` | OpenAI Responses API (`input`, `max_output_tokens`) | Supported |
| `POST` | `/embeddings` | Generate vector embeddings | Supported |
| `POST` | `/completions`, `/images/generations`, `/audio/transcriptions` | Legacy completions, images, audio | Not supported (`404`) |
| `GET` | `/moderations`, `/files`, `/batches` | Moderation, files, and batch endpoints | Not supported (`404`) |

### Embedding Models (`/api/v1`)

| Model ID | Provider (`owned_by`) | Notes |
| --- | --- | --- |
| `text-embedding-3-large` | Azure OpenAI | High-dimensional text embeddings |
| `text-embedding-3-small` | Azure OpenAI | 1536-dimensional embeddings |

### Direct Usage Examples

#### cURL

```bash
export OPENAI_API_KEY="<YOUR_API_KEY>"
export OPENAI_BASE_URL="https://genai.hkbu.edu.hk/api/v1"

# List models
curl -sS "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# Chat completions
curl -sS "$OPENAI_BASE_URL/chat/completions" \
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

# Streaming chat completions (SSE)
curl -sS -N "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "Write a haiku about Hong Kong."}],
    "max_tokens": 256,
    "stream": true
  }'

# Responses API
curl -sS "$OPENAI_BASE_URL/responses" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "input": "Summarize the purpose of unit testing in two bullet points.",
    "max_output_tokens": 256
  }'

# Embeddings
curl -sS "$OPENAI_BASE_URL/embeddings" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "Hong Kong Baptist University"
  }'
```

#### Python (`openai` SDK)

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.environ.get("OPENAI_BASE_URL", "https://genai.hkbu.edu.hk/api/v1"),
)

chat_resp = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
    max_tokens=256,
)
print(chat_resp.choices[0].message.content)
```

#### Node.js / TypeScript (`openai` SDK)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL ?? "https://genai.hkbu.edu.hk/api/v1",
});

const completion = await client.chat.completions.create({
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "Hello from Node.js!" }],
  max_tokens: 256,
});
console.log(completion.choices[0]?.message?.content);
```

### Other OpenAI-Compatible Tools & IDEs

Any client supporting custom OpenAI `/v1` endpoints (OpenAI Codex CLI, Cline, Continue, Cursor, LiteLLM, LangChain) can use:

- **Base URL:** `https://genai.hkbu.edu.hk/api/v1`
- **API Key:** `$OPENAI_API_KEY`
- **Model:** Any model ID from `GET /models`

---

## Response Metadata & Troubleshooting

### Diagnostic Headers & Usage Fields

- **Headers:** `x-request-id`, `x-chat-run-id`, `Retry-After`
- **Usage details:** `prompt_tokens_details` (`cached_tokens`, `cache_write_tokens`), `completion_tokens_details` (`reasoning_tokens`), `quota_used_percent_threshold`

### Common Errors

- **Akamai WAF `403 Access Denied` (`Server: AkamaiGHost`, `Denied Reason: WP`):**
  - `/api/v1/responses` blocks shell/code patterns in `function_call.arguments`, `function_call_output.output`, and plain string `input`. Prefer `/api/v1/chat/completions`.
  - On `/api/v1/chat/completions`, Akamai blocks `;`, `&&`, `||`, `alert(...)`, `eval(...)`, and `<script...>` inside `tool_calls[].function.arguments` and `<script...>` / `eval(...)` inside `messages[].content`.
  - If a session receives `403`, prune the offending turn from history or contact HKBU ITO (`hotline@hkbu.edu.hk`) with the `Reference Code`.
- **Very small `max_tokens` values:** Some models (e.g., `gemini-3.8-flash`) stop with `"finish_reason": "length"` and empty text if `max_tokens` is set too low (e.g., `16`). Use `256` or higher.
- **`401 invalid_api_key`:** Use `Authorization: Bearer <YOUR_API_KEY>` (not `api-key`), and note that web JWTs only work on `/api/v0`, not `/api/v1`.
- **`400 invalid_parameter` / schema / cross-model errors:** Omit `strict: true` unless every object schema sets `"additionalProperties": false`, avoid `Content-Encoding: gzip`, and adapt/fold `tool_calls` IDs when switching between Gemini and GPT models.
- **`429 Too Many Requests` (`MODEL_DAILY_QUOTA_IN_FLIGHT` / `COST_QUOTA_EXCEEDED`):** Honor `Retry-After` when slots are in flight (`gpt-6-astra` enforces an account-wide `limit: 3` quota with `Retry-After: 15`), or switch to `hkbu-genai-web` / another model when hard daily or monthly cost limits are reached.
- **Upstream stream drops (`Provider stream ended before completion.` / `other side closed`):** Handled automatically with pre-content retries inside `streamSimple`.
