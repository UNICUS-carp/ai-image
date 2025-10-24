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
    this.rpID = process.env.NODE_ENV === 'production' 
      ? 'unicus.top' 
      : 'localhost';
    this.origin = process.env.NODE_ENV === 'production'
      ? 'https://unicus.top'
      : 'http://localhost:3000';
      
    console.log(`[auth] Initialized for ${this.rpID} (${process.env.NODE_ENV || 'development'})`);
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
        id: cred.credential_id,
        type: 'public-key',
        transports: cred.transports
      }));

      const options = await generateRegistrationOptions({
        rpName: this.rpName,
        rpID: this.rpID,
        userID: user.id,
        userName: userEmail,
        userDisplayName: userName || userEmail,
        attestationType: 'none',
        excludeCredentials,
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'preferred',
          residentKey: 'preferred'
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

      // ユーザーとチャレンジを取得
      const user = await this.db.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const challengeRecord = await this.db.getChallenge(registrationResponse.response.clientDataJSON);
      if (!challengeRecord || challengeRecord.user_id !== userId) {
        throw new Error('Invalid challenge');
      }

      // 登録レスポンスを検証
      const verification = await verifyRegistrationResponse({
        response: registrationResponse,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: false
      });

      if (verification.verified && verification.registrationInfo) {
        // 認証情報をデータベースに保存
        const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
        
        await this.db.saveCredential(userId, {
          id: credentialID,
          publicKey: credentialPublicKey,
          counter,
          deviceType: 'platform',
          backedUp: false,
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
            id: cred.credential_id,
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

      const { id: credentialID } = authenticationResponse;
      
      // 認証情報を取得
      const credential = await this.db.getCredentialByCredentialId(credentialID);
      if (!credential) {
        throw new Error('Credential not found');
      }

      // ユーザー情報を取得
      const user = await this.db.getUserById(credential.user_id);
      if (!user) {
        throw new Error('User not found');
      }

      // チャレンジを取得
      const challengeRecord = await this.db.getChallenge(authenticationResponse.response.clientDataJSON);
      if (!challengeRecord) {
        throw new Error('Invalid challenge');
      }

      // 認証レスポンスを検証
      const verification = await verifyAuthenticationResponse({
        response: authenticationResponse,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        authenticator: {
          credentialID: credential.credential_id,
          credentialPublicKey: credential.credential_public_key,
          counter: credential.counter,
          transports: credential.transports
        },
        requireUserVerification: false
      });

      if (verification.verified) {
        // カウンターを更新
        await this.db.updateCredentialCounter(credentialID, verification.authenticationInfo.newCounter);
        
        // 最終ログイン時刻を更新
        await this.db.updateLastLogin(user.id);

        // チャレンジを削除
        await this.db.deleteChallenge(challengeRecord.challenge);

        // セッションを作成
        const sessionData = {
          userId: user.id,
          email: user.email,
          displayName: user.display_name,
          authenticatedAt: new Date().toISOString()
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

  async validateSession(sessionId) {
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
