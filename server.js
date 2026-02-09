const express = require("express");
const cookieSession = require("cookie-session");
const path = require("path");

const app = express();

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || "lapine";
const SESSION_SECRET = process.env.SESSION_SECRET || "please-set-a-session-secret-lapine";
const OPENCLAW_GATEWAY_URL = (
  process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789"
).replace(/\/+$/, "");
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";
const CHAT_USER = process.env.CHAT_USER || "zhangting";
const CHAT_INSTRUCTIONS = process.env.CHAT_INSTRUCTIONS || "";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json({ limit: "25mb" }));
app.use(
  cookieSession({
    name: "session",
    keys: [SESSION_SECRET],
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: "lax",
    httpOnly: true,
  })
);

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(401).json({ error: "Not authenticated" });
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (password === CHAT_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid password" });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ---------------------------------------------------------------------------
// Chat proxy  –  streams SSE from OpenClaw back to the browser
// ---------------------------------------------------------------------------
app.post("/api/chat", requireAuth, async (req, res) => {
  const { input } = req.body;

  if (!input) {
    return res.status(400).json({ error: "Missing input" });
  }

  const openclawBody = {
    model: `openclaw:${OPENCLAW_AGENT_ID}`,
    stream: true,
    input,
    user: CHAT_USER,
    instructions: CHAT_INSTRUCTIONS
      ? `You are talking to ${CHAT_USER}. ${CHAT_INSTRUCTIONS}`
      : `You are talking to ${CHAT_USER}`,
  };

  try {
    const upstream = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OPENCLAW_GATEWAY_TOKEN
          ? { Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(openclawBody),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error("OpenClaw upstream error:", upstream.status, text);

      let errorMsg = `Upstream error: ${upstream.status}`;
      if (upstream.status === 405) {
        errorMsg =
          "OpenClaw Gateway returned 405 — the /v1/responses endpoint is likely disabled. " +
          'Enable it in your OpenClaw config: gateway.http.endpoints.responses.enabled = true';
      } else if (upstream.status === 401) {
        errorMsg = "OpenClaw Gateway rejected the token — check OPENCLAW_GATEWAY_TOKEN.";
      }

      return res.status(502).json({ error: errorMsg, detail: text });
    }

    // Pipe SSE back to the browser
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } catch (streamErr) {
      console.error("Stream read error:", streamErr);
    } finally {
      res.end();
    }
  } catch (err) {
    console.error("Chat proxy error:", err);
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to reach OpenClaw Gateway" });
    } else {
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// Fallback – serve index.html for SPA
// ---------------------------------------------------------------------------
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Webchat server running on http://localhost:${PORT}`);
});
