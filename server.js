// server.js (ESM)
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 8080;

// ===== 環境変数 =====
const PROVIDER = (process.env.PROVIDER || "google").toLowerCase(); // "google" 固定でOK
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const IMAGE_TIMEOUT_SECONDS = Number(process.env.IMAGE_TIMEOUT_SECONDS || 120);

// ===== ミドルウェア =====
app.use(express.json({ limit: "2mb" }));
app.use(cors()); // 既存サイトからのCORSを許可（必要なら origin 指定に変更）

// ルート健全性
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// 簡易デバッグ
app.get("/debug/ip", (req, res) => {
  res.json({ ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null });
});
app.get("/debug/openai-ping", async (_req, res) => {
  // 以前の疎通テストのダミー
  res.json({ ok: true, status: 200, bodySample: "{ mock ping }" });
});

// ===== セッション（ダミーでOK：clientTokenを返すだけ） =====
app.post("/api/create-session", async (req, res) => {
  try {
    console.log("[create-session] start");
    const userId = (req.body && req.body.userId) || "stage-user";
    // 実際のChatKitセッションは使わず、前回同様ダミートークンでOK
    const token = "ek_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(36);
    console.log("[create-session] success");
    res.json({ clientToken: token, userId });
  } catch (err) {
    console.error("[create-session] error", err);
    res.status(500).json({ error: "CHATKIT_SESSION_FAILED", detail: String(err) });
  }
});

// ===== 画像生成（Google優先、失敗時はSVGプレースホルダー） =====
app.post("/api/generate-test-image", async (req, res) => {
  const t0 = Date.now();
  try {
    const { prompt, provider } = req.body || {};
    console.log("[gen] start", { provider, promptLength: (prompt || "").length });

    // タイムアウト制御
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), IMAGE_TIMEOUT_SECONDS * 1000);

    // プロバイダは google 固定でOK（要件通り）
    let result = await generateWithGoogle(prompt, ac.signal);

    clearTimeout(timer);

    if (result.ok) {
      const elapsed = Date.now() - t0;
      return res.json({
        dataUrl: result.dataUrl, // PNG or SVG data URL
        elapsed,
        provider: result.provider,
        warning: result.warning || undefined,
      });
    } else {
      const elapsed = Date.now() - t0;
      console.warn("[gen] google failed:", result.error);
      // フォールバック：青い円SVG（以前もこれで通っていました）
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <rect width="100%" height="100%" fill="#e5f1ff"/>
  <circle cx="512" cy="512" r="300" fill="#3b82f6"/>
</svg>`;
      const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
      return res.json({
        dataUrl,
        elapsed,
        provider: "placeholder",
        warning: result.error?.msg || "Google API fallback",
      });
    }
  } catch (err) {
    console.error("[gen] error", err);
    res.status(500).json({ error: "UNEXPECTED", message: String(err) });
  }
});

// ====== Google 画像生成（シンプル版） ======
// ※ Google側の仕様変更やリージョン制約により404/429等が出た場合はそのままフォールバック
async function generateWithGoogle(prompt, signal) {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: { msg: "GEMINI_API_KEY missing" } };
  }
  const body = {
    // ここでは簡易なText-to-Imageエンドポイント想定（ベンダ側の更新で404になることも）
    // 実サービス接続は別途本実装で置換する前提
    prompt: prompt || "青い丸のシンプルなロゴ風イメージ",
    size: "1024x1024",
  };

  try {
    const resp = await fetch(
      // 参考用の仮URL（Googleのバージョン変更により404もありうる）:
      // v1beta/images:generate など、使用する実エンドポイントに合わせて差し替え
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-image-1:generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal,
      }
    );

    if (!resp.ok) {
      const txt = await safeText(resp);
      return { ok: false, error: { msg: `Google API error ${resp.status}`, status: resp.status, payload: txt } };
    }

    // 実データはプロバイダ仕様に依存。ここでは PNG base64 を想定。
    const data = await resp.json();
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;
    if (!b64) {
      return { ok: false, error: { msg: "Google API: no image in response" } };
    }
    const dataUrl = `data:image/png;base64,${b64}`;
    return { ok: true, dataUrl, provider: "google" };
  } catch (e) {
    if (e?.name === "AbortError") {
      return { ok: false, error: { msg: "Timeout" } };
    }
    return { ok: false, error: { msg: String(e) } };
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return undefined; }
}

// ===== サーバ起動 =====
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
