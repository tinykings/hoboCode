# OpenRouter Free Opencode Gateway

Runs a local OpenAI-compatible endpoint for Opencode. The gateway discovers
OpenRouter `:free` models, drops malformed or nonzero-priced entries, probes each
remaining model, ranks healthy models, and exposes one stable model:

```text
openrouter/free-auto
```

Requests to that synthetic model are forwarded to the highest-ranked healthy
free OpenRouter model. If the upstream model fails before a response is sent,
the gateway tries the next ranked model.

The current upstream model is printed only when it changes. It is also available
in `GET /health` as `current_model` and on successful completion responses as
the `x-openrouter-upstream-model` header.

## Requirements

- Node.js 24 or newer
- `OPENROUTER_API_KEY`

## Run

```bash
OPENROUTER_API_KEY=sk-or-... npm run dev
```

Optional settings:

```bash
PORT=4141
HOST=127.0.0.1
LOCAL_API_KEY=local-secret
REFRESH_INTERVAL_MS=1800000
PROBE_CONCURRENCY=4
PROBE_TIMEOUT_MS=10000
UPSTREAM_TIMEOUT_MS=120000
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
```

If `LOCAL_API_KEY` is set, Opencode must send that value as a bearer token.

## Opencode Config

Add a custom provider to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter-free-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter Free Local",
      "options": {
        "baseURL": "http://127.0.0.1:4141/v1",
        "apiKey": "{env:LOCAL_API_KEY}"
      },
      "models": {
        "openrouter/free-auto": {
          "name": "OpenRouter Free Auto"
        }
      }
    }
  }
}
```

If you are not using `LOCAL_API_KEY`, omit `options.apiKey`.

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

## Ranking

Healthy free models are ranked by:

1. `context_length` descending
2. unthrottled before throttled
3. `created` descending

Probe classification:

- HTTP `200`: healthy
- HTTP `429`: healthy-but-throttled
- any other response, fetch error, or timeout over 10 seconds: unhealthy
