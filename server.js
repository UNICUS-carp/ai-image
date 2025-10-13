// server.js — ChatKit「セッション発行API」最小版（Railway向け）
// - 必須ヘッダー: OpenAI-Beta: chatkit_beta=v1
// - workflow 文字列/オブジェクト両対応（フォールバック）
// - Node v18 で動作（グローバル fetch 利用）
// - ポートは process.env.PORT || 3000（Railwayは8080で公開ドメインを作成済み）

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

const allowed = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowed }));

app.get("/", (_req, res) => {
  res.type("text/plain").send("illustauto-backend: ok");
});

app.post("/api/create-session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;

    if (!apiKey || !workflowId) {
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "chatkit_beta=v1",
    };

    // 1st attempt: workflow を「文字列」で送る
    const payloadString = {
      workflow: workflowId, // 例: "wf_..."
      user: { id: userId },
    };

    let resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(payloadString),
    });

    // 失敗したら 2nd attempt: workflow を「オブジェクト」で送る
    if (!resp.ok) {
      const errText1 = await resp.text();
      console.error("[create-session:first] status=", resp.status, "body=", errText1);

      const payloadObject = {
        workflow: { id: workflowId }, // 例: { id: "wf_..." }
        user: { id: userId },
      };

      resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify(payloadObject),
      });

      if (!resp.ok) {
        const errText2 = await resp.text();
        console.error("[create-session:second] status=", resp.status, "body=", errText2);
        return res.status(502).json({
          error: "CHATKIT_SESSION_FAILED",
          detail: errText2,
          tried: ["workflow:string", "workflow:object"],
        });
      }
    }

    const data = await resp.json();
    const clientToken = data.client_secret || data.clientToken || data.token || null;

    if (!clientToken) {
      console.error("[create-session] token missing. raw=", data);
      return res.status(502).json({ error: "TOKEN_MISSING", raw: data });
    }

    return res.json({ clientToken });
  } catch (e) {
    console.error("[create-session] unexpected:", e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
