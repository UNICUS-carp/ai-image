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
// 本文分割（Gemini APIで意味の切れ目判定）
// ========================================
app.post("/api/split-content", async (req, res) => {
  const { content, hasHeadings = false, headings = [] } = req.body;
  
  console.log("[split] ===========================================");
  console.log("[split] Split request received:");
  console.log(`[split] - content length: ${content?.length || 0} characters`);
  console.log(`[split] - hasHeadings: ${hasHeadings}`);
  console.log(`[split] - headings count: ${headings.length}`);
  console.log("[split] ===========================================");

  // バリデーション
  if (!content || content.trim().length === 0) {
    console.error("[split] ERROR: No content provided");
    return res.status(400).json({
      error: "NO_CONTENT",
      message: "本文が指定されていません"
    });
  }

  if (content.length > MAX_CONTENT_LENGTH) {
    console.error(`[split] ERROR: Content too long (${content.length} > ${MAX_CONTENT_LENGTH})`);
    return res.status(400).json({
      error: "CONTENT_TOO_LONG",
      message: `本文が長すぎます（${content.length}文字 > ${MAX_CONTENT_LENGTH}文字）`
    });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

  if (!GEMINI_API_KEY) {
    console.error("[split] ERROR: GEMINI_API_KEY not configured");
    return res.status(500).json({
      error: "API_KEY_NOT_SET",
      message: "GEMINI_API_KEYが設定されていません"
    });
  }

  // Gemini APIで分割を試行（リトライ + フォールバック）
  try {
    const result = await splitContentWithRetry(content, hasHeadings, headings, GEMINI_API_KEY);
    return res.json(result);
  } catch (error) {
    console.error("[split] ERROR: All attempts failed, using fallback");
    const fallbackResult = splitContentFallback(content, hasHeadings, headings);
    return res.json(fallbackResult);
  }
});

// ========================================
// Gemini APIで本文分割（リトライ機能付き）
// ========================================
async function splitContentWithRetry(content, hasHeadings, headings, apiKey) {
  const MAX_RETRIES = 3;
  
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`[split] Attempt ${attempt + 1}/${MAX_RETRIES}`);
      
      if (attempt > 0) {
        // リトライの場合は待機（指数バックオフ）
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`[split] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      const result = await splitContentWithGemini(content, hasHeadings, headings, apiKey);
      console.log(`[split] ✅ SUCCESS on attempt ${attempt + 1}`);
      return {
        success: true,
        method: attempt === 0 ? "gemini" : `gemini-retry-${attempt}`,
        ...result
      };
    } catch (error) {
      console.error(`[split] Attempt ${attempt + 1} failed:`, error.message);
      
      if (attempt === MAX_RETRIES - 1) {
        throw error; // 最後の試行が失敗したら例外を投げる
      }
    }
  }
}

// ========================================
// Gemini APIで本文分割（本体）
// ========================================
async function splitContentWithGemini(content, hasHeadings, headings, apiKey) {
  const modelName = "gemini-1.5-flash";
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

  let prompt;
  
  if (hasHeadings && headings.length > 0) {
    // 小見出しありの場合
    prompt = `あなたは日本語の文章を分析し、構造化するエキスパートです。

【タスク】
以下の小見出しを分析してください。

【小見出し一覧】
${headings.map((h, i) => `${i + 1}. ${h}`).join('\n')}

【要件】
1. 小見出しを統合せず、すべてそのまま使用する
2. 各小見出しのテーマに最も重要で視覚的な描写を抽出
3. 小見出しの順序を保持
4. 小見出しが6つ以上ある場合のみ、最も重要な5つを選択してください
5. 見出しの意図を最も効果的に視覚化できる場面を優先

【抽出の重要度評価基準】
A. 見出しのテーマとの直接的関連性（最重要）
B. 読者の理解・実践に必須の場面
C. 問題解決や効果を示す具体的状況
D. 視覚的インパクトと明確さ
E. 記事全体における位置的重要性

【選択基準（6つ以上の場合）】
- 記事の主要テーマとの関連性
- 読者にとっての実用性・役立ち度  
- 視覚的表現の具体性と効果性
- 日本語の文章構造（結論重視）への配慮
- 全体的なバランスと多様性

【出力形式】
必ずJSON形式で出力してください：
{
  "mergedHeadings": [
    {
      "title": "統合後の見出し",
      "originalIndices": [0, 1],
      "text": "この見出しに対応する本文"
    }
  ]
}

【本文】
${content}

【重要】
- 必ずJSON形式で出力（他のテキストは含めない）
- 本文の内容を変更・要約しない
- 見出しごとに本文を適切に分割`;
  } else {
    // 小見出しなしの場合
    prompt = `あなたは日本語の文章を分析し、記事の核心を視覚的に表現できる重要な場面を抽出するエキスパートです。

【タスク】
以下の本文を分析し、記事の主要テーマに関連する重要で視覚的な場面を抽出してください。

【本文】
${content}

【分析手順】
1. まず本文全体のテーマと目的を理解する
2. 記事の核心的な内容を特定する  
3. その核心に関連する視覚的な描写を重要度順に選択する

【抽出の重要度評価基準】
A. 記事の主要テーマとの関連性（最重要）
B. 読者の理解に必須の場面・状況
C. 問題・解決・結果を示す具体的な描写
D. 視覚的表現の明確さ・具体性
E. 記事全体の流れにおける重要性

【視覚化可能な要素の優先順位】
1. 問題を示す具体的な状況・場面（例：肩こりで困る人）
2. 解決方法の実践場面（例：ストレッチをする様子）
3. 結果・効果が分かる状況（例：改善された状態）
4. 重要なポイントを示す場面（例：正しい姿勢）
5. 読者が共感できる日常的な場面

【要件】
1. 記事の主要テーマから逸脱しない範囲で抽出
2. 各チャンクは100-400字（重要度と視覚性のバランス）
3. 最大5チャンクまで（重要度の高い順）
4. 要約せず、原文から重要な視覚的描写をそのまま抽出
5. 単なる装飾的描写より、記事の核心に関わる場面を優先

【出力形式】
必ずJSON形式で出力してください：
{
  "chunks": [
    {
      "text": "抽出した重要で視覚的な本文",
      "charCount": 245,
      "importance": "この部分が記事にとって重要な理由",
      "visualElements": "主要な視覚要素（人物、場所、動作、状況）"
    }
  ]
}

【重要】
- 必ずJSON形式で出力（他のテキストは含めない）
- 本文を要約や改変せず、原文から抽出
- 記事の価値を最大化する重要な場面を選択`;
  }

  const requestBody = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.1, // 低温度で安定した出力
      maxOutputTokens: 8000
    }
  };

  console.log("[split] Sending request to Gemini API...");
  console.log(`[split] Using model: ${modelName}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30秒タイムアウト

  try {
    const response = await fetch(`${apiUrl}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error("No text in Gemini response");
    }

    console.log("[split] Raw response:", text);

    // JSONを抽出（マークダウンコードブロックを除去）
    let jsonText = text.trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(jsonText);
    console.log("[split] Parsed JSON:", JSON.stringify(parsed, null, 2));

    // バリデーションと正規化
    let chunks;
    
    if (hasHeadings && parsed.mergedHeadings) {
      // 小見出しありの場合
      chunks = parsed.mergedHeadings.map((heading, index) => ({
        index,
        text: heading.text || "",
        charCount: (heading.text || "").length,
        heading: heading.title
      }));
    } else if (parsed.chunks) {
      // 小見出しなしの場合
      chunks = parsed.chunks.map((chunk, index) => ({
        index,
        text: chunk.text || "",
        charCount: chunk.charCount || (chunk.text || "").length
      }));
    } else {
      throw new Error("Invalid response format from Gemini");
    }

    // バリデーション
    chunks = validateChunks(chunks);

    console.log(`[split] ✅ Validated ${chunks.length} chunks`);

    return {
      chunks,
      totalChunks: chunks.length
    };

  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

// ========================================
// フォールバック：ルールベースで分割
// ========================================
function splitContentFallback(content, hasHeadings, headings) {
  console.log("[split] Using fallback (rule-based) splitting");
  console.log(`[split] hasHeadings: ${hasHeadings}, headings count: ${headings.length}`);

  const chunks = [];
  
  if (hasHeadings && headings.length > 0) {
    // 小見出しありの場合：見出しベースで分割
    console.log("[split] Fallback: Using heading-based splitting");
    
    // 6つ以上ある場合は最初の5つを使用（簡易版）
    const selectedHeadings = headings.slice(0, 5);
    
    selectedHeadings.forEach((heading, index) => {
      chunks.push({
        index,
        text: heading, // 見出しをそのまま画像生成に使用
        charCount: heading.length,
        heading: heading
      });
    });
    
    console.log(`[split] Fallback created ${chunks.length} chunks from headings`);
    
  } else {
    // 小見出しなしの場合：段落ベースで分割
    console.log("[split] Fallback: Using paragraph-based splitting");
    
    const TARGET_LENGTH = 200;
    const MAX_LENGTH = 400;
    
    // 段落で分割
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);
    
    let currentChunk = "";
    
    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length <= MAX_LENGTH) {
        currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        
        // 段落が長すぎる場合は文で分割
        if (paragraph.length > MAX_LENGTH) {
          const sentences = paragraph.split(/[。！？]/);
          let tempChunk = "";
          
          for (const sentence of sentences) {
            if (!sentence.trim()) continue;
            
            const sentenceWithPunct = sentence + (paragraph[sentence.length] || "");
            
            if (tempChunk.length + sentenceWithPunct.length <= MAX_LENGTH) {
              tempChunk += sentenceWithPunct;
            } else {
              if (tempChunk) chunks.push(tempChunk);
              tempChunk = sentenceWithPunct;
            }
          }
          
          if (tempChunk) currentChunk = tempChunk;
        } else {
          currentChunk = paragraph;
        }
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    // 文字列配列をオブジェクト配列に変換
    const formattedChunks = chunks.slice(0, 5).map((text, index) => ({
      index,
      text,
      charCount: text.length
    }));
    
    chunks.length = 0;
    chunks.push(...formattedChunks);
    
    console.log(`[split] Fallback created ${chunks.length} chunks from paragraphs`);
  }

  return {
    success: true,
    method: "fallback",
    chunks,
    totalChunks: chunks.length
  };
}

// ========================================
// チャンクのバリデーション
// ========================================
function validateChunks(chunks) {
  return chunks
    .filter(chunk => chunk.text && chunk.text.trim().length > 0) // 空除去
    .map(chunk => ({
      ...chunk,
      text: chunk.text.substring(0, 400), // 400字制限
      charCount: Math.min(chunk.charCount || chunk.text.length, 400)
    }))
    .slice(0, 5); // 最大5チャンク
}

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
