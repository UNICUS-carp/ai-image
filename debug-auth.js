// 認証システムのデバッグ用スクリプト
import EmailAuthenticator from './auth.js';
import SecureDatabase from './database.js';
import ConfigManager from './config.js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function debugAuth() {
  console.log('認証システムデバッグ開始\n');

  const config = new ConfigManager();
  const db = new SecureDatabase();
  await db.initialize();
  
  const auth = new EmailAuthenticator(db);
  
  const testEmail = 'akihiro210@gmail.com';
  
  console.log('=== 環境変数確認 ===');
  console.log('ADMIN_EMAILS:', process.env.ADMIN_EMAILS);
  console.log('PAID_USER_EMAILS:', process.env.PAID_USER_EMAILS);
  console.log('ALLOWED_EMAILS:', process.env.ALLOWED_EMAILS);
  
  console.log('\n=== ホワイトリストチェック ===');
  const isAllowed = auth.isEmailAllowed(testEmail);
  console.log(`${testEmail} がホワイトリストに含まれるか:`, isAllowed);
  
  if (!isAllowed) {
    console.log('❌ ホワイトリストチェックで弾かれています');
    return;
  }
  
  console.log('\n=== 認証コード送信テスト ===');
  try {
    const result = await auth.requestAuthCode(testEmail, '127.0.0.1', 'debug-test');
    console.log('✅ 認証コード送信成功:', result);
    
    console.log('\n=== データベース確認 ===');
    const codes = await db.getAuthCodesForEmail(testEmail);
    console.log('データベース内の認証コード:', codes);
    
  } catch (error) {
    console.log('❌ 認証コード送信失敗:', error.message);
    console.log('エラー詳細:', error);
  }
  
  await db.close();
}

debugAuth().catch(console.error);