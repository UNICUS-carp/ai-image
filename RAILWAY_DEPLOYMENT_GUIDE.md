# Railway Deployment Guide

## 有料ユーザー認証エラーの解決方法

### 問題の概要
有料ユーザーが画像生成ボタンを押すとログイン画面に戻される問題が発生していました。これは環境変数 `PAID_USER_EMAILS` が正しく設定されていないことが原因でした。

### 解決方法

Railway Dashboard で以下の環境変数を設定してください：

#### 必須環境変数
```
NODE_ENV=production
GEMINI_API_KEY=<your-gemini-api-key>
ADMIN_EMAILS=admin@unicus.top
PAID_USER_EMAILS=akihiro210@gmail.com
```

#### オプション環境変数（推奨）
```
OPENAI_API_KEY=<your-openai-api-key>
DATABASE_PATH=/app/illustauto.db
ALLOWED_ORIGINS=https://unicus.top,https://your-domain.com
```

### Railway Dashboard での設定手順

1. **Railway Dashboard にログイン**
   - https://railway.app にアクセス
   - プロジェクトを選択

2. **Environment Variables の設定**
   - プロジェクトページで "Variables" タブをクリック
   - 以下の変数を追加：

   ```
   PAID_USER_EMAILS = akihiro210@gmail.com
   ```

   ※複数のユーザーを追加する場合はカンマ区切り：
   ```
   PAID_USER_EMAILS = user1@example.com,user2@example.com,user3@example.com
   ```

3. **デプロイの確認**
   - 環境変数を保存すると自動的に再デプロイされます
   - ログで環境変数が正しく読み込まれているか確認：
   ```
   [auth] Loaded 1 paid users: [ 'akihiro210@gmail.com' ]
   ```

### デバッグ用ログの確認

デプロイ後、Railway のログで以下を確認してください：

```bash
# 起動時のログ
[auth] Loaded X admin users: [...]
[auth] Loaded X paid users: [...]

# 認証時のログ（ユーザーがアクセスした時）
[auth] User: akihiro210@gmail.com
[auth] Determined role: paid
[auth] isPaidUser: true
[auth] Access granted for user akihiro210@gmail.com with role paid
```

### エラーの場合の確認事項

もし認証エラーが続く場合：

1. **環境変数の確認**
   ```bash
   [auth] PAID_USER_EMAILS env var: undefined
   ```
   → Railway Dashboard で `PAID_USER_EMAILS` が設定されているか確認

2. **メールアドレスの大文字小文字**
   システムは自動的に小文字に正規化するため、大文字小文字は問題ありません

3. **スペースや改行**
   環境変数にスペースや改行が入っていないか確認

### 緊急時の対処法

問題が解決しない場合の一時的な対処：

1. **全ユーザーを管理者として設定（非推奨）**
   ```
   ADMIN_EMAILS = akihiro210@gmail.com,admin@unicus.top
   ```

2. **ログでのトラブルシューティング**
   - Railway Dashboard の "Deployments" → "View Logs" で詳細確認
   - 認証エラーの具体的な内容を確認

### 完了確認

設定が正しく完了すると：
- 有料ユーザーがログイン後、画像生成ページにアクセス可能
- 画像生成ボタンが正常に動作
- ログイン画面にリダイレクトされない

### 追加メモ

- この修正により、`akihiro210@gmail.com` は有料ユーザーとして認識されます
- 管理者ユーザーは無制限でサービスを利用可能
- 有料ユーザーは1日3回の画像生成、10回の再生成が可能
- 無料ユーザーはサービス利用不可