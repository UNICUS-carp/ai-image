// server.js (ESM版)
// Node 18 / Express / "type":"module" 前提
import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- CORS（必要なら origin を固定ドメインに変えてください）
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// ---- 環境変数
const PORT = process.env.PORT || 8080;
const PROVIDER = "google";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// ---- ユーティリティ
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- タイムアウト付き fetch
async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

// ---- Google画像生成（失敗時 throw）
async function generateImageWithGoogle(prompt) {
  if (!GEMINI_API_KEY) {
    const err = new Error("GEMINI_API_KEY is missing");
    err.code = "MISSING_GEMINI_KEY";
    throw err;
  }

  // Google 側の画像生成モデル名（環境により調整）
  const model = "imagen-3.0-generate";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImage?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const body = {
    prompt: { text: prompt },
  };

  const tries = 3;
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const start = Date.now();
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        120000
      );

      const elapsed = Date.now() - start;
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const err = new Error(`Google API error ${resp.status}`);
        err.status = resp.status;
        err.payload = text;
        throw err;
      }

      const json = await resp.json();
      const b64 =
        json?.images?.[0]?.image?.bytesBase64 ||
        json?.image?.bytesBase64 ||
        json?.candidates?.[0]?.content?.parts?.find((p) => p.inline_data)?.inline_data?.data;

      if (!b64) {
        const err = new Error("Google API returned no image data");
        err.status = 502;
        err.payload = JSON.stringify(json).slice(0, 1000);
        throw err;
      }

      return {
        dataUrl: `data:image/png;base64,${b64}`,
        elapsed,
        provider: "google",
      };
    } catch (e) {
      lastError = e;
      const retryable =
        e.name === "AbortError" ||
        e.code === "ECONNRESET" ||
        e.code === "ENOTFOUND" ||
        (typeof e.status === "number" && e.status >= 500);
      if (i < tries - 1 && retryable) {
        await sleep(300 * Math.pow(2, i));
        continue;
      }
      break;
    }
  }
  throw lastError || new Error("Unknown error on Google image generation");
}

// ---- フォールバック（プレースホルダ画像：青丸）
function placeholderPngDataUrl() {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <rect width="100%" height="100%" fill="#e5f1ff"/>
  <circle cx="512" cy="512" r="300" fill="#3b82f6"/>
</svg>`;
  const b64 = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

// ---- リクエスト簡易ログ
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const elapsed = Date.now() - start;
    console.log(`[req] ${req.method} ${req.path} ${res.statusCode} ${elapsed}ms`);
  });
  next();
});

// ---- 疎通用（clientToken風のダミーを返す）
app.post("/api/create-session", async (req, res) => {
  try {
    const userId = (req.body && req.body.userId) || "stage-user";
    const token = `ek_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    console.log("[create-session] ok user:", userId);
    res.json({ clientToken: token, provider: PROVIDER });
  } catch (e) {
    console.error("[create-session] fail", e);
    res.status(500).json({ error: "SESSION_FAILED" });
  }
});

// ---- 画像生成API
app.post("/api/generate-test-image", async (req, res) => {
  const start = Date.now();
  try {
    const prompt = (req.body && req.body.prompt) || "";
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 4) {
      return res.status(400).json({ error: "INVALID_PROMPT" });
    }

    try {
      const result = await generateImageWithGoogle(prompt);
      return res.json({
        dataUrl: result.dataUrl,
        elapsed: Date.now() - start,
        provider: result.provider,
      });
    } catch (apiErr) {
      console.error("[gen] google failed:", {
        msg: apiErr.message,
        status: apiErr.status,
        payload: apiErr.payload ? String(apiErr.payload).slice(0, 800) : undefined,
      });
      return res.json({
        dataUrl: placeholderPngDataUrl(),
        elapsed: Date.now() - start,
        provider: "placeholder",
        warning: apiErr.message || "google_failed",
      });
    }
  } catch (e) {
    console.error("[gen] fatal:", e);
    res.status(500).json({ error: "UNEXPECTED" });
  }
});

// ---- デバッグ
app.get("/debug/ip", async (_req, res) => {
  try {
    const r = await fetchWithTimeout("https://api64.ipify.org?format=json", {}, 8000);
    const j = await r.json();
    res.json({ ip: j });
  } catch {
    res.json({ ip: { ip: "unknown" } });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
