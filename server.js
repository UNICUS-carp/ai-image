// server.js — リクエスト可視化 & タイムアウト付き（Railway向け）
import express from "express";
import cors from "cors";

const app = express();

// 1) リクエストが来たことを必ずログに残す（最初に入れる）
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());

// CORS（ロリポップからも呼べる）
const allowed = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowed }));

// 健康チェック
app.get("/", (_req, res) => {
  res.type("text/plain").send("illustauto-backend: ok");
});

// デバッグ用：POSTが届くか確認（エコー）
app.post("/debug/echo", (req, res) => {
  console.log("[echo] body:", req.body);
  res.json({ ok: true, body: req.body ?? null });
});

// ChatKit セッション発行API
app.post("/api/create-session", async (req, res) => {
  console.log("[create-session] start");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;
    const workflowVersion = process.env.WORKFLOW_VERSION; // 任意

    if (!apiKey || !workflowId) {
      console.error("[cfg] missing env", { hasKey: !!apiKey, hasWorkflowId: !!workflowId });
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    // user は文字列で送る
    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;
    console.log("[create-session] userId:", userId);

    // ----------------------------------------------------------------
    // ChatKit 呼び出し（ヘッダー必須 & タイムアウト15秒）
    // ----------------------------------------------------------------
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "chatkit_beta=v1",
    };

    const workflowObj = workflowVersion
      ? { id: workflowId, version: String(workflowVersion) }
      : { id: workflowId };

    const body = { user: userId, workflow: workflowObj };
    console.log("[create-session] request headers:", headers);
    console.log("[create-session] request body:", body);

    // fetch にタイムアウトを付与
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch((e) => {
      console.error("[create-session] fetch error:", e);
      throw e;
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      console.error("[create-session] failed:", resp.status, errText);
      return res.status(502).json({ error: "CHATKIT_SESSION_FAILED", detail: errText, status: resp.status });
    }

    const data = await resp.json().catch(() => ({}));
    const clientToken = data.client_secret || data.clientToken || data.token || null;

    if (!clientToken) {
      console.error("[create-session] token missing:", data);
      return res.status(502).json({ error: "TOKEN_MISSING", raw: data });
    }

    console.log("[create-session] success");
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
