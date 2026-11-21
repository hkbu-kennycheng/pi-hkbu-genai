# pi-hkbu-genai

Use **HKBU GenAI** models (GPT-6, Gemini 3, Qwen 3, DeepSeek V4, Grok 4, Kimi K3, GLM 5) directly inside [Pi](https://github.com/earendil-works/pi).

`pi-hkbu-genai` gives you two ways to connect:

1. **HKBU SSO Sign-In (`hkbu-genai-web`)** — Sign in with your HKBU account in your browser. No API key needed, supports Pi's coding tools and image reading, and uses your HKBU GenAI web quota.
2. **HKBU GenAI API Key (`hkbu-genai`)** — Connect with an HKBU GenAI API key for native OpenAI tool calling, with built-in safeguards against gateway errors and rate limits.

---

## Install

```bash
pi install git:github.com/hkbu-kennycheng/pi-hkbu-genai
```

---

## Quick Start

### Option 1: Sign In with HKBU SSO (`hkbu-genai-web`)

1. Sign in via Pi:
   ```bash
   pi auth login hkbu-genai-web
   ```
   *(Or start `pi`, run `/login`, and choose **`hkbu-genai-web`**.)*
2. A Chrome window will open to `https://genai.hkbu.edu.hk`. Complete your HKBU SSO sign-in as usual — Pi automatically captures and saves your ~30-day session token.
3. Start Pi with any HKBU model:
   ```bash
   pi --provider hkbu-genai-web --model gpt-6-luna
   ```

> **Tip:** On a remote/SSH machine without Chrome, set `HKBU_GENAI_NO_BROWSER=1` before running `pi auth login hkbu-genai-web` (or set `HKBU_GENAI_WEB_TOKEN`). To enable HKBU's built-in Google web search in `hkbu-genai-web`, set `HKBU_GENAI_WEB_USE_GOOGLE=1`.

### Option 2: Use an HKBU GenAI API Key (`hkbu-genai`)

1. Set your API key in the `HKBU_GENAI_API_KEY` environment variable:
   ```bash
   export HKBU_GENAI_API_KEY="<YOUR_API_KEY>"
   ```
2. Start Pi:
   ```bash
   pi --provider hkbu-genai --model gpt-6.1-terra
   ```

> [!IMPORTANT]
> Never commit or share your API key or web session token.

---

## Available Models

You can use any of the following model IDs with either `--provider hkbu-genai-web` or `--provider hkbu-genai`:

| Model ID | Provider | Vision (Images) |
| --- | --- | --- |
| `gpt-6-luna` | Azure AI Foundry | Yes |
| `gpt-6.1-terra` | Azure AI Foundry | Yes |
| `gpt-6.1-sol` | Azure AI Foundry | Yes |
| `gpt-6-astra` | Azure AI Foundry | Yes |
| `gemini-3.8-flash` | Google Cloud | Yes |
| `gemini-3.1-pro-preview` | Google Cloud | Yes |
| `grok-4.7` | Azure AI Foundry | Text only |
| `qwen3.8-max` | Alibaba Cloud | Text only |
| `qwen3.7-plus` | Alibaba Cloud | Text only |
| `kimi-k3` | Alibaba Cloud | Text only |
| `glm-5.2` | Alibaba Cloud | Text only |
| `deepseek-v4.1-flash` | Azure AI Service | Text only |
| `deepSeek-V4-Pro-hkbu` | Microsoft Azure | Text only |

> **Note:** Model IDs are case-sensitive (for example, `deepSeek-V4-Pro-hkbu`).

---

## Helpful Tips

- **Check status & token expiry:** Run `/hkbu-status` inside Pi to see your active model, session ID, and when your `hkbu-genai-web` login expires.
- **Re-login after ~30 days:** When your HKBU web session expires, run `pi auth login hkbu-genai-web` (or `/login` in Pi) again.
- **Hit a quota limit?** If `hkbu-genai` reaches its monthly API cost cap (`COST_QUOTA_EXCEEDED`), switch to `--provider hkbu-genai-web`, or switch models (e.g., from `gpt-6-astra` to `gpt-6.1-terra` or `gpt-6-luna`).

---

## Developer & API Documentation

For local development, running unit tests, architecture details, direct cURL / Python / Node.js API usage, and troubleshooting, see [DEVELOPMENT.md](DEVELOPMENT.md).
