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
    hasGoogleProjectId: !!process.env.GOOGLE_PROJECT_ID,
    hasGoogleLocation: !!process.env.GOOGLE_LOCATION,
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
// 画像生成（Google Imagen）
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
  const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID || "";
  const GOOGLE_LOCATION = process.env.GOOGLE_LOCATION || "us-central1";

  if (!GEMINI_API_KEY) {
    console.error("[gen] ERROR: GEMINI_API_KEY not configured");
    return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  }

  // Google Imagen API 呼び出し
  const modelName = "imagen-3.0-generate-002";
  const googleUrl = GOOGLE_PROJECT_ID
    ? `https://${GOOGLE_LOCATION}-aiplatform.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${GOOGLE_LOCATION}/publishers/google/models/${modelName}:predict`
    : `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:predict?key=${GEMINI_API_KEY}`;

  console.log(`[gen] Using model: ${modelName}`);
  console.log(`[gen] API endpoint: ${googleUrl.split('?')[0]}`);

  const parameters = { sampleCount: 1 };
  
  // aspectRatio の検証と追加
  const validAspectRatios = ["1:1", "3:4", "4:3", "9:16", "16:9"];
  if (aspectRatio && validAspectRatios.includes(aspectRatio)) {
    parameters.aspectRatio = aspectRatio;
    console.log(`[gen] ✅ aspectRatio added to parameters: ${aspectRatio}`);
  } else {
    console.log(`[gen] ⚠️ Invalid or missing aspectRatio (${aspectRatio}), using default`);
  }

  const requestBody = {
    instances: [{ prompt }],
    parameters: parameters
  };

  console.log("[gen] Request body to Imagen API:");
  console.log(JSON.stringify(requestBody, null, 2));

  try {
    const headers = { "Content-Type": "application/json" };
    if (GOOGLE_PROJECT_ID) {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const client = await auth.getClient();
      const token = await client.getAccessToken();
      if (token.token) {
        headers["Authorization"] = `Bearer ${token.token}`;
      }
    }

    console.log("[gen] Sending request to Imagen API...");
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒タイムアウト

    const response = await fetch(googleUrl, {
      method: "POST",
      headers,
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
        error: "IMAGEN_API_ERROR", 
        status: response.status, 
        message: errorText 
      });
    }

    const data = await response.json();
    console.log("[gen] API response structure:");
    console.log(`[gen] - predictions count: ${data.predictions?.length || 0}`);

    if (!data.predictions || data.predictions.length === 0) {
      console.error("[gen] ERROR: No predictions in response");
      return res.status(500).json({ error: "NO_PREDICTIONS", message: "Imagen API returned no predictions" });
    }

    const prediction = data.predictions[0];
    if (!prediction.bytesBase64Encoded) {
      console.error("[gen] ERROR: No bytesBase64Encoded in prediction");
      return res.status(500).json({ error: "NO_IMAGE_DATA" });
    }

    const base64Image = prediction.bytesBase64Encoded;
    const mimeType = prediction.mimeType || "image/png";
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    console.log("[gen] ✅ SUCCESS");
    console.log(`[gen] - Image generated with aspectRatio: ${aspectRatio}`);
    console.log(`[gen] - Image size: ${Math.round(base64Image.length / 1024)}KB`);
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
app.listen(PORT, () => console.log(`✅ Server listening on :${PORT}`));
