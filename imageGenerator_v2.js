class ImageGeneratorV2 {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.geminiApiKey = process.env.GEMINI_API_KEY;
    this.huggingfaceApiKey = process.env.HUGGINGFACE_API_KEY;
    this.mockMode = !this.geminiApiKey;
    
    if (!this.openaiApiKey) {
      console.warn('[imageGen] OpenAI API key not found - using local processing');
    }
    if (!this.geminiApiKey) {
      console.warn('[imageGen] Gemini API key not found - using mock mode');
    }
    
    console.log(`[imageGen] ImageGenerator initialized (mock: ${this.mockMode})`);
  }

  // メイン画像生成関数
  async generateImages(content, options = {}) {
    const { taste = 'photo', aspectRatio = '1:1', maxImages = 5 } = options;
    
    try {
      console.log(`[imageGen] Starting generation: style=${taste}, ratio=${aspectRatio}`);
      
      // 画像枚数決定
      const imageCount = this.calculateImageCount(content, maxImages);
      console.log(`[imageGen] Target image count: ${imageCount}`);
      
      // コンテンツを分割
      const chunks = await this.splitContent(content, imageCount);
      console.log(`[imageGen] Split into ${chunks.length} chunks`);
      
      // 各チャンクから画像生成
      const images = [];
      for (const chunk of chunks) {
        const scene = await this.extractScene(chunk);
        const prompt = await this.sceneToPrompt(scene, taste);
        
        console.log(`[imageGen] 🎨 Chunk ${chunk.index}: "${scene.substring(0, 50)}..."`);
        console.log(`[imageGen] 📝 Prompt: "${prompt}"`);
        
        let imageDataUrl = null;
        if (!this.mockMode) {
          imageDataUrl = await this.generateImageWithGemini(prompt, aspectRatio);
        }
        
        if (!imageDataUrl) {
          imageDataUrl = this.generatePlaceholderImage(chunk, prompt, taste, aspectRatio);
        }
        
        images.push({
          id: `img-${Date.now()}-${chunk.index}`,
          title: chunk.heading || `画像 ${chunk.index + 1}`,
          dataUrl: imageDataUrl,
          provider: this.mockMode ? 'placeholder' : 'gemini'
        });
      }
      
      return {
        success: true,
        images,
        message: `${images.length}枚の画像を生成しました`
      };
      
    } catch (error) {
      console.error('[imageGen] Generation error:', error);
      return {
        success: false,
        images: [],
        message: 'エラーが発生しました',
        error: error.message
      };
    }
  }

  // 画像枚数を計算（汎用的）
  calculateImageCount(content, maxImages = 5) {
    // null/undefinedチェック
    if (!content || typeof content !== 'string') {
      return 1;
    }
    
    const length = content.length;
    
    // 空文字列の場合
    if (length === 0) {
      return 1;
    }
    
    // 段落数をカウント
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 50);
    const paragraphCount = paragraphs.length;
    
    // 文字数ベースの計算（修正済み）
    let count = 1;
    if (length > 500) count = 2;
    if (length > 800) count = 3; 
    if (length > 1200) count = 4;
    if (length > 1600) count = 5;
    
    // 段落数も考慮
    if (paragraphCount >= 5) {
      count = Math.max(count, Math.min(5, paragraphCount));
    }
    
    return Math.min(count, maxImages);
  }

  // コンテンツ分割（汎用的）
  async splitContent(content, targetCount) {
    // 空コンテンツの場合
    if (!content || content.trim().length === 0) {
      return [{
        index: 0,
        text: 'コンテンツがありません',
        heading: null
      }];
    }
    
    if (this.openaiApiKey) {
      try {
        const result = await this.splitWithGPT(content, targetCount);
        if (result && result.length > 0) {
          return result;
        }
      } catch (error) {
        console.warn('[imageGen] GPT splitting failed:', error.message);
      }
    }
    
    return this.splitContentLocal(content, targetCount);
  }

  // GPTを使った意味的分割
  async splitWithGPT(content, targetCount) {
    const systemPrompt = `You are a content analyzer. Split the given text into ${targetCount} meaningful segments.
Each segment should represent a distinct visual scene or concept.
Return a JSON array with objects containing: {"text": "segment content", "summary": "visual description"}`;

    const userPrompt = `Split this content into ${targetCount} visual segments:\n\n${content}`;

    const response = await this.callOpenAI(systemPrompt, userPrompt);
    const parsed = this.parseGPTResponse(response);
    
    return parsed.map((item, index) => ({
      index,
      text: item.text,
      heading: item.summary || null
    }));
  }

  // ローカル分割（汎用的）
  splitContentLocal(content, targetCount) {
    // 段落ベースで分割を試みる
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20);
    
    if (paragraphs.length >= targetCount) {
      // 段落数が十分なら、均等に選択
      const step = Math.floor(paragraphs.length / targetCount);
      const chunks = [];
      for (let i = 0; i < targetCount; i++) {
        const idx = i * step;
        chunks.push({
          index: i,
          text: paragraphs[idx],
          heading: null
        });
      }
      return chunks;
    }
    
    // 段落が少ない場合は文字数で均等分割
    const chunkSize = Math.ceil(content.length / targetCount);
    const chunks = [];
    
    for (let i = 0; i < targetCount; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize, content.length);
      chunks.push({
        index: i,
        text: content.substring(start, end).trim(),
        heading: null
      });
    }
    
    return chunks;
  }

  // シーン抽出（汎用的）
  async extractScene(chunk) {
    if (this.openaiApiKey) {
      try {
        const systemPrompt = `Extract the main visual scene from the text. 
Focus on: people, actions, objects, settings, emotions.
Be concise and specific.`;

        const userPrompt = `Extract visual scene:\n${chunk.text}`;
        
        const response = await this.callOpenAI(systemPrompt, userPrompt);
        if (response && response.length > 30) {
          return response.trim();
        }
      } catch (error) {
        console.warn('[imageGen] Scene extraction failed:', error.message);
      }
    }
    
    // フォールバック：重要な文を抽出
    const sentences = chunk.text.split(/[。！？]/);
    const importantSentences = sentences.filter(s => 
      s.length > 10 && (s.includes('は') || s.includes('が') || s.includes('を'))
    );
    
    return importantSentences.slice(0, 2).join('。') || chunk.text.substring(0, 100);
  }

  // プロンプト生成（汎用的）
  async sceneToPrompt(sceneText, style) {
    const styleGuides = {
      photo: 'photorealistic photograph',
      deformed: 'cute anime chibi style',
      watercolor: 'watercolor painting',
      detailed: 'detailed illustration',
      pictogram: 'simple pictogram icon'
    };

    if (this.openaiApiKey) {
      try {
        const systemPrompt = `Convert text to image generation prompt.
Rules:
- Extract visual elements only
- Include style: ${styleGuides[style]}
- Add "no text, no letters"
- Keep under 120 characters
- Be specific and clear`;

        const userPrompt = `Convert to image prompt:\n${sceneText}`;
        
        const response = await this.callOpenAI(systemPrompt, userPrompt);
        if (response && response.includes('no text')) {
          return response.trim();
        }
      } catch (error) {
        console.warn('[imageGen] Prompt generation failed:', error.message);
      }
    }
    
    // フォールバック：基本的なプロンプト生成
    return this.generateBasicPrompt(sceneText, style);
  }

  // 基本的なプロンプト生成（汎用的）
  generateBasicPrompt(text, style) {
    const styleMap = {
      photo: 'photorealistic photography',
      deformed: 'cute anime chibi style',
      watercolor: 'watercolor painting art',
      detailed: 'detailed illustration',
      pictogram: 'simple icon pictogram'
    };

    // キーワード抽出
    const keywords = this.extractKeywords(text);
    
    // プロンプト組み立て
    const elements = [];
    
    if (keywords.person) elements.push(keywords.person);
    if (keywords.action) elements.push(keywords.action);
    if (keywords.object) elements.push(keywords.object);
    if (keywords.setting) elements.push(keywords.setting);
    
    elements.push(styleMap[style] || 'photography');
    elements.push('no text, no letters');
    elements.push('high quality');
    
    return elements.join(', ');
  }

  // キーワード抽出（汎用的）
  extractKeywords(text) {
    const keywords = {
      person: null,
      action: null,
      object: null,
      setting: null
    };
    
    if (!text) return keywords;

    // 人物検出（改善）
    if (text.match(/人|男性|女性|子供|子ども|老人|若者|私|彼|彼女/)) {
      keywords.person = 'person';
    }

    // 動作検出（改善）
    if (text.match(/している|した|する|します|歩|走|食べ|読|書|見|聞|話/)) {
      keywords.action = 'performing action';
    }

    // 場所検出（改善）
    if (text.match(/室内|屋内|部屋|家|中|店|オフィス|学校/)) {
      keywords.setting = 'indoor scene';
    } else if (text.match(/屋外|外|公園|街|道|庭|山|海|空/)) {
      keywords.setting = 'outdoor scene';
    }

    // 主要な名詞を探す（改善）
    const nounMatch = text.match(/[ァ-ヶー]{2,}|[一-龠]{2,}/g);
    if (nounMatch && nounMatch.length > 0) {
      // 最初の意味のある名詞を選択
      for (const noun of nounMatch) {
        if (noun.length >= 2 && noun.length <= 10) {
          keywords.object = noun;
          break;
        }
      }
    }

    return keywords;
  }

  // OpenAI API呼び出し
  async callOpenAI(systemPrompt, userPrompt) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  // GPTレスポンスのパース
  parseGPTResponse(response) {
    try {
      // 空レスポンスチェック
      if (!response) return [];
      
      // JSONブロックを抽出
      let jsonStr = response;
      if (response.includes('```json')) {
        const match = response.match(/```json\n?([\s\S]*?)\n?```/);
        if (match) jsonStr = match[1];
      } else if (response.includes('```')) {
        const match = response.match(/```\n?([\s\S]*?)\n?```/);
        if (match) jsonStr = match[1];
      }
      
      const parsed = JSON.parse(jsonStr);
      
      // 配列でない場合、配列に変換
      if (!Array.isArray(parsed)) {
        return [parsed];
      }
      
      return parsed;
    } catch (error) {
      console.error('[imageGen] Failed to parse GPT response:', error);
      return [];
    }
  }

  // Gemini画像生成（修正版）
  async generateImageWithGemini(prompt, aspectRatio = '1:1') {
    if (!this.geminiApiKey) return null;

    // 方法1: Imagen 3を試行
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImage?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: prompt,
            config: {
              aspectRatio: aspectRatio,
              safetyFilterLevel: "BLOCK_ONLY_HIGH",
              personGeneration: "ALLOW_ADULT"
            }
          })
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log('[imageGen] Imagen 3 response:', Object.keys(data));
        
        if (data.generatedImages && data.generatedImages.length > 0) {
          const imageData = data.generatedImages[0];
          if (imageData.bytesBase64Encoded) {
            console.log('[imageGen] ✅ Imagen 3 success');
            return `data:image/png;base64,${imageData.bytesBase64Encoded}`;
          }
        }
      } else {
        console.warn('[imageGen] Imagen 3 failed:', response.status);
      }
    } catch (error) {
      console.warn('[imageGen] Imagen 3 error:', error.message);
    }

    // 方法2: 古いImagenAPIを試行
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/imagegeneration-004:generateImage?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: prompt,
            config: {
              aspectRatio: aspectRatio
            }
          })
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log('[imageGen] Legacy Imagen response:', Object.keys(data));
        
        if (data.generatedImages && data.generatedImages.length > 0) {
          const imageData = data.generatedImages[0];
          if (imageData.bytesBase64Encoded) {
            console.log('[imageGen] ✅ Legacy Imagen success');
            return `data:image/png;base64,${imageData.bytesBase64Encoded}`;
          }
        }
      } else {
        console.warn('[imageGen] Legacy Imagen failed:', response.status);
      }
    } catch (error) {
      console.warn('[imageGen] Legacy Imagen error:', error.message);
    }

    console.error('[imageGen] All Gemini methods failed');
    return null;
  }

  // プレースホルダー画像生成
  generatePlaceholderImage(chunk, prompt, style, aspectRatio) {
    const [width, height] = aspectRatio === '16:9' ? [1920, 1080] : 
                            aspectRatio === '9:16' ? [1080, 1920] : 
                            [1024, 1024];
    
    const colors = {
      photo: '#4A90E2',
      deformed: '#FF6B9D',
      watercolor: '#95E1D3',
      detailed: '#8B5CF6',
      pictogram: '#10B981'
    };
    
    const bgColor = colors[style] || '#6B7280';
    // XML特殊文字をエスケープ
    const escapeXml = (str) => {
      if (!str) return '';
      return str.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };
    
    const title = escapeXml(chunk.heading || `画像 ${chunk.index + 1}`);
    const safeStyle = escapeXml(style);
    
    const svgContent = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect fill="${bgColor}" width="${width}" height="${height}"/>
        <text x="50%" y="40%" font-family="Arial" font-size="36" fill="white" text-anchor="middle">
          ${title}
        </text>
        <text x="50%" y="50%" font-family="Arial" font-size="18" fill="white" text-anchor="middle">
          画像生成中...
        </text>
        <text x="50%" y="60%" font-family="Arial" font-size="14" fill="white" text-anchor="middle">
          スタイル: ${safeStyle}
        </text>
      </svg>`;
    
    // btoaはNode.jsではラテン文字のみサポート
    const base64 = Buffer.from(svgContent).toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
  }

  // 画像再生成
  async regenerateSingleImage(originalPrompt, instructions, options = {}) {
    const { taste = 'photo', aspectRatio = '1:1' } = options;
    
    try {
      // 新しいプロンプトを生成
      const newPrompt = await this.buildRegeneratePrompt(originalPrompt, instructions, taste);
      
      let imageDataUrl = null;
      if (!this.mockMode) {
        imageDataUrl = await this.generateImageWithGemini(newPrompt, aspectRatio);
      }
      
      if (!imageDataUrl) {
        imageDataUrl = this.generatePlaceholderImage(
          { index: 0, heading: 'Regenerated' },
          newPrompt,
          taste,
          aspectRatio
        );
      }
      
      return {
        success: true,
        image: {
          id: `regen-${Date.now()}`,
          title: '再生成画像',
          dataUrl: imageDataUrl,
          provider: this.mockMode ? 'placeholder' : 'gemini'
        },
        message: '画像を再生成しました'
      };
      
    } catch (error) {
      console.error('[imageGen] Regeneration error:', error);
      return {
        success: false,
        message: '再生成に失敗しました',
        error: error.message
      };
    }
  }

  // 再生成プロンプト作成
  async buildRegeneratePrompt(originalPrompt, instructions, style) {
    if (this.openaiApiKey) {
      try {
        const systemPrompt = `Modify the image prompt based on user instructions.
Keep the core scene but apply the requested changes.`;

        const userPrompt = `Original: ${originalPrompt}\nChanges: ${instructions}\nStyle: ${style}`;
        
        const response = await this.callOpenAI(systemPrompt, userPrompt);
        if (response && response.length > 30) {
          return response.trim();
        }
      } catch (error) {
        console.warn('[imageGen] Regenerate prompt failed:', error.message);
      }
    }
    
    // フォールバック
    return `${originalPrompt}, modified: ${instructions}, no text, no letters`;
  }
}

export default ImageGeneratorV2;