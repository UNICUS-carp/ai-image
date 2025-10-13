// server.js — ChatKit セッション + 画像生成テストAPI（URL返却版・確定）
import express from "express";
import cors from "cors";

const app = express();

// リクエスト簡易ログ
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());

// CORS（ロリポップから呼べるよう許可）
const allowed = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowed }));

// ヘルスチェック
app.get("/", (_req, res) => {
  res.type("text/plain").send("illustauto-backend: ok");
});

// デバッグ用
app.post("/debug/echo", (req, res) => {
  console.log("[echo] body:", req.body);
  res.json({ ok: true, body: req.body ?? null });
});

// ChatKit: clientToken を発行
app.post("/api/create-session", async (req, res) => {
  console.log("[create-session] start");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;
    const workflowVersion = process.env.WORKFLOW_VERSION; // 任意
    if (!apiKey || !workflowId) {
      return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });
    }

    // user は「文字列」必須
    const baseUser = typeof req.body?.userId === "string" ? req.body.userId : "anon";
    const userId = `${baseUser}-${Math.random().toString(36).slice(2, 10)}`;

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "chatkit_beta=v1",
    };
    const workflowObj = workflowVersion
      ? { id: workflowId, version: String(workflowVersion) }
      : { id: workflowId };
    const body = { user: userId, workflow: workflowObj };

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

// 画像生成テストAPI（Images API は URL 返却で受け取る）
app.post("/api/generate-test-image", async (req, res) => {
  console.log("[gen] start");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });

    const prompt = typeof req.body?.prompt === "string" && req.body.prompt.trim()
      ? req.body.prompt.trim()
      : "A simple blue circle icon on white background";

    // 15秒タイムアウト
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024"
        // response_format は指定しない（URLが返る）
      }),
      signal: controller.signal,
    }).catch((e) => {
      console.error("[gen] fetch error:", e);
      throw e;
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      console.error("[gen] failed:", resp.status, errText);
      return res.status(502).json({ error: "IMAGE_API_FAILED", detail: errText, status: resp.status });
    }

    const data = await resp.json().catch(() => ({}));
    const url = data?.data?.[0]?.url || null;
    if (!url) {
      console.error("[gen] missing url in response:", data);
      return res.status(502).json({ error: "IMAGE_MISSING", raw: data });
    }

    console.log("[gen] success");
    return res.json({ url });
  } catch (e) {
    console.error("[gen] unexpected:", e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

// ポート
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`server listening on :${PORT}`);
});
