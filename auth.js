import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';

class EmailAuthenticator {
  constructor(database) {
    this.db = database;
    this.jwtSecret = process.env.JWT_SECRET || 'your-super-secure-256-bit-secret-key-change-this';
    this.jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-change-this';
    
    // JWT設定
    this.jwtExpiry = '24h';
    this.refreshExpiry = '7d';
    
    // 認証コード設定
    this.codeExpiry = 5 * 60 * 1000; // 5分
    this.codeRequestCooldown = 60 * 1000; // 1分
    
    // レート制限設定
    this.rateLimit = {
      codeRequest: { window: 15 * 60 * 1000, max: 3 }, // 15分で3回
      authAttempt: { window: 15 * 60 * 1000, max: 5 }   // 15分で5回
    };
    
    this.initializeMailer();
    
    console.log(`[auth] Email authenticator initialized`);
  }

  initializeMailer() {
    // メール送信設定
    this.mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false, // STARTTLS for port 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      tls: {
        rejectUnauthorized: false,
        ciphers: 'SSLv3'
      },
      connectionTimeout: 60000, // 60秒タイムアウト
      greetingTimeout: 30000, // 30秒グリーティングタイムアウト
      socketTimeout: 60000, // 60秒ソケットタイムアウト
      debug: false // デバッグ無効化
    });

    // メール設定を検証
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      this.mailer.verify((error, success) => {
        if (error) {
          console.error('[auth] SMTP configuration error:', error);
        } else {
          console.log('[auth] SMTP server ready');
        }
      });
    } else {
      console.warn('[auth] SMTP credentials not configured - email sending will fail');
    }
  }

  // ========================================
  // 認証コード送信
  // ========================================

  async requestAuthCode(email, ipAddress = null, userAgent = null) {
    try {
      email = email.toLowerCase().trim();
      
      console.log(`[auth] Auth code requested for: ${email}`);

      // 入力検証
      if (!this.isValidEmail(email)) {
        throw new Error('有効なメールアドレスを入力してください');
      }

      // ユーザーロック状態をチェック
      if (await this.db.isUserLocked(email)) {
        throw new Error('アカウントが一時的にロックされています。しばらく待ってから再試行してください');
      }

      // レート制限チェック（IP別）
      if (ipAddress) {
        const ipLimit = await this.db.checkRateLimit(
          ipAddress, 'ip', 'code_request', 
          this.rateLimit.codeRequest.window, 
          this.rateLimit.codeRequest.max
        );
        
        if (!ipLimit.allowed) {
          const resetTime = Math.ceil((ipLimit.resetAt - new Date()) / 1000 / 60);
          throw new Error(`認証コードの要求回数が多すぎます。${resetTime}分後に再試行してください`);
        }
      }

      // レート制限チェック（メール別）
      const emailLimit = await this.db.checkRateLimit(
        this.db.hashEmail(email), 'email', 'code_request',
        this.rateLimit.codeRequest.window,
        this.rateLimit.codeRequest.max
      );
      
      if (!emailLimit.allowed) {
        const resetTime = Math.ceil((emailLimit.resetAt - new Date()) / 1000 / 60);
        throw new Error(`このメールアドレスの認証コード要求回数が多すぎます。${resetTime}分後に再試行してください`);
      }

      // クールダウンチェック
      const lastRequest = await this.db.getLastCodeRequest(email);
      if (lastRequest) {
        const timeSinceLastRequest = Date.now() - new Date(lastRequest.created_at).getTime();
        if (timeSinceLastRequest < this.codeRequestCooldown) {
          const waitTime = Math.ceil((this.codeRequestCooldown - timeSinceLastRequest) / 1000);
          throw new Error(`認証コードの再送信は${waitTime}秒後に可能です`);
        }
      }

      // 6桁ランダムコード生成
      const code = this.generateAuthCode();
      const expiresAt = new Date(Date.now() + this.codeExpiry).toISOString();
      
      // データベースに保存
      const codeId = await this.db.saveAuthCode(code, email, expiresAt, ipAddress, userAgent);
      
      // メール送信
      await this.sendAuthCodeEmail(email, code);
      
      // セキュリティログ
      const user = await this.db.getUserByEmail(email);
      await this.db.logSecurityEvent(
        user?.id || null, 
        'auth_code_requested', 
        ipAddress, 
        userAgent, 
        `Code requested for ${email}`,
        'low'
      );

      console.log(`[auth] Auth code sent to: ${email}`);
      
      const nextAllowedAt = new Date(Date.now() + this.codeRequestCooldown);
      
      return {
        success: true,
        message: '認証コードを送信しました',
        codeId,
        expiresAt,
        nextRequestAllowedAt: nextAllowedAt.toISOString()
      };

    } catch (error) {
      console.error('[auth] Auth code request error:', error);
      
      // セキュリティログ（失敗）
      await this.db.logSecurityEvent(
        null, 
        'auth_code_request_failed', 
        ipAddress, 
        userAgent, 
        `Failed: ${error.message}`,
        'medium'
      );
      
      throw error;
    }
  }

  // ========================================
  // 認証コード検証とJWT発行
  // ========================================

  async verifyCodeAndLogin(email, code, ipAddress = null, userAgent = null) {
    try {
      email = email.toLowerCase().trim();
      
      console.log(`[auth] Verifying code for: ${email}`);

      // 入力検証
      if (!email || !code) {
        throw new Error('メールアドレスと認証コードを入力してください');
      }

      if (!this.isValidEmail(email)) {
        throw new Error('有効なメールアドレスを入力してください');
      }

      if (!/^\d{6}$/.test(code)) {
        throw new Error('認証コードは6桁の数字で入力してください');
      }

      // ユーザーロック状態をチェック
      if (await this.db.isUserLocked(email)) {
        throw new Error('アカウントが一時的にロックされています');
      }

      // レート制限チェック（認証試行）
      if (ipAddress) {
        const ipLimit = await this.db.checkRateLimit(
          ipAddress, 'ip', 'auth_attempt',
          this.rateLimit.authAttempt.window,
          this.rateLimit.authAttempt.max
        );
        
        if (!ipLimit.allowed) {
          throw new Error('認証試行回数が多すぎます。しばらく待ってから再試行してください');
        }
      }

      // 認証コード検証
      const verification = await this.db.verifyAuthCode(email, code);
      
      if (!verification.valid) {
        // 失敗の場合、ログイン試行回数を増加
        await this.db.incrementLoginAttempts(email);
        
        // セキュリティログ
        const user = await this.db.getUserByEmail(email);
        await this.db.logSecurityEvent(
          user?.id || null,
          'auth_failed',
          ipAddress,
          userAgent,
          `Invalid code: ${verification.reason}`,
          'high'
        );
        
        let errorMessage = '認証に失敗しました';
        if (verification.reason === 'Code not found or expired') {
          errorMessage = '認証コードが無効または期限切れです';
        } else if (verification.reason === 'Too many attempts') {
          errorMessage = '認証コードの試行回数が多すぎます';
        } else if (verification.reason === 'Invalid code') {
          errorMessage = '認証コードが正しくありません';
        }
        
        throw new Error(errorMessage);
      }

      // ユーザーを取得または作成
      let user = await this.db.getUserByEmail(email);
      if (!user) {
        // 新規ユーザー作成
        const userId = await this.db.createUser(email);
        user = await this.db.getUserById(userId);
        console.log(`[auth] Created new user: ${userId}`);
      }

      // ログイン成功処理
      await this.db.updateLastLogin(user.id, ipAddress);
      
      // JWT生成
      const tokens = this.generateTokens(user);
      
      // セキュリティログ
      await this.db.logSecurityEvent(
        user.id,
        'login_success',
        ipAddress,
        userAgent,
        'Email authentication successful',
        'low'
      );

      console.log(`[auth] Login successful for user: ${user.id}`);

      return {
        success: true,
        verified: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role || 'user'
        },
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: 24 * 60 * 60, // 24時間（秒）
        message: 'ログインに成功しました'
      };

    } catch (error) {
      console.error('[auth] Login verification error:', error);
      throw error;
    }
  }

  // ========================================
  // JWT関連
  // ========================================

  generateTokens(user) {
    const jti = uuidv4(); // JWT ID
    const now = Math.floor(Date.now() / 1000);
    
    const payload = {
      jti,
      sub: user.id,
      email: user.email,
      role: user.role || 'user',
      iat: now,
      iss: 'illustauto',
      aud: 'illustauto-users'
    };

    const accessToken = jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiry
    });

    const refreshPayload = {
      jti: uuidv4(),
      sub: user.id,
      type: 'refresh',
      iat: now
    };

    const refreshToken = jwt.sign(refreshPayload, this.jwtRefreshSecret, {
      expiresIn: this.refreshExpiry
    });

    return { accessToken, refreshToken };
  }

  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      
      // ブラックリストチェック
      if (await this.db.isTokenBlacklisted(decoded.jti)) {
        throw new Error('Token has been revoked');
      }
      
      // ユーザー存在チェック
      const user = await this.db.getUserById(decoded.sub);
      if (!user) {
        throw new Error('User not found');
      }
      
      return {
        valid: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role || 'user'
        },
        decoded
      };
    } catch (error) {
      console.error('[auth] Token verification error:', error);
      return {
        valid: false,
        error: error.message
      };
    }
  }

  async refreshToken(refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtRefreshSecret);
      
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid refresh token');
      }
      
      const user = await this.db.getUserById(decoded.sub);
      if (!user) {
        throw new Error('User not found');
      }
      
      const tokens = this.generateTokens(user);
      
      return {
        success: true,
        accessToken: tokens.accessToken,
        expiresIn: 24 * 60 * 60
      };
      
    } catch (error) {
      console.error('[auth] Token refresh error:', error);
      throw new Error('Invalid refresh token');
    }
  }

  async logout(token) {
    try {
      const decoded = jwt.verify(token, this.jwtSecret, { ignoreExpiration: true });
      
      // トークンをブラックリストに追加
      const expiresAt = new Date(decoded.exp * 1000).toISOString();
      await this.db.addToBlacklist(decoded.jti, decoded.sub, expiresAt);
      
      // セキュリティログ
      await this.db.logSecurityEvent(
        decoded.sub,
        'logout',
        null,
        null,
        'User logged out',
        'low'
      );
      
      console.log(`[auth] User logged out: ${decoded.sub}`);
      
      return { success: true };
    } catch (error) {
      console.error('[auth] Logout error:', error);
      return { success: false, message: error.message };
    }
  }

  // ========================================
  // ユーティリティメソッド
  // ========================================

  generateAuthCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  async sendAuthCodeEmail(email, code) {
    const emailTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>IllustAuto 認証コード</title>
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="margin: 0; font-size: 28px;">🎨 IllustAuto</h1>
    <p style="margin: 10px 0 0 0; opacity: 0.9;">AI画像生成サービス</p>
  </div>
  <div style="background: white; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
    <h2 style="color: #333; margin-top: 0;">認証コード</h2>
    <p style="color: #666; margin-bottom: 30px;">以下の認証コードを入力してログインを完了してください：</p>
    
    <div style="background: #f8f9fa; border: 2px solid #667eea; padding: 25px; text-align: center; border-radius: 10px; margin: 30px 0;">
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea; font-family: 'Courier New', monospace;">
        ${code}
      </div>
    </div>
    
    <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <p style="margin: 0; color: #856404; font-size: 14px;">
        ⚠️ <strong>重要:</strong><br>
        • このコードは<strong>5分間</strong>有効です<br>
        • 第三者と共有しないでください<br>
        • このメールに心当たりがない場合は削除してください
      </p>
    </div>
    
    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
    
    <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">
      このメールはIllustAutoから自動送信されています。<br>
      返信はできませんのでご了承ください。
    </p>
  </div>
</body>
</html>
    `;

    const mailOptions = {
      from: `"IllustAuto" <${process.env.SMTP_USER}>`,
      to: email,
      subject: '[IllustAuto] ログイン認証コード',
      html: emailTemplate
    };

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.log(`[auth] EMAIL NOT SENT (SMTP not configured): Code ${code} for ${email}`);
      return;
    }

    await this.mailer.sendMail(mailOptions);
    console.log(`[auth] Email sent to: ${email}`);
  }

  // ========================================
  // クリーンアップ
  // ========================================

  async cleanup() {
    try {
      await this.db.cleanupExpiredTokens();
      await this.db.cleanupOldRateLimits();
      console.log('[auth] Cleanup completed');
    } catch (error) {
      console.error('[auth] Cleanup error:', error);
    }
  }
}

export default EmailAuthenticator;
