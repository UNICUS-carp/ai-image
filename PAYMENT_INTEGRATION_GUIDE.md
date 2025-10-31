# 💳 決済サービス統合ガイド

## 🏗️ 現在の実装状況

### ✅ 実装済み機能
- 環境変数ベースの有料ユーザー管理 (`PAID_USER_EMAILS`)
- 3段階の権限システム (admin/paid/free)
- 使用制限システム (1日5回記事生成/50回再生成)
- 権限に基づくAPI制限

## 🚀 Stripe統合の実装ガイド

### 1. 必要な依存関係の追加

```bash
npm install stripe express-raw-body
```

### 2. 環境変数の設定

```bash
# Stripe設定
STRIPE_SECRET_KEY=sk_test_xxx  # Stripeシークレットキー
STRIPE_WEBHOOK_SECRET=whsec_xxx  # Webhookエンドポイントシークレット
STRIPE_PRICE_ID=price_xxx  # 有料プランの価格ID

# フロントエンド用
STRIPE_PUBLISHABLE_KEY=pk_test_xxx  # Stripeパブリックキー（フロントエンド用）
```

### 3. データベーススキーマの拡張

```sql
-- ユーザーテーブルに決済情報を追加
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'inactive'; -- active, inactive, canceled
ALTER TABLE users ADD COLUMN subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_end_date DATETIME;

-- 決済履歴テーブル
CREATE TABLE IF NOT EXISTS payment_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stripe_payment_intent_id TEXT UNIQUE,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'jpy',
  status TEXT NOT NULL, -- succeeded, failed, pending
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);
```

### 4. Stripe統合コードの追加

#### A. Stripeクライアントの初期化 (server.js)

```javascript
import Stripe from 'stripe';

// Stripe初期化
const stripe = process.env.STRIPE_SECRET_KEY ? 
  new Stripe(process.env.STRIPE_SECRET_KEY) : null;

if (stripe) {
  console.log('[payment] Stripe initialized for payments');
} else {
  console.log('[payment] Stripe not configured - payments unavailable');
}
```

#### B. サブスクリプション作成API

```javascript
// サブスクリプション作成
app.post('/api/payment/create-subscription', requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ 
        error: 'PAYMENT_UNAVAILABLE',
        message: '決済サービスが利用できません' 
      });
    }

    const { priceId } = req.body;
    const userEmail = req.user.email;

    // Stripeカスタマーの作成または取得
    let customer = await stripe.customers.list({ email: userEmail, limit: 1 });
    
    if (customer.data.length === 0) {
      customer = await stripe.customers.create({
        email: userEmail,
        metadata: { userId: req.user.id.toString() }
      });
    } else {
      customer = customer.data[0];
    }

    // データベースにカスタマーIDを保存
    await db.updateUser(req.user.id, { 
      stripe_customer_id: customer.id 
    });

    // サブスクリプション作成
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
    });

    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret
    });

  } catch (error) {
    console.error('[payment] Subscription creation error:', error);
    res.status(500).json({
      error: 'SUBSCRIPTION_FAILED',
      message: 'サブスクリプションの作成に失敗しました'
    });
  }
});
```

#### C. Webhookハンドラー

```javascript
// Stripe Webhook
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('[payment] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionCancellation(event.data.object);
        break;
        
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
        
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
        
      default:
        console.log(`[payment] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('[payment] Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handleSubscriptionUpdate(subscription) {
  const customerId = subscription.customer;
  const status = subscription.status; // active, past_due, canceled, etc.
  
  // カスタマーからユーザーを特定
  const customer = await stripe.customers.retrieve(customerId);
  const userEmail = customer.email;
  
  // データベース更新
  await db.updateUserByEmail(userEmail, {
    subscription_status: status,
    subscription_id: subscription.id,
    subscription_end_date: status === 'active' ? 
      new Date(subscription.current_period_end * 1000) : null
  });
  
  console.log(`[payment] Subscription updated for ${userEmail}: ${status}`);
}
```

### 5. 権限システムの拡張

現在の `UserPermissionManager` を拡張:

```javascript
// UserPermissionManagerに追加
async getUserRoleWithDatabase(email) {
  // 基本的な権限チェック（環境変数ベース）
  const envRole = this.getUserRole(email);
  if (envRole !== 'free') {
    return envRole;
  }
  
  // データベースでサブスクリプション状況を確認
  const user = await db.getUserByEmail(email);
  if (user && user.subscription_status === 'active') {
    const endDate = new Date(user.subscription_end_date);
    if (endDate > new Date()) {
      return 'paid';
    }
  }
  
  return 'free';
}
```

### 6. フロントエンド統合

#### A. Stripe Elements の追加 (app.html)

```html
<script src="https://js.stripe.com/v3/"></script>
<script>
const stripe = Stripe('pk_test_xxx'); // 環境変数から取得

async function createSubscription() {
  const response = await fetch('/api/payment/create-subscription', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('access_token')}`
    },
    body: JSON.stringify({
      priceId: 'price_xxx' // 有料プランの価格ID
    })
  });
  
  const { clientSecret } = await response.json();
  
  // 決済フォームの表示
  const { error } = await stripe.confirmPayment({
    clientSecret,
    confirmParams: {
      return_url: window.location.origin + '/payment-success'
    }
  });
  
  if (error) {
    console.error('Payment failed:', error);
  }
}
</script>
```

### 7. 実装の難易度評価

| 機能 | 難易度 | 実装時間 | 備考 |
|------|--------|----------|------|
| 基本的なStripe統合 | ⭐⭐⭐ | 2-3日 | 標準的な実装 |
| Webhook処理 | ⭐⭐⭐⭐ | 1-2日 | セキュリティ重要 |
| データベース拡張 | ⭐⭐ | 半日 | 既存スキーマに追加 |
| フロントエンド統合 | ⭐⭐⭐ | 1-2日 | UI/UX考慮 |
| テスト・デバッグ | ⭐⭐⭐⭐ | 2-3日 | 決済は慎重にテスト |

## 🎯 推奨実装順序

1. **Phase 1**: 現在の環境変数ベース管理で開始 ✅ (完了)
2. **Phase 2**: Stripeの基本統合（サブスクリプション作成）
3. **Phase 3**: Webhook処理とデータベース統合
4. **Phase 4**: フロントエンド決済フォーム
5. **Phase 5**: 本番環境テストと最適化

## 💡 現在のシステムの利点

- **簡単な管理**: 環境変数でユーザー追加/削除が可能
- **即座反映**: サーバー再起動で権限変更適用
- **テスト容易**: 複雑な決済フローなしでテスト可能
- **Stripe準備完了**: いつでもStripe統合に移行可能

現在の実装で十分運用可能で、必要に応じてStripe統合に段階的に移行できます。