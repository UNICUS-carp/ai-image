// server.js — ChatKit「セッション発行API」最小版（Railway向け・フォールバック強化版）
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

    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;
    console.log("[session] start", { workflowId, userId });

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "chatkit_beta=v1",
    };
    console.log("[session] headers", headers);

    const endpoint = "https://api.openai.com/v1/chatkit/sessions";

    // 送信候補（順番に試す）
    const candidates = [
      { note: "workflow:string", body: { workflow: workflowId, user: { id: userId } } },
      { note: "workflow:object_id", body: { workflow: { id: workflowId }, user: { id: userId } } },
      { note: "workflow:object_id_version", body: { workflow: { id: workflowId, version: "1" }, user: { id: userId } } },
      { note: "workflow_id:string (legacy)", body: { workflow_id: workflowId, user: { id: userId } } },
    ];

    let lastErrText = "";
    for (const cand of candidates) {
      console.log("[session] try", cand.note, cand.body);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(cand.body),
      });

      if (resp.ok) {
        const data = await resp.json();
        const clientToken = data.client_secret || data.clientToken || data.token || null;
        if (!clientToken) {
          console.error("[session] token missing", data);
          return res.status(502).json({ error: "TOKEN_MISSING", raw: data, used: cand.note });
        }
        console.log("[session] success with", cand.note);
        return res.json({ clientToken, used: cand.note });
      }

      const errText = await resp.text();
      lastErrText = errText;
      console.error("[session] fail", cand.note, resp.status, errText);
    }

    return res.status(502).json({
      error: "CHATKIT_SESSION_FAILED",
      detail: lastErrText,
      tried: candidates.map(c => c.note),
    });
  } catch (e) {
    console.error("[session] unexpected", e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
