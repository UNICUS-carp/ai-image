import { GoogleGenerativeAI } from '@google/generative-ai';
import { Buffer } from 'buffer';

class ImageGeneratorV2 {
  constructor() {
    this.geminiApiKey = process.env.GEMINI_API_KEY;
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!this.geminiApiKey) {
      console.warn('[imageGen] GEMINI_API_KEY not found, using mock implementation');
      this.mockMode = true;
    } else {
      this.genAI = new GoogleGenerativeAI(this.geminiApiKey);
      this.geminiModel = this.genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      this.mockMode = false;
      console.log('[imageGen] Gemini API initialized');
    }

    if (this.openaiApiKey) {
      console.log('[imageGen] OpenAI API available for enhanced semantic splitting');
    }
  }

  // 高度な記事分割（OpenAI GPT対応）
  async splitArticle(content, maxImages = 5) {
    const headings = this.detectHeadings(content);
    if (headings.length > 0) {
      // 見出しがある場合：OpenAI GPTで見出しベース分析
      if (this.openaiApiKey) {
        try {
          return await this.splitContentWithOpenAI(content, true, headings.map(h => h.heading), maxImages);
        } catch (error) {
          console.warn('[imageGen] OpenAI splitting failed, falling back to local merge:', error.message);
          return this.mergeSimilarHeadings(headings, Math.min(maxImages, 5));
        }
      }
      return this.mergeSimilarHeadings(headings, Math.min(maxImages, 5));
    }

    if (content.length < 200) {
      return [{ index: 0, text: content.trim(), heading: null }];
    }

    // 見出しがない場合：OpenAI GPTでセマンティック分析
    if (this.openaiApiKey) {
      try {
        return await this.splitContentWithOpenAI(content, false, [], maxImages);
      } catch (error) {
        console.warn('[imageGen] OpenAI splitting failed, falling back to deterministic split:', error.message);
        return this.semanticSplit(content, {
          maxChunks: Math.min(maxImages, 5),
          maxCharsPerChunk: 400,
        });
      }
    }

    return this.semanticSplit(content, {
      maxChunks: Math.min(maxImages, 5),
      maxCharsPerChunk: 400,
    });
  }

  // マークダウン風の見出しを検出
  detectHeadings(content) {
    const HEADING_REGEX = /^(#{1,6}|[*-]\s+|\d+\.)\s*(.+)$/gm;
    const matches = [];
    let lastIndex = 0;
    let match;

    while ((match = HEADING_REGEX.exec(content)) !== null) {
      const headingStart = match.index;
      const heading = match[2].trim();
      if (matches.length > 0) {
        matches[matches.length - 1].content = content.slice(lastIndex, headingStart).trim();
      }
      matches.push({ heading, content: "" });
      lastIndex = HEADING_REGEX.lastIndex;
    }

    if (matches.length > 0) {
      matches[matches.length - 1].content = content.slice(lastIndex).trim();
    }

    return matches.filter((item) => item.content.length > 0);
  }

  // 類似した見出しをマージ
  mergeSimilarHeadings(headings, maxChunks) {
    const merged = [];
    for (const item of headings) {
      const found = merged.find((chunk) => this.isSimilarHeading(chunk.heading || "", item.heading));
      if (found) {
        found.text = `${found.text}\n\n${item.content}`;
      } else {
        merged.push({ index: merged.length, heading: item.heading, text: item.content });
      }
    }

    return merged.slice(0, maxChunks).map((chunk, index) => ({ ...chunk, index }));
  }

  // 見出しの類似性判定
  isSimilarHeading(a, b) {
    if (!a || !b) return false;
    const normalizedA = a.toLowerCase();
    const normalizedB = b.toLowerCase();
    return normalizedA === normalizedB || normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA);
  }

  // セマンティック分割（決定論的実装）
  semanticSplit(content, options) {
    const sentences = content.split(/(?<=。|\.)[\s]*/);
    const chunks = [];
    let buffer = "";

    for (const sentence of sentences) {
      const prospective = buffer.length === 0 ? sentence : `${buffer}${sentence}`;
      const overLimit =
        prospective.length > options.maxCharsPerChunk ||
        (chunks.length + 1 === options.maxChunks && prospective.length > options.maxCharsPerChunk);

      if (overLimit && buffer.length > 0) {
        chunks.push({ index: chunks.length, text: buffer.trim(), heading: null });
        buffer = sentence;
      } else {
        buffer = prospective;
      }

      if (chunks.length >= options.maxChunks) break;
    }

    if (buffer.trim().length > 0 && chunks.length < options.maxChunks) {
      chunks.push({ index: chunks.length, text: buffer.trim(), heading: null });
    }

    return chunks.slice(0, options.maxChunks);
  }

  // OpenAI GPT-4o-miniによる高度なセマンティック分割
  async splitContentWithOpenAI(content, hasHeadings, headings, maxImages = 5) {
    console.log("[imageGen] Using OpenAI GPT-4o-mini for content analysis");
    
    let systemPrompt, userPrompt;
    
    if (hasHeadings && headings.length > 0) {
      systemPrompt = `あなたは日本語の記事を分析し、画像生成に適した重要で視覚的な場面を抽出する専門家です。
記事から各見出しに対応する本文の中で、最も視覚的に表現しやすく、記事の価値を伝える重要な場面を抽出してください。
抽出の優先順位：
1. 記事の主要テーマに直結する重要な場面
2. 具体的な動作・行動・状況の描写
3. 問題・解決・結果を示す場面
4. 読者が理解・実践に必要な視覚的要素
5. 感情移入できる日常的な場面
必ずJSON形式で出力してください。`;
      
      userPrompt = `【記事の見出し一覧】
${headings.map((h, i) => `${i + 1}. ${h}`).join('\n')}

【本文】
${content}

【要求】
- 各見出しに対応する本文から、最も重要で視覚的な場面を抽出
- 要約ではなく、原文から重要な部分をそのまま抽出
- 6つ以上ある場合は、最も重要な5つの見出しを選択
- 各抽出は100-400字程度

出力形式：
{
  "chunks": [
    {
      "heading": "見出し名",
      "text": "抽出した重要で視覚的な本文",
      "importance": "この部分が重要な理由",
      "visualElements": "主要な視覚要素（人物・場所・動作）"
    }
  ]
}`;
    } else {
      systemPrompt = `あなたは日本語の記事を分析し、画像生成に適した重要で視覚的な場面を抽出する専門家です。
記事の核心を理解し、最も価値のある視覚的場面を重要度順に抽出してください。単なる装飾的描写ではなく、記事の目的を達成するために不可欠な場面を選択してください。
必ずJSON形式で出力してください。`;
      
      userPrompt = `【本文】
${content}

【要求】
- 記事から最も重要で視覚的な場面を重要度順に抽出
- 要約ではなく、原文から重要な部分をそのまま抽出
- 最大5つまで
- 各抽出は100-400字程度

出力形式：
{
  "chunks": [
    {
      "text": "抽出した重要で視覚的な本文",
      "importance": "この部分が重要な理由",
      "visualElements": "主要な視覚要素（人物・場所・動作）"
    }
  ]
}`;
    }

    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 4000,
      temperature: 0.3
    };

    console.log("[imageGen] Sending request to OpenAI API...");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.openaiApiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const responseContent = data.choices?.[0]?.message?.content;
    
    if (!responseContent) {
      throw new Error("No content in OpenAI response");
    }

    console.log("[imageGen] OpenAI response received:", responseContent.substring(0, 200) + "...");

    try {
      const parsed = JSON.parse(responseContent);
      const chunks = parsed.chunks || [];
      
      return chunks.slice(0, Math.min(maxImages, 5)).map((chunk, index) => ({
        index,
        text: chunk.text,
        heading: chunk.heading || null,
        importance: chunk.importance,
        visualElements: chunk.visualElements
      }));
    } catch (parseError) {
      console.error("[imageGen] Failed to parse OpenAI response as JSON:", parseError);
      throw new Error("Invalid JSON response from OpenAI");
    }
  }

  // プロンプト生成（見出し対応）
  async generateImagePrompt(chunk, style = 'modern', aspectRatio = '1:1') {
    if (this.mockMode) {
      return this.generateMockPrompt(chunk.text, style, chunk.heading);
    }

    try {
      const styleGuides = {
        photo: 'photorealistic, detailed, high quality photography style',
        anime: 'anime style, manga illustration, Japanese animation aesthetic',
        '3d': '3D rendered, computer graphics, realistic 3D modeling',
        pixel: 'pixel art style, retro gaming aesthetic, 8-bit graphics',
        watercolor: 'watercolor painting style, soft brushstrokes, artistic',
        // 旧スタイル（互換性用）
        modern: 'modern, clean, professional, minimalist aesthetic',
        classic: 'classic, elegant, traditional, refined style',
        minimal: 'minimal, simple, clean lines, monochromatic',
        colorful: 'vibrant, colorful, dynamic, energetic'
      };

      const headingText = chunk.heading ? `\nHeading: "${chunk.heading}"` : '';
      const scope = chunk.heading || '記事内容';

      // 記事内容を含めたプロンプト生成
      const articleContent = chunk.text.substring(0, 200); // 最初の200文字
      const systemPrompt = `記事内容: ${articleContent}

上記の記事内容を表現する画像生成プロンプトを英語で作成してください。

参考例（この形式で記事内容に合わせて作成）:
- "Middle-aged Japanese man worried expression, back pain, calm colors"
- "Young Japanese woman bad posture, shoulder stiffness, cluttered desk"  
- "Japanese person relaxed expression, health recovery, calm atmosphere"
- "Japanese man bright expression, stretching at home, healthy impression"

要求:
- 記事内容に基づく適切な日本人の人物（年齢・性別）
- 具体的な状況・感情・表情を含める
- 雰囲気や背景設定も含める
- 文字やテキストは絶対に含めない
- ${styleGuides[style] || styleGuides.modern}スタイル
- 英語で50文字程度`;

      console.log(`[imageGen] DEBUG - Chunk text:`, chunk.text);
      console.log(`[imageGen] DEBUG - Article content:`, articleContent);
      console.log(`[imageGen] DEBUG - System prompt:`, systemPrompt);

      const result = await this.geminiModel.generateContent(systemPrompt);
      const geminiResponse = result.response;
      let imagePrompt = geminiResponse.text().trim();
      
      // 50文字制限を強制
      if (imagePrompt.length > 50) {
        imagePrompt = imagePrompt.substring(0, 50);
      }
      
      console.log(`[imageGen] Generated prompt for chunk ${chunk.index} "${chunk.heading || 'no heading'}":`, imagePrompt);
      return imagePrompt;
      
    } catch (error) {
      console.error('[imageGen] Prompt generation error:', error);
      return this.generateMockPrompt(chunk.text, style, chunk.heading);
    }
  }

  // モックプロンプト生成（見出し対応）
  generateMockPrompt(text, style, heading) {
    const keywords = text
      .replace(/[^\w\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g, ' ')
      .split(' ')
      .filter(w => w.length > 2)
      .slice(0, 3)
      .join(' ');

    const styleMap = {
      photo: 'photorealistic professional',
      anime: 'anime illustration',
      '3d': '3D rendered graphics',
      pixel: 'pixel art retro',
      watercolor: 'watercolor artistic',
      modern: 'modern professional',
      classic: 'elegant classic',
      minimal: 'minimalist clean',
      colorful: 'vibrant colorful'
    };

    // 記事内容に基づいて適切な人物像と雰囲気を推定
    let personAge = 'middle-aged';
    let emotion = 'calm expression';
    let setting = 'indoor scene';
    
    if (text.includes('痛み') || text.includes('つらい') || text.includes('苦しい')) {
      emotion = 'worried expression, concerned look';
    }
    if (text.includes('改善') || text.includes('解決') || text.includes('ストレッチ')) {
      emotion = 'relieved expression, healthy impression';
    }
    if (text.includes('女性') || text.includes('ニット')) {
      personAge = 'young Japanese woman';
    }
    if (text.includes('デスク') || text.includes('PC') || text.includes('仕事')) {
      setting = 'office desk environment';
    }

    // サンプル形式に基づいた詳細なプロンプト
    return `${personAge} Japanese person, ${keywords}, ${emotion}, ${setting}, ${styleMap[style] || 'professional'}, no text, no letters, calm atmosphere`;
  }

  // Google Gemini 2.5 Flashによる実際の画像生成
  async generateRealImage(prompt, aspectRatio = '1:1') {
    if (this.mockMode) {
      return null; // モックモードでは実画像生成しない
    }

    try {
      console.log('[imageGen] Generating image with Gemini 2.5 Flash...');
      
      // Gemini 2.5 Flash Image Generation API
      return await this.generateImageWithGemini2_5Flash(prompt, aspectRatio);
      
    } catch (error) {
      console.error('[imageGen] Gemini 2.5 Flash generation error:', error);
      return null;
    }
  }

  // Google Gemini 2.5 Flash Image APIによる画像生成（v1_backup仕様準拠）
  async generateImageWithGemini2_5Flash(prompt, aspectRatio = '1:1') {
    try {
      console.log(`[imageGen] Generating image with Gemini 2.5 Flash Image: ${aspectRatio}`);
      
      // v1_backupと同じモデル名を使用
      const modelName = "gemini-2.5-flash-image";
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${this.geminiApiKey}`;
      
      // v1_backupの正確なAPI仕様に従う
      const requestBody = {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          response_modalities: ["IMAGE"]  // v1_backupの重要な設定
        }
      };

      // v1_backupのアスペクト比設定を追加
      if (aspectRatio && aspectRatio !== "1:1") {
        requestBody.generationConfig.image_config = {
          aspect_ratio: aspectRatio
        };
        console.log(`[imageGen] ✅ aspectRatio added to image_config: ${aspectRatio}`);
      } else {
        console.log(`[imageGen] ℹ️ Using default aspect ratio (1:1)`);
      }

      console.log(`[imageGen] API endpoint: ${apiUrl}`);
      console.log(`[imageGen] Request body:`, JSON.stringify(requestBody, null, 2));

      const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        console.warn(`[imageGen] Gemini 2.5 Flash Image API error: ${apiResponse.status} - ${errorText}`);
        throw new Error(`Gemini API error: ${apiResponse.status} - ${errorText}`);
      }

      const data = await apiResponse.json();
      console.log(`[imageGen] Gemini API response:`, JSON.stringify(data, null, 2));
      
      // v1_backupの正確なレスポンス処理ロジックに従う
      if (data.candidates && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        const parts = candidate.content?.parts;
        
        if (parts) {
          console.log(`[imageGen] Found ${parts.length} parts in response`);
          
          // v1_backupと同じ方法で画像データを探す
          let imagePart = parts.find(p => p.inline_data?.mime_type?.startsWith("image/"));
          if (!imagePart) {
            // inlineData（キャメルケース）も試す
            imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith("image/"));
          }
          
          console.log("[imageGen] Image part found:", !!imagePart);
          
          if (imagePart) {
            const imageData = imagePart.inline_data?.data || imagePart.inlineData?.data;
            const mimeType = imagePart.inline_data?.mime_type || imagePart.inlineData?.mimeType;
            
            if (imageData && mimeType) {
              console.log('[imageGen] Gemini 2.5 Flash Image generated successfully');
              console.log(`[imageGen] Image type: ${mimeType}, data length: ${imageData.length}`);
              return `data:${mimeType};base64,${imageData}`;
            } else {
              console.error("[imageGen] Image part found but no data or mimeType");
              console.error("[imageGen] Image part structure:", JSON.stringify(imagePart, null, 2));
            }
          } else {
            console.error("[imageGen] No image data in response parts");
            parts.forEach((part, index) => {
              console.log(`[imageGen] Part ${index}:`, Object.keys(part));
              if (part.inlineData) {
                console.log(`[imageGen]     - Has inlineData with keys:`, Object.keys(part.inlineData));
              }
              if (part.text) {
                console.log(`[imageGen]     - Has text (length ${part.text.length})`);
              }
            });
          }
        }
      }
      
      console.warn('[imageGen] No image data found in Gemini 2.5 Flash response');
      return null;
      
    } catch (error) {
      console.error('[imageGen] Gemini 2.5 Flash Image generation failed:', error);
      return null;
    }
  }

  // フォールバック: Gemini Pro APIによる画像生成（テキスト→画像プロンプト変換）
  async generateImageWithGeminiPro(prompt, aspectRatio = '1:1') {
    try {
      console.log('[imageGen] Fallback: Using Gemini Pro for enhanced prompt generation');
      
      // Gemini Proで画像生成プロンプトを最適化
      const optimizedPrompt = await this.optimizeImagePromptWithGemini(prompt, aspectRatio);
      
      // 注意: 現在のGemini APIは直接的な画像生成をサポートしていません
      // 実際の本番環境では、最適化されたプロンプトを外部画像生成サービスに送信
      console.log('[imageGen] Optimized prompt:', optimizedPrompt);
      console.log('[imageGen] Note: Direct image generation not available, using enhanced placeholder');
      
      return null; // プレースホルダー画像を使用
      
    } catch (error) {
      console.error('[imageGen] Gemini Pro fallback failed:', error);
      return null;
    }
  }

  // Gemini Proによるプロンプト最適化
  async optimizeImagePromptWithGemini(prompt, aspectRatio) {
    try {
      const systemPrompt = `You are an expert image generation prompt optimizer. Transform the given prompt into a highly detailed, specific prompt optimized for AI image generation.

Requirements:
- Enhance visual details and composition
- Specify lighting, colors, and atmosphere  
- Add technical photography/art terms
- Ensure the description is vivid and specific
- Aspect ratio: ${aspectRatio}
- Keep under 200 words

Original prompt: ${prompt}

Generate an optimized image generation prompt:`;

      const result = await this.geminiModel.generateContent(systemPrompt);
      const geminiResponse = result.response;
      const optimizedPrompt = geminiResponse.text().trim();
      
      return optimizedPrompt;
    } catch (error) {
      console.error('[imageGen] Prompt optimization failed:', error);
      return prompt; // 元のプロンプトを返す
    }
  }

  // メイン画像生成関数
  async generateImages(content, options = {}) {
    const {
      taste = 'modern',
      aspectRatio = '1:1',
      maxImages = 5
    } = options;

    try {
      console.log(`[imageGen] Generating ${maxImages} images for content...`);
      
      // 1. 記事を分割（OpenAI GPT対応）
      console.log(`[imageGen] DEBUG - Original content (first 200 chars):`, content.substring(0, 200));
      const chunks = await this.splitArticle(content, maxImages);
      console.log(`[imageGen] Split content into ${chunks.length} chunks`);
      chunks.forEach((chunk, i) => {
        console.log(`[imageGen] DEBUG - Chunk ${i}: "${chunk.text.substring(0, 100)}..."`);
      });
      
      // 2. 各チャンクに対して画像生成
      const images = [];
      for (const chunk of chunks) {
        const prompt = await this.generateImagePrompt(chunk, taste, aspectRatio);
        
        // 実際のAI画像生成を試行
        const realImage = await this.generateRealImage(prompt, aspectRatio);
        
        if (realImage) {
          // 実画像が生成できた場合
          images.push({
            id: `gemini-${chunk.index}-${Date.now()}`,
            title: chunk.heading || `AI生成画像 ${chunk.index + 1}`,
            heading: chunk.heading,
            dataUrl: realImage,
            prompt: prompt,
            provider: 'gemini-2.5-flash-image',
            type: 'real',
            visualElements: chunk.visualElements,
            importance: chunk.importance
          });
        } else {
          // フォールバック：プレースホルダー画像
          const placeholderImage = this.generatePlaceholderImage(chunk, prompt, taste, aspectRatio);
          images.push({
            ...placeholderImage,
            heading: chunk.heading,
            type: 'placeholder',
            visualElements: chunk.visualElements,
            importance: chunk.importance
          });
        }
      }

      return {
        success: true,
        images: images,
        message: `${images.length}枚の画像を生成しました`
      };

    } catch (error) {
      console.error('[imageGen] Generation error:', error);
      
      // エラー時はフォールバック画像を返す
      return {
        success: false,
        images: [this.generateFallbackImage(content, taste, aspectRatio)],
        message: 'フォールバック画像を生成しました',
        error: error.message
      };
    }
  }

  // プレースホルダー画像生成（実際のAI画像の代替）
  generatePlaceholderImage(chunk, prompt, taste, aspectRatio) {
    const colorMap = {
      photo: '#2563eb',
      anime: '#7c3aed', 
      '3d': '#059669',
      pixel: '#dc2626',
      watercolor: '#ea580c',
      modern: '#667eea',
      classic: '#8b5a3c', 
      minimal: '#888888',
      colorful: '#ff6b6b'
    };

    const dimensions = {
      '1:1': { width: 400, height: 400 },
      '9:16': { width: 350, height: 600 },
      '16:9': { width: 600, height: 350 }
    };

    const color = colorMap[taste] || '#667eea';
    const { width, height } = dimensions[aspectRatio] || dimensions['1:1'];
    const displayTitle = chunk.heading || chunk.text.substring(0, 40) + (chunk.text.length > 40 ? '...' : '');

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad${chunk.index}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${color};stop-opacity:0.8" />
            <stop offset="100%" style="stop-color:${color};stop-opacity:0.5" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad${chunk.index})"/>
        <circle cx="50%" cy="50%" r="30" fill="rgba(255,255,255,0.3)"/>
        <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="24" fill="white" text-anchor="middle" dy=".3em">🎨</text>
      </svg>
    `;

    const base64 = Buffer.from(svg).toString('base64');

    return {
      id: `generated-${chunk.index}-${Date.now()}`,
      title: chunk.heading || `生成画像 ${chunk.index + 1}`,
      dataUrl: `data:image/svg+xml;base64,${base64}`,
      prompt: prompt,
      provider: this.mockMode ? 'mock' : 'gemini'
    };
  }

  // フォールバック画像
  generateFallbackImage(content, taste, aspectRatio) {
    const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
    
    const svg = `
      <svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f0f0f0"/>
        <text x="50%" y="45%" font-family="Arial, sans-serif" font-size="16" fill="#666" text-anchor="middle" dy=".3em">⚠️ 画像生成エラー</text>
        <text x="50%" y="55%" font-family="Arial, sans-serif" font-size="12" fill="#666" text-anchor="middle" dy=".3em">${title}</text>
      </svg>
    `;

    const base64 = Buffer.from(svg).toString('base64');

    return {
      id: `fallback-${Date.now()}`,
      title: 'フォールバック画像',
      dataUrl: `data:image/svg+xml;base64,${base64}`,
      provider: 'fallback'
    };
  }

  // スタイルマッピング
  get styleMap() {
    return {
      photo: '写真画質',
      deformed: 'デフォルメアニメ',
      watercolor: '手書き水彩画',
      detailed: '精密イラスト',
      pictogram: 'ピクトグラム',
      modern: 'モダン',
      classic: 'クラシック',
      minimal: 'ミニマル',
      colorful: 'カラフル'
    };
  }

  // 言語と地域検出
  detectLanguageAndRegion(content) {
    // 日本語の文字が含まれているかチェック
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(content);
    
    if (hasJapanese) {
      return {
        language: 'ja',
        region: '日本',
        era: '現代',
        style: '日本的美意識'
      };
    }
    
    return {
      language: 'en',
      region: '国際',
      era: '現代',
      style: '国際的スタンダード'
    };
  }

  // 安全性ガイドライン構築
  buildSafetyGuidelines(regionInfo) {
    return `安全性ガイドライン: ${regionInfo.region}の文化的配慮を重視し、適切な表現を使用`;
  }

  // 再生成プロンプト構築（TypeScript版から移植）
  buildRegeneratePrompt(originalPrompt, instructions, style, aspectRatio, content = "") {
    // 言語と地域を検出（元のプロンプトから抽出、なければ修正指示から）
    const detectionContent = content || originalPrompt + " " + instructions;
    const regionInfo = this.detectLanguageAndRegion(detectionContent);

    // 言語別安全性ガイドライン
    const safetyGuidelines = this.buildSafetyGuidelines(regionInfo);

    const ratioLabel = aspectRatio === "1:1" ? "square" : aspectRatio;
    const styleText = this.styleMap[style] || `スタイル:${style}`;

    return [
      safetyGuidelines,
      `再生成リクエスト`,
      `比率: ${ratioLabel}`,
      `スタイル: ${styleText}`,
      `地域・文化: ${regionInfo.region} (${regionInfo.era})`,
      `文化的配慮: ${regionInfo.style}`,
      `修正指示: ${instructions}`,
      `--- 元のプロンプト ---`,
      originalPrompt,
    ].join("\n");
  }

  // Geminiによる画像生成（再生成用）
  async generateWithGemini(prompt, aspectRatio = '1:1') {
    try {
      return await this.generateImageWithGemini2_5Flash(prompt, aspectRatio);
    } catch (error) {
      console.error('[imageGen] Gemini generation failed:', error);
      return null;
    }
  }

  // 単一画像再生成
  async regenerateSingleImage(originalPrompt, instructions, options = {}) {
    try {
      const { taste = 'photo', aspectRatio = '1:1' } = options;
      
      console.log(`[imageGen] Starting regeneration with instructions: ${instructions}`);

      const regeneratePrompt = this.buildRegeneratePrompt(originalPrompt, instructions, taste, aspectRatio);
      console.log(`[imageGen] Regenerate prompt:`, regeneratePrompt);

      let imageDataUrl = null;

      if (!this.mockMode) {
        imageDataUrl = await this.generateWithGemini(regeneratePrompt, aspectRatio);
      }

      if (!imageDataUrl) {
        const placeholderData = this.generatePlaceholderImage(
          { index: 0, text: instructions, heading: '修正版' },
          regeneratePrompt,
          taste,
          aspectRatio
        );
        imageDataUrl = placeholderData.dataUrl;
      }

      return {
        success: true,
        image: {
          id: `regenerated-${Date.now()}`,
          title: '修正版画像',
          dataUrl: imageDataUrl,
          prompt: regeneratePrompt,
          provider: this.mockMode ? 'enhanced-mock' : 'gemini-2.5-flash'
        },
        message: '画像を修正しました'
      };

    } catch (error) {
      console.error('[imageGen] Regeneration error:', error);
      
      return {
        success: false,
        message: '画像の修正に失敗しました',
        error: error.message
      };
    }
  }
}

export default ImageGeneratorV2;