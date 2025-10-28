import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import SecureDatabase from './database.js';
import EmailAuthenticator from './auth.js';
import ConfigManager from './config.js';

const app = express();
const PORT = process.env.PORT || 8080;

// 設定管理
const config = new ConfigManager();
const validation = config.displayValidation();

if (!validation.valid) {
  console.error('❌ Configuration validation failed. Exiting...');
  process.exit(1);
}

// データベースとAuth初期化
const db = new SecureDatabase();
const auth = new EmailAuthenticator(db);

// ========================================
// ミドルウェア設定
// ========================================

// CORS設定
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : ['https://unicus.top'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID']
}));

// セキュリティヘッダー
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
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

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 基本的なレート制限
const basicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 100, // 100リクエスト
  message: { error: 'RATE_LIMITED', message: 'リクエストが多すぎます' }
});

app.use(basicLimiter);

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
    
    // 支払い状況チェック（開発者以外）
    if (req.user.role !== 'developer') {
      const paymentStatus = await db.checkPaymentStatus(req.user.email);
      if (paymentStatus !== 'paid') {
        return res.status(403).json({
          error: 'PAYMENT_REQUIRED',
          message: 'サービスの利用には有効な決済が必要です',
          paymentStatus: paymentStatus || 'pending'
        });
      }
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

// 認証コード検証とログイン
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.headers['x-real-ip'] || 
                    req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    if (!email || !code) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'メールアドレスと認証コードが必要です'
      });
    }

    const result = await auth.verifyCodeAndLogin(email, code, clientIp, userAgent);
    
    res.json(result);
  } catch (error) {
    console.error('[api] Auth verification error:', error);
    
    let statusCode = 400;
    if (error.message.includes('多すぎます') || error.message.includes('ロック')) {
      statusCode = 429;
    }
    
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
    const userRole = req.user.role;

    // 開発者は制限なし
    if (userRole === 'developer') {
      return next();
    }

    const usage = await db.getTodayUsage(userId);
    const articleCount = usage?.article_count || 0;
    const regenerationCount = usage?.regeneration_count || 0;

    // 制限チェック
    const DAILY_LIMITS = {
      articles: 5,
      regenerations: 50
    };

    if (articleCount >= DAILY_LIMITS.articles) {
      return res.status(403).json({
        error: "DAILY_LIMIT_EXCEEDED",
        message: "本日の記事処理数が上限に達しました",
        usage: { articleCount, regenerationCount },
        limits: DAILY_LIMITS
      });
    }

    req.usage = { articleCount, regenerationCount };
    req.limits = DAILY_LIMITS;
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
    const usage = await db.getTodayUsage(userId);
    
    const limits = {
      articles: req.user.role === 'developer' ? -1 : 5,
      regenerations: req.user.role === 'developer' ? -1 : 50
    };

    res.json({
      success: true,
      usage: {
        articleCount: usage?.article_count || 0,
        regenerationCount: usage?.regeneration_count || 0
      },
      limits
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

    // 画像生成処理をここに実装
    // TODO: Gemini API連携

    // 仮の応答
    res.json({
      success: true,
      dataUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZGRkZGRkIi8+CiAgPHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxOCIgZmlsbD0iIzk5OTk5OSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkRlbW8gSW1hZ2U8L3RleHQ+Cjwvc3ZnPgo=',
      demoInfo: {
        message: `デモ画像を生成しました（残り${remainingUses}回）`,
        remainingUses,
        usedCount: usageResults[0].count
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
    const { content, provider = 'google', taste = 'modern', aspectRatio = '1:1' } = req.body;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'コンテンツが必要です'
      });
    }

    // 使用量を増加
    await db.incrementUsage(req.user.id, 'article');

    // TODO: 実際の画像生成処理をここに実装
    
    // 仮の応答
    res.json({
      success: true,
      message: '画像生成が完了しました',
      images: [
        {
          id: 'demo-1',
          title: 'Generated Image 1',
          dataUrl: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjQwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjNjY3ZWVhIi8+CiAgPHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxOCIgZmlsbD0iI2ZmZmZmZiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPkdlbmVyYXRlZCBJbWFnZTwvdGV4dD4KPC9zdmc+Cg=='
        }
      ],
      usage: {
        articleCount: req.usage.articleCount + 1,
        regenerationCount: req.usage.regenerationCount
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
