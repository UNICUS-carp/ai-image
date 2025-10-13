// server.js — ChatKit「セッション発行API」最小版（確定版）
// 要求仕様（あなたのログから確定）:
//   - headers: "OpenAI-Beta": "chatkit_beta=v1" 必須
//   - body: { workflow: { id: "wf_..." }, user: "<string>" }

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
      console.error("[cfg] missing env", { hasKey: !!apiKey, hasWorkflowId: !!workflowId });
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    // user は string で送る（ログで要求が確定）
    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "chatkit_beta=v1",
    };

    const body = {
      workflow: { id: workflowId },   // ← object で送る（{ id: wf_... }）
      user: userId,                    // ← string で送る（"..."）
    };

    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[session] fail", resp.status, errText);
      return res.status(502).json({ error: "CHATKIT_SESSION_FAILED", detail: errText });
    }

    const data = await resp.json();
    const clientToken = data.client_secret || data.clientToken || data.token || null;
    if (!clientToken) {
      console.error("[session] token missing", data);
      return res.status(502).json({ error: "TOKEN_MISSING", raw: data });
    }

    return res.json({ clientToken });
  } catch (e) {
    console.error("[session] unexpected", e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
