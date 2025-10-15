// server.js — 画像生成は Google / OpenAI 両対応（デフォルト Google）
// Google:
//  - "imagen-*"   -> :predict
//  - "gemini-*-image*" -> :generateContent (inlineData PNG)
// モデル名に "models/" が付いていても自動で外します。
// 必須ENV（Railway Variables）:
//   PROVIDER=google
//   GEMINI_API_KEY=xxxxxxxxxxxxxxxx
//   GOOGLE_IMAGE_MODEL=gemini-2.5-flash-image   ← 推奨。※ "models/" は付けないのが基本
// 任意：ALLOWED_ORIGIN=https://あなたのフロント
//
// OpenAIを使わないなら OPENAI_API_KEY は不要。/api/create-session を使う時だけ必要。

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

// ───────────── 設定見える化
app.get("/debug/config", (_req, res) => {
  const raw = (process.env.GOOGLE_IMAGE_MODEL || "").trim();
  const cleaned = cleanModelName(raw);
  res.json({
    provider_env: process.env.PROVIDER || "(unset)",
    google_image_model_env_raw: raw || "(unset)",
    google_image_model_normalized: cleaned || "(default: gemini-2.5-flash-image)",
    route_gemini_image: isGeminiImageModel(cleaned),
    route_imagen: isImagenModel(cleaned),
    has_gemini_key: Boolean(process.env.GEMINI_API_KEY),
    allowed_origin: process.env.ALLOWED_ORIGIN || "*",
  });
});

// ───────────── Google モデル一覧（確認用）
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

// ───────────── 画像生成
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 60000);
const IMAGE_RETRIES = Number(process.env.IMAGE_RETRIES || 2); // 合計3回

function getProvider(req) {
  const p = (req.body?.provider || process.env.PROVIDER || "").toString().toLowerCase();
  return p.startsWith("google") ? "google" : "openai";
}

function cleanModelName(val) {
  // 先頭の "models/" を除去し、両端の空白も除去
  const s = (val || "").trim().replace(/^models\//i, "");
  return s;
}

function normalizedGoogleModel() {
  const raw = process.env.GOOGLE_IMAGE_MODEL || "";
  const cleaned = cleanModelName(raw);
  return cleaned || "gemini-2.5-flash-image"; // デフォルト
}

function isImagenModel(name) {
  return /^imagen-/i.test(name);
}
function isGeminiImageModel(name) {
  const n = (name || "").toLowerCase();
  return n.includes("gemini") && n.includes("image");
}

// リトライ
async function fetchWithRetries(doFetch, tryCount = IMAGE_RETRIES) {
  const start = Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt <= tryCount; attempt++) {
    const label = `attempt ${attempt + 1}/${tryCount + 1}`;
    try {
      console.log(`[gen] ${label} → call provider`);
      const { ok, data, status, errText, route } = await doFetch(IMAGE_TIMEOUT_MS);
      if (ok) return { ok, data, attempt, elapsed: Date.now() - start, route };
      if (status && (status === 429 || (status >= 500 && status <= 599))) {
        console.warn(`[gen] ${label} transient ${status}: ${String(errText).slice(0, 200)}`);
        lastErr = new Error(`status ${status}`);
      } else {
        return { ok: false, status, errText, attempt, elapsed: Date.now() - start, route };
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

// OpenAI（未使用ならキー不要）
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
  if (url) return { ok: true, data: { url }, route: "openai:url" };
  if (b64) return { ok: true, data: { dataUrl: `data:image/png;base64,${b64}` }, route: "openai:b64" };
  return { ok: false, status: 502, errText: "IMAGE_MISSING" };
}

// Google: 画像生成（モデル名でルート分岐）
async function googleGenerate(prompt, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, status: 500, errText: "SERVER_NOT_CONFIGURED (GEMINI_API_KEY)" };

  const model = normalizedGoogleModel();
  console.log(`[gen] google model resolved = "${model}"`);

  if (isGeminiImageModel(model)) {
    // ---- Gemini 画像: :generateContent（inlineData PNG）
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
    const part =
      data?.candidates?.[0]?.content?.parts?.find?.(p => p?.inlineData?.data) ||
      data?.candidates?.[0]?.content?.parts?.[0];
    const b64 = part?.inlineData?.data || null;
    if (!b64) return { ok: false, status: 502, errText: "IMAGE_MISSING (no inlineData)" };
    return { ok: true, data: { dataUrl: `data:image/png;base64,${b64}` }, route: "gemini:generateContent" };
  }

  // ---- Imagen: :predict（imageBytes）
  const imagenModel = model || "imagen-3.0-generate-002";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${imagenModel}:predict`;
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
  return { ok: true, data: { dataUrl: `data:image/png;base64,${bytes}` }, route: "imagen:predict" };
}

app.post("/api/generate-test-image", async (req, res) => {
  console.log("[gen] start");
  try {
    const prompt =
      typeof req.body?.prompt === "string" && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : "A simple blue circle icon on white background";

    const provider = getProvider(req);
    const doFetch = async (timeoutMs) => {
      if (provider === "google") return await googleGenerate(prompt, timeoutMs);
      return await openaiGenerate(prompt, timeoutMs);
    };

    const { ok, data, status, errText, attempt, elapsed, route } = await fetchWithRetries(doFetch);

    if (!ok) {
      console.error("[gen] failed:", status, errText, "route:", route);
      return res
        .status(status || 502)
        .json({ error: "IMAGE_API_FAILED", detail: errText, status: status || 502, attempt: (attempt ?? 0) + 1, elapsed, route });
    }

    console.log(`[gen] success by ${provider} via ${route} in ${elapsed}ms (attempt ${(attempt ?? 0) + 1})`);
    return res.json({ ...data, provider, elapsed, attempt: (attempt ?? 0) + 1, route });
  } catch (e) {
    console.error("[gen] unexpected:", e);
    const msg = e?.name === "AbortError" ? "AbortError: timeout" : String(e?.message || e);
    return res.status(500).json({ error: "UNEXPECTED", message: msg });
  }
});

// ───────────── 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server listening on :${PORT}`));
