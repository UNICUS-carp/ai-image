import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const MAX_CONTENT_LENGTH = 5000;

// ========================================
// デバッグ用：設定確認
// ========================================
app.get("/debug/config", (req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV || "development",
    hasGeminiApiKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    model: "gemini-2.5-flash-image",
    maxContentLength: MAX_CONTENT_LENGTH
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
// 画像生成の共通処理
// ========================================
async function generateImage(req, res) {
  const { prompt, provider = "google", aspectRatio = "1:1" } = req.body;
  
  console.log("[gen] ===========================================");
  console.log("[gen] Request received:");
  console.log(`[gen] - prompt length: ${prompt?.length || 0} characters`);
  console.log(`[gen] - provider: ${provider}`);
  console.log(`[gen] - aspectRatio: ${aspectRatio}`);
  console.log("[gen] ===========================================");

  // プロンプトの存在チェック
  if (!prompt) {
    console.error("[gen] ERROR: No prompt provided");
    return res.status(400).json({ 
      error: "NO_PROMPT",
      message: "プロンプトが指定されていません"
    });
  }

  // 文字数チェック
  if (prompt.length > MAX_CONTENT_LENGTH) {
    console.error(`[gen] ERROR: Prompt too long (${prompt.length} > ${MAX_CONTENT_LENGTH})`);
    return res.status(400).json({
      error: "PROMPT_TOO_LONG",
      message: `プロンプトが長すぎます（${prompt.length}文字 > ${MAX_CONTENT_LENGTH}文字）`,
      currentLength: prompt.length,
      maxLength: MAX_CONTENT_LENGTH
    });
  }

  // プロバイダーチェック
  if (provider !== "google") {
    console.error(`[gen] ERROR: Unsupported provider: ${provider}`);
    return res.status(400).json({ 
      error: "UNSUPPORTED_PROVIDER", 
      message: `プロバイダー '${provider}' はサポートされていません。'google' を使用してください。`
    });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

  if (!GEMINI_API_KEY) {
    console.error("[gen] ERROR: GEMINI_API_KEY not configured");
    return res.status(500).json({ 
      error: "API_KEY_NOT_SET",
      message: "GEMINI_API_KEYが設定されていません"
    });
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
    const timeout = setTimeout(() => controller.abort(), 60000); // 60秒タイムアウト

    const response = await fetch(`${apiUrl}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const elapsed = Date.now() - startTime;
    console.log(`[gen] Response received in ${elapsed}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[gen] ERROR: API returned non-OK status");
      console.error(`[gen] Status: ${response.status}`);
      console.error(`[gen] Response: ${errorText}`);
      
      return res.status(response.status).json({
        error: "API_ERROR",
        message: "Gemini APIからエラーが返されました",
        status: response.status,
        details: errorText
      });
    }

    const data = await response.json();
    console.log("[gen] Full response keys:", Object.keys(data));

    // 画像データの抽出
    const candidate = data.candidates?.[0];
    console.log("[gen] Candidate exists:", !!candidate);
    
    if (candidate) {
      console.log("[gen] Candidate keys:", Object.keys(candidate));
      console.log("[gen] Candidate.content:", candidate.content);
    }
    
    const parts = candidate?.content?.parts;
    console.log("[gen] Parts count:", parts?.length || 0);
    
    if (parts && parts.length > 0) {
      console.log("[gen] Parts structure:");
      parts.forEach((part, idx) => {
        console.log(`[gen]   Part ${idx}:`, Object.keys(part));
        if (part.inline_data) {
          console.log(`[gen]     - Has inline_data with keys:`, Object.keys(part.inline_data));
        }
        if (part.inlineData) {
          console.log(`[gen]     - Has inlineData with keys:`, Object.keys(part.inlineData));
        }
        if (part.text) {
          console.log(`[gen]     - Has text (length ${part.text.length})`);
        }
      });
    }
    
    // 画像データを探す（複数のキー名を試す）
    let imagePart = parts?.find(p => p.inline_data?.mime_type?.startsWith("image/"));
    if (!imagePart) {
      // inlineData（キャメルケース）も試す
      imagePart = parts?.find(p => p.inlineData?.mimeType?.startsWith("image/"));
    }
    
    console.log("[gen] Image part found:", !!imagePart);

    if (!imagePart) {
      console.error("[gen] ERROR: No image data in response");
      console.error("[gen] Full parts:", JSON.stringify(parts, null, 2));
      return res.status(500).json({
        error: "NO_IMAGE_DATA",
        message: "レスポンスに画像データが含まれていません",
        parts: parts,
        candidate: candidate
      });
    }

    // 画像データとMIMEタイプを取得（スネークケースとキャメルケースの両方に対応）
    const imageData = imagePart.inline_data?.data || imagePart.inlineData?.data;
    const mimeType = imagePart.inline_data?.mime_type || imagePart.inlineData?.mimeType;
    
    if (!imageData) {
      console.error("[gen] ERROR: Image part found but no data");
      console.error("[gen] Image part structure:", JSON.stringify(imagePart, null, 2));
      return res.status(500).json({
        error: "NO_IMAGE_DATA",
        message: "画像パートにデータが含まれていません",
        imagePart: imagePart
      });
    }
    
    console.log("[gen] ✅ SUCCESS");
    console.log(`[gen] - Image generated with aspectRatio: ${aspectRatio}`);
    console.log(`[gen] - MIME type: ${mimeType}`);
    console.log(`[gen] - Image data length: ${imageData.length}`);
    console.log(`[gen] - Image data preview: ${imageData.substring(0, 100)}...`);

    // Base64データURLとして返す
    const dataUrl = `data:${mimeType};base64,${imageData}`;
    console.log(`[gen] - DataURL preview: ${dataUrl.substring(0, 100)}...`);

    const responseBody = {
      dataUrl,
      url: dataUrl,
      provider: "google",
      model: modelName,
      elapsed,
      aspectRatio,
      mimeType
    };
    
    console.log("[gen] Sending response with keys:", Object.keys(responseBody));
    return res.json(responseBody);

  } catch (err) {
    console.error("[gen] ERROR: Unexpected error");
    console.error(err);

    if (err.name === "AbortError") {
      return res.status(408).json({
        error: "TIMEOUT",
        message: "リクエストがタイムアウトしました"
      });
    }

    return res.status(500).json({
      error: "UNEXPECTED_ERROR",
      message: "予期しないエラーが発生しました",
      details: err.message
    });
  }
}

// ========================================
// 画像生成エンドポイント
// ========================================
app.post("/api/generate", generateImage);

// ========================================
// 再生成エンドポイント（画像生成と同じ処理）
// ========================================
app.post("/api/regenerate", generateImage);

// ========================================
// 後方互換性のため、古いエンドポイントも残す
// ========================================
app.post("/api/generate-test-image", generateImage);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📏 Max content length: ${MAX_CONTENT_LENGTH} characters`);
});
