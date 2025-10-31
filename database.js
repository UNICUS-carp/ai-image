import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

class SecureDatabase {
  constructor() {
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      const dbPath = process.env.DATABASE_PATH || './illustauto_v2.db';
      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          console.error('[db] Failed to initialize database:', err);
          reject(err);
        } else {
          console.log('[db] Database initialized successfully');
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    const tables = [
      // ユーザーテーブル（シンプル化・セキュア化）
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        email_hash TEXT UNIQUE NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'user',
        payment_status TEXT DEFAULT 'pending',
        payment_date DATETIME,
        expiration_date DATETIME,
        payment_plan TEXT,
        payment_amount INTEGER,
        payment_note TEXT,
        login_attempts INTEGER DEFAULT 0,
        locked_until DATETIME NULL,
        email_verified BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        last_ip TEXT
      )`,
      
      // 認証コードテーブル
      `CREATE TABLE IF NOT EXISTS auth_codes (
        id TEXT PRIMARY KEY,
        email_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        attempts INTEGER DEFAULT 0,
        ip_address TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // JWTブラックリストテーブル
      `CREATE TABLE IF NOT EXISTS jwt_blacklist (
        id TEXT PRIMARY KEY,
        token_jti TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )`,
      
      // セキュリティログテーブル
      `CREATE TABLE IF NOT EXISTS security_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        details TEXT,
        risk_level TEXT DEFAULT 'low',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
      )`,
      
      // レート制限テーブル
      `CREATE TABLE IF NOT EXISTS rate_limits (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        action TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        window_start DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(identifier, identifier_type, action)
      )`,
      
      // 使用量追跡テーブル（既存から移行）
      `CREATE TABLE IF NOT EXISTS usage_tracking (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date DATE NOT NULL,
        article_count INTEGER DEFAULT 0,
        regeneration_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        UNIQUE(user_id, date)
      )`,
      
      // デモ使用追跡テーブル（既存のまま）
      `CREATE TABLE IF NOT EXISTS demo_usage (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        usage_count INTEGER DEFAULT 0,
        is_banned BOOLEAN DEFAULT FALSE,
        last_used DATETIME,
        device_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(identifier, identifier_type)
      )`,
      
      // ブラックリスト（既存のまま）
      `CREATE TABLE IF NOT EXISTS demo_blacklist (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        reason TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        device_info TEXT,
        UNIQUE(identifier, identifier_type)
      )`
    ];

    for (const sql of tables) {
      await this.run(sql);
    }
    
    console.log('[db] All tables created successfully');
  }

  // Promiseベースのクエリ実行
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          console.error('[db] Run error:', err);
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          console.error('[db] Get error:', err);
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('[db] All error:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // ========================================
  // ユーティリティメソッド
  // ========================================

  // メールアドレスのハッシュ化
  hashEmail(email) {
    return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  }

  // 認証コードのハッシュ化
  async hashCode(code) {
    return await bcrypt.hash(code, 10);
  }

  // 認証コードの検証
  async verifyCode(code, hashedCode) {
    return await bcrypt.compare(code, hashedCode);
  }

  // ========================================
  // ユーザー管理メソッド
  // ========================================

  async createUser(email, displayName = null) {
    const userId = uuidv4();
    const emailHash = this.hashEmail(email);
    
    // 開発者用メールアドレスの場合は開発者ロールを設定
    const role = email === 'free_dial0120@yahoo.co.jp' ? 'developer' : 'user';
    
    await this.run(
      'INSERT INTO users (id, email, email_hash, display_name, email_verified, role) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, email, emailHash, displayName, true, role] // メール認証後なのでtrue
    );
    
    // セキュリティログを記録
    await this.logSecurityEvent(userId, 'user_created', null, null, `User created: ${email} (role: ${role})`, 'low');
    
    return userId;
  }

  async getUserByEmail(email) {
    const emailHash = this.hashEmail(email);
    return await this.get('SELECT * FROM users WHERE email_hash = ?', [emailHash]);
  }

  async getUserById(userId) {
    return await this.get('SELECT * FROM users WHERE id = ?', [userId]);
  }

  async updateLastLogin(userId, ipAddress = null) {
    await this.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP, last_ip = ?, login_attempts = 0 WHERE id = ?',
      [ipAddress, userId]
    );
  }

  async incrementLoginAttempts(email) {
    const emailHash = this.hashEmail(email);
    
    // アトミックな操作: 試行回数を増加し、同時に新しい値を取得
    const result = await this.run(
      'UPDATE users SET login_attempts = login_attempts + 1 WHERE email_hash = ?',
      [emailHash]
    );
    
    // 更新後の値を取得
    const user = await this.getUserByEmail(email);
    if (!user) return result;
    
    // 5回失敗したらロック（15分間） - 更新された値で判定
    if (user.login_attempts >= 5) {
      const lockUntil = new Date(Date.now() + 15 * 60 * 1000); // 15分後
      await this.run(
        'UPDATE users SET locked_until = ? WHERE email_hash = ? AND login_attempts >= 5',
        [lockUntil.toISOString(), emailHash]
      );
      console.log(`[db] User locked after ${user.login_attempts} failed attempts: ${email}`);
    }
    
    return result;
  }

  async isUserLocked(email) {
    const user = await this.getUserByEmail(email);
    if (!user || !user.locked_until) return false;
    
    const now = new Date();
    const lockUntil = new Date(user.locked_until);
    
    if (now < lockUntil) {
      return true;
    } else {
      // ロック期間が過ぎた場合、ロックを解除
      await this.run('UPDATE users SET locked_until = NULL, login_attempts = 0 WHERE id = ?', [user.id]);
      return false;
    }
  }

  // ========================================
  // 認証コード管理
  // ========================================

  async saveAuthCode(email, code, expiresAt, ipAddress = null, userAgent = null) {
    const codeId = uuidv4();
    const emailHash = this.hashEmail(email);
    const codeHash = await this.hashCode(code);
    
    // 既存の未使用コードを削除
    await this.run('DELETE FROM auth_codes WHERE email_hash = ? AND used = FALSE', [emailHash]);
    
    await this.run(
      'INSERT INTO auth_codes (id, email_hash, code_hash, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [codeId, emailHash, codeHash, expiresAt, ipAddress, userAgent]
    );
    
    return codeId;
  }

  async verifyAuthCode(email, code) {
    const emailHash = this.hashEmail(email);
    
    // 現在時刻をJavaScriptで取得してISO文字列にする（SQLiteとの一貫性を保つため）
    const currentTime = new Date().toISOString();
    
    // アトミックな操作: 使用済みマークと同時に取得
    const result = await this.run(
      'UPDATE auth_codes SET used = TRUE WHERE email_hash = ? AND used = FALSE AND expires_at > ? AND attempts < 3',
      [emailHash, currentTime]
    );
    
    // 更新されたレコードがない場合は失敗
    if (result.changes === 0) {
      console.log(`[db] verifyAuthCode - no available code found for atomic update`);
      return { valid: false, reason: 'Code not found or expired' };
    }
    
    // 更新されたレコードを取得
    const authCode = await this.get(
      'SELECT * FROM auth_codes WHERE email_hash = ? AND used = TRUE ORDER BY created_at DESC LIMIT 1',
      [emailHash]
    );
    
    console.log(`[db] verifyAuthCode - email: ${email}, currentTime: ${currentTime}`);
    console.log(`[db] verifyAuthCode - atomic update successful, verifying code`);
    
    if (!authCode) {
      console.log(`[db] verifyAuthCode - failed to retrieve updated record`);
      return { valid: false, reason: 'Code verification failed' };
    }
    
    // コードを検証（既に使用済みマークされているので、検証のみ）
    const isValid = await this.verifyCode(code, authCode.code_hash);
    
    console.log(`[db] verifyAuthCode - code verification result: ${isValid}`);
    
    if (isValid) {
      console.log(`[db] verifyAuthCode - success with atomic operation`);
      return { valid: true, codeId: authCode.id };
    } else {
      // 検証失敗の場合、使用済みマークを戻す
      await this.run('UPDATE auth_codes SET used = FALSE WHERE id = ?', [authCode.id]);
      console.log(`[db] verifyAuthCode - code invalid, reverted used flag`);
      return { valid: false, reason: 'Invalid code' };
    }
  }

  // デバッグ用: 特定メールの認証コード一覧取得
  async getAuthCodesForEmail(email) {
    const emailHash = this.hashEmail(email);
    const codes = await this.all(
      'SELECT id, email_hash, code_hash, expires_at, used, attempts, created_at FROM auth_codes WHERE email_hash = ? ORDER BY created_at DESC',
      [emailHash]
    );
    return codes.map(code => ({
      ...code,
      email: email, // 元のメールアドレスを追加
      expired: new Date(code.expires_at) < new Date()
    }));
  }

  async getLastCodeRequest(email) {
    const emailHash = this.hashEmail(email);
    return await this.get(
      'SELECT * FROM auth_codes WHERE email_hash = ? ORDER BY created_at DESC LIMIT 1',
      [emailHash]
    );
  }

  // ========================================
  // JWT ブラックリスト管理
  // ========================================

  async addToBlacklist(tokenJti, userId, expiresAt) {
    const id = uuidv4();
    await this.run(
      'INSERT INTO jwt_blacklist (id, token_jti, user_id, expires_at) VALUES (?, ?, ?, ?)',
      [id, tokenJti, userId, expiresAt]
    );
  }

  async isTokenBlacklisted(tokenJti) {
    const result = await this.get(
      'SELECT * FROM jwt_blacklist WHERE token_jti = ? AND expires_at > CURRENT_TIMESTAMP',
      [tokenJti]
    );
    return !!result;
  }

  async cleanupExpiredTokens() {
    const result = await this.run('DELETE FROM jwt_blacklist WHERE expires_at <= CURRENT_TIMESTAMP');
    if (result.changes > 0) {
      console.log(`[db] Cleaned up ${result.changes} expired tokens`);
    }
  }

  // ========================================
  // レート制限管理
  // ========================================

  async checkRateLimit(identifier, identifierType, action, windowMs, maxAttempts) {
    const windowStart = new Date(Date.now() - windowMs);
    const now = new Date().toISOString();
    
    // アトミックな UPSERT 操作で競合状態を回避
    const id = uuidv4();
    const result = await this.run(`
      INSERT INTO rate_limits (id, identifier, identifier_type, action, count, window_start) 
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(identifier, identifier_type, action) 
      DO UPDATE SET 
        count = CASE 
          WHEN window_start <= ? THEN 1 
          ELSE count + 1 
        END,
        window_start = CASE 
          WHEN window_start <= ? THEN ? 
          ELSE window_start 
        END
    `, [id, identifier, identifierType, action, now, windowStart.toISOString(), windowStart.toISOString(), now]);
    
    // 更新後の値を取得して制限チェック
    const updated = await this.get(
      'SELECT * FROM rate_limits WHERE identifier = ? AND identifier_type = ? AND action = ?',
      [identifier, identifierType, action]
    );
    
    if (updated.count > maxAttempts) {
      const resetAt = new Date(new Date(updated.window_start).getTime() + windowMs);
      return { allowed: false, count: updated.count, resetAt };
    }
    
    return { allowed: true, count: updated.count };
  }

  async cleanupOldRateLimits() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.run('DELETE FROM rate_limits WHERE window_start < ?', [oneDayAgo.toISOString()]);
    if (result.changes > 0) {
      console.log(`[db] Cleaned up ${result.changes} old rate limit records`);
    }
  }

  // ========================================
  // セキュリティログ
  // ========================================

  async logSecurityEvent(userId, action, ipAddress = null, userAgent = null, details = null, riskLevel = 'low') {
    const logId = uuidv4();
    await this.run(
      'INSERT INTO security_logs (id, user_id, action, ip_address, user_agent, details, risk_level) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [logId, userId, action, ipAddress, userAgent, details, riskLevel]
    );
  }

  async getSecurityLogs(userId, limit = 50) {
    return await this.all(
      'SELECT * FROM security_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
  }

  // ========================================
  // 既存機能（デモ・使用量）の移行
  // ========================================

  // デモ使用管理（既存のまま）
  async getDemoUsage(identifier, identifierType = 'ip') {
    return await this.get(
      'SELECT * FROM demo_usage WHERE identifier = ? AND identifier_type = ?',
      [identifier, identifierType]
    );
  }

  async incrementDemoUsage(identifiers, deviceInfo = null) {
    const DEMO_LIMIT = 3;
    const results = [];
    
    for (const { identifier, type } of identifiers) {
      const existing = await this.getDemoUsage(identifier, type);
      let newCount;
      
      if (existing) {
        newCount = existing.usage_count + 1;
        const isBanned = newCount >= DEMO_LIMIT;
        
        await this.run(`
          UPDATE demo_usage 
          SET usage_count = ?,
              is_banned = ?,
              last_used = CURRENT_TIMESTAMP,
              device_info = ?
          WHERE identifier = ? AND identifier_type = ?
        `, [newCount, isBanned, deviceInfo, identifier, type]);
        
        if (isBanned) {
          await this.addToBlacklist(identifier, type, `Demo limit exceeded (${newCount}/${DEMO_LIMIT})`, deviceInfo);
        }
      } else {
        newCount = 1;
        const id = uuidv4();
        await this.run(`
          INSERT INTO demo_usage 
          (id, identifier, identifier_type, usage_count, last_used, device_info)
          VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?)
        `, [id, identifier, type, deviceInfo]);
      }
      
      results.push({ identifier, type, count: newCount });
    }
    
    return results;
  }

  async addToBlacklist(identifier, identifierType, reason, deviceInfo = null) {
    const id = uuidv4();
    await this.run(`
      INSERT OR IGNORE INTO demo_blacklist 
      (id, identifier, identifier_type, reason, device_info)
      VALUES (?, ?, ?, ?, ?)
    `, [id, identifier, identifierType, reason, deviceInfo]);
  }

  // 使用量追跡
  async getTodayUsage(userId) {
    const today = new Date().toISOString().split('T')[0];
    return await this.get(
      'SELECT * FROM usage_tracking WHERE user_id = ? AND date = ?',
      [userId, today]
    );
  }

  async incrementUsage(userId, type) {
    const today = new Date().toISOString().split('T')[0];
    const column = type === 'article' ? 'article_count' : 'regeneration_count';
    
    await this.run(`
      INSERT INTO usage_tracking (id, user_id, date, ${column})
      VALUES (?, ?, ?, 1)
      ON CONFLICT(user_id, date)
      DO UPDATE SET 
        ${column} = ${column} + 1,
        updated_at = CURRENT_TIMESTAMP
    `, [uuidv4(), userId, today]);
  }

  // 決済管理
  async updatePaymentStatus(userId, paymentData) {
    const { status, plan, amount, expirationDate, note } = paymentData;
    await this.run(`
      UPDATE users 
      SET payment_status = ?, 
          payment_date = CURRENT_TIMESTAMP,
          payment_plan = ?,
          payment_amount = ?,
          expiration_date = ?,
          payment_note = ?
      WHERE id = ?
    `, [status, plan, amount, expirationDate, note, userId]);
  }

  async checkPaymentStatus(email) {
    const user = await this.getUserByEmail(email);
    if (!user) return null;
    
    if (user.payment_status === 'paid' && user.expiration_date) {
      const now = new Date();
      const expiry = new Date(user.expiration_date);
      if (expiry < now) {
        await this.run('UPDATE users SET payment_status = ? WHERE id = ?', ['expired', user.id]);
        return 'expired';
      }
    }
    
    return user.payment_status;
  }

  async getUserRole(userId) {
    const user = await this.get('SELECT role FROM users WHERE id = ?', [userId]);
    return user?.role || 'user';
  }

  // ========================================
  // デモ使用管理メソッド
  // ========================================
  
  async getDemoUsage(identifier, identifierType = 'ip') {
    return await this.get(`
      SELECT * FROM demo_usage 
      WHERE identifier = ? AND identifier_type = ?
    `, [identifier, identifierType]);
  }

  async isBlacklisted(identifier, identifierType = 'ip') {
    const blacklisted = await this.get(`
      SELECT * FROM demo_blacklist 
      WHERE identifier = ? AND identifier_type = ?
    `, [identifier, identifierType]);
    return !!blacklisted;
  }

  async addToBlacklist(identifier, identifierType, reason, deviceInfo = null) {
    const id = uuidv4();
    await this.run(`
      INSERT OR IGNORE INTO demo_blacklist 
      (id, identifier, identifier_type, reason, device_info)
      VALUES (?, ?, ?, ?, ?)
    `, [id, identifier, identifierType, reason, deviceInfo]);
  }

  async checkDemoAccess(identifiers) {
    // 複数の識別子をチェック
    for (const { identifier, type } of identifiers) {
      // ブラックリストチェック
      if (await this.isBlacklisted(identifier, type)) {
        return { allowed: false, reason: 'BLACKLISTED', identifier, type };
      }
      
      // 使用回数チェック
      const usage = await this.getDemoUsage(identifier, type);
      if (usage && (usage.usage_count >= 3 || usage.is_banned)) {
        return { allowed: false, reason: 'LIMIT_EXCEEDED', identifier, type, usage };
      }
    }
    
    return { allowed: true };
  }

  async incrementDemoUsage(identifiers, deviceInfo = null) {
    const DEMO_LIMIT = 3;
    const results = [];
    
    // 各識別子の使用回数を更新
    for (const { identifier, type } of identifiers) {
      const existing = await this.getDemoUsage(identifier, type);
      let newCount;
      
      if (existing) {
        newCount = existing.usage_count + 1;
        
        // 制限に達した場合はban状態にする
        const isBanned = newCount >= DEMO_LIMIT;
        
        await this.run(`
          UPDATE demo_usage 
          SET usage_count = ?,
              is_banned = ?,
              last_used = CURRENT_TIMESTAMP,
              device_info = ?
          WHERE identifier = ? AND identifier_type = ?
        `, [newCount, isBanned, deviceInfo, identifier, type]);
        
        // ブラックリストに追加
        if (isBanned) {
          await this.addToBlacklist(
            identifier, 
            type, 
            `Demo limit exceeded (${newCount}/${DEMO_LIMIT})`,
            deviceInfo
          );
        }
      } else {
        newCount = 1;
        const id = uuidv4();
        await this.run(`
          INSERT INTO demo_usage 
          (id, identifier, identifier_type, usage_count, last_used, device_info)
          VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?)
        `, [id, identifier, type, deviceInfo]);
      }
      
      results.push({ identifier, type, count: newCount });
    }
    
    return results;
  }

  async close() {
    if (this.db) {
      return new Promise((resolve) => {
        this.db.close((err) => {
          if (err) {
            console.error('[db] Error closing database:', err);
          } else {
            console.log('[db] Database connection closed');
          }
          resolve();
        });
      });
    }
  }
}

export default SecureDatabase;
