// server.js — ChatKit セッション(OpenAI) + 画像生成（Google/OpenAI）
// Google側はモデル名で分岐：
//  - imagen-*           -> :predict
//  - gemini-*-image*    -> :generateContent（inlineData）
// どちらでもない場合はフォールバック（imagen-3.0-generate-002）
//
// 必要な環境変数（Railway Variables）
//  - ALLOWED_ORIGIN=https://<あなたのフロントのドメイン>（CORS制御。ローカル検証なら * でも可）
//  - PROVIDER=google | openai（未設定時は openai）
//  - GOOGLE_IMAGE_MODEL=gemini-2.5-flash-image など
//  - GEMINI_API_KEY=（Google AI Studio / Gemini API のキー）
//  - OPENAI_API_KEY=（OpenAI Images を使う時だけ必要）
//  - WORKFLOW_ID=（ChatKitセッションが必要な場合のみ）
//  - WORKFLOW_VERSION=（任意）
//  - PORT=8080（Railway は自動で設定）

import express from "express";
import cors from "cors";
import dns from "dns";

dns.setDefaultResultOrder("ipv4first");

const app = express();
app.use((req, _res, next) => { console.log(`[req] ${req.method} ${req.url}`); next(); });
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// ───────────── ヘルス
app.get("/", (_req, res) => res.type("text/plain").send("illustauto-backend: ok"));

// ───────────── 診断（OpenAI）
app.get("/debug/openai-ping", async (_req, res) => {
  try {
    const t0 = Date.now();
    const resp = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const elapsed = Date.now() - t0;
    const body = await resp.text().catch(() => "(no body)");
    res.json({ ok: resp.ok, status: resp.status, elapsed, bodySample: body.slice(0, 500) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ───────────── 診断（外向きIP）
app.get("/debug/ip", async (_req, res) => {
  try {
    const ip = await fetch("https://api.ipify.org?format=json").then(r => r.json());
    res.json({ ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ───────────── 設定の見える化
app.get("/debug/config", (_req, res) => {
  res.json({
    provider_env: process.env.PROVIDER || "(unset)",
    google_image_model_env: process.env.GOOGLE_IMAGE_MODEL || "(unset)",
    google_image_model_normalized: normalizeGoogleModel(process.env.GOOGLE_IMAGE_MODEL),
    has_gemini_key: Boolean(process.env.GEMINI_API_KEY),
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    allowed_origin: process.env.ALLOWED_ORIGIN || "*",
  });
});

// ───────────── Google: モデル一覧（見える化）
app.get("/debug/google-models", async (_req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: "GEMINI_API_KEY missing" });
    const t0 = Date.now();
    const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": key },
    });
    const elapsed = Date.now() - t0;
    const body = await resp.text();
    res.json({ ok: resp.ok, status: resp.status, elapsed, body });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ───────────── ChatKit セッション（OpenAI）
app.post("/api/create-session", async (req, res) => {
  console.log("[create-session] start");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const workflowId = process.env.WORKFLOW_ID;
    const workflowVersion = process.env.WORKFLOW_VERSION;
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
    const workflowObj = workflowVersion ? { id: workflowId, version: String(workflowVersion) } : { id: workflowId };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ user: userId, workflow: workflowObj }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      console.error("[create-session] failed:", resp.status, errText);
      return res.status(502).json({ error: "CHATKIT_SESSION_FAILED", detail: errText, status: resp.status });
    }

    const data = await resp.json().catch(() => ({}));
    const clientToken = data.client_secret || data.clientToken || data.token || null;
    if (!clientToken) return res.status(502).json({ error: "TOKEN_MISSING", raw: data });

    console.log("[create-session] success");
    return res.json({ clientToken });
  } catch (e) {
    console.error("[create-session] unexpected:", e);
    return res.status(500).json({ error: "UNEXPECTED", message: String(e) });
  }
});

// ───────────── 画像生成（OpenAI/Google）
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 60000);
const IMAGE_RETRIES = Number(process.env.IMAGE_RETRIES || 2); // 合計3回

function getProvider(req) {
  const p = (req.body?.provider || process.env.PROVIDER || "").toString().toLowerCase();
  if (p.startsWith("google")) return "google";
  return "openai";
}

function normalizeGoogleModel(envVal) {
  const model = (envVal || "").trim();
  if (!model) return "gemini-2.5-flash-image"; // デフォルト
  return model;
}

function isImagenModel(name) {
  return /^imagen-/i.test(name);
}
function isGeminiImageModel(name) {
  const n = name.toLowerCase();
  return n.includes("gemini") && n.includes("image");
}

// リトライユーティリティ
async function fetchWithRetries(doFetch, tryCount = IMAGE_RETRIES) {
  const start = Date.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= tryCount; attempt++) {
    const label = `attempt ${attempt + 1}/${tryCount + 1}`;
    try {
      console.log(`[gen] ${label} → calling provider`);
      const { ok, data, status, errText } = await doFetch(IMAGE_TIMEOUT_MS);
      if (ok) return { ok, data, attempt, elapsed: Date.now() - start };
      if (status && (status === 429 || (status >= 500 && status <= 599))) {
        console.warn(`[gen] ${label} transient ${status}: ${String(errText).slice(0, 200)}`);
        lastErr = new Error(`status ${status}`);
      } else {
        return { ok: false, status, errText, attempt, elapsed: Date.now() - start };
      }
    } catch (e) {
      console.warn(`[gen] ${label} error:`, e?.name || e);
      lastErr = e;
    }
    const backoff = attempt === 0 ? 0 : attempt === 1 ? 2000 : 5000;
    if (attempt < tryCount) {
      console.log(`[gen] waiting ${backoff}ms before retry...`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr || new Error("ALL_RETRIES_FAILED");
}

// OpenAI 実装
async function openaiGenerate(prompt, timeoutMs) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, errText: "SERVER_NOT_CONFIGURED (OPENAI_API_KEY)" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: process.env.IMAGE_MODEL || "gpt-image-1",
      prompt,
      size: "1024x1024",
    }),
    signal: controller.signal,
  }).catch(e => ({ __error: e }));

  clearTimeout(t);

  if (resp?.__error) return { ok: false, errText: String(resp.__error) };
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "(no body)");
    return { ok: false, status: resp.status, errText };
  }

  const data = await resp.json().catch(() => ({}));
  const url = data?.data?.[0]?.url || null;
  const b64 = data?.data?.[0]?.b64_json || null;
  if (url) return { ok: true, data: { url } };
  if (b64) return { ok: true, data: { dataUrl: `data:image/png;base64,${b64}` } };
  return { ok: false, status: 502, errText: "IMAGE_MISSING" };
}

// Google 実装（モデル名で分岐）
async function googleGenerate(prompt, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, errText: "SERVER_NOT_CONFIGURED (GEMINI_API_KEY)" };

  const model = normalizeGoogleModel(process.env.GOOGLE_IMAGE_MODEL);

  if (isImagenModel(model)) {
    // Imagen :predict
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1 },
      }),
      signal: controller.signal,
    }).catch(e => ({ __error: e }));

    clearTimeout(t);

    if (resp?.__error) return { ok: false, errText: String(resp.__error) };
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      return { ok: false, status: resp.status, errText };
    }

    const data = await resp.json().catch(() => ({}));
    const bytes =
      data?.predictions?.[0]?.generatedImages?.[0]?.image?.imageBytes ||
      data?.generatedImages?.[0]?.image?.imageBytes ||
      null;

    if (!bytes) return { ok: false, status: 502, errText: "IMAGE_MISSING (no imageBytes)" };
    return { ok: true, data: { dataUrl: `data:image/png;base64,${bytes}` } };
  }

  if (isGeminiImageModel(model)) {
    // Gemini image :generateContent（inlineData）
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // 画像で返す指定（inlineData）
        generationConfig: { responseMimeType: "image/png" }
      }),
      signal: controller.signal,
    }).catch(e => ({ __error: e }));

    clearTimeout(t);

    if (resp?.__error) return { ok: false, errText: String(resp.__error) };
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(no body)");
      return { ok: false, status: resp.status, errText };
    }

    const data = await resp.json().catch(() => ({}));
    // 代表ケース：candidates[0].content.parts[0].inlineData.data（base64）
    const part =
      data?.candidates?.[0]?.content?.parts?.find?.(p => p?.inlineData?.data) ||
      data?.candidates?.[0]?.content?.parts?.[0];

    const b64 = part?.inlineData?.data || null;
    if (!b64) return { ok: false, status: 502, errText: "IMAGE_MISSING (no inlineData)" };
    return { ok: true, data: { dataUrl: `data:image/png;base64,${b64}` } };
  }

  // フォールバック：Imagen 3
  return await googleGenerateWithModel(prompt, timeoutMs, "imagen-3.0-generate-002", apiKey);
}

async function googleGenerateWithModel(prompt, timeoutMs, model, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1 },
    }),
    signal: controller.signal,
  }).catch(e => ({ __error: e }));

  clearTimeout(t);

  if (resp?.__error) return { ok: false, errText: String(resp.__error) };
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "(no body)");
    return { ok: false, status: resp.status, errText };
  }

  const data = await resp.json().catch(() => ({}));
  const bytes =
    data?.predictions?.[0]?.generatedImages?.[0]?.image?.imageBytes ||
    data?.generatedImages?.[0]?.image?.imageBytes ||
    null;

  if (!bytes) return { ok: false, status: 502, errText: "IMAGE_MISSING (no imageBytes)" };
  return { ok: true, data: { dataUrl: `data:image/png;base64,${bytes}` } };
}

app.post("/api/generate-test-image", async (req, res) => {
  console.log("[gen] start");
  try {
    const prompt =
      typeof req.body?.prompt === "string" && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : "A simple blue circle icon on white background";

    const provider = getProvider(req); // "google" or "openai"
    const doFetch = async (timeoutMs) => {
      if (provider === "google") return await googleGenerate(prompt, timeoutMs);
      return await openaiGenerate(prompt, timeoutMs);
    };

    const { ok, data, status, errText, attempt, elapsed } = await fetchWithRetries(doFetch);

    if (!ok) {
      console.error("[gen] failed:", status, errText);
      return res
        .status(status || 502)
        .json({ error: "IMAGE_API_FAILED", detail: errText, status: status || 502, attempt: (attempt ?? 0) + 1, elapsed });
    }

    console.log(`[gen] success by ${provider} in ${elapsed}ms (attempt ${(attempt ?? 0) + 1})`);
    return res.json({ ...data, provider, elapsed, attempt: (attempt ?? 0) + 1 });
  } catch (e) {
    console.error("[gen] unexpected:", e);
    const msg = e?.name === "AbortError" ? "AbortError: timeout" : String(e?.message || e);
    return res.status(500).json({ error: "UNEXPECTED", message: msg });
  }
});

// ───────────── 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server listening on :${PORT}`));
