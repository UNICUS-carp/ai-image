// server.js — ChatKit セッション + 画像生成テストAPI（URL返却・リトライ/60sタイムアウト対応）
import express from "express";
import cors from "cors";

const app = express();

// ───────────────────────── 共通
app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.url}`);
  next();
});
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

app.get("/", (_req, res) => res.type("text/plain").send("illustauto-backend: ok"));

app.post("/debug/echo", (req, res) => res.json({ ok: true, body: req.body ?? null }));

// ───────────────────────── ChatKit セッション
app.post("/api/create-session", async (req, res) => {
  console.log("[create-session] start");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;
    const workflowVersion = process.env.WORKFLOW_VERSION; // 任意
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
    const workflowObj = workflowVersion
      ? { id: workflowId, version: String(workflowVersion) }
      : { id: workflowId };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s で十分
    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ user: userId, workflow: workflowObj }),
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

// ───────────────────────── 画像生成（URL受取・60sタイムアウト＋リトライ）
const IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-1";
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 60000); // 60s
const IMAGE_RETRIES = Number(process.env.IMAGE_RETRIES || 2); // 追加リトライ回数（合計3回）

async function fetchWithRetries(init, tryCount = IMAGE_RETRIES) {
  const start = Date.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= tryCount; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

    const label = `attempt ${attempt + 1}/${tryCount + 1}`;
    try {
      console.log(`[gen] ${label} → calling Images API`);
      const resp = await fetch(IMAGE_ENDPOINT, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(t);

      if (resp.ok) return { resp, elapsed: Date.now() - start, attempt };

      // 429/5xx はリトライ
      if (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) {
        const body = await resp.text().catch(() => "(no body)");
        console.warn(`[gen] ${label} transient status ${resp.status}: ${body}`);
        lastErr = new Error(`status ${resp.status}`);
      } else {
        // それ以外は即終了
        const body = await resp.text().catch(() => "(no body)");
        return { resp, body, elapsed: Date.now() - start, attempt };
      }
    } catch (e) {
      clearTimeout(t);
      console.warn(`[gen] ${label} error:`, e?.name || e);
      lastErr = e;
    }

    // バックオフ（0s → 2s → 5s）
    const backoff = attempt === 0 ? 0 : attempt === 1 ? 2000 : 5000;
    if (attempt < tryCount) {
      console.log(`[gen] waiting ${backoff}ms before retry...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // すべて失敗
  throw lastErr || new Error("IMAGE_API_ALL_RETRIES_FAILED");
}

app.post("/api/generate-test-image", async (req, res) => {
  console.log("[gen] start");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SERVER_NOT_CONFIGURED" });

    const prompt =
      typeof req.body?.prompt === "string" && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : "A simple blue circle icon on white background";

    const init = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        size: "1024x1024",
        // response_format は指定しない：URL返却
      }),
    };

    const { resp, body, elapsed, attempt } = await fetchWithRetries(init);

    if (!resp.ok) {
      const errText = body ?? (await resp.text().catch(() => "(no body)"));
      console.error("[gen] failed (non-retryable):", resp.status, errText);
      return res
        .status(502)
        .json({ error: "IMAGE_API_FAILED", detail: errText, status: resp.status, attempt: attempt + 1, elapsed });
    }

    const data = await resp.json().catch(() => ({}));
    const url = data?.data?.[0]?.url || null;
    if (!url) {
      console.error("[gen] missing url in response:", data);
      return res.status(502).json({ error: "IMAGE_MISSING", raw: data, elapsed, attempt: attempt + 1 });
    }

    console.log(`[gen] success in ${elapsed}ms (attempt ${attempt + 1})`);
    return res.json({ url, elapsed, attempt: attempt + 1 });
  } catch (e) {
    console.error("[gen] unexpected:", e);
    const msg =
      e?.name === "AbortError"
        ? "AbortError: timeout"
        : String(e?.message || e);
    return res.status(500).json({ error: "UNEXPECTED", message: msg });
  }
});

// ───────────────────────── 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server listening on :${PORT}`));
