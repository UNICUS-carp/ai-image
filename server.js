import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import Database from "./database.js";
import PasskeyAuthenticator from "./auth.js";

const app = express();

// CORS設定（本番環境では制限）
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || ['https://unicus.top']
    : true, // 開発環境では全許可
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'X-Dev-Token']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));

// 悪意のあるボット・攻撃者対策
app.use('/api/', (req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  const suspicious = [
    'bot', 'crawler', 'spider', 'scan', 'test', 'python', 'curl', 'wget',
    'automated', 'scraper', 'hack', 'exploit', 'injection', 'attack'
  ];
  
  if (suspicious.some(pattern => userAgent.toLowerCase().includes(pattern))) {
    console.log(`[security] Suspicious user-agent blocked: ${userAgent}`);
    return res.status(403).json({
      error: "BLOCKED",
      message: "不正なアクセスが検出されました"
    });
  }
  next();
});

// グローバルレート制限（一般的なAPIアクセス）
const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 15分間に100リクエスト
  message: {
    error: "RATE_LIMIT_EXCEEDED",
    message: "アクセス頻度が高すぎます。しばらく待ってから再試行してください"
  },
  standardHeaders: true,
  legacyHeaders: false
});

// 認証関連のレート制限（より厳しく）
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 10, // 15分間に10回
  message: {
    error: "AUTH_RATE_LIMIT_EXCEEDED",
    message: "認証試行回数が多すぎます。しばらく待ってから再試行してください"
  }
});

// APIエンドポイントにレート制限を適用
app.use('/api/auth/', authRateLimit);
app.use('/api/', globalRateLimit);

// セキュリティヘッダー設定（強化版）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://generativelanguage.googleapis.com https://api.openai.com;");
  }
  next();
});

// 不正なリクエストペイロード検証
app.use((req, res, next) => {
  const suspiciousPatterns = [
    /<script[^>]*>.*?<\/script>/gi,
    /javascript:/gi,
    /vbscript:/gi,
    /onload\s*=/gi,
    /onerror\s*=/gi,
    /eval\s*\(/gi,
    /document\.cookie/gi,
    /document\.write/gi,
    /window\.location/gi,
    /'\s*(union|select|insert|update|delete|drop|create|alter)\s+/gi,
    /\b(union|select|insert|update|delete|drop|create|alter)\b.*\b(from|into|set|table|database)\b/gi
  ];
  
  const checkPayload = (obj) => {
    if (typeof obj === 'string') {
      return suspiciousPatterns.some(pattern => pattern.test(obj));
    }
    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj).some(value => checkPayload(value));
    }
    return false;
  };
  
  if (req.body && checkPayload(req.body)) {
    console.log(`[security] Malicious payload detected from IP: ${req.ip}`);
    return res.status(400).json({
      error: "INVALID_REQUEST",
      message: "リクエストに不正な内容が含まれています"
    });
  }
  
  next();
});

// データベースと認証システムの初期化
const db = new Database();
const auth = new PasskeyAuthenticator(db);

// アプリケーション初期化
async function initializeApp() {
  try {
    await db.initialize();
    console.log('[app] Database initialized successfully');
    
    // 定期クリーンアップの設定（1時間ごと）
    setInterval(() => {
      auth.cleanup();
    }, 60 * 60 * 1000);
    
    console.log('[app] Authentication system initialized');
  } catch (error) {
    console.error('[app] Failed to initialize application:', error);
    process.exit(1);
  }
}

// アプリケーションを初期化
await initializeApp();

const MAX_CONTENT_LENGTH = 5000;

// OpenAI API設定
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ========================================
// デバッグ用：設定確認（開発環境のみ）
// ========================================
if (process.env.NODE_ENV !== 'production') {
  app.get("/debug/config", (req, res) => {
    res.json({
      NODE_ENV: process.env.NODE_ENV || "development",
      hasGeminiApiKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      model: "gemini-2.5-flash-image",
      maxContentLength: MAX_CONTENT_LENGTH
    });
  });
}

// ========================================
// 認証ミドルウェア
// ========================================
async function requireAuth(req, res, next) {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '') || 
                     req.headers['x-session-id'];
    
    if (!sessionId) {
      return res.status(401).json({ 
        error: "AUTHENTICATION_REQUIRED",
        message: "認証が必要です" 
      });
    }

    const validation = await auth.validateSession(sessionId);
    if (!validation.valid) {
      return res.status(401).json({ 
        error: "INVALID_SESSION",
        message: validation.message 
      });
    }

    req.user = validation.user;
    req.sessionData = validation.sessionData;
    
    // ユーザーのロールを取得
    const userRole = await db.getUserRole(req.user.id);
    req.user.role = userRole;
    req.sessionData.role = userRole;
    
    // 開発者以外は支払い状況をチェック
    if (userRole !== 'developer') {
      const paymentStatus = await db.checkPaymentStatus(req.user.email);
      if (paymentStatus !== 'paid') {
        return res.status(403).json({
          error: "PAYMENT_REQUIRED",
          message: "サービスの利用には有効な決済が必要です",
          paymentStatus: paymentStatus || 'pending',
          instruction: "管理者による決済確認が完了していません"
        });
      }
    }
    
    next();
  } catch (error) {
    console.error('[auth] Authentication middleware error:', error);
    return res.status(500).json({ 
      error: "AUTHENTICATION_ERROR",
      message: "認証エラーが発生しました" 
    });
  }
}

// ========================================
// 使用量制限ミドルウェア
// ========================================
async function checkUsageLimits(req, res, next) {
  try {
    // 開発者は制限なし
    if (req.user?.role === 'developer') {
      console.log('[usage] Developer role - skipping usage limits');
      return next();
    }

    const userId = req.user.id;
    const isRegeneration = req.path.includes('regenerate');
    
    // 今日の使用量を取得
    const todayUsage = await db.getTodayUsage(userId);
    const currentArticleCount = todayUsage?.article_count || 0;
    const currentRegenerationCount = todayUsage?.regeneration_count || 0;
    
    // 制限値
    const DAILY_ARTICLE_LIMIT = 5;
    const DAILY_REGENERATION_LIMIT = 50;
    
    if (isRegeneration) {
      if (currentRegenerationCount >= DAILY_REGENERATION_LIMIT) {
        return res.status(429).json({
          error: "REGENERATION_LIMIT_EXCEEDED",
          message: `1日の再生成制限（${DAILY_REGENERATION_LIMIT}回）に達しました`,
          limits: {
            dailyRegenerationLimit: DAILY_REGENERATION_LIMIT,
            currentRegenerationCount,
            remainingRegenerations: 0
          }
        });
      }
    } else {
      if (currentArticleCount >= DAILY_ARTICLE_LIMIT) {
        return res.status(429).json({
          error: "ARTICLE_LIMIT_EXCEEDED", 
          message: `1日の記事生成制限（${DAILY_ARTICLE_LIMIT}記事）に達しました`,
          limits: {
            dailyArticleLimit: DAILY_ARTICLE_LIMIT,
            currentArticleCount,
            remainingArticles: 0
          }
        });
      }
    }
    
    // 制限内の場合は次へ
    req.usageInfo = {
      userId,
      isRegeneration,
      currentArticleCount,
      currentRegenerationCount,
      remainingArticles: DAILY_ARTICLE_LIMIT - currentArticleCount,
      remainingRegenerations: DAILY_REGENERATION_LIMIT - currentRegenerationCount
    };
    
    console.log(`[usage] User ${userId}: ${currentArticleCount}/${DAILY_ARTICLE_LIMIT} articles, ${currentRegenerationCount}/${DAILY_REGENERATION_LIMIT} regenerations`);
    next();
  } catch (error) {
    console.error('[usage] Usage limit check error:', error);
    return res.status(500).json({
      error: "USAGE_CHECK_ERROR",
      message: "使用量確認エラーが発生しました"
    });
  }
}

// 使用量更新ミドルウェア（成功時に実行）
async function incrementUsage(req, res, next) {
  try {
    if (req.user?.role === 'developer') {
      return next();
    }

    const { userId, isRegeneration } = req.usageInfo;
    const type = isRegeneration ? 'regeneration' : 'article';
    
    await db.incrementUsage(userId, type);
    console.log(`[usage] Incremented ${type} usage for user ${userId}`);
    
    next();
  } catch (error) {
    console.error('[usage] Usage increment error:', error);
    // エラーでもレスポンスは続行（使用量更新の失敗で処理を止めない）
    next();
  }
}

// ========================================
// Passkey認証エンドポイント
// ========================================

// 登録開始
app.post("/api/auth/register/begin", async (req, res) => {
  try {
    const { email, displayName } = req.body;
    
    if (!email) {
      return res.status(400).json({
        error: "EMAIL_REQUIRED",
        message: "メールアドレスが必要です"
      });
    }

    // 支払い状態をチェック
    const paymentStatus = await db.checkPaymentStatus(email);
    if (paymentStatus !== 'paid') {
      return res.status(403).json({
        error: "PAYMENT_REQUIRED",
        message: "サービスのご利用には決済が必要です",
        paymentStatus: paymentStatus || 'pending',
        instruction: "決済完了後、Passkey登録が可能になります"
      });
    }

    const result = await auth.generateRegistrationOptions(email, displayName);
    
    if (result.success) {
      res.json({
        success: true,
        options: result.options,
        userId: result.userId
      });
    } else {
      res.status(500).json({
        error: "REGISTRATION_FAILED",
        message: "登録の準備に失敗しました"
      });
    }
  } catch (error) {
    console.error('[auth] Registration begin error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "サーバーエラーが発生しました"
    });
  }
});

// 登録完了
app.post("/api/auth/register/complete", async (req, res) => {
  try {
    const { userId, registrationResponse } = req.body;
    
    if (!userId || !registrationResponse) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "必要なパラメータが不足しています"
      });
    }

    const result = await auth.verifyRegistration(userId, registrationResponse);
    
    if (result.success) {
      res.json({
        success: true,
        verified: result.verified,
        message: result.message
      });
    } else {
      res.status(400).json({
        error: "REGISTRATION_VERIFICATION_FAILED",
        message: result.message
      });
    }
  } catch (error) {
    console.error('[auth] Registration complete error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "サーバーエラーが発生しました"
    });
  }
});

// 認証開始
app.post("/api/auth/authenticate/begin", async (req, res) => {
  try {
    const { email } = req.body;
    
    const result = await auth.generateAuthenticationOptions(email);
    
    if (result.success) {
      res.json({
        success: true,
        options: result.options
      });
    } else {
      res.status(500).json({
        error: "AUTHENTICATION_FAILED",
        message: "認証の準備に失敗しました"
      });
    }
  } catch (error) {
    console.error('[auth] Authentication begin error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "サーバーエラーが発生しました"
    });
  }
});

// 認証完了
app.post("/api/auth/authenticate/complete", async (req, res) => {
  try {
    const { authenticationResponse } = req.body;
    
    if (!authenticationResponse) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "認証レスポンスが必要です"
      });
    }

    const result = await auth.verifyAuthentication(authenticationResponse);
    
    if (result.success) {
      res.json({
        success: true,
        verified: result.verified,
        user: result.user,
        sessionId: result.sessionId,
        message: result.message
      });
    } else {
      res.status(400).json({
        error: "AUTHENTICATION_VERIFICATION_FAILED",
        message: result.message
      });
    }
  } catch (error) {
    console.error('[auth] Authentication complete error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "サーバーエラーが発生しました"
    });
  }
});

// ログアウト
app.post("/api/auth/logout", async (req, res) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '') || 
                     req.headers['x-session-id'];
    
    const result = await auth.logout(sessionId);
    res.json(result);
  } catch (error) {
    console.error('[auth] Logout error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "ログアウトに失敗しました"
    });
  }
});

// セッション確認
app.get("/api/auth/session", async (req, res) => {
  try {
    const sessionId = req.headers.authorization?.replace('Bearer ', '') || 
                     req.headers['x-session-id'];
    
    if (!sessionId) {
      return res.status(401).json({ 
        valid: false, 
        message: "セッションIDが提供されていません" 
      });
    }

    const validation = await auth.validateSession(sessionId);
    res.json(validation);
  } catch (error) {
    console.error('[auth] Session check error:', error);
    res.status(500).json({
      valid: false,
      message: "セッション確認エラー"
    });
  }
});

// ========================================
// Passkey トークン発行（後方互換性のため保持）
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
app.post("/api/split-content", requireAuth, async (req, res) => {
  const { content, hasHeadings = false, headings = [] } = req.body;
  
  console.log("[split] ===========================================");
  console.log("[split] Split request received:");
  console.log(`[split] - content length: ${content?.length || 0} characters`);
  console.log(`[split] - hasHeadings: ${hasHeadings}`);
  console.log(`[split] - headings count: ${headings.length}`);
  console.log("[split] ===========================================");

  // 強化されたバリデーション
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
  
  // 不正な文字・パターンの検出
  const maliciousPatterns = [
    /<script[^>]*>/gi,
    /javascript:/gi,
    /vbscript:/gi,
    /on\w+\s*=/gi,
    /eval\s*\(/gi,
    /document\./gi,
    /window\./gi,
    /\bexec\b/gi,
    /\bsystem\b/gi,
    /file:\/\//gi
  ];
  
  if (maliciousPatterns.some(pattern => pattern.test(content))) {
    console.log(`[security] Malicious content detected in split request from user: ${req.user.email}`);
    return res.status(400).json({
      error: "MALICIOUS_CONTENT",
      message: "不正な内容が検出されました"
    });
  }
  
  // 見出しの検証
  if (hasHeadings && headings) {
    if (!Array.isArray(headings)) {
      return res.status(400).json({
        error: "INVALID_HEADINGS_FORMAT",
        message: "見出しの形式が正しくありません"
      });
    }
    
    if (headings.length > 20) {
      return res.status(400).json({
        error: "TOO_MANY_HEADINGS",
        message: "見出しが多すぎます（最大20個）"
      });
    }
    
    for (const heading of headings) {
      if (typeof heading !== 'string' || heading.length > 200) {
        return res.status(400).json({
          error: "INVALID_HEADING",
          message: "見出しの形式または長さが正しくありません"
        });
      }
      
      if (maliciousPatterns.some(pattern => pattern.test(heading))) {
        console.log(`[security] Malicious heading detected: ${heading}`);
        return res.status(400).json({
          error: "MALICIOUS_HEADING",
          message: "不正な見出しが検出されました"
        });
      }
    }
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

  if (!GEMINI_API_KEY) {
    console.error("[split] ERROR: GEMINI_API_KEY not configured");
    return res.status(500).json({
      error: "API_KEY_NOT_SET",
      message: "GEMINI_API_KEYが設定されていません"
    });
  }

  // 優先順位: OpenAI > Gemini > フォールバック
  try {
    // まずOpenAI APIを試行
    if (OPENAI_API_KEY) {
      console.log("[split] Trying OpenAI API first...");
      const openaiResult = await splitContentWithOpenAI(content, hasHeadings, headings);
      return res.json(openaiResult);
    }
    
    // OpenAI が利用できない場合はGemini APIを試行
    console.log("[split] OpenAI not available, trying Gemini API...");
    const result = await splitContentWithRetry(content, hasHeadings, headings, GEMINI_API_KEY);
    return res.json(result);
  } catch (openaiError) {
    console.log("[split] OpenAI failed, trying Gemini API...");
    try {
      const result = await splitContentWithRetry(content, hasHeadings, headings, GEMINI_API_KEY);
      return res.json(result);
    } catch (geminiError) {
      console.error("[split] ERROR: All AI attempts failed, using fallback");
      const fallbackResult = splitContentFallback(content, hasHeadings, headings);
      return res.json(fallbackResult);
    }
  }
});

// ========================================
// OpenAI APIで本文分割（高品質）
// ========================================
async function splitContentWithOpenAI(content, hasHeadings, headings) {
  console.log("[split] Using OpenAI GPT-4o-mini for content analysis");
  
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
- 記事の主要テーマと目的を理解
- 最も重要で視覚的な場面を5つまで抽出
- 要約ではなく、原文から重要な部分をそのまま抽出
- 各抽出は100-400字程度
- 問題→解決→結果の流れを意識

出力形式：
{
  "chunks": [
    {
      "text": "抽出した重要で視覚的な本文",
      "importance": "この部分が記事にとって重要な理由",
      "visualElements": "主要な視覚要素（人物・場所・動作・状況）"
    }
  ]
}`;
  }

  const requestBody = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.3,
    max_tokens: 3000,
    response_format: { type: "json_object" }
  };

  console.log("[split] Sending request to OpenAI API...");
  const startTime = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    console.log("[split] OpenAI response received:", content.substring(0, 200) + "...");

    // JSONを抽出
    let jsonText = content.trim();
    if (jsonText.startsWith("```json")) {
      jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(jsonText);
    
    // 正規化
    const chunks = parsed.chunks.map((chunk, index) => ({
      index,
      text: chunk.text || "",
      charCount: (chunk.text || "").length,
      heading: chunk.heading || `チャンク${index + 1}`,
      importance: chunk.importance || "",
      visualElements: chunk.visualElements || ""
    }));

    const elapsed = Date.now() - startTime;
    console.log(`[split] ✅ OpenAI analysis completed in ${elapsed}ms`);
    console.log(`[split] Extracted ${chunks.length} high-quality chunks`);

    return {
      success: true,
      method: "openai-gpt4o-mini",
      chunks,
      totalChunks: chunks.length,
      elapsed
    };

  } catch (error) {
    clearTimeout(timeout);
    console.error("[split] OpenAI API failed:", error.message);
    throw error;
  }
}

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
  const modelName = "gemini-2.5-flash";
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
    // 小見出しありの場合：見出しと対応する本文を抽出
    console.log("[split] Fallback: Using heading-based splitting with content extraction");
    
    // 6つ以上ある場合は最初の5つを使用
    const selectedHeadings = headings.slice(0, 5);
    
    // 本文を段落で分割して見出しとマッチング
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0);
    
    selectedHeadings.forEach((heading, index) => {
      // この見出しに対応する本文を探す
      let matchedContent = heading; // デフォルトは見出し
      
      // 見出しの後の段落を探す
      for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        
        // この段落に見出しが含まれているかチェック
        if (paragraph.includes(heading) || paragraph.includes(heading.replace(/^[0-9０-９①-⑩]+[\.、\s]/, ''))) {
          // 次の段落があれば、それを本文として使用
          if (i + 1 < paragraphs.length) {
            const nextParagraph = paragraphs[i + 1];
            
            // 視覚的な描写を含む部分を探す
            const visualKeywords = ['腕を上げ', '痛み', '着る', '姿勢', 'ストレッチ', '運動', '座っ', '立っ', '歩', '動作', '手', '肩', '首', '背中'];
            
            if (visualKeywords.some(keyword => nextParagraph.includes(keyword))) {
              matchedContent = nextParagraph.substring(0, 300); // 300字まで
            } else if (nextParagraph.length > 0) {
              matchedContent = nextParagraph.substring(0, 200); // 200字まで
            }
          }
          break;
        }
      }
      
      chunks.push({
        index,
        text: matchedContent,
        charCount: matchedContent.length,
        heading: heading
      });
    });
    
    console.log(`[split] Fallback created ${chunks.length} chunks with content extraction`);
    
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
// デモ使用エンドポイント（無料試用・強化版）
// ========================================

// 悪意のあるアクセスパターン検出
const suspiciousIPs = new Map();
const blockedIPs = new Set();

function detectMaliciousActivity(req, res, next) {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                  req.headers['x-real-ip'] || 
                  req.connection.remoteAddress;
  
  // IPブロックリストチェック
  if (blockedIPs.has(clientIp)) {
    console.log(`[security] Blocked IP attempted access: ${clientIp}`);
    return res.status(403).json({
      error: "BLOCKED",
      message: "このIPアドレスからのアクセスは制限されています"
    });
  }
  
  const now = Date.now();
  const windowMs = 60 * 1000; // 1分
  
  if (!suspiciousIPs.has(clientIp)) {
    suspiciousIPs.set(clientIp, { requests: 1, firstRequest: now, violations: 0 });
    return next();
  }
  
  const ipData = suspiciousIPs.get(clientIp);
  
  // ウィンドウリセット
  if (now - ipData.firstRequest > windowMs) {
    ipData.requests = 1;
    ipData.firstRequest = now;
    return next();
  }
  
  ipData.requests++;
  
  // 異常な頻度でのアクセス検出（1分間に30回以上）
  if (ipData.requests > 30) {
    ipData.violations++;
    console.log(`[security] Suspicious activity detected from IP: ${clientIp} (${ipData.requests} requests in 1 minute)`);
    
    if (ipData.violations >= 3) {
      blockedIPs.add(clientIp);
      console.log(`[security] IP permanently blocked: ${clientIp}`);
    }
    
    return res.status(429).json({
      error: "SUSPICIOUS_ACTIVITY",
      message: "異常なアクセスパターンが検出されました"
    });
  }
  
  next();
}

// デモ用レート制限（強化版：1分間に2回まで）
const demoRateLimit = new Map();

function checkDemoRateLimit(req, res, next) {
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                  req.headers['x-real-ip'] || 
                  req.connection.remoteAddress;
  
  const now = Date.now();
  const windowMs = 60 * 1000; // 1分
  const maxRequests = 2; // 厳格化：1分間に2回まで
  
  if (!demoRateLimit.has(clientIp)) {
    demoRateLimit.set(clientIp, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  const rateData = demoRateLimit.get(clientIp);
  
  if (now > rateData.resetTime) {
    demoRateLimit.set(clientIp, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  if (rateData.count >= maxRequests) {
    console.log(`[security] Demo rate limit exceeded for IP: ${clientIp}`);
    return res.status(429).json({
      error: "DEMO_RATE_LIMIT_EXCEEDED",
      message: "デモ機能の利用頻度が高すぎます。1分間に2回まで利用可能です",
      retryAfter: Math.ceil((rateData.resetTime - now) / 1000)
    });
  }
  
  rateData.count++;
  next();
}

// 全APIエンドポイントに悪意のあるアクティビティ検出を適用
app.use('/api/', detectMaliciousActivity);

// デモエンドポイント用追加セキュリティ
function enhancedDemoSecurity(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || '';
  const origin = req.headers['origin'] || '';
  
  // 有効なブラウザからのアクセスかチェック
  const validBrowserPatterns = [
    /Mozilla.*Chrome/i,
    /Mozilla.*Firefox/i,
    /Mozilla.*Safari/i,
    /Mozilla.*Edge/i
  ];
  
  const isValidBrowser = validBrowserPatterns.some(pattern => pattern.test(userAgent));
  
  if (!isValidBrowser && process.env.NODE_ENV === 'production') {
    console.log(`[security] Invalid browser for demo access: ${userAgent}`);
    return res.status(403).json({
      error: "INVALID_CLIENT",
      message: "デモ機能は有効なブラウザからのみ利用可能です"
    });
  }
  
  // 本番環境では適切なOriginからのアクセスかチェック
  if (process.env.NODE_ENV === 'production') {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://unicus.top').split(',');
    if (origin && !allowedOrigins.includes(origin)) {
      console.log(`[security] Invalid origin for demo access: ${origin}`);
      return res.status(403).json({
        error: "INVALID_ORIGIN",
        message: "不正なアクセス元からのリクエストです"
      });
    }
  }
  
  next();
}

app.post("/api/demo/generate", enhancedDemoSecurity, checkDemoRateLimit, async (req, res) => {
  try {
    // IPアドレスを取得（プロキシ経由も考慮）
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress;
    
    // デバイス情報を取得（フィンガープリンティング）
    const userAgent = req.headers['user-agent'] || '';
    const acceptLanguage = req.headers['accept-language'] || '';
    const acceptEncoding = req.headers['accept-encoding'] || '';
    
    // 複数の識別子を生成（不正使用防止強化）
    const deviceFingerprint = Buffer.from(
      userAgent + acceptLanguage + acceptEncoding + (req.headers['accept'] || '')
    ).toString('base64').substring(0, 32);
    
    const ipHash = Buffer.from(clientIp).toString('base64').substring(0, 16);
    const sessionFingerprint = Buffer.from(
      userAgent + clientIp + (req.headers['x-forwarded-for'] || '') + acceptLanguage
    ).toString('base64').substring(0, 24);
    
    // 追加の不正使用検出
    const timeBasedFingerprint = Buffer.from(
      clientIp + Math.floor(Date.now() / (24 * 60 * 60 * 1000)).toString() // 日単位
    ).toString('base64').substring(0, 20);
    
    // 複数の識別子で制限チェック（強化版）
    const identifiers = [
      { identifier: clientIp, type: 'ip' },
      { identifier: deviceFingerprint, type: 'device' },
      { identifier: ipHash, type: 'ip_hash' },
      { identifier: timeBasedFingerprint, type: 'time_based' },
      { identifier: sessionFingerprint.substring(0, 16), type: 'session' }
    ];
    
    // アクセス許可チェック
    const accessCheck = await db.checkDemoAccess(identifiers);
    if (!accessCheck.allowed) {
      const errorMessages = {
        'BLACKLISTED': '永久にデモ使用が制限されています',
        'LIMIT_EXCEEDED': 'デモ使用回数（3回）を永久に超過しました'
      };
      
      console.log(`[demo] Access denied: ${accessCheck.reason} for ${accessCheck.identifier} (${accessCheck.type})`);
      
      return res.status(403).json({
        error: "DEMO_PERMANENTLY_BLOCKED",
        message: errorMessages[accessCheck.reason] || '使用が制限されています',
        suggestion: "デモ利用は3回まで永久制限です。継続利用には有料プランへの登録が必要です",
        isPermaBan: true,
        reason: accessCheck.reason
      });
    }
    
    // デバイス情報を記録（不正防止用）
    const deviceInfo = JSON.stringify({
      userAgent,
      language: acceptLanguage,
      encoding: acceptEncoding,
      ip: clientIp,
      timestamp: new Date().toISOString()
    });
    
    // デモ使用を記録
    const usageResults = await db.incrementDemoUsage(identifiers, deviceInfo);
    
    // 最大使用回数を取得
    const maxCount = Math.max(...usageResults.map(r => r.count));
    const DEMO_LIMIT = 3;
    
    // 画像生成処理を実行
    const originalSend = res.json.bind(res);
    res.json = function(data) {
      // 成功時にデモ情報を追加
      if (data && !data.error) {
        const remainingUses = Math.max(0, DEMO_LIMIT - maxCount);
        const isLastUse = maxCount >= DEMO_LIMIT;
        
        data.demoInfo = {
          remainingUses,
          totalLimit: DEMO_LIMIT,
          currentUse: maxCount,
          isLastUse,
          message: isLastUse 
            ? "⚠️ これがデモ最後の使用です。以後永久に制限されます"
            : `デモ使用: 残り ${remainingUses} 回（永久制限）`
        };
        
        if (isLastUse) {
          console.log(`[demo] User permanently banned after ${maxCount} uses: ${clientIp}`);
        }
      }
      return originalSend(data);
    };
    
    // 通常の画像生成処理を実行
    await generateImage(req, res);
    
  } catch (error) {
    console.error('[demo] Demo generation error:', error);
    res.status(500).json({
      error: "DEMO_ERROR",
      message: "デモ生成エラーが発生しました"
    });
  }
});

// デモ統計確認エンドポイント（管理者のみ）
app.get("/api/admin/demo-stats", requireAuth, async (req, res) => {
  try {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    
    if (!adminEmails.includes(req.user.email)) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "管理者権限が必要です"
      });
    }
    
    const stats = await db.getDemoStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('[admin] Demo stats error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "統計取得に失敗しました"
    });
  }
});

// ========================================
// 決済管理エンドポイント（管理者のみ）
// ========================================
app.post("/api/admin/update-payment", requireAuth, async (req, res) => {
  try {
    // 管理者チェック
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    
    if (!adminEmails.includes(req.user.email)) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "管理者権限が必要です"
      });
    }
    
    const { userEmail, status, plan, amount, expirationDays, note } = req.body;
    
    if (!userEmail || !status) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "メールアドレスと支払いステータスが必要です"
      });
    }
    
    const targetUser = await db.getUserByEmail(userEmail);
    if (!targetUser) {
      // ユーザーが存在しない場合は新規作成
      const userId = await db.createUser(userEmail, userEmail);
      targetUser = { id: userId };
    }
    
    // 有効期限を計算
    let expirationDate = null;
    if (status === 'paid' && expirationDays) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + expirationDays);
      expirationDate = expiry.toISOString();
    }
    
    // 支払い情報を更新
    await db.updatePaymentStatus(targetUser.id, {
      status,
      plan: plan || 'standard',
      amount: amount || 0,
      expirationDate,
      note: note || `Updated by ${req.user.email}`
    });
    
    console.log(`[admin] Payment status updated for ${userEmail}: ${status} by ${req.user.email}`);
    
    res.json({
      success: true,
      message: `${userEmail} の支払い状態を ${status} に更新しました`,
      expirationDate
    });
  } catch (error) {
    console.error('[admin] Payment update error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "支払い状態の更新に失敗しました"
    });
  }
});

// ========================================
// 開発者ロール管理エンドポイント（管理者のみ）
// ========================================
app.post("/api/admin/set-role", requireAuth, async (req, res) => {
  try {
    // 環境変数で管理者メールアドレスを指定（カンマ区切り）
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    
    if (!adminEmails.includes(req.user.email)) {
      return res.status(403).json({
        error: "FORBIDDEN",
        message: "管理者権限が必要です"
      });
    }
    
    const { userEmail, role } = req.body;
    
    if (!userEmail || !role) {
      return res.status(400).json({
        error: "INVALID_REQUEST",
        message: "メールアドレスとロールが必要です"
      });
    }
    
    if (!['user', 'developer'].includes(role)) {
      return res.status(400).json({
        error: "INVALID_ROLE",
        message: "無効なロールです"
      });
    }
    
    const targetUser = await db.getUserByEmail(userEmail);
    if (!targetUser) {
      return res.status(404).json({
        error: "USER_NOT_FOUND",
        message: "指定されたユーザーが見つかりません"
      });
    }
    
    await db.setUserRole(targetUser.id, role);
    console.log(`[admin] User ${userEmail} role changed to ${role} by ${req.user.email}`);
    
    res.json({
      success: true,
      message: `${userEmail} のロールを ${role} に変更しました`
    });
  } catch (error) {
    console.error('[admin] Set role error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "ロール変更に失敗しました"
    });
  }
});

// ========================================
// 使用量統計エンドポイント
// ========================================
app.get("/api/usage/stats", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const todayUsage = await db.getTodayUsage(userId);
    
    const DAILY_ARTICLE_LIMIT = 5;
    const DAILY_REGENERATION_LIMIT = 50;
    
    const currentArticleCount = todayUsage?.article_count || 0;
    const currentRegenerationCount = todayUsage?.regeneration_count || 0;
    
    res.json({
      success: true,
      usage: {
        today: {
          articles: {
            used: currentArticleCount,
            limit: DAILY_ARTICLE_LIMIT,
            remaining: DAILY_ARTICLE_LIMIT - currentArticleCount
          },
          regenerations: {
            used: currentRegenerationCount,
            limit: DAILY_REGENERATION_LIMIT,
            remaining: DAILY_REGENERATION_LIMIT - currentRegenerationCount
          }
        },
        isDeveloper: req.user?.role === 'developer'
      }
    });
  } catch (error) {
    console.error('[usage] Stats error:', error);
    res.status(500).json({
      error: "STATS_ERROR",
      message: "使用量統計の取得に失敗しました"
    });
  }
});

// ========================================
// 画像生成エンドポイント
// ========================================
app.post("/api/generate", requireAuth, checkUsageLimits, async (req, res) => {
  try {
    await generateImage(req, res);
    // 成功時に使用量を更新
    await incrementUsage(req, res, () => {});
  } catch (error) {
    console.error('[api] Generate error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "GENERATION_ERROR",
        message: "画像生成エラーが発生しました"
      });
    }
  }
});

// ========================================
// 再生成エンドポイント
// ========================================
app.post("/api/regenerate", requireAuth, checkUsageLimits, async (req, res) => {
  try {
    await generateImage(req, res);
    // 成功時に使用量を更新
    await incrementUsage(req, res, () => {});
  } catch (error) {
    console.error('[api] Regenerate error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "REGENERATION_ERROR",
        message: "再生成エラーが発生しました"
      });
    }
  }
});

// ========================================
// 後方互換性のため、古いエンドポイントも残す
// ========================================
app.post("/api/generate-test-image", requireAuth, checkUsageLimits, async (req, res) => {
  try {
    await generateImage(req, res);
    // 成功時に使用量を更新
    await incrementUsage(req, res, () => {});
  } catch (error) {
    console.error('[api] Generate-test error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "GENERATION_ERROR",
        message: "画像生成エラーが発生しました"
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📏 Max content length: ${MAX_CONTENT_LENGTH} characters`);
});
