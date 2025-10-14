// server.js (ESM: package.json に "type": "module" がある前提)
import express from "express";
import cors from "cors";

// ---- 環境変数
const PORT = process.env.PORT || 8080;

// 今は Google/Gemini を使わないプレースホルダ実装（課金/制限回避のため）
const PROVIDER = process.env.PROVIDER || "placeholder";

// ---- アプリ本体
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

// ① ヘルスチェック（ここがご質問の行です）
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// ② デバッグ用（任意）
app.get("/debug/ip", async (_req, res) => {
  try {
    const ip = _req.headers["x-forwarded-for"] || _req.socket.remoteAddress || "";
    res.json({ ip: { ip: Array.isArray(ip) ? ip[0] : ip } });
  } catch (e) {
    res.status(500).json({ error: "DEBUG_IP_FAILED" });
  }
});

// ③ セッション作成（ダミー）
app.post("/api/create-session", async (req, res) => {
  try {
    const userId = (req.body && req.body.userId) || "anonymous";
    // 実運用時は ChatKit/AgentKit のセッションをここで作成。
    // 今はテスト用のダミートークンを返すだけ。
    const clientToken = `ek_dummy_${userId}_${Date.now()}`;
    res.json({ clientToken });
  } catch (e) {
    res.status(500).json({ error: "SESSION_CREATE_FAILED", detail: String(e?.message || e) });
  }
});

// ④ 画像生成（プレースホルダ）
app.post("/api/generate-test-image", async (req, res) => {
  try {
    const prompt = (req.body && req.body.prompt) || "no prompt";
    // ここで本来は OpenAI/Gemini の画像APIを呼ぶ。
    // 今はプレースホルダのSVGを返す（青地に円）。
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <rect width="100%" height="100%" fill="#e5f1ff"/>
  <circle cx="512" cy="512" r="300" fill="#3b82f6"/>
</svg>`;
    const dataUrl =
      "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
    res.json({ dataUrl, elapsed: 120, provider: PROVIDER });
  } catch (e) {
    res.status(500).json({ error: "IMAGE_API_FAILED", detail: String(e?.message || e) });
  }
});

// ⑤（必要なら）他のAPIルートをここに追加…

// ⑥ サーバ起動（最後）
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
