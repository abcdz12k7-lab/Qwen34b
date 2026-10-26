# qwen-render-gateway

Small authenticated gateway that exposes a public Render URL in front of a private
Daytona-hosted Ollama instance.

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

| Method | Path        | Auth                    | Description                    |
| ------ | ----------- | ----------------------- | ------------------------------ |
| GET    | `/health`   | none                    | Liveness check                 |
| POST   | `/api/chat` | `Bearer APP_API_KEY`    | Forwards a chat request        |

`POST /api/chat` accepts:

```json
{
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

The gateway always forces `model: "qwen3-4b-local"`, `stream: false`, and
`think: false`. Only `messages` is taken from the request body.

Status codes:

- `200` upstream response
- `400` invalid JSON body
- `401` missing or wrong `APP_API_KEY`
- `404` unknown route
- `413` body larger than 1 MB
- `502` Daytona unreachable or upstream response failed

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

curl -s -X POST https://YOUR-SERVICE.onrender.com/api/chat \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply exactly: RENDER OK"}]}'
```

Expected chat response (from Ollama):

```json
{
  "model": "qwen3-4b-local",
  "message": { "role": "assistant", "content": "RENDER OK" },
  "done": true
}
```

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
