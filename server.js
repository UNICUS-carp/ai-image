// server.js — ChatKit セッション(OpenAI) + 画像生成（Google/OpenAI）
// 重要: Google 画像モデルはアカウントによって使えるIDが違うため、models一覧から自動検出してフォールバックします。

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

// ───────────── 診断
app.post("/debug/echo", (req, res) => res.json({ ok: true, body: req.body ?? null }));

app.get("/debug/openai-ping", async (_req, res) => {
  try {
    const t0 = Date.now();
    const resp = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    const elapsed = Date.now() - t0;
    const txt = await resp.text().catch(() => "(no body)");
    res.json({ ok: resp.ok, status: resp.status, elapsed, bodySample: txt.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/debug/ip", async (_req, res) => {
  try {
    const ip = await fetch("https://api.ipify.org?format=json").then((r) => r.json());
    res.json({ ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Google: 利用可能モデルの生ダンプ
app.get("/debug/google-models", async (_req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "GEMINI_API_KEY not set" });
    const t0 = Date.now();
    const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
    });
    const txt = await resp.text().catch(() => "(no body)");
    res
      .status(resp.status)
      .type("application/json")
      .send(JSON.stringify({ ok: resp.ok, status: resp.status, elapsed: Date.now() - t0, body: txt }, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ───────────── ChatKit セッション（OpenAI）
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

// ───────────── 画像生成（OpenAI/Google 切替）
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 60000);
const IMAGE_RETRIES = Number(process.env.IMAGE_RETRIES || 2); // 合計3回

function getProvider(req) {
  const p = (req.body?.provider || process.env.PROVIDER || "").toString().toLowerCase();
  if (p.startsWith("google")) return "google"; // "google", "google-gemini", etc.
  return "openai";
}

async function fetchWithRetries(doFetch, tryCount = IMAGE_RETRIES) {
  const start = Date.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= tryCount; attempt++) {
    const label = `attempt ${attempt + 1}/${tryCount + 1}`;
    try {
      console.log(`[gen] ${label} → calling provider`);
      const { ok, data, status, errText, raw } = await doFetch(IMAGE_TIMEOUT_MS);
      if (ok) return { ok, data, attempt, elapsed: Date.now() - start };
      if (status && (status === 429 || (status >= 500 && status <= 599))) {
        console.warn(`[gen] ${label} transient ${status}: ${errText?.slice?.(0, 200)}`);
        lastErr = new Error(`status ${status}`);
      } else {
        return { ok: false, status, errText, raw, attempt, elapsed: Date.now() - start };
      }
    } catch (e) {
      console.warn(`[gen] ${label} error:`, e?.name || e);
      lastErr = e;
    }
    const backoff = attempt === 0 ? 0 : attempt === 1 ? 2000 : 5000;
    if (attempt < tryCount) {
      console.log(`[gen] waiting ${backoff}ms before retry...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr || new Error("ALL_RETRIES_FAILED");
}

// OpenAI 実装（URL or b64_json）
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
  }).catch((e) => ({ __error: e }));

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

// ───────────── Google（Imagen/Gemini Images）実装
// v1beta/images:generate を基本に、モデル404時は models 一覧から画像生成対応モデルを自動選択して再試行
async function listGoogleModels(apiKey) {
  const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
  });
  const txt = await resp.text().catch(() => "{}");
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

function pickImageModelFromList(listJson) {
  // 1) よく見る候補を優先
  const preferred = [
    "imagen-3.0-generate-001",
    "imagen-3.0-fast-generate-001",
    "imagegeneration@005",
    "imagegeneration@004",
    "imagegeneration@003",
    "imagegeneration@002",
  ];
  const items = listJson?.models || listJson?.data || listJson?.items || [];

  // name に含まれていたら即採択
  for (const id of preferred) {
    const hit = items.find((m) => (m.name || m.id || "").includes(id));
    if (hit) return hit.name || hit.id;
  }

  // supportedGenerationMethods などの示唆から画像生成っぽいものを拾う
  for (const m of items) {
    const name = m.name || m.id || "";
    const methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
    const desc = (m.description || "").toLowerCase();

    const looksImagey =
      /image|imagen|photo|imagegeneration/i.test(name) ||
      methods.some((x) => /image|images|generate/i.test(String(x))) ||
      /image/.test(desc);

    if (looksImagey) return name;
  }
  return null;
}

async function googleImagesGenerate(apiKey, model, prompt, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/images:generate?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const body = { model, prompt };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((e) => ({ __error: e }));

  clearTimeout(t);

  if (resp?.__error) return { ok: false, status: 0, errText: String(resp.__error) };

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    return { ok: false, status: resp.status, errText: text || "(no body)" };
  }

  // 可能性のあるパターンを網羅的に探す
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }

  const b64 =
    data?.images?.[0]?.data ||
    data?.predictions?.[0]?.bytesBase64 ||
    data?.generatedImages?.[0]?.image?.imageBytes ||
    null;

  if (!b64) {
    return { ok: false, status: 502, errText: "IMAGE_MISSING (no base64 field)", raw: data };
  }
  return { ok: true, data: { dataUrl: `data:image/png;base64,${b64}` } };
}

async function googleGenerate(prompt, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, errText: "SERVER_NOT_CONFIGURED (GEMINI_API_KEY)" };

  // 1) まず環境変数で指定があればそれを使う
  const initialModel = (process.env.GOOGLE_IMAGE_MODEL || "").trim() || null;
  if (initialModel) {
    const r1 = await googleImagesGenerate(apiKey, initialModel, prompt, timeoutMs);
    // 404 のときだけ自動検出に切り替える
    if (r1.ok || r1.status !== 404) return r1;
    console.warn("[google] specified model 404, fallback to autodetect");
  }

  // 2) 自動検出（ListModels）
  const list = await listGoogleModels(apiKey);
  const picked = pickImageModelFromList(list);

  if (!picked) {
    return { ok: false, status: 404, errText: "No usable image model found in your account.", raw: list };
  }

  console.log("[google] using model:", picked);
  return await googleImagesGenerate(apiKey, picked, prompt, timeoutMs);
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
      if (provider === "google") {
        return await googleGenerate(prompt, timeoutMs);
      } else {
        return await openaiGenerate(prompt, timeoutMs);
      }
    };

    const { ok, data, status, errText, raw, attempt, elapsed } = await fetchWithRetries(doFetch);

    if (!ok) {
      console.error("[gen] failed:", status, errText);
      if (raw) console.error("[gen] raw:", JSON.stringify(raw).slice(0, 600));
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
