import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import SecureDatabase from './database.js';
import EmailAuthenticator from './auth.js';
import ConfigManager from './config.js';
import ImageGeneratorV2 from './imageGenerator_v2.js';

// ES Modules用のdirname設定
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// 設定管理
const config = new ConfigManager();
const validation = config.displayValidation();

if (!validation.valid) {
  console.error('❌ Configuration validation failed. Exiting...');
  process.exit(1);
}

// ユーザー権限管理
class UserPermissionManager {
  constructor(configManager) {
    this.config = configManager;
    // 環境変数のメールアドレスを正規化（小文字・トリム）
    this.adminEmails = configManager.getArray('ADMIN_EMAILS', [])
      .map(email => email.toLowerCase().trim())
      .filter(email => email.length > 0);
    this.paidUserEmails = configManager.getArray('PAID_USER_EMAILS', [])
      .map(email => email.toLowerCase().trim())
      .filter(email => email.length > 0);
    
    console.log(`[auth] Loaded ${this.adminEmails.length} admin users`);
    console.log(`[auth] Loaded ${this.paidUserEmails.length} paid users`);
    
    // セキュリティ: 重複チェック
    const duplicates = this.adminEmails.filter(email => this.paidUserEmails.includes(email));
    if (duplicates.length > 0) {
      console.warn(`[auth] WARNING: Duplicate emails in admin and paid lists: ${duplicates.join(', ')}`);
    }
  }

  // ユーザーの権限レベルを判定
  getUserRole(email) {
    const normalizedEmail = email.toLowerCase().trim();
    
    if (this.adminEmails.includes(normalizedEmail)) {
      return 'admin';
    }
    
    if (this.paidUserEmails.includes(normalizedEmail)) {
      return 'paid';
    }
    
    return 'free';
  }

  // 開発者権限チェック（管理者として扱う）
  isDeveloper(email, userRole = null) {
    const role = userRole || this.getUserRole(email);
    return role === 'admin';
  }

  // 有料ユーザー権限チェック
  isPaidUser(email, userRole = null) {
    const role = userRole || this.getUserRole(email);
    return role === 'paid' || role === 'admin';
  }

  // 使用制限の取得
  getUsageLimits(email, userRole = null) {
    const role = userRole || this.getUserRole(email);
    
    switch (role) {
      case 'admin':
        return {
          articles: -1,        // 無制限
          regenerations: -1    // 無制限
        };
      case 'paid':
        return {
          articles: 3,         // 1日3回（コスト削減）
          regenerations: 10    // 1日10回（コスト削減）
        };
      case 'free':
      default:
        return {
          articles: 0,         // 無料ユーザーは使用不可
          regenerations: 0     // 無料ユーザーは使用不可
        };
    }
  }

  // 権限情報の表示用
  getPermissionInfo(email) {
    const role = this.getUserRole(email);
    const limits = this.getUsageLimits(email, role);
    
    return {
      email,
      role,
      limits,
      isDeveloper: this.isDeveloper(email, role),
      isPaidUser: this.isPaidUser(email, role)
    };
  }
}

// データベース、Auth、画像生成初期化
const db = new SecureDatabase();
const auth = new EmailAuthenticator(db);
const imageGen = new ImageGeneratorV2();
const permissions = new UserPermissionManager(config);

// ========================================
// ミドルウェア設定
// ========================================

// CORS設定
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['https://unicus.top'];

// Helmet.js セキュリティヘッダー（安全な部分のみ）
app.use(helmet({
  // CSPは無効化（既存機能保護）
  contentSecurityPolicy: false,
  
  // 安全なセキュリティヘッダーのみ有効
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  crossOriginEmbedderPolicy: false, // 互換性のため無効
  
  // クリックジャッキング防止
  frameguard: { action: 'deny' },
  
  // MIMEタイプスニッフィング防止
  noSniff: true,
  
  // DNS先読み制御
  dnsPrefetchControl: { allow: false },
  
  // リファラーポリシー
  referrerPolicy: { policy: "same-origin" },
  
  // HSTS（本番環境のみ）
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  } : false,
  
  // Origin Agent Cluster
  originAgentCluster: true,
  
  // X-Permitted-Cross-Domain-Policies
  permittedCrossDomainPolicies: { permittedPolicies: "none" }
}));

// CORS設定
app.use(cors({
  origin: true, // 全てのoriginを許可
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID', 'X-Requested-With'],
  optionsSuccessStatus: 200
}));

// 追加のCORSヘッダー設定（既存機能保持）
app.use((req, res, next) => {
  // 追加のCORSヘッダー（念のため）
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-ID');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  next();
});

// HTTPS リダイレクト（本番環境のみ）
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (!req.secure && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect('https://' + req.get('host') + req.url);
    }
    next();
  });
}

// Trust proxy for Railway/Heroku deployments
app.set('trust proxy', true);

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 基本的なレート制限（セキュアに設定）
const basicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 適切な制限値に戻す
  message: { error: 'RATE_LIMITED', message: 'リクエストが多すぎます' },
  trustProxy: 1, // Railway プロキシを信頼（1つのプロキシのみ）
  standardHeaders: true, // レート制限情報をヘッダーに含める
  legacyHeaders: false, // X-RateLimit-* ヘッダーを無効化
  // 個別IPを正確に取得するキーを設定
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           'unknown';
  }
});

app.use(basicLimiter);

// ========================================
// 静的ファイル配信 (HTMLファイル用)
// ========================================

// 静的ファイルミドルウェア
app.use(express.static('.', {
  index: 'index.html',  // デフォルトファイル
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
  }
}));

// ページルーティング
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/app.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// ========================================
// 認証ミドルウェア
// ========================================

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'AUTHENTICATION_REQUIRED',
        message: '認証が必要です'
      });
    }

    const token = authHeader.substring(7);
    const verification = await auth.verifyToken(token);
    
    if (!verification.valid) {
      return res.status(401).json({
        error: 'AUTHENTICATION_REQUIRED',
        message: '認証が必要です'
      });
    }

    req.user = verification.user;
    req.tokenData = verification.decoded;
    
    // 新しい権限システムを使用
    const userRole = permissions.getUserRole(req.user.email);
    const userPermissions = permissions.getPermissionInfo(req.user.email);
    
    // リクエストに権限情報を追加
    req.userRole = userRole;
    req.userPermissions = userPermissions;
    
    // 無料ユーザーのアクセス制限（管理者と有料ユーザー以外）
    if (!permissions.isPaidUser(req.user.email, userRole)) {
      return res.status(403).json({
        error: 'SUBSCRIPTION_REQUIRED',
        message: 'このサービスの利用には有料プランへの登録が必要です',
        userRole: userRole,
        upgradeInfo: {
          current: 'free',
          required: 'paid',
          benefits: [
            '1日3回の画像生成',
            '1日10回の再生成', 
            'OpenAI GPT-4o-mini分析機能',
            '高品質なアイキャッチ画像'
          ]
        }
      });
    }
    
    next();
  } catch (error) {
    console.error('[auth] Authentication middleware error:', error);
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'サーバーエラーが発生しました'
    });
  }
}

// ========================================
// 認証API
// ========================================

// 認証コード要求
app.post('/api/auth/request-code', async (req, res) => {
  try {
    const { email } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!email) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'メールアドレスが必要です'
      });
    }

    const result = await auth.requestAuthCode(email, clientIp, userAgent);
    
    res.json(result);
  } catch (error) {
    console.error('[api] Auth code request error:', error);
    
    let statusCode = 400;
    if (error.message.includes('多すぎます') || error.message.includes('ロック')) {
      statusCode = 429;
    }
    
    res.status(statusCode).json({
      error: 'AUTH_CODE_REQUEST_FAILED',
      message: error.message
    });
  }
});

// 認証リクエスト追跡（重複防止）
const activeAuthRequests = new Map();

// 認証コード検証とログイン
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    console.log('[debug] verify-code リクエスト受信');
    console.log('[debug] req.body:', req.body);
    console.log('[debug] Content-Type:', req.headers['content-type']);
    
    const { email, code } = req.body;
    const requestKey = `${email}:${code}`;
    
    // 重複リクエストをチェック
    if (activeAuthRequests.has(requestKey)) {
      console.log('[debug] 重複リクエスト検出 - ブロック');
      return res.status(429).json({
        error: 'DUPLICATE_REQUEST',
        message: '認証リクエストが重複しています'
      });
    }
    
    // リクエストを追跡
    activeAuthRequests.set(requestKey, Date.now());
    console.log('[debug] 認証リクエスト追跡開始:', requestKey);
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    console.log('[debug] parsed values:', { email, code, clientIp });

    if (!email || !code) {
      console.log('[debug] Missing email or code - returning 400');
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'メールアドレスと認証コードが必要です'
      });
    }

    try {
      const result = await auth.verifyCodeAndLogin(email, code, clientIp, userAgent);
      
      // 成功時にリクエスト追跡を削除
      activeAuthRequests.delete(requestKey);
      console.log('[debug] 認証成功 - 追跡削除:', requestKey);
      
      res.json(result);
    } catch (authError) {
      // 失敗時もリクエスト追跡を削除
      activeAuthRequests.delete(requestKey);
      console.log('[debug] 認証失敗 - 追跡削除:', requestKey);
      throw authError;
    }
  } catch (error) {
    console.error('[api] Auth verification error:', error);
    console.error('[api] Error message:', error.message);
    console.error('[api] Error stack:', error.stack);
    
    let statusCode = 400;
    if (error.message.includes('多すぎます') || error.message.includes('ロック')) {
      statusCode = 429;
    }
    
    console.log('[debug] Sending error response:', statusCode, error.message);
    
    res.status(statusCode).json({
      error: 'AUTHENTICATION_FAILED',
      message: error.message
    });
  }
});

// トークンリフレッシュ
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'リフレッシュトークンが必要です'
      });
    }

    const result = await auth.refreshToken(refreshToken);
    
    res.json(result);
  } catch (error) {
    console.error('[api] Token refresh error:', error);
    res.status(401).json({
      error: 'TOKEN_REFRESH_FAILED',
      message: error.message
    });
  }
});

// ユーザー情報取得
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    res.json({
      success: true,
      user: req.user
    });
  } catch (error) {
    console.error('[api] User info error:', error);
    res.status(500).json({
      error: 'SERVER_ERROR',
      message: 'ユーザー情報の取得に失敗しました'
    });
  }
});

// ログアウト
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    const token = req.headers.authorization.substring(7);
    const result = await auth.logout(token);
    
    res.json(result);
  } catch (error) {
    console.error('[api] Logout error:', error);
    res.status(500).json({
      error: 'LOGOUT_FAILED',
      message: 'ログアウトに失敗しました'
    });
  }
});

// ========================================
// 使用量制限ミドルウェア（既存のまま）
// ========================================

async function checkUsageLimits(req, res, next) {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const userRole = req.userRole;

    // 権限から使用制限を取得
    const limits = permissions.getUsageLimits(userEmail, userRole);
    
    // 管理者（開発者）は制限なし
    if (permissions.isDeveloper(userEmail, userRole)) {
      req.usage = { articleCount: 0, regenerationCount: 0 };
      req.limits = limits;
      return next();
    }

    const usage = await db.getTodayUsage(userId);
    const articleCount = usage?.article_count || 0;
    const regenerationCount = usage?.regeneration_count || 0;

    // 制限チェック（有料ユーザー用）
    if (limits.articles !== -1 && articleCount >= limits.articles) {
      return res.status(403).json({
        error: "DAILY_LIMIT_EXCEEDED",
        message: `本日の記事処理数が上限に達しました（${limits.articles}回/日）`,
        usage: { articleCount, regenerationCount },
        limits: limits,
        userRole: userRole,
        upgradeInfo: userRole === 'paid' ? null : {
          message: '制限を解除するには有料プランにアップグレードしてください',
          benefits: ['1日3回の画像生成', '1日10回の再生成']
        }
      });
    }

    req.usage = { articleCount, regenerationCount };
    req.limits = limits;
    next();
  } catch (error) {
    console.error('[middleware] Usage limit check error:', error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: "使用量の確認に失敗しました"
    });
  }
}

// ========================================
// 使用量統計API
// ========================================

app.get('/api/usage/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const usage = await db.getTodayUsage(userId);
    
    // 新しい権限システムを使用
    const userPermissions = permissions.getPermissionInfo(userEmail);

    res.json({
      success: true,
      usage: {
        articleCount: usage?.article_count || 0,
        regenerationCount: usage?.regeneration_count || 0
      },
      limits: userPermissions.limits,
      user: {
        email: userEmail,
        role: userPermissions.role,
        isDeveloper: userPermissions.isDeveloper,
        isPaidUser: userPermissions.isPaidUser
      }
    });
  } catch (error) {
    console.error('[api] Usage stats error:', error);
    res.status(500).json({
      error: 'SERVER_ERROR',
      message: '使用量統計の取得に失敗しました'
    });
  }
});

// ========================================
// デモAPI（既存のまま）
// ========================================

app.post('/api/demo/generate', async (req, res) => {
  try {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress;
    
    // デモアクセス制限チェック
    const identifiers = [
      { identifier: clientIp, type: 'ip' }
    ];
    
    const accessCheck = await db.checkDemoAccess(identifiers);
    if (!accessCheck.allowed) {
      let message = 'デモ利用制限に達しました';
      let isPermaBan = false;
      
      if (accessCheck.reason === 'BLACKLISTED') {
        message = 'デモ利用が制限されています';
        isPermaBan = true;
      } else if (accessCheck.reason === 'LIMIT_EXCEEDED') {
        message = 'デモは3回までご利用いただけます';
      }
      
      return res.status(403).json({
        error: accessCheck.reason,
        message,
        suggestion: '無制限でご利用いただくには、ユーザー登録（無料）をお願いします',
        isPermaBan
      });
    }

    const { prompt, provider = 'google', aspectRatio = '1:1' } = req.body;
    
    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'プロンプトが必要です'
      });
    }

    if (prompt.length > 500) {
      return res.status(400).json({
        error: 'PROMPT_TOO_LONG',
        message: 'デモ版では500文字以内で入力してください'
      });
    }

    // デモ使用量を増加
    const usageResults = await db.incrementDemoUsage(identifiers);
    const remainingUses = Math.max(0, 3 - usageResults[0].count);

    // 画像生成処理
    console.log('[api] Generating demo image with AI...');
    const result = await imageGen.generateImages(prompt, {
      taste: 'modern',
      aspectRatio: aspectRatio,
      maxImages: 1
    });

    const image = result.images[0];
    
    res.json({
      success: true,
      dataUrl: image.dataUrl,
      demoInfo: {
        message: `デモ画像を生成しました（残り${remainingUses}回）`,
        remainingUses,
        usedCount: usageResults[0].count,
        prompt: image.prompt,
        provider: image.provider
      }
    });
  } catch (error) {
    console.error('[api] Demo generation error:', error);
    res.status(500).json({
      error: 'GENERATION_FAILED',
      message: 'デモ画像の生成に失敗しました'
    });
  }
});

// ========================================
// 画像生成API（認証必要）
// ========================================

app.post('/api/generate', requireAuth, checkUsageLimits, async (req, res) => {
  try {
    const { content, provider = 'google', taste = 'photo', aspectRatio = '1:1' } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'コンテンツが必要です'
      });
    }

    // 使用量を増加
    await db.incrementUsage(req.user.id, 'article');

    // AI画像生成処理
    console.log(`[api] Generating images for user ${req.user.id} with ${provider} provider...`);
    const result = await imageGen.generateImages(content, {
      taste: taste,
      aspectRatio: aspectRatio,
      maxImages: 5
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'GENERATION_FAILED',
        message: result.message || '画像生成に失敗しました',
        details: result.error
      });
    }
    
    res.json({
      success: true,
      message: result.message,
      images: result.images,
      usage: {
        articleCount: req.usage.articleCount + 1,
        regenerationCount: req.usage.regenerationCount
      },
      generationInfo: {
        provider: result.provider,
        chunksProcessed: result.images.length
      }
    });
  } catch (error) {
    console.error('[api] Image generation error:', error);
    res.status(500).json({
      error: 'GENERATION_FAILED',
      message: '画像生成に失敗しました'
    });
  }
});

// ========================================
// 画像再生成API（認証必要）
// ========================================

app.post('/api/regenerate', requireAuth, async (req, res) => {
  try {
    const { originalPrompt, instructions, style = 'photo', aspectRatio = '1:1' } = req.body;
    
    if (!originalPrompt || !instructions) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '元のプロンプトと修正指示が必要です'
      });
    }

    if (instructions.trim().length === 0) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: '修正指示を入力してください'
      });
    }

    // 再生成制限チェック
    const userId = req.user.id;
    const userEmail = req.user.email;
    const userRole = req.userRole;
    const limits = permissions.getUsageLimits(userEmail, userRole);
    
    // 管理者以外は制限チェック
    if (!permissions.isDeveloper(userEmail, userRole)) {
      const usage = await db.getTodayUsage(userId);
      const regenerationCount = usage?.regeneration_count || 0;
      
      if (limits.regenerations !== -1 && regenerationCount >= limits.regenerations) {
        return res.status(403).json({
          error: "DAILY_REGENERATION_LIMIT_EXCEEDED",
          message: `本日の画像再生成回数が上限に達しました（${limits.regenerations}回/日）`,
          usage: { regenerationCount },
          limits: limits,
          userRole: userRole
        });
      }
    }

    // 再生成処理
    console.log(`[api] Regenerating image for user ${req.user.id}...`);
    const result = await imageGen.regenerateSingleImage(originalPrompt, instructions, {
      taste: style,
      aspectRatio: aspectRatio
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'REGENERATION_FAILED',
        message: result.message || '画像の修正に失敗しました',
        details: result.error
      });
    }
    
    // 再生成成功時に使用量を増加
    if (!permissions.isDeveloper(userEmail, userRole)) {
      await db.incrementUsage(userId, 'regeneration');
    }
    
    res.json({
      success: true,
      message: result.message,
      image: result.image
    });
  } catch (error) {
    console.error('[api] Image regeneration error:', error);
    res.status(500).json({
      error: 'REGENERATION_FAILED',
      message: '画像の修正に失敗しました'
    });
  }
});

// ========================================
// ヘルスチェック
// ========================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    auth: 'email-jwt',
    database: 'sqlite3'
  });
});

// ========================================
// エラーハンドリング
// ========================================

app.use((err, req, res, next) => {
  console.error('[app] Unhandled error:', err);
  res.status(500).json({
    error: 'SERVER_ERROR',
    message: 'サーバーでエラーが発生しました'
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'エンドポイントが見つかりません'
  });
});

// ========================================
// サーバー起動
// ========================================

async function startServer() {
  try {
    // データベース初期化
    await db.initialize();
    console.log('[app] Database initialized successfully');

    // 定期クリーンアップ（1時間ごと）
    setInterval(async () => {
      try {
        await auth.cleanup();
      } catch (error) {
        console.error('[app] Cleanup error:', error);
      }
    }, 60 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`🚀 Server v2.0 listening on port ${PORT}`);
      console.log(`📧 Email authentication enabled`);
      console.log(`🔐 JWT security active`);
      console.log(`🌐 CORS origins: ${allowedOrigins.join(', ')}`);
    });
  } catch (error) {
    console.error('[app] Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[app] Received SIGTERM, shutting down gracefully');
  try {
    await db.close();
  } catch (error) {
    console.error('[app] Error during shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[app] Received SIGINT, shutting down gracefully');
  try {
    await db.close();
  } catch (error) {
    console.error('[app] Error during shutdown:', error);
  }
  process.exit(0);
});

startServer();
