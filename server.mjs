import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 10000);

const DAYTONA_AI_URL = process.env.DAYTONA_AI_URL;
const DAYTONA_PROXY_KEY = process.env.DAYTONA_PROXY_KEY;
const DAYTONA_PREVIEW_TOKEN = process.env.DAYTONA_PREVIEW_TOKEN;
const APP_API_KEY = process.env.APP_API_KEY;

if (
  !DAYTONA_AI_URL ||
  !DAYTONA_PROXY_KEY ||
  !DAYTONA_PREVIEW_TOKEN ||
  !APP_API_KEY
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const MODEL_ID = "qwen3-4b-local";
const UPSTREAM_URL = `${DAYTONA_AI_URL.replace(/\/+$/, "")}/api/ai/chat`;
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no"
};

function authorized(req) {
  const header = req.headers.authorization || "";
  const value = header.replace(/^Bearer\s+/i, "").trim();
  const given = Buffer.from(value);
  const expected = Buffer.from(APP_API_KEY);

  return (
    given.length === expected.length &&
    timingSafeEqual(given, expected)
  );
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

function sendOpenAIError(
  res,
  status,
  message,
  code = null,
  type = "invalid_request_error",
  param = null
) {
  return sendJson(res, status, {
    error: {
      message,
      type,
      param,
      code
    }
  });
}

function modelObject() {
  return {
    id: MODEL_ID,
    object: "model",
    created: 0,
    owned_by: "daytona"
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      const error = new Error("payload too large");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);

  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    const error = new Error("invalid json");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }

  const normalized = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = typeof message.role === "string" ? message.role : "user";
    let content = "";

    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (part && typeof part.text === "string") {
            return part.text;
          }

          return "";
        })
        .join("");
    } else if (message.content != null) {
      content = String(message.content);
    }

    normalized.push({ role, content });
  }

  return normalized;
}

async function callUpstream(messages) {
  const payload = {
    model: MODEL_ID,
    messages,
    stream: false,
    think: false
  };

  let upstream;

  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DAYTONA_PROXY_KEY}`,
        "x-daytona-preview-token": DAYTONA_PREVIEW_TOKEN
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    console.error("Daytona connection failed:", error.message);
    const wrapped = new Error("ai backend unavailable");
    wrapped.code = "UPSTREAM_UNAVAILABLE";
    throw wrapped;
  }

  let body;

  try {
    body = Buffer.from(await upstream.arrayBuffer());
  } catch (error) {
    console.error("Daytona response failed:", error.message);
    const wrapped = new Error("ai backend unavailable");
    wrapped.code = "UPSTREAM_UNAVAILABLE";
    throw wrapped;
  }

  return {
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "application/json",
    body
  };
}

function parseUpstream(result) {
  if (result.status < 200 || result.status >= 300) {
    return null;
  }

  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch {
    return null;
  }
}

function extractContent(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (data.message && typeof data.message.content === "string") {
    return data.message.content;
  }

  if (typeof data.response === "string") {
    return data.response;
  }

  if (typeof data.content === "string") {
    return data.content;
  }

  if (typeof data.text === "string") {
    return data.text;
  }

  if (Array.isArray(data.choices) && data.choices[0]) {
    const choice = data.choices[0];

    if (choice.message && typeof choice.message.content === "string") {
      return choice.message.content;
    }

    if (typeof choice.text === "string") {
      return choice.text;
    }
  }

  return null;
}

function estimateTokens(text) {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(String(text).length / 4));
}

function usageFrom(data, messages, content) {
  const promptTokens = Number.isFinite(data?.prompt_eval_count)
    ? data.prompt_eval_count
    : estimateTokens(JSON.stringify(messages));
  const completionTokens = Number.isFinite(data?.eval_count)
    ? data.eval_count
    : estimateTokens(content);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
}

function completionId(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function upstreamFailure(res, result) {
  console.error(`Upstream request failed with status ${result.status}`);

  if (result.status === 429) {
    return sendOpenAIError(
      res,
      429,
      "AI backend rate limit reached",
      "rate_limit_exceeded",
      "rate_limit_error"
    );
  }

  if (result.status >= 400 && result.status < 500) {
    return sendOpenAIError(
      res,
      400,
      `AI backend rejected the request (${result.status})`,
      "upstream_request_error"
    );
  }

  return sendOpenAIError(
    res,
    502,
    "AI backend unavailable",
    "upstream_unavailable",
    "api_error"
  );
}

function sendChatStream(res, { id, created, content, usage, includeUsage }) {
  res.writeHead(200, SSE_HEADERS);

  const base = {
    id,
    object: "chat.completion.chunk",
    created,
    model: MODEL_ID
  };

  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null
        }
      ]
    })}\n\n`
  );

  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null
        }
      ]
    })}\n\n`
  );

  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    })}\n\n`
  );

  if (includeUsage) {
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [],
        usage
      })}\n\n`
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function sendCompletionStream(res, { id, created, content, usage, includeUsage }) {
  res.writeHead(200, SSE_HEADERS);

  const base = {
    id,
    object: "text_completion",
    created,
    model: MODEL_ID
  };

  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          text: content,
          index: 0,
          logprobs: null,
          finish_reason: null
        }
      ]
    })}\n\n`
  );

  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [
        {
          text: "",
          index: 0,
          logprobs: null,
          finish_reason: "stop"
        }
      ]
    })}\n\n`
  );

  if (includeUsage) {
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [],
        usage
      })}\n\n`
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  let path = url.pathname;

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "qwen-render-gateway",
      openai_compatible: true,
      model: MODEL_ID
    });
  }

  if (req.method === "GET" && path === "/") {
    return sendJson(res, 200, {
      service: "qwen-render-gateway",
      openai_base: "/v1",
      model: MODEL_ID
    });
  }

  if (req.method === "GET" && path === "/v1") {
    return sendJson(res, 200, {
      object: "api",
      service: "qwen-render-gateway",
      model: MODEL_ID,
      openai_base: "/v1",
      endpoints: {
        models: "/v1/models",
        chat_completions: "/v1/chat/completions",
        completions: "/v1/completions"
      }
    });
  }

  if (req.method === "POST" && path === "/api/chat") {
    if (!authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    let incoming;

    try {
      incoming = await readJson(req);
    } catch (error) {
      if (error.code === "PAYLOAD_TOO_LARGE") {
        return sendJson(res, 413, { error: "payload_too_large" });
      }

      return sendJson(res, 400, { error: "invalid_json" });
    }

    const messages =
      incoming && Array.isArray(incoming.messages)
        ? incoming.messages
        : [];

    let result;

    try {
      result = await callUpstream(messages);
    } catch {
      return sendJson(res, 502, { error: "ai_backend_unavailable" });
    }

    res.writeHead(result.status, {
      "Content-Type": result.contentType,
      "Content-Length": result.body.length
    });

    return res.end(result.body);
  }

  if (req.method === "GET" && path === "/v1/models") {
    if (!authorized(req)) {
      return sendOpenAIError(
        res,
        401,
        "Invalid API key",
        "invalid_api_key"
      );
    }

    return sendJson(res, 200, {
      object: "list",
      data: [modelObject()]
    });
  }

  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    if (!authorized(req)) {
      return sendOpenAIError(
        res,
        401,
        "Invalid API key",
        "invalid_api_key"
      );
    }

    let id;

    try {
      id = decodeURIComponent(path.slice("/v1/models/".length));
    } catch {
      return sendOpenAIError(
        res,
        400,
        "Invalid model id",
        "invalid_model_id"
      );
    }

    if (id === MODEL_ID) {
      return sendJson(res, 200, modelObject());
    }

    return sendOpenAIError(
      res,
      404,
      `The model '${id}' does not exist`,
      "model_not_found"
    );
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    if (!authorized(req)) {
      return sendOpenAIError(
        res,
        401,
        "Invalid API key",
        "invalid_api_key"
      );
    }

    let incoming;

    try {
      incoming = await readJson(req);
    } catch (error) {
      if (error.code === "PAYLOAD_TOO_LARGE") {
        return sendOpenAIError(
          res,
          413,
          "Request body too large",
          "payload_too_large"
        );
      }

      return sendOpenAIError(res, 400, "Invalid JSON body", "invalid_json");
    }

    if (Number.isInteger(incoming?.n) && incoming.n > 1) {
      return sendOpenAIError(
        res,
        400,
        "Only n=1 is supported",
        "unsupported_parameter",
        "invalid_request_error",
        "n"
      );
    }

    const messages = normalizeMessages(incoming?.messages);

    if (!messages || messages.length === 0) {
      return sendOpenAIError(
        res,
        400,
        "'messages' must be a non-empty array",
        "invalid_messages",
        "invalid_request_error",
        "messages"
      );
    }

    let result;

    try {
      result = await callUpstream(messages);
    } catch {
      return sendOpenAIError(
        res,
        502,
        "AI backend unavailable",
        "upstream_unavailable",
        "api_error"
      );
    }

    if (result.status < 200 || result.status >= 300) {
      return upstreamFailure(res, result);
    }

    const data = parseUpstream(result);
    const content = extractContent(data);

    if (!data || content === null) {
      return sendOpenAIError(
        res,
        502,
        "AI backend returned an invalid response",
        "invalid_upstream_response",
        "api_error"
      );
    }

    const id = completionId("chatcmpl");
    const created = Math.floor(Date.now() / 1000);
    const usage = usageFrom(data, messages, content);

    if (incoming.stream === true) {
      return sendChatStream(res, {
        id,
        created,
        content,
        usage,
        includeUsage: incoming.stream_options?.include_usage === true
      });
    }

    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content
          },
          logprobs: null,
          finish_reason: "stop"
        }
      ],
      usage
    });
  }

  if (req.method === "POST" && path === "/v1/completions") {
    if (!authorized(req)) {
      return sendOpenAIError(
        res,
        401,
        "Invalid API key",
        "invalid_api_key"
      );
    }

    let incoming;

    try {
      incoming = await readJson(req);
    } catch (error) {
      if (error.code === "PAYLOAD_TOO_LARGE") {
        return sendOpenAIError(
          res,
          413,
          "Request body too large",
          "payload_too_large"
        );
      }

      return sendOpenAIError(res, 400, "Invalid JSON body", "invalid_json");
    }

    if (Number.isInteger(incoming?.n) && incoming.n > 1) {
      return sendOpenAIError(
        res,
        400,
        "Only n=1 is supported",
        "unsupported_parameter",
        "invalid_request_error",
        "n"
      );
    }

    let prompt = incoming?.prompt;

    if (Array.isArray(prompt)) {
      if (!prompt.every((item) => typeof item === "string")) {
        return sendOpenAIError(
          res,
          400,
          "'prompt' must be a string or an array of strings",
          "invalid_prompt",
          "invalid_request_error",
          "prompt"
        );
      }

      prompt = prompt.join("\n");
    }

    if (typeof prompt !== "string" || prompt.length === 0) {
      return sendOpenAIError(
        res,
        400,
        "'prompt' must be a non-empty string",
        "invalid_prompt",
        "invalid_request_error",
        "prompt"
      );
    }

    const messages = [{ role: "user", content: prompt }];

    let result;

    try {
      result = await callUpstream(messages);
    } catch {
      return sendOpenAIError(
        res,
        502,
        "AI backend unavailable",
        "upstream_unavailable",
        "api_error"
      );
    }

    if (result.status < 200 || result.status >= 300) {
      return upstreamFailure(res, result);
    }

    const data = parseUpstream(result);
    const content = extractContent(data);

    if (!data || content === null) {
      return sendOpenAIError(
        res,
        502,
        "AI backend returned an invalid response",
        "invalid_upstream_response",
        "api_error"
      );
    }

    const id = completionId("cmpl");
    const created = Math.floor(Date.now() / 1000);
    const usage = usageFrom(data, messages, content);

    if (incoming.stream === true) {
      return sendCompletionStream(res, {
        id,
        created,
        content,
        usage,
        includeUsage: incoming.stream_options?.include_usage === true
      });
    }

    return sendJson(res, 200, {
      id,
      object: "text_completion",
      created,
      model: MODEL_ID,
      choices: [
        {
          text: content,
          index: 0,
          logprobs: null,
          finish_reason: "stop"
        }
      ],
      usage
    });
  }

  if (path.startsWith("/v1/")) {
    return sendOpenAIError(res, 404, "Not found", "not_found");
  }

  return sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI gateway listening on 0.0.0.0:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
