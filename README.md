# qwen-render-gateway

Small authenticated gateway that exposes a public Render URL in front of a private
Daytona-hosted Ollama instance. It provides an OpenAI-compatible `/v1` API, so
standard OpenAI SDKs and tools can use it by changing only the base URL.

```
Your application
      |
      | HTTPS + Bearer APP_API_KEY
      v
Render gateway (this project)
      |
      | HTTPS + Bearer DAYTONA_PROXY_KEY
      |       + x-daytona-preview-token
      v
Daytona :8080 Node proxy
      |
      | localhost
      v
127.0.0.1:11434 -> Ollama -> qwen3-4b-local
```

The Render service never talks to Ollama directly, and the Daytona proxy key and
preview token stay on the server side.

## Endpoints

| Method | Path                    | Auth                 | Description                    |
| ------ | ----------------------- | -------------------- | ------------------------------ |
| GET    | `/health`               | none                 | Liveness check                 |
| GET    | `/`                     | none                 | Service info                   |
| GET    | `/v1`                   | none                 | API info                       |
| GET    | `/v1/models`            | `Bearer APP_API_KEY` | List models                    |
| GET    | `/v1/models/{id}`       | `Bearer APP_API_KEY` | Get one model                  |
| POST   | `/v1/chat/completions`  | `Bearer APP_API_KEY` | OpenAI chat completions        |
| POST   | `/v1/completions`       | `Bearer APP_API_KEY` | OpenAI text completions        |
| POST   | `/api/chat`             | `Bearer APP_API_KEY` | Legacy raw passthrough         |

## OpenAI-compatible API

- Base URL: `https://YOUR-SERVICE.onrender.com/v1`
- Model: `qwen3-4b-local` (always used; the request `model` value is ignored)
- API key: your `APP_API_KEY`

Only one model is served, `n` must be 1, and tool calling, images, and audio are
not supported. The upstream response is generated without streaming; if the
caller sets `"stream": true`, the gateway converts that response into SSE chunks
and ends with `data: [DONE]`.

### curl

```bash
curl -s https://YOUR-SERVICE.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b-local",
    "messages": [{ "role": "user", "content": "Reply exactly: RENDER OK" }]
  }'
```

### Python (openai)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://YOUR-SERVICE.onrender.com/v1",
    api_key=APP_API_KEY,
)

reply = client.chat.completions.create(
    model="qwen3-4b-local",
    messages=[{"role": "user", "content": "Reply exactly: RENDER OK"}],
)
print(reply.choices[0].message.content)
```

### JavaScript (openai)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://YOUR-SERVICE.onrender.com/v1",
  apiKey: process.env.APP_API_KEY,
});

const reply = await client.chat.completions.create({
  model: "qwen3-4b-local",
  messages: [{ role: "user", content: "Reply exactly: RENDER OK" }],
});

console.log(reply.choices[0].message.content);
```

The gateway always sends `model: "qwen3-4b-local"`, `stream: false`, and
`think: false` to the Daytona proxy, so the upstream response is always complete.

Status codes:

- `200` success
- `400` invalid JSON, messages, prompt, or unsupported parameter
- `401` missing or wrong `APP_API_KEY`
- `404` unknown route or model
- `413` body larger than 1 MB
- `429` upstream rate limit
- `502` Daytona unreachable, upstream error, or invalid upstream response

## Environment variables

| Name                   | Required | Description                                              |
| ---------------------- | -------- | -------------------------------------------------------- |
| `DAYTONA_AI_URL`       | yes      | HTTPS base URL of the Daytona :8080 proxy                |
| `DAYTONA_PROXY_KEY`    | yes      | Bearer key for the Daytona proxy                         |
| `DAYTONA_PREVIEW_TOKEN`| yes      | Value for the `x-daytona-preview-token` header           |
| `APP_API_KEY`          | yes      | Bearer key callers must present to this gateway          |
| `PORT`                 | no       | Listen port; Render sets it automatically (default 10000)|

Use `.env.example` as a template. This gateway reads variables from the process
environment; it does not load `.env` automatically. For local runs, export the
variables or start with `node --env-file=.env server.mjs` (Node 20.6+). Never
commit `.env`.

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In the Render Dashboard: **New -> Web Service** and connect the repository.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
4. Add the four required environment variables under **Environment**
   (`DAYTONA_AI_URL`, `DAYTONA_PROXY_KEY`, `DAYTONA_PREVIEW_TOKEN`, `APP_API_KEY`).
   Do not set `PORT`; Render injects it.
5. Deploy and wait for the health check to pass.
6. Note the public base URL, for example
   `https://qwen-render-gateway.onrender.com`.

## Test

```bash
curl -s https://YOUR-SERVICE.onrender.com/health
curl -s https://YOUR-SERVICE.onrender.com/v1

curl -s https://YOUR-SERVICE.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-4b-local","messages":[{"role":"user","content":"Reply exactly: RENDER OK"}]}'
```

Expected OpenAI response:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "model": "qwen3-4b-local",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "RENDER OK" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 18, "completion_tokens": 3, "total_tokens": 21 }
}
```

The legacy `/api/chat` endpoint still returns the raw Ollama-shaped response:

```bash
curl -s -X POST https://YOUR-SERVICE.onrender.com/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply exactly: RENDER OK"}]}'
```

On Render's free tier the service sleeps when idle; the first request after a
pause can take 30-60 seconds while the instance and the Daytona backend wake up.

## Security notes

- `APP_API_KEY` is the public-facing credential. Call this gateway from a server
  or serverless function, never from browser JavaScript.
- `DAYTONA_PROXY_KEY` and `DAYTONA_PREVIEW_TOKEN` are backend-only. The preview
  token also grants sandbox-level access, so treat it as highly sensitive and
  store it only in Render's environment settings.
- If `APP_API_KEY` leaks, rotate it in Render and update your application.
- If the Daytona preview token rotates (for example after a sandbox restart),
  update `DAYTONA_PREVIEW_TOKEN` in Render.

## Local run

```bash
npm install
cp .env.example .env
# fill in .env, then:
node --env-file=.env server.mjs
```

`npm start` is intended for Render, where variables come from the service
environment.
