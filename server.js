// server.js — ChatKit用の「セッション発行API」最小版（Railway向け）
// 依存: express, cors（package.jsonに記載済み）
// 必要な環境変数: OPENAI_API_KEY, WORKFLOW_ID, ALLOWED_ORIGIN(optional)

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// CORS: フロント(ロリポップ)から呼べるようにする
const allowed = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowed }));

// 動作確認用
app.get("/", (_req, res) => {
  res.type("text/plain").send("illustauto-backend: ok");
});

// ChatKit セッション発行API
// フロントから POST /api/create-session を叩く → { clientToken } を返す想定
app.post("/api/create-session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;
    if (!apiKey || !workflowId) {
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    // ユーザー識別子（匿名・短命セッション想定）
    const userId = (req.body?.userId || "anon") + "-" + Math.random().toString(36).slice(2, 10);

    // ChatKitの「セッション作成」エンドポイントにサーバー側からリクエスト
    // ※ 注意：エンドポイント/ペイロード名は将来変更される可能性があります。
    // 公式ガイドの「ChatKitはサーバーで短命トークンを発行してクライアントへ渡す」
    // という要件に基づいた実装です。
    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_id: workflowId,   // ワークフローID（wf_...）
        user: { id: userId },      // 必要に応じてメタデータ追加
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("create-session failed:", resp.status, errText);
      return res.status(502).json({ error: "CHATKIT_SESSION_FAILED", detail: errText });
    }

    const data = await resp.json();
    // 期待する形: { client_secret: "..." } / { clientToken: "._
