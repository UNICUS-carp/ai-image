import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ========================================
// デバッグ用：設定確認
// ========================================
app.get("/debug/config", (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV || "development",
    hasGeminiApiKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    model: "gemini-2.5-flash-image",
  });
});

// ========================================
// Passkey トークン発行（ステージング用）
// ========================================
app.post("/api/passkey-token", (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }
  const clientToken = `stage-token-${Date.now()}-${userId}`;
  console.log(`[passkey] issued clientToken for userId=${userId} => ${clientToken}`);
  return res.json({ clientToken });
});

// ========================================
// 画像生成（Gemini 2.5 Flash Image）
// ========================================
app.post("/api/generate-test-image", async (req, res) => {
  const { prompt, provider = "google", aspectRatio = "1:1" } = req.body;
  
  console.log("[gen] ===========================================");
  console.log("[gen] Request received:");
  console.log(`[gen] - prompt length: ${prompt?.length || 0} characters`);
  console.log(`[gen] - provider: ${provider}`);
  console.log(`[gen] - aspectRatio: ${aspectRatio}`);
  console.log("[gen] ===========================================");

  if (!prompt) {
    console.error("[gen] ERROR: No prompt provided");
    return res.status(400).json({ error: "NO_PROMPT" });
  }

  if (provider !== "google") {
    console.error(`[gen] ERROR: Unsupported provider: ${provider}`);
    return res.status(400).json({ error: "UNSUPPORTED_PROVIDER", message: `Provider '${provider}' not supported. Use 'google'.` });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

  if (!GEMINI_API_KEY) {
    console.error("[gen] ERROR: GEMINI_API_KEY not configured");
    return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  }

  // Gemini 2.5 Flash Image API
  const modelName = "gemini-2.5-flash-image";
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

  console.log(`[gen] Using model: ${modelName}`);
  console.log(`[gen] API endpoint: ${apiUrl}`);

  // Gemini APIのリクエスト形式
  const requestBody = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      response_modalities: ["IMAGE"]
    }
  };

  // aspectRatio を image_config に追加
  if (aspectRatio && aspectRatio !== "1:1") {
    requestBody.generationConfig.image_config = {
      aspect_ratio: aspectRatio
    };
    console.log(`[gen] ✅ aspectRatio added to image_config: ${aspectRatio}`);
  } else {
    console.log(`[gen] ℹ️ Using default aspect ratio (1:1)`);
  }

  console.log("[gen] Request body:");
  console.log(JSON.stringify(requestBody, null, 2));

  try {
    console.log("[gen] Sending request to Gemini API...");
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(`${apiUrl}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;

    console.log(`[gen] Response received in ${elapsed}ms`);
    console.log(`[gen] HTTP Status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[gen] ERROR: API returned non-OK status");
      console.error(`[gen] Status: ${response.status}`);
      console.error(`[gen] Error body: ${errorText}`);
      return res.status(response.status).json({ 
        error: "GEMINI_API_ERROR", 
        status: response.status, 
        message: errorText 
      });
    }

    const data = await response.json();
    console.log("[gen] API response structure:");
    console.log(`[gen] - candidates count: ${data.candidates?.length || 0}`);

    if (!data.candidates || data.candidates.length === 0) {
      console.error("[gen] ERROR: No candidates in response");
      return res.status(500).json({ error: "NO_CANDIDATES", message: "Gemini API returned no candidates" });
    }

    const candidate = data.candidates[0];
    if (!candidate.content || !candidate.content.parts) {
      console.error("[gen] ERROR: No content.parts in candidate");
      return res.status(500).json({ error: "NO_CONTENT_PARTS" });
    }

    // 画像データを探す
    let imageData = null;
    let mimeType = "image/png";

    for (const part of candidate.content.parts) {
      if (part.inlineData) {
        imageData = part.inlineData.data;
        mimeType = part.inlineData.mimeType || "image/png";
        break;
      }
    }

    if (!imageData) {
      console.error("[gen] ERROR: No image data in response");
      return res.status(500).json({ error: "NO_IMAGE_DATA" });
    }

    const dataUrl = `data:${mimeType};base64,${imageData}`;

    console.log("[gen] ✅ SUCCESS");
    console.log(`[gen] - Image generated with aspectRatio: ${aspectRatio}`);
    console.log(`[gen] - Image size: ${Math.round(imageData.length / 1024)}KB`);
    console.log(`[gen] - MIME type: ${mimeType}`);
    console.log("[gen] ===========================================");

    return res.json({
      dataUrl,
      provider: "google",
      model: modelName,
      aspectRatio: aspectRatio,
      elapsed,
    });

  } catch (e) {
    console.error("[gen] EXCEPTION:", e);
    const msg = e?.name === "AbortError" ? "Request timeout (60s)" : String(e?.message || e);
    return res.status(500).json({ error: "UNEXPECTED", message: msg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT} (Gemini 2.5 Flash Image)`));
