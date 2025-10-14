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
// === ここから下を server.js の一番最後に丸ごと貼り付け ===
app.get("/ui", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Illustauto テストUI（同一オリジン）</title>
  <style>
    body{font-family:system-ui;-apple-system,'Segoe UI',Roboto,'Noto Sans JP',sans-serif;margin:0;padding:24px;background:#f8fafc}
    .wrap{max-width:980px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.08);padding:24px}
    h1{margin:0 0 8px;font-size:22px}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:8px 0}
    textarea{width:100%;min-height:140px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;font:14px system-ui}
    button{appearance:none;border:0;border-radius:10px;padding:10px 14px;background:#0ea5e9;color:#fff;font-weight:600;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    .status{margin-top:12px;padding:12px 14px;border-radius:8px;background:#eff6ff;color:#1e3a8a;white-space:pre-wrap;font:14px/1.6 system-ui}
    .ok{background:#ecfdf5;color:#065f46}.error{background:#fef2f2;color:#991b1b}
    .imgbox{margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
    .card{border:1px solid #e2e8f0;border-radius:12px;padding:10px;background:#fff;display:flex;flex-direction:column}
    img.preview{width:100%;height:auto;border-radius:8px;display:block}
    .actions{display:flex;gap:8px;margin-top:10px}
    a.btn-dl{display:inline-block;background:#10b981;color:#fff;padding:8px 12px;border-radius:8px;text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Illustauto テストUI</h1>
    <p>このページは <code>/ui</code> で配信されています（バックエンドと同一オリジン）。</p>

    <div class="row">
      <button id="btnToken">clientToken 取得</button>
      <span id="statusToken" class="status">待機中…</span>
    </div>

    <div class="row">
      <textarea id="article"># サンプル記事タイトル

これはサンプル本文です。本文の長さに応じて自動で画像を1〜5枚を生成します。</textarea>
    </div>

    <div class="row">
      <button id="btnGenerate">画像生成（1枚テスト）</button>
    </div>
    <div id="statusGen" class="status">待機中…</div>

    <div id="gallery" class="imgbox"></div>
  </div>

  <script>
    const BACKEND = location.origin; // 同一オリジンなのでCORS不要
    const $btnToken = document.getElementById("btnToken");
    const $statusToken = document.getElementById("statusToken");
    const $btnGenerate = document.getElementById("btnGenerate");
    const $statusGen = document.getElementById("statusGen");
    const $article = document.getElementById("article");
    const $gallery = document.getElementById("gallery");

    $btnToken.addEventListener("click", async () => {
      $btnToken.disabled = true;
      $statusToken.className = "status";
      $statusToken.textContent = "接続中…";
      try {
        const r = await fetch(BACKEND + "/api/create-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: "stage-user" })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.clientToken) {
          $statusToken.classList.add("ok");
          $statusToken.textContent = "接続OK：clientToken 取得に成功";
          console.log("[clientToken]", data.clientToken);
        } else {
          $statusToken.classList.add("error");
          $statusToken.textContent = "エラー：clientToken なし\n" + JSON.stringify(data);
        }
      } catch (e) {
        $statusToken.classList.add("error");
        $statusToken.textContent = "接続エラー：" + String(e);
      } finally {
        $btnToken.disabled = false;
      }
    });

    $btnGenerate.addEventListener("click", async () => {
      $btnGenerate.disabled = true;
      $statusGen.className = "status";
      $statusGen.textContent = "生成中…";
      try {
        const prompt = [
          "【要件】次の文の内容に具体的に対応した、写真画質のリアルな1枚を生成してください。",
          "・画像に文字・記号・看板文字・透かしは禁止。",
          "・人物が登場する場合は日本人として自然な容姿。",
          "",
          "【具体内容】",
          ($article.value || "秋の公園で準備運動をするランナーの股関節ケアの様子。")
        ].join("\\n");

        const r = await fetch(BACKEND + "/api/generate-test-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, provider: "google" })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && (data.dataUrl || data.url)) {
          const src = data.dataUrl || data.url;
          const card = document.createElement("div");
          card.className = "card";
          const img = new Image();
          img.className = "preview";
          img.src = src;
          const a = document.createElement("a");
          a.className = "btn-dl";
          a.href = src;
          a.download = \`illustauto_\${Date.now()}.png\`;
          a.textContent = "ダウンロード";
          const actions = document.createElement("div");
          actions.className = "actions";
          actions.appendChild(a);
          card.appendChild(img);
          card.appendChild(actions);
          $gallery.prepend(card);
          $statusGen.classList.add("ok");
          $statusGen.textContent = "生成完了：1枚追加しました。";
        } else {
          $statusGen.classList.add("error");
          $statusGen.textContent = "生成エラー：" + JSON.stringify(data);
          console.error("[gen error]", data);
        }
      } catch (e) {
        $statusGen.classList.add("error");
        $statusGen.textContent = "生成エラー（通信）： " + String(e);
      } finally {
        $btnGenerate.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});
// === ここまで貼り付け ===
