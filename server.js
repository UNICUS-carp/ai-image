// server.js
// ランタイム: Node.js 18（CommonJS）
// 仕様: プロバイダは Google 固定。画像生成はまず Google を試行し、失敗時はプレースホルダPNGを返す。
// タイムアウト: 120秒。リトライ: 最大2回（指数バックオフ）。
// CORS: 任意オリジン許可（必要に応じてホワイトリスト化可能）。

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- CORS（必要なら origin を特定ドメインに調整）
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// ---- ログ（最低限）
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const elapsed = Date.now() - start;
    console.log(`[req] ${req.method} ${req.path} ${res.statusCode} ${elapsed}ms`);
  });
  next();
});

// ---- 環境変数
const PORT = process.env.PORT || 8080;
const PROVIDER = "google";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// ---- ユーティリティ: 待ち時間
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

// ---- リトライ付き: Google 画像生成（失敗時 throw）
async function generateImageWithGoogle(prompt) {
  if (!GEMINI_API_KEY) {
    const err = new Error("GEMINI_API_KEY is missing");
    err.code = "MISSING_GEMINI_KEY";
    throw err;
  }

  // Google AI Studio (Generative Language API) の images:generate 互換エンドポイント想定
  // 参考: https://ai.google.dev/api/rest/v1beta/images
  // モデル名は環境により異なるため、代表例を使用（必要に応じて差し替え）
  const model = "imagen-3.0-generate"; // 例: imagen-3.0-generate / imagen-2.0 / gemini-2.0-flash-exp など

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImage?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const body = {
    // text_prompt のみ利用（ベースの要件はフロントの prompt に含まれる前提）
    prompt: {
      text: prompt,
    },
    // 追加のヒント等が必要ならここに付与可能
    // safety_settings などは最小構成（必要に応じて拡張）
  };

  const tries = 3; // 1回 + 2リトライ
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const start = Date.now();
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
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
      // 期待レスポンス例（API進化により差異あり）:
      // {
      //   "images": [{ "image": { "bytesBase64": "..." } }]
      // }
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
      // ネットワーク・一時失敗のみリトライ
      const retryable =
        e.name === "AbortError" ||
        e.code === "ECONNRESET" ||
        e.code === "ENOTFOUND" ||
        (typeof e.status === "number" && e.status >= 500);
      if (i < tries - 1 && retryable) {
        await sleep(300 * Math.pow(2, i)); // 300ms, 600ms
        continue;
      }
      break;
    }
  }
  throw lastError || new Error("Unknown error on Google image generation");
}

// ---- フォールバック: プレースホルダ PNG（青丸）
function placeholderPngDataUrl() {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <rect width="100%" height="100%" fill="#e5f1ff"/>
  <circle cx="512" cy="512" r="300" fill="#3b82f6"/>
</svg>`;
  const b64 = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

// ---- 疎通: セッション風トークンを返す（UIの「clientToken 取得」用）
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

// ---- 画像生成: { prompt } を受け取り Google で生成、失敗時はプレースホルダ
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
      // フォールバック（UIが全滅しないよう最低限のプレースホルダ）
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
