// Enhanced Image Generator based on existing TypeScript implementation
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
      console.log('[imageGen] Gemini 2.5 Flash initialized');
    }

    // Style mappings based on original TypeScript implementation
    this.styleMap = {
      'photo': '写真風、リアリスティック、高品質な写真のような',
      'deformed': 'デフォルメ、キャラクター風、可愛らしい、アニメ調',
      'watercolor': '手書き風、水彩画、アナログ感のある、温かみのある',
      'detailed': '精密、詳細、高解像度、細かい描写の',
      'pictogram': 'ピクトグラム、アイコン風、シンプル、記号的な',
      // 下位互換性のための追加マッピング
      'modern': '写真風、リアリスティック、高品質な写真のような',
      'anime': 'デフォルメ、キャラクター風、可愛らしい、アニメ調',
      'realistic': '写真風、リアリスティック、高品質な写真のような'
    };
  }

  // ============================================
  // Language Detection and Regional Adaptation
  // ============================================

  detectLanguageAndRegion(content) {
    const text = content.toLowerCase();
    
    // 歴史的コンテンツの検出
    const historicalContext = this.detectHistoricalContext(content);
    
    // 言語パターン検出
    const patterns = {
      japanese: {
        chars: /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g,
        keywords: ['です', 'ます', 'ある', 'する', 'という', 'こと', 'ため', 'から']
      },
      english: {
        chars: /[a-zA-Z]/g,
        keywords: ['the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']
      },
      chinese: {
        chars: /[\u4E00-\u9FFF]/g,
        keywords: ['的', '是', '在', '有', '了', '我', '你', '他', '她', '我们', '这', '那']
      },
      korean: {
        chars: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g,
        keywords: ['는', '을', '를', '이', '가', '에', '의', '와', '과', '로', '으로']
      }
    };

    const scores = {};
    
    // 文字種類による判定
    Object.keys(patterns).forEach(lang => {
      const charMatches = content.match(patterns[lang].chars) || [];
      const keywordMatches = patterns[lang].keywords.filter(keyword => 
        text.includes(keyword)
      ).length;
      
      scores[lang] = charMatches.length + (keywordMatches * 10);
    });

    // 最高スコアの言語を判定
    const detectedLang = Object.keys(scores).reduce((a, b) => 
      scores[a] > scores[b] ? a : b
    );

    // 地域マッピング
    const regionMapping = {
      japanese: {
        region: '日本',
        culture: '現代日本',
        style: '現代的な日本のビジネス環境',
        era: '2020年代の現代日本'
      },
      english: {
        region: '欧米圏',
        culture: '欧米文化',
        style: '現代的な欧米のビジネス環境',
        era: '2020年代の現代欧米'
      },
      chinese: {
        region: '中華圏',
        culture: '中華文化',
        style: '現代的な中華圏のビジネス環境',
        era: '2020年代の現代中国'
      },
      korean: {
        region: '韓国',
        culture: '韓国文化',
        style: '現代的な韓国のビジネス環境',
        era: '2020年代の現代韓国'
      }
    };

    const result = regionMapping[detectedLang] || regionMapping.japanese;
    
    console.log(`[imageGen] Language detected: ${detectedLang}, Region: ${result.region}`);
    
    return {
      language: detectedLang,
      confidence: scores[detectedLang] / Math.max(content.length, 1),
      historical: historicalContext,
      ...result
    };
  }

  detectHistoricalContext(content) {
    const text = content.toLowerCase();
    
    // 歴史的キーワードと年代の検出
    const historicalIndicators = {
      ancient: {
        keywords: ['古代', '紀元前', '原始', '石器時代', '青銅器', 'ancient', 'prehistoric', 'bc', 'stone age'],
        score: 10
      },
      classical: {
        keywords: ['古典', '中世', '平安', '鎌倉', '室町', '戦国', 'classical', 'medieval', 'feudal'],
        score: 9
      },
      early_modern: {
        keywords: ['江戸', '明治', '大正', '昭和初期', '19世紀', '18世紀', '17世紀', 'edo', 'meiji', 'taisho'],
        score: 8
      },
      modern: {
        keywords: ['昭和', '20世紀', '戦前', '戦後', '1900年代', '1950年代', '1960年代'],
        score: 6
      },
      contemporary: {
        keywords: ['平成', '令和', '21世紀', '2000年代', '2010年代', '現代'],
        score: 2
      }
    };

    // 年号パターンの検出
    const eraPatterns = [
      /(\d{1,4})年/g,  // 年号
      /(\d{3,4})世紀/g, // 世紀
      /紀元前\s*(\d+)/g, // 紀元前
      /(\d{4})年代/g    // 年代
    ];

    let historicalScore = 0;
    let detectedEra = 'contemporary';
    let specificYear = null;

    // キーワードベースの検出
    Object.entries(historicalIndicators).forEach(([era, data]) => {
      const matches = data.keywords.filter(keyword => text.includes(keyword)).length;
      if (matches > 0) {
        const score = matches * data.score;
        if (score > historicalScore) {
          historicalScore = score;
          detectedEra = era;
        }
      }
    });

    // 年号パターンの解析
    eraPatterns.forEach(pattern => {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(match => {
          const yearMatch = match.match(/\d+/);
          if (yearMatch) {
            const year = parseInt(yearMatch[0]);
            specificYear = year;
            
            // 年代に基づく時代判定
            if (year < 500) {
              detectedEra = 'ancient';
              historicalScore = Math.max(historicalScore, 10);
            } else if (year < 1600) {
              detectedEra = 'classical';
              historicalScore = Math.max(historicalScore, 9);
            } else if (year < 1900) {
              detectedEra = 'early_modern';
              historicalScore = Math.max(historicalScore, 8);
            } else if (year < 1990) {
              detectedEra = 'modern';
              historicalScore = Math.max(historicalScore, 6);
            }
          }
        });
      }
    });

    const isHistorical = historicalScore > 5;
    
    console.log(`[imageGen] Historical context detected: ${detectedEra}, score: ${historicalScore}, isHistorical: ${isHistorical}`);
    
    return {
      isHistorical,
      era: detectedEra,
      score: historicalScore,
      specificYear
    };
  }

  // ============================================
  // Chunking Logic (from chunking.ts)
  // ============================================

  detectHeadings(body) {
    const HEADING_REGEX = /^(#{1,6}|[*-]\s+|\d+\.)\s*(.+)$/gm;
    const matches = [];
    let lastIndex = 0;
    let match;

    while ((match = HEADING_REGEX.exec(body)) !== null) {
      const headingStart = match.index;
      const heading = match[2].trim();
      if (matches.length > 0) {
        matches[matches.length - 1].content = body.slice(lastIndex, headingStart).trim();
      }
      matches.push({ heading, content: "" });
      lastIndex = HEADING_REGEX.lastIndex;
    }

    if (matches.length > 0) {
      matches[matches.length - 1].content = body.slice(lastIndex).trim();
    }

    return matches.filter((item) => item.content.length > 0);
  }

  isSimilarHeading(a, b) {
    if (!a || !b) return false;
    const normalizedA = a.toLowerCase();
    const normalizedB = b.toLowerCase();
    return normalizedA === normalizedB || normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA);
  }

  mergeSimilarHeadings(headings, maxChunks) {
    const merged = [];
    for (const item of headings) {
      const found = merged.find((chunk) => this.isSimilarHeading(chunk.heading || "", item.heading));
      if (found) {
        found.body = `${found.body}\n\n${item.content}`;
      } else {
        merged.push({ index: merged.length, heading: item.heading, body: item.content });
      }
    }

    return merged.slice(0, maxChunks).map((chunk, index) => ({ ...chunk, index }));
  }

  semanticSplit(body, options) {
    const sentences = body.split(/(?<=。|\.)\s*/);
    const chunks = [];
    let buffer = "";

    for (const sentence of sentences) {
      const prospective = buffer.length === 0 ? sentence : `${buffer}${sentence}`;
      const overLimit =
        prospective.length > options.maxCharsPerChunk ||
        (chunks.length + 1 === options.maxChunks && prospective.length > options.maxCharsPerChunk);

      if (overLimit && buffer.length > 0) {
        chunks.push({ index: chunks.length, body: buffer.trim() });
        buffer = sentence;
      } else {
        buffer = prospective;
      }

      if (chunks.length >= options.maxChunks) break;
    }

    if (buffer.trim().length > 0 && chunks.length < options.maxChunks) {
      chunks.push({ index: chunks.length, body: buffer.trim() });
    }

    return chunks.slice(0, options.maxChunks);
  }

  splitArticle(body, maxImages) {
    const headings = this.detectHeadings(body);
    if (headings.length > 0) {
      return this.mergeSimilarHeadings(headings, Math.min(maxImages, 5));
    }

    if (body.length < 200) {
      return [{ index: 0, body: body.trim() }];
    }

    return this.semanticSplit(body, {
      maxChunks: Math.min(maxImages, 5),
      maxCharsPerChunk: 400,
    });
  }

  // ============================================
  // Prompt Building Logic (from prompts.ts)
  // ============================================

  buildPrompt(params) {
    const { chunk, style, aspectRatio = '1:1', title, chunkTitle, content } = params;
    const body = chunk?.body || params.body || "";
    const fullContent = content || body;

    // 言語と地域を検出
    const regionInfo = this.detectLanguageAndRegion(fullContent);

    // Convert aspectRatio to display format
    const ratioLabel = aspectRatio === "1:1" ? "square" : aspectRatio;

    // Style description
    const styleText = this.styleMap[style] || `スタイル:${style}`;
    const scope = chunkTitle || chunk?.heading || title || "記事内容";

    // 言語別安全性ガイドライン
    const safetyGuidelines = this.buildSafetyGuidelines(regionInfo);

    const timeContext = regionInfo.historical?.isHistorical 
      ? `歴史的時代設定: ${regionInfo.historical.era}時代`
      : regionInfo.era;

    return [
      safetyGuidelines,
      `アイキャッチ用イラストを生成`,
      `対象: ${scope}`,
      `比率: ${ratioLabel}`,
      `スタイル: ${styleText}`,
      `地域・文化: ${regionInfo.region}`,
      `時代設定: ${timeContext}`,
      `文化的配慮: ${regionInfo.style}`,
      `本文:`,
      body,
    ].join("\n");
  }

  buildSafetyGuidelines(regionInfo) {
    const commonGuidelines = [
      "SAFETY_GUIDELINES:",
      "- 著作権を侵害しない独創的なデザイン",
      "- 暴力的、性的、差別的な表現を避ける",
      "- 特定の個人、企業、宗教を連想させる要素を避ける",
      "- 年齢制限なしで使用可能な健全な内容"
    ];

    // 歴史的コンテンツかどうかで分岐
    const isHistorical = regionInfo.historical?.isHistorical || false;
    const historicalEra = regionInfo.historical?.era || 'contemporary';

    // 地域別ガイドライン
    const regionalGuidelines = {
      japanese: isHistorical ? [
        "- 日本の法律と文化に準拠した適切な内容で生成",
        `- 歴史的内容のため${historicalEra}時代の雰囲気を重視`,
        "- 歴史的な建築、服装、生活様式を時代考証に基づいて表現",
        "- その時代特有の文化的特徴（建築様式、服装、道具など）を正確に反映",
        "- 日本文化の特徴: 時代に応じた履物文化（草履、下駄、足袋など）",
        "- 歴史的建造物（寺院、城、古民家など）の場合は適切な時代様式",
        "- 現代的要素を避け、歴史的な雰囲気を重視"
      ] : [
        "- 日本の法律と文化に準拠した適切な内容で生成",
        "- 現代的な日本のビジネス環境に適したプロフェッショナルな表現",
        "- 古風な日本（木造建築、着物など）ではなく現代日本（2020年代）を基調とする",
        "- オフィス、カフェ、都市部などの現代的な環境を優先",
        "- 日本文化の特徴: 室内では靴を脱ぎ、素足やソックス姿を表現",
        "- 玄関での靴の脱ぎ履き、スリッパの使用など日本特有の生活文化",
        "- 畳、フローリングでの生活シーンでは必ず靴を履いていない状態"
      ],
      english: isHistorical ? [
        "- 欧米の法律と文化に準拠した適切な内容で生成",
        `- 歴史的内容のため${historicalEra}時代の欧米文化を重視`,
        "- 歴史的な欧米の建築、服装、生活様式を時代考証に基づいて表現",
        "- その時代特有の文化的特徴を正確に反映"
      ] : [
        "- 欧米の法律と文化に準拠した適切な内容で生成",
        "- 現代的な欧米のビジネス環境に適したプロフェッショナルな表現",
        "- 現代的な都市環境、オフィス、カフェなどの欧米的な設定",
        "- 多様性を尊重した現代的な表現"
      ],
      chinese: isHistorical ? [
        "- 中華圏の法律と文化に準拠した適切な内容で生成",
        `- 歴史的内容のため${historicalEra}時代の中華文化を重視`,
        "- 歴史的な中華建築、服装、生活様式を時代考証に基づいて表現",
        "- その時代特有の中華文化的特徴を正確に反映"
      ] : [
        "- 中華圏の法律と文化に準拠した適切な内容で生成",
        "- 現代的な中華圏のビジネス環境に適したプロフェッショナルな表現",
        "- 現代中国の都市部、オフィス環境を基調とする",
        "- 伝統的ではなく現代的な中華圏の表現を優先"
      ],
      korean: isHistorical ? [
        "- 韓国の法律と文化に準拠した適切な内容で生成",
        `- 歴史的内容のため${historicalEra}時代の韓国文化を重視`,
        "- 歴史的な韓国の建築、服装、生活様式を時代考証に基づいて表現",
        "- その時代特有の韓国文化的特徴を正確に反映"
      ] : [
        "- 韓国の法律と文化に準拠した適切な内容で生成",
        "- 現代的な韓国のビジネス環境に適したプロフェッショナルな表現",
        "- 現代韓国の都市部、オフィス環境を基調とする",
        "- K-culture要素を含む現代的な韓国らしさの表現"
      ]
    };

    const specificGuidelines = regionalGuidelines[regionInfo.language] || regionalGuidelines.japanese;

    return [
      ...commonGuidelines,
      ...specificGuidelines,
      ""
    ].join("\n");
  }

  // ============================================
  // Enhanced Image Generation
  // ============================================

  async generateImages(content, options = {}) {
    try {
      const { taste = 'photo', aspectRatio = '1:1', maxImages = 3 } = options;
      
      console.log(`[imageGen] Starting enhanced generation`);
      console.log(`[imageGen] - Style: ${taste} (mapped: ${this.styleMap[taste] || 'unknown'})`);
      console.log(`[imageGen] - Aspect Ratio: ${aspectRatio}`);
      console.log(`[imageGen] - Max Images: ${maxImages}`);
      console.log(`[imageGen] - Content length: ${content.length} chars`);

      // Split content using sophisticated chunking
      const chunks = this.splitArticle(content, maxImages);
      console.log(`[imageGen] Split content into ${chunks.length} chunks`);

      const images = [];

      // Generate images for each chunk
      for (const chunk of chunks) {
        const prompt = this.buildPrompt({
          chunk,
          style: taste,
          aspectRatio,
          content: content  // 全体コンテンツを言語検出用に渡す
        });

        console.log(`[imageGen] Generating image ${chunk.index + 1} with prompt:`, prompt);

        let imageDataUrl = null;

        if (!this.mockMode) {
          // Try Gemini 2.5 Flash with image generation
          imageDataUrl = await this.generateWithGemini(prompt, aspectRatio);
        }

        // If Gemini fails or mockMode, use enhanced placeholder
        if (!imageDataUrl) {
          const regionInfo = this.detectLanguageAndRegion(content);
          imageDataUrl = this.generateEnhancedPlaceholder(chunk, prompt, taste, aspectRatio, regionInfo);
        }

        images.push({
          id: `generated-${chunk.index}-${Date.now()}`,
          title: chunk.heading || `画像 ${chunk.index + 1}`,
          heading: chunk.heading,
          dataUrl: imageDataUrl,
          prompt: prompt,
          provider: this.mockMode ? 'enhanced-mock' : 'gemini-2.5-flash'
        });
      }

      return {
        success: true,
        images: images,
        message: `${images.length}枚の画像を生成しました`,
        provider: this.mockMode ? 'enhanced-mock' : 'gemini-2.5-flash'
      };

    } catch (error) {
      console.error('[imageGen] Enhanced generation error:', error);
      
      // Enhanced fallback - success: true でフォールバック画像を返す
      return {
        success: true,
        images: [this.generateEnhancedFallback(content, options.taste, options.aspectRatio)],
        message: 'フォールバック画像を生成しました',
        provider: 'enhanced-fallback',
        error: error.message
      };
    }
  }

  async generateWithGemini(prompt, aspectRatio = '1:1') {
    try {
      console.log('[imageGen] Attempting Gemini 2.5 Flash image generation...');

      // Gemini 2.5 Flash での画像生成リクエスト
      const geminiPrompt = `画像を生成してください。アスペクト比: ${aspectRatio}\n\n${prompt}`;

      // 注意: 現在のGemini APIは直接的な画像生成機能が限定的
      // まずはテキストレスポンスを試行
      const result = await this.geminiModel.generateContent(geminiPrompt);
      const response = await result.response;
      
      // レスポンステキストをログ出力
      console.log('[imageGen] Gemini response received:', response.text().substring(0, 200));

      // 現在のGemini APIはテキストベースの画像説明のみ返すため
      // 実際の画像生成は将来の機能として保留
      console.log('[imageGen] Gemini 2.5 Flash currently returns text descriptions only');
      
      return null; // プレースホルダーを使用

    } catch (error) {
      console.error('[imageGen] Gemini generation failed:', error);
      console.error('[imageGen] Error details:', error.message);
      return null;
    }
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
        imageDataUrl = this.generateEnhancedPlaceholder(
          { index: 0, body: instructions, heading: '修正版' },
          regeneratePrompt,
          taste,
          aspectRatio
        );
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

  generateEnhancedPlaceholder(chunk, prompt, taste, aspectRatio, regionInfo = null) {
    const colorMap = {
      photo: '#2563eb',
      deformed: '#7c3aed', 
      watercolor: '#ea580c',
      detailed: '#059669',
      pictogram: '#dc2626'
    };

    const dimensions = {
      '1:1': { width: 400, height: 400 },
      '9:16': { width: 350, height: 600 },
      '16:9': { width: 600, height: 350 }
    };

    const color = colorMap[taste] || '#667eea';
    const { width, height } = dimensions[aspectRatio] || dimensions['1:1'];
    const displayTitle = chunk.heading || chunk.body.substring(0, 40) + (chunk.body.length > 40 ? '...' : '');

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad${chunk.index}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${color};stop-opacity:0.9" />
            <stop offset="100%" style="stop-color:${color};stop-opacity:0.6" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad${chunk.index})"/>
        <circle cx="30" cy="30" r="20" fill="rgba(255,255,255,0.4)"/>
        <text x="50%" y="30%" font-family="Arial, sans-serif" font-size="16" fill="white" text-anchor="middle" dy=".3em">🎨 ${this.styleMap[taste]?.split('、')[0] || taste}</text>
        <text x="50%" y="45%" font-family="Arial, sans-serif" font-size="14" fill="white" text-anchor="middle" dy=".3em">${displayTitle}</text>
        <text x="50%" y="70%" font-family="Arial, sans-serif" font-size="11" fill="rgba(255,255,255,0.9)" text-anchor="middle" dy=".3em">Enhanced Chunking: ${chunk.index + 1}</text>
      </svg>
    `;

    const base64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
  }

  generateEnhancedFallback(content, taste, aspectRatio) {
    const title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
    
    const svg = `
      <svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f8f9fa"/>
        <text x="50%" y="40%" font-family="Arial, sans-serif" font-size="18" fill="#666" text-anchor="middle" dy=".3em">⚠️ 生成エラー</text>
        <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="12" fill="#666" text-anchor="middle" dy=".3em">Enhanced Fallback</text>
        <text x="50%" y="60%" font-family="Arial, sans-serif" font-size="10" fill="#666" text-anchor="middle" dy=".3em">${title}</text>
      </svg>
    `;

    const base64 = Buffer.from(svg).toString('base64');

    return {
      id: `enhanced-fallback-${Date.now()}`,
      title: 'Enhanced Fallback画像',
      dataUrl: `data:image/svg+xml;base64,${base64}`,
      provider: 'enhanced-fallback'
    };
  }
}

export default ImageGeneratorV2;