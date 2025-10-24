import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';

class Database {
  constructor() {
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(':memory:', (err) => {
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
      // ユーザーテーブル
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        display_name TEXT,
        role TEXT DEFAULT 'user',
        payment_status TEXT DEFAULT 'pending',
        payment_date DATETIME,
        expiration_date DATETIME,
        payment_plan TEXT,
        payment_amount INTEGER,
        payment_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      )`,
      
      // WebAuthn認証情報テーブル
      `CREATE TABLE IF NOT EXISTS user_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT UNIQUE NOT NULL,
        credential_public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        credential_device_type TEXT,
        credential_backed_up BOOLEAN DEFAULT FALSE,
        transports TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )`,
      
      // セッションテーブル
      `CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_data TEXT,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )`,
      
      // 使用量追跡テーブル
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
      
      // デモ使用追跡テーブル（複数識別子）
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
      
      // ブラックリスト（使用制限済み識別子）
      `CREATE TABLE IF NOT EXISTS demo_blacklist (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        reason TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        device_info TEXT,
        UNIQUE(identifier, identifier_type)
      )`,
      
      // チャレンジストレージ（一時的な認証チャレンジ）
      `CREATE TABLE IF NOT EXISTS auth_challenges (
        challenge TEXT PRIMARY KEY,
        user_id TEXT,
        type TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
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
  // ユーザー管理メソッド
  // ========================================

  async createUser(email, displayName = null) {
    const userId = uuidv4();
    await this.run(
      'INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)',
      [userId, email, displayName]
    );
    return userId;
  }

  async getUserByEmail(email) {
    return await this.get('SELECT * FROM users WHERE email = ?', [email]);
  }

  async getUserById(userId) {
    return await this.get('SELECT * FROM users WHERE id = ?', [userId]);
  }

  async updateLastLogin(userId) {
    await this.run(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
      [userId]
    );
  }

  async setUserRole(userId, role) {
    await this.run(
      'UPDATE users SET role = ? WHERE id = ?',
      [role, userId]
    );
  }

  async getUserRole(userId) {
    const user = await this.get('SELECT role FROM users WHERE id = ?', [userId]);
    return user?.role || 'user';
  }

  // ========================================
  // 決済管理メソッド
  // ========================================
  
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
    const user = await this.get(`
      SELECT payment_status, expiration_date 
      FROM users 
      WHERE email = ?
    `, [email]);
    
    if (!user) return null;
    
    // 有効期限チェック
    if (user.payment_status === 'paid' && user.expiration_date) {
      const now = new Date();
      const expiry = new Date(user.expiration_date);
      if (expiry < now) {
        // 期限切れの場合、ステータスを更新
        await this.run(
          'UPDATE users SET payment_status = ? WHERE email = ?',
          ['expired', email]
        );
        return 'expired';
      }
    }
    
    return user.payment_status;
  }

  // ========================================
  // デモ使用管理メソッド（強化版）
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

  // デモ使用統計の取得
  async getDemoStats() {
    const totalUsers = await this.get('SELECT COUNT(*) as count FROM demo_usage');
    const bannedUsers = await this.get('SELECT COUNT(*) as count FROM demo_usage WHERE is_banned = TRUE');
    const blacklistedUsers = await this.get('SELECT COUNT(*) as count FROM demo_blacklist');
    
    return {
      totalDemoUsers: totalUsers.count,
      bannedUsers: bannedUsers.count,
      blacklistedUsers: blacklistedUsers.count
    };
  }

  // ========================================
  // WebAuthn認証情報管理
  // ========================================

  async saveCredential(userId, credentialData) {
    const credentialId = uuidv4();
    await this.run(`
      INSERT INTO user_credentials (
        id, user_id, credential_id, credential_public_key, 
        counter, credential_device_type, credential_backed_up, transports
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      credentialId,
      userId,
      credentialData.id,
      credentialData.publicKey,
      credentialData.counter,
      credentialData.deviceType,
      credentialData.backedUp,
      JSON.stringify(credentialData.transports)
    ]);
    return credentialId;
  }

  async getCredentialByCredentialId(credentialId) {
    const row = await this.get(
      'SELECT * FROM user_credentials WHERE credential_id = ?',
      [credentialId]
    );
    if (row) {
      row.transports = JSON.parse(row.transports || '[]');
    }
    return row;
  }

  async getUserCredentials(userId) {
    const rows = await this.all(
      'SELECT * FROM user_credentials WHERE user_id = ?',
      [userId]
    );
    return rows.map(row => ({
      ...row,
      transports: JSON.parse(row.transports || '[]')
    }));
  }

  async updateCredentialCounter(credentialId, newCounter) {
    await this.run(
      'UPDATE user_credentials SET counter = ? WHERE credential_id = ?',
      [newCounter, credentialId]
    );
  }

  // ========================================
  // セッション管理
  // ========================================

  async createSession(userId, sessionData, expiresAt) {
    const sessionId = uuidv4();
    await this.run(
      'INSERT INTO user_sessions (id, user_id, session_data, expires_at) VALUES (?, ?, ?, ?)',
      [sessionId, userId, JSON.stringify(sessionData), expiresAt]
    );
    return sessionId;
  }

  async getSession(sessionId) {
    const row = await this.get(
      'SELECT * FROM user_sessions WHERE id = ? AND expires_at > CURRENT_TIMESTAMP',
      [sessionId]
    );
    if (row) {
      row.session_data = JSON.parse(row.session_data);
    }
    return row;
  }

  async deleteSession(sessionId) {
    await this.run('DELETE FROM user_sessions WHERE id = ?', [sessionId]);
  }

  async cleanupExpiredSessions() {
    const result = await this.run('DELETE FROM user_sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    if (result.changes > 0) {
      console.log(`[db] Cleaned up ${result.changes} expired sessions`);
    }
  }

  // ========================================
  // チャレンジ管理
  // ========================================

  async saveChallenge(challenge, userId, type, expiresAt) {
    await this.run(
      'INSERT INTO auth_challenges (challenge, user_id, type, expires_at) VALUES (?, ?, ?, ?)',
      [challenge, userId, type, expiresAt]
    );
  }

  async getChallenge(challenge) {
    return await this.get(
      'SELECT * FROM auth_challenges WHERE challenge = ? AND expires_at > CURRENT_TIMESTAMP',
      [challenge]
    );
  }

  async deleteChallenge(challenge) {
    await this.run('DELETE FROM auth_challenges WHERE challenge = ?', [challenge]);
  }

  async cleanupExpiredChallenges() {
    const result = await this.run('DELETE FROM auth_challenges WHERE expires_at <= CURRENT_TIMESTAMP');
    if (result.changes > 0) {
      console.log(`[db] Cleaned up ${result.changes} expired challenges`);
    }
  }

  // ========================================
  // 使用量追跡
  // ========================================

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
    
    // UPSERT操作
    await this.run(`
      INSERT INTO usage_tracking (id, user_id, date, ${column})
      VALUES (?, ?, ?, 1)
      ON CONFLICT(user_id, date)
      DO UPDATE SET 
        ${column} = ${column} + 1,
        updated_at = CURRENT_TIMESTAMP
    `, [uuidv4(), userId, today]);
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

export default Database;
