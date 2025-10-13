// server.js — ChatKit「セッション発行API」最小版（Railway向け・確定版）
// 要件（あなたのログと公式の挙動から確定）:
//   - ヘッダー: "OpenAI-Beta": "chatkit_beta=v1" 必須
//   - ボディ: { workflow: { id: "wf_..." }, user: "<string>" }
//   - Node v18 の fetch を使用
//   - Railway は :8080 で公開（app は process.env.PORT || 3000 で待受。現在ログ上 :8080 で起動OK）

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// CORS: ロリポップ（unicus.top）からの呼び出しを許可
const allowed = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowed }));

// 動作確認
app.get("/", (_req, res) => {
  res.type("text/plain").send("illustauto-backend: ok");
});

// ChatKit セッション発行API
app.post("/api/create-session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;
    const workflowVersion = process.env.WORKFLOW_VERSION; // 任意: 指定したい場合のみ

    if (!apiKey || !workflowId) {
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    // user は「文字列」を要求されるため、文字列で生成
    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;

    // 必須ヘッダー
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "chatkit_beta=v1",
    };

    // workflow は「オブジェクト」で送る（必須: id / 任意: version）
    const workflowObj = workflowVersion
      ? { id: workflowId, version: String(workflowVersion) }
      : { id: workflowId };

    const body = {
      user: userId,          // ← 文字列
      workflow: workflowObj, // ← オブジェクト { id, (version) }
    };

    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[create-session] failed:", resp.status, errText);
      return res.status(502).json({ error: "CHATKIT_SESSION_FAILED", detail: errText });
    }

    const data = await resp.json();
    const clientToken = data.client_secret || data.clientToken || data.token || null;

    if (!clientToken) {
      console.error("[create-session] token missing:", data);
      return res.status(502).json({ error: "TOKEN_MISSING", raw: data });
    }

    return res.json({ clientToken });
  } catch (e) {
    console.error("[create-session] unexpected:", e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

// ポート
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
