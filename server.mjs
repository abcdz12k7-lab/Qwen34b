import http from "node:http";
import { timingSafeEqual } from "node:crypto";

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

const UPSTREAM_URL = `${DAYTONA_AI_URL.replace(/\/+$/, "")}/api/ai/chat`;
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120000;

function authorized(req) {
  const header = req.headers.authorization || "";
  const value = header.replace(/^Bearer\s+/i, "");
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

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "qwen-render-gateway"
    });
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    if (!authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    let incoming;

    try {
      const raw = await readBody(req);
      incoming = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      if (error.code === "PAYLOAD_TOO_LARGE") {
        return sendJson(res, 413, { error: "payload_too_large" });
      }

      return sendJson(res, 400, { error: "invalid_json" });
    }

    const payload = {
      model: "qwen3-4b-local",
      messages:
        incoming && Array.isArray(incoming.messages)
          ? incoming.messages
          : [],
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
      return sendJson(res, 502, { error: "ai_backend_unavailable" });
    }

    let body;

    try {
      body = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      console.error("Daytona response failed:", error.message);
      return sendJson(res, 502, { error: "ai_backend_unavailable" });
    }

    res.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") || "application/json",
      "Content-Length": body.length
    });

    return res.end(body);
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
