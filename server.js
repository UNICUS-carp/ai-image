// server.js — ChatKit 用「セッション発行API」最小版（Railway向け）
import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// フロント（ロリポップ）から呼べるようCORS許可
const allowed = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowed }));

// 動作確認用
app.get("/", (_req, res) => {
  res.type("text/plain").send("illustauto-backend: ok");
});

// ChatKit セッション発行API
app.post("/api/create-session", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;

    if (!apiKey || !workflowId) {
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;

    // ChatKit のセッション作成（エンドポイント名は将来変更の可能性あり）
    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workflow_id: workflowId, // wf_...
        user: { id: userId },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("create-session failed:", resp.status, errText);
      return res.status(502).json({ error: "CHATKIT_SESSION_FAILED", detail: errText });
    }

    const data = await resp.json();
    const clientToken = data.client_secret || data.clientToken || data.token || null;

    if (!clientToken) {
      return res.status(502).json({ error: "TOKEN_MISSING", raw: data });
    }

    return res.json({ clientToken });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

// Railway が使用するポート
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
