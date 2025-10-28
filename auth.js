import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

class PasskeyAuthenticator {
  constructor(database) {
    this.db = database;
    this.rpName = 'IllustAuto';
    
    // フロントエンドの実際のホスティング先に合わせて修正
    this.rpID = process.env.NODE_ENV === 'production' 
      ? 'unicus.top' 
      : 'localhost';
    
    // フロントエンドの実際のURLに合わせて修正
    this.origin = process.env.NODE_ENV === 'production'
      ? ['https://unicus.top'] // 配列として複数のoriginを許可
      : ['http://localhost:3000', 'http://127.0.0.1:3000'];
      
    console.log(`[auth] Initialized for ${this.rpID} (${process.env.NODE_ENV || 'development'})`);
    console.log(`[auth] Allowed origins:`, this.origin);
  }

  // ========================================
  // 登録フロー
  // ========================================

  async generateRegistrationOptions(userEmail, userName = null) {
    try {
      console.log(`[auth] Generating registration options for: ${userEmail}`);
      
      // 既存ユーザーをチェック
      let user = await this.db.getUserByEmail(userEmail);
      if (!user) {
        const userId = await this.db.createUser(userEmail, userName);
        user = await this.db.getUserById(userId);
        console.log(`[auth] Created new user: ${userId}`);
      }

      // 既存の認証情報を取得
      const existingCredentials = await this.db.getUserCredentials(user.id);
      const excludeCredentials = existingCredentials.map(cred => ({
        id: Buffer.from(cred.credential_id, 'base64'), // Uint8Arrayに変換
        type: 'public-key',
        transports: cred.transports
      }));

      const options = await generateRegistrationOptions({
        rpName: this.rpName,
        rpID: this.rpID,
        userID: new TextEncoder().encode(user.id), // Uint8Arrayに変換
        userName: userEmail,
        userDisplayName: userName || userEmail,
        attestationType: 'none',
        excludeCredentials,
        authenticatorSelection: {
          // より緩い設定に変更
          userVerification: 'preferred',
          residentKey: 'preferred', // requiredから変更
          requireResidentKey: false  // falseに変更
        },
        supportedAlgorithmIDs: [-7, -257]
      });

      // チャレンジを保存（5分間有効）
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await this.db.saveChallenge(options.challenge, user.id, 'registration', expiresAt);

      console.log(`[auth] Registration options generated for user ${user.id}`);
      return {
        success: true,
        options,
        userId: user.id
      };

    } catch (error) {
      console.error('[auth] Error generating registration options:', error);
      throw new Error('Failed to generate registration options');
    }
  }

  async verifyRegistration(userId, registrationResponse) {
    try {
      console.log(`[auth] Verifying registration for user: ${userId}`);
      console.log(`[auth] Registration response keys:`, Object.keys(registrationResponse));
      console.log(`[auth] Response type:`, registrationResponse.type);
      console.log(`[auth] Response id:`, registrationResponse.id);

      // ユーザーとチャレンジを取得
      const user = await this.db.getUserById(userId);
      if (!user) {
        console.error(`[auth] User not found: ${userId}`);
        throw new Error('User not found');
      }
      console.log(`[auth] Found user:`, user.email);

      // clientDataJSONからchallengeを抽出
      const clientData = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(registrationResponse.response.clientDataJSON), c => c.charCodeAt(0))
      ));
      console.log(`[auth] Extracted challenge from clientData:`, clientData.challenge);
      
      const challengeRecord = await this.db.getChallenge(clientData.challenge);
      if (!challengeRecord) {
        console.error(`[auth] Challenge not found for challenge: ${clientData.challenge}`);
        throw new Error('Challenge not found');
      }
      if (challengeRecord.user_id !== userId) {
        console.error(`[auth] Challenge user mismatch: expected ${userId}, got ${challengeRecord.user_id}`);
        throw new Error('Challenge user mismatch');
      }
      console.log(`[auth] Challenge verification passed`);

      // 登録レスポンスを検証（複数のoriginに対応）
      let verification = null;
      const originsToTry = Array.isArray(this.origin) ? this.origin : [this.origin];
      
      for (const origin of originsToTry) {
        try {
          verification = await verifyRegistrationResponse({
            response: registrationResponse,
            expectedChallenge: challengeRecord.challenge,
            expectedOrigin: origin,
            expectedRPID: this.rpID,
            requireUserVerification: false
          });
          
          if (verification.verified) {
            console.log(`[auth] Verification successful with origin: ${origin}`);
            break;
          }
        } catch (originError) {
          console.log(`[auth] Verification failed with origin ${origin}:`, originError.message);
          continue;
        }
      }
      
      if (!verification || !verification.verified) {
        throw new Error('Registration verification failed for all origins');
      }

      if (verification.verified && verification.registrationInfo) {
        // 認証情報をデータベースに保存
        const { credentialID, credentialPublicKey, counter, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
        
        // Uint8ArrayをBase64に変換
        const credentialIDBase64 = Buffer.from(credentialID).toString('base64');
        const publicKeyBase64 = Buffer.from(credentialPublicKey).toString('base64');
        
        console.log(`[auth] Saving credential with ID (base64):`, credentialIDBase64);
        
        await this.db.saveCredential(userId, {
          id: credentialIDBase64,
          publicKey: publicKeyBase64,
          counter,
          deviceType: credentialDeviceType || 'singleDevice',
          backedUp: credentialBackedUp || false,
          transports: registrationResponse.response.transports || []
        });

        // チャレンジを削除
        await this.db.deleteChallenge(challengeRecord.challenge);

        console.log(`[auth] Registration verified and saved for user ${userId}`);
        return {
          success: true,
          verified: true,
          message: 'Passkey registration successful'
        };
      } else {
        throw new Error('Registration verification failed');
      }

    } catch (error) {
      console.error('[auth] Registration verification error:', error);
      return {
        success: false,
        verified: false,
        message: error.message
      };
    }
  }

  // ========================================
  // 認証フロー
  // ========================================

  async generateAuthenticationOptions(userEmail = null) {
    try {
      console.log(`[auth] Generating authentication options for: ${userEmail || 'any user'}`);

      let allowCredentials = undefined;

      if (userEmail) {
        // 特定ユーザーの認証情報を取得
        const user = await this.db.getUserByEmail(userEmail);
        if (user) {
          const credentials = await this.db.getUserCredentials(user.id);
          allowCredentials = credentials.map(cred => ({
            id: Buffer.from(cred.credential_id, 'base64'), // Uint8Arrayに変換
            type: 'public-key',
            transports: cred.transports
          }));
        }
      }

      const options = await generateAuthenticationOptions({
        rpID: this.rpID,
        allowCredentials,
        userVerification: 'preferred',
        timeout: 300000 // 5分
      });

      // チャレンジを保存
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await this.db.saveChallenge(options.challenge, userEmail || null, 'authentication', expiresAt);

      console.log(`[auth] Authentication options generated`);
      return {
        success: true,
        options
      };

    } catch (error) {
      console.error('[auth] Error generating authentication options:', error);
      throw new Error('Failed to generate authentication options');
    }
  }

  async verifyAuthentication(authenticationResponse) {
    try {
      console.log(`[auth] Verifying authentication`);
      console.log(`[auth] Authentication response ID:`, authenticationResponse.id);

      const { id: credentialID } = authenticationResponse;
      
      // credentialIDはBase64エンコードされた文字列として渡される
      // DBにもBase64で保存されているので、そのまま検索
      console.log(`[auth] Looking for credential with ID:`, credentialID);
      
      // 認証情報を取得
      const credential = await this.db.getCredentialByCredentialId(credentialID);
      if (!credential) {
        console.error(`[auth] Credential not found for ID:`, credentialID);
        throw new Error('Credential not found');
      }
      console.log(`[auth] Found credential for user:`, credential.user_id);

      // ユーザー情報を取得
      const user = await this.db.getUserById(credential.user_id);
      if (!user) {
        throw new Error('User not found');
      }

      // clientDataJSONからchallengeを抽出
      const clientData = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(authenticationResponse.response.clientDataJSON), c => c.charCodeAt(0))
      ));
      
      // チャレンジを取得
      const challengeRecord = await this.db.getChallenge(clientData.challenge);
      if (!challengeRecord) {
        throw new Error('Authentication failed');
      }

      // Base64からUint8Arrayに変換
      const credentialIDBytes = Buffer.from(credential.credential_id, 'base64');
      const credentialPublicKeyBytes = Buffer.from(credential.credential_public_key, 'base64');
      
      console.log(`[auth] Converting credential from Base64 for verification`);
      
      // 認証レスポンスを検証（複数のoriginに対応）
      let verification = null;
      const originsToTry = Array.isArray(this.origin) ? this.origin : [this.origin];
      
      for (const origin of originsToTry) {
        try {
          verification = await verifyAuthenticationResponse({
            response: authenticationResponse,
            expectedChallenge: challengeRecord.challenge,
            expectedOrigin: origin,
            expectedRPID: this.rpID,
            authenticator: {
              credentialID: credentialIDBytes,
              credentialPublicKey: credentialPublicKeyBytes,
              counter: credential.counter,
              transports: JSON.parse(credential.transports || '[]')
            },
            requireUserVerification: false
          });
          
          if (verification.verified) {
            console.log(`[auth] Authentication successful with origin: ${origin}`);
            break;
          }
        } catch (originError) {
          console.log(`[auth] Authentication failed with origin ${origin}:`, originError.message);
          continue;
        }
      }

      if (!verification || !verification.verified) {
        throw new Error('Authentication verification failed for all origins');
      }

      if (verification.verified) {
        // カウンターを更新
        await this.db.updateCredentialCounter(credentialID, verification.authenticationInfo.newCounter);
        
        // 最終ログイン時刻を更新
        await this.db.updateLastLogin(user.id);

        // チャレンジを削除
        await this.db.deleteChallenge(challengeRecord.challenge);

        // セッションを作成（セキュリティ強化）
        const sessionData = {
          userId: user.id,
          email: user.email,
          displayName: user.display_name,
          authenticatedAt: new Date().toISOString(),
          userAgent: null, // フロントエンドから送られてきた場合のみ設定
          ipAddress: null  // サーバーサイドで設定
        };
        
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24時間
        const sessionId = await this.db.createSession(user.id, sessionData, expiresAt);

        console.log(`[auth] Authentication verified for user ${user.id}`);
        return {
          success: true,
          verified: true,
          user: {
            id: user.id,
            email: user.email,
            displayName: user.display_name
          },
          sessionId,
          message: 'Authentication successful'
        };
      } else {
        throw new Error('Authentication verification failed');
      }

    } catch (error) {
      console.error('[auth] Authentication verification error:', error);
      return {
        success: false,
        verified: false,
        message: error.message
      };
    }
  }

  // ========================================
  // セッション管理
  // ========================================

  async validateSession(sessionId, userAgent = null, ipAddress = null) {
    try {
      if (!sessionId) {
        return { valid: false, message: 'No session ID provided' };
      }

      const session = await this.db.getSession(sessionId);
      if (!session) {
        return { valid: false, message: 'Session not found or expired' };
      }

      // ユーザー情報も取得
      const user = await this.db.getUserById(session.user_id);
      if (!user) {
        await this.db.deleteSession(sessionId);
        return { valid: false, message: 'User not found' };
      }

      // セキュリティチェック（必要に応じて有効化）
      if (session.session_data) {
        const sessionData = JSON.parse(session.session_data);
        
        // UserAgentの変更チェック（オプション）
        if (sessionData.userAgent && userAgent && sessionData.userAgent !== userAgent) {
          console.warn(`[auth] UserAgent changed for session ${sessionId}`);
          // 必要に応じてセッションを無効化
          // await this.db.deleteSession(sessionId);
          // return { valid: false, message: 'Session security check failed' };
        }
        
        // IPアドレスの変更チェック（オプション）
        if (sessionData.ipAddress && ipAddress && sessionData.ipAddress !== ipAddress) {
          console.warn(`[auth] IP address changed for session ${sessionId}`);
          // 必要に応じてセッションを無効化
        }
      }

      return {
        valid: true,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          role: user.role || 'user'
        },
        sessionData: session.session_data
      };

    } catch (error) {
      console.error('[auth] Session validation error:', error);
      return { valid: false, message: 'Session validation failed' };
    }
  }

  async logout(sessionId) {
    try {
      if (sessionId) {
        await this.db.deleteSession(sessionId);
        console.log(`[auth] Session ${sessionId} logged out`);
      }
      return { success: true };
    } catch (error) {
      console.error('[auth] Logout error:', error);
      return { success: false, message: error.message };
    }
  }

  // ========================================
  // クリーンアップ
  // ========================================

  async cleanup() {
    try {
      await this.db.cleanupExpiredSessions();
      await this.db.cleanupExpiredChallenges();
    } catch (error) {
      console.error('[auth] Cleanup error:', error);
    }
  }
}

export default PasskeyAuthenticator;
