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

  // 高度な記事分割（新仕様対応）
  async splitArticle(content, maxImages = 5) {
    console.log(`[imageGen] Starting article split. Content length: ${content.length}`);
    
    // Step 1: 文字数に応じてチャンク数を決定
    const targetChunkCount = this.determineChunkCount(content.length);
    console.log(`[imageGen] Target chunk count: ${targetChunkCount} (based on ${content.length} chars)`);
    
    // Step 2: 意味の区切りでチャンク化（GPT優先）
    if (this.openaiApiKey) {
      try {
        return await this.splitContentSemanticGPT(content, targetChunkCount);
      } catch (error) {
        console.warn('[imageGen] OpenAI semantic splitting failed, falling back to local split:', error.message);
        return this.semanticSplitLocal(content, targetChunkCount);
      }
    }

    // フォールバック: ローカル意味分割
    return this.semanticSplitLocal(content, targetChunkCount);
  }

  // 文字数に応じたチャンク数決定
  determineChunkCount(contentLength) {
    if (contentLength <= 500) return 1;
    if (contentLength <= 800) return 2;
    if (contentLength <= 1200) return 3;
    if (contentLength <= 1600) return 4;
    return 5; // 2000文字超
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
    // 見出しを基準に分割を試みる
    const headingPattern = /小見出し\d+：[^\n]+/g;
    const headings = content.match(headingPattern) || [];
    
    if (headings.length > 0) {
      const chunks = [];
      let lastIndex = 0;
      
      headings.forEach((heading, i) => {
        const headingIndex = content.indexOf(heading, lastIndex);
        if (headingIndex !== -1) {
          const nextHeadingIndex = i < headings.length - 1 
            ? content.indexOf(headings[i + 1], headingIndex + heading.length)
            : content.length;
          
          const chunkText = content.slice(headingIndex, nextHeadingIndex).trim();
          if (chunkText.length > 0 && chunks.length < options.maxChunks) {
            chunks.push({ 
              index: chunks.length, 
              text: chunkText, 
              heading: heading.replace(/小見出し\d+：/, '').trim()
            });
          }
          lastIndex = nextHeadingIndex;
        }
      });
      
      if (chunks.length > 0) {
        return chunks.slice(0, options.maxChunks);
      }
    }
    
    // フォールバック：句点での分割
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

  // GPTによる意味の区切りでのチャンク化
  async splitContentSemanticGPT(content, targetChunkCount) {
    console.log(`[imageGen] Using OpenAI for semantic splitting into ${targetChunkCount} chunks`);
    
    const systemPrompt = `あなたは日本語の記事を意味の区切りで分割する専門家です。
重要: 絶対に要約せず、元の文章をそのまま使用してください。

指示:
1. 記事を${targetChunkCount}個の意味のある塊に分割
2. 各塊は意味的に完結した内容にする
3. 文字数ではなく意味で区切る（段落・話題の変わり目など）
4. 元の文章を一切変更・要約しない
5. 各塊は原文のまま抽出する

出力形式（JSON）:
{
  "chunks": [
    {
      "index": 0,
      "text": "元の文章をそのまま抽出",
      "reason": "分割理由"
    }
  ]
}`;
      
    const userPrompt = `以下の記事を${targetChunkCount}個の意味のある塊に分割してください。

【記事】
${content}

要約は禁止。元の文章をそのまま使用してJSON形式で出力してください。`;

    const response = await this.callOpenAI(systemPrompt, userPrompt);
    return this.parseGPTChunks(response, targetChunkCount);
  }

  // OpenAI API呼び出し
  async callOpenAI(systemPrompt, userPrompt) {
    const payload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 4000,
      temperature: 0.1
    };

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
    return data.choices?.[0]?.message?.content;
  }

  // GPTレスポンスのパース
  parseGPTChunks(response, targetCount) {
    try {
      const parsed = JSON.parse(response);
      const chunks = parsed.chunks || [];
      
      return chunks.slice(0, targetCount).map((chunk, index) => ({
        index,
        text: chunk.text?.trim() || '',
        heading: null, // 意味分割では見出しはなし
        reason: chunk.reason || ''
      }));
    } catch (error) {
      console.error('[imageGen] Failed to parse GPT response:', error);
      throw new Error('Invalid GPT response format');
    }
  }

  // ローカル意味分割（フォールバック・改善版）
  semanticSplitLocal(content, targetCount) {
    console.log(`[imageGen] Using enhanced local semantic splitting into ${targetCount} chunks`);
    
    // 見出しパターンを検出
    const headingPattern = /小見出し\d+：([^\n]+)/g;
    const headings = [];
    let match;
    
    while ((match = headingPattern.exec(content)) !== null) {
      headings.push({
        title: match[1],
        index: match.index,
        fullMatch: match[0]
      });
    }
    
    if (headings.length > 0 && headings.length <= targetCount) {
      // 見出しベースで分割
      const chunks = [];
      for (let i = 0; i < headings.length; i++) {
        const startIdx = headings[i].index;
        const endIdx = i < headings.length - 1 ? headings[i + 1].index : content.length;
        const chunkText = content.slice(startIdx, endIdx).trim();
        
        if (chunkText.length > 0) {
          chunks.push({
            index: i,
            text: chunkText,
            heading: headings[i].title,
            chunkType: this.classifyChunkType(headings[i].title, chunkText)
          });
        }
      }
      return chunks.slice(0, targetCount);
    }
    
    // フォールバック: 均等分割
    const chunkSize = Math.ceil(content.length / targetCount);
    const chunks = [];
    
    for (let i = 0; i < targetCount; i++) {
      const startIdx = i * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, content.length);
      let chunkText = content.slice(startIdx, endIdx);
      
      // 文の途中で切れないよう調整
      if (i < targetCount - 1 && endIdx < content.length) {
        const nextSentenceEnd = content.indexOf('。', endIdx);
        if (nextSentenceEnd !== -1 && nextSentenceEnd - endIdx < 100) {
          chunkText = content.slice(startIdx, nextSentenceEnd + 1);
        }
      }
      
      if (chunkText.trim()) {
        chunks.push({
          index: i,
          text: chunkText.trim(),
          heading: null,
          chunkType: this.classifyChunkType(null, chunkText)
        });
      }
    }
    
    return chunks;
  }

  // チャンクタイプ分類
  classifyChunkType(heading, text) {
    const combined = (heading || '') + ' ' + text;
    
    if (combined.includes('はじめ') || combined.includes('経験') || combined.includes('痛み')) {
      return 'introduction';
    }
    if (combined.includes('危険') || combined.includes('放置') || combined.includes('症状')) {
      return 'warning';
    }
    if (combined.includes('方法') || combined.includes('着替え') || combined.includes('姿勢')) {
      return 'technique';
    }
    if (combined.includes('ケア') || combined.includes('ストレッチ') || combined.includes('運動')) {
      return 'exercise';
    }
    if (combined.includes('まとめ') || combined.includes('改善') || combined.includes('効果')) {
      return 'conclusion';
    }
    
    return 'general';
  }

  // 旧実装（削除予定）
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
      model: "gpt-4o",
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

  // 新仕様: チャンクから具体的場面を抽出してプロンプト化
  async generateImagePrompt(chunk, style = 'modern', aspectRatio = '1:1') {
    if (this.mockMode) {
      return this.generateMockPrompt(chunk.text, style, chunk.heading);
    }

    try {
      // Step 1: チャンクから画像化する具体的場面を抽出
      const specificScene = await this.extractSpecificScene(chunk);
      console.log(`[imageGen] DEBUG - Extracted scene for chunk ${chunk.index}:`, specificScene.substring(0, 100) + '...');
      
      // Step 2: 抽出した場面をプロンプト化
      return await this.sceneToPrompt(specificScene, style);
      
    } catch (error) {
      console.error('[imageGen] Prompt generation error:', error);
      return this.generateMockPrompt(chunk.text, style, chunk.heading);
    }
  }

  // チャンクから具体的な場面を抽出（要約禁止）
  async extractSpecificScene(chunk) {
    if (this.openaiApiKey) {
      try {
        const systemPrompt = `あなたは日本語の文章から画像として表現できる具体的な場面を抽出する専門家です。

重要な制約:
- 絶対に要約しない
- 元の文章から具体的な場面の部分をそのまま抽出
- 人物の動作・表情・状況が描かれた部分を選ぶ
- 抽出した文章は原文のまま変更しない

例:
元文: "朝の身支度で、いつものようにニットを着ようと腕を上げた瞬間、「うっ...」と肩に鋭い痛みが走った経験はありませんか"
抽出: "ニットを着ようと腕を上げた瞬間、「うっ...」と肩に鋭い痛みが走った"

抽出した場面の文章だけを返してください。`;

        const userPrompt = `以下の文章から、画像として表現できる最も具体的で視覚的な場面を原文のまま抽出してください。

【文章】
${chunk.text}

具体的な人物の動作・表情・状況が描かれた部分を原文のまま抽出してください。`;

        const response = await this.callOpenAI(systemPrompt, userPrompt);
        return response?.trim() || chunk.text.substring(0, 200);
        
      } catch (error) {
        console.warn('[imageGen] Scene extraction failed, using chunk text:', error.message);
        return chunk.text.substring(0, 200);
      }
    }
    
    // フォールバック: チャンクの最初の部分を使用
    return chunk.text.substring(0, 200);
  }

  // 抽出した場面をプロンプト化
  async sceneToPrompt(sceneText, style) {
    const styleGuides = {
      photo: 'photorealistic, detailed, high quality photography style',
      anime: 'anime style, manga illustration, Japanese animation aesthetic',
      '3d': '3D rendered, computer graphics, realistic 3D modeling',
      pixel: 'pixel art style, retro gaming aesthetic, 8-bit graphics',
      watercolor: 'watercolor painting style, soft brushstrokes, artistic',
      modern: 'modern, clean, professional, minimalist aesthetic',
      classic: 'classic, elegant, traditional, refined style',
      minimal: 'minimal, simple, clean lines, monochromatic',
      colorful: 'vibrant, colorful, dynamic, energetic'
    };

    if (this.openaiApiKey) {
      try {
        const systemPrompt = `あなたは日本語の場面描写を英語の画像生成プロンプトに変換する専門家です。

要求:
- 日本人の人物を必ず含める
- 場面の具体的な動作・表情・状況を表現
- 文字やテキストは絶対に含めない
- ${styleGuides[style] || styleGuides.modern}スタイル
- 英語で70文字程度
- 自然で具体的な描写にする

参考例:
"ニットを着ようと腕を上げた瞬間、肩に痛みが走った" → "Japanese woman raising arms putting on sweater, sudden shoulder pain expression"`;

        const userPrompt = `以下の日本語の場面を英語の画像生成プロンプトに変換してください。

【場面】
${sceneText}

日本人の人物を含む具体的で自然な英語プロンプトを70文字程度で作成してください。`;

        const response = await this.callOpenAI(systemPrompt, userPrompt);
        let prompt = response?.trim() || '';
        
        if (prompt.length > 80) {
          prompt = prompt.substring(0, 80);
        }
        
        return prompt;
        
      } catch (error) {
        console.warn('[imageGen] Prompt conversion failed, using fallback:', error.message);
        return this.generateMockPrompt(sceneText, style, null);
      }
    }
    
    // フォールバック
    return this.generateMockPrompt(sceneText, style, null);
  }

  // 改善されたプロンプト生成（チャンクタイプベース）
  generateMockPrompt(text, style, heading, chunkType = null) {
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

    // チャンクタイプに基づくシーン生成
    const sceneTemplates = {
      introduction: {
        scene: 'Japanese woman morning routine putting on knit sweater',
        action: 'raising arms with sudden pain',
        emotion: 'surprised painful expression',
        setting: 'bedroom morning light'
      },
      warning: {
        scene: 'Japanese woman showing shoulder muscle anatomy concern',
        action: 'touching shoulder with worry',
        emotion: 'serious concerned expression',
        setting: 'medical consultation room'
      },
      technique: {
        scene: 'Japanese woman demonstrating proper dressing technique',
        action: 'careful arm movement demonstration',
        emotion: 'instructional focused expression',
        setting: 'bright home interior'
      },
      exercise: {
        scene: 'Japanese woman doing shoulder stretches',
        action: 'gentle stretching exercise',
        emotion: 'concentrated peaceful expression',
        setting: 'exercise mat home'
      },
      conclusion: {
        scene: 'Japanese woman happy after successful recovery',
        action: 'easy comfortable arm movement',
        emotion: 'bright satisfied smile',
        setting: 'sunny home environment'
      }
    };

    // チャンクタイプまたは内容ベースでシーンを決定
    let sceneData = sceneTemplates.general || sceneTemplates.introduction;
    
    if (chunkType && sceneTemplates[chunkType]) {
      sceneData = sceneTemplates[chunkType];
    } else {
      // フォールバック: 内容ベース判定
      if (text.includes('ニット') || text.includes('着る') || text.includes('痛み')) {
        sceneData = sceneTemplates.introduction;
      } else if (text.includes('筋肉') || text.includes('血流') || text.includes('危険')) {
        sceneData = sceneTemplates.warning;
      } else if (text.includes('方法') || text.includes('着替え') || text.includes('姿勢')) {
        sceneData = sceneTemplates.technique;
      } else if (text.includes('ストレッチ') || text.includes('運動') || text.includes('ケア')) {
        sceneData = sceneTemplates.exercise;
      } else if (text.includes('まとめ') || text.includes('改善') || text.includes('効果')) {
        sceneData = sceneTemplates.conclusion;
      }
    }

    // より多様性のためのランダム要素
    const variations = {
      age: ['young', 'middle-aged'],
      pose: ['sitting', 'standing'],
      lighting: ['soft natural light', 'warm indoor lighting', 'bright daylight']
    };
    
    const randomAge = variations.age[Math.floor(Math.random() * variations.age.length)];
    const randomLighting = variations.lighting[Math.floor(Math.random() * variations.lighting.length)];

    // 完全英語プロンプト生成
    return `${randomAge} ${sceneData.scene}, ${sceneData.action}, ${sceneData.emotion}, ${sceneData.setting}, ${randomLighting}, ${styleMap[style] || 'professional'}, no text, no letters, high quality`;
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