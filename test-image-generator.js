// 画像生成システムの徹底検証テスト
import ImageGeneratorV2 from './imageGenerator_v2.js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const generator = new ImageGeneratorV2();

// テスト記事サンプル
const testArticles = {
  // 1. 肩こり記事（元の記事）
  shoulderPain: `
小見出し1：はじめに
ニットを着ようと腕を上げた瞬間、肩に激痛が走った経験はありませんか？
私も先日、お気に入りのセーターを着ようとして、肩が上がらず困りました。

小見出し2：肩こりの原因
肩こりは筋肉の緊張や血流不良が主な原因です。
デスクワークや運動不足により、肩周りの筋肉が固まってしまいます。

小見出し3：ストレッチ方法
肩甲骨を回すストレッチが効果的です。
ゆっくりと大きく腕を回し、肩の可動域を広げましょう。

小見出し4：予防策
日常的に姿勢に気をつけることが大切です。
1時間に1回は立ち上がって、肩を動かすようにしましょう。

小見出し5：まとめ
肩こり改善には継続的なケアが必要です。
毎日少しずつストレッチを続けることで、快適な生活を取り戻せます。
`,

  // 2. 料理記事（全く異なるテーマ）
  cooking: `
今日は簡単で美味しいパスタの作り方を紹介します。

まず、大きな鍋にたっぷりの水を入れて沸騰させます。
塩を適量加えて、パスタを茹でます。

フライパンにオリーブオイルとニンニクを入れ、香りが出るまで炒めます。
トマト缶を加えて、10分ほど煮込みます。

茹で上がったパスタをフライパンに移し、ソースと絡めます。
仕上げにバジルを散らせば完成です。
`,

  // 3. 旅行記事（段落なし、長文）
  travel: `東京から京都への旅は新幹線で約2時間。車窓から見える富士山の姿は圧巻です。京都駅に到着すると、古都の雰囲気が感じられます。まず訪れたのは清水寺。石段を登ると、木造の本堂が見えてきます。舞台からの眺めは素晴らしく、京都市内を一望できます。次に向かったのは金閣寺。金箔で覆われた建物が池に映る様子は、まさに絶景です。嵐山の竹林も外せません。竹のトンネルを歩くと、別世界に迷い込んだような感覚になります。`,

  // 4. 技術記事（専門用語多い）
  tech: `
## クラウドコンピューティングの基礎

クラウドコンピューティングとは、インターネット経由でコンピューティングリソースを提供するサービスです。

### IaaS（Infrastructure as a Service）
仮想マシンやストレージなどのインフラを提供します。
ユーザーはOSから上のレイヤーを管理します。

### PaaS（Platform as a Service）
アプリケーション開発のためのプラットフォームを提供します。
開発者はアプリケーションの開発に集中できます。

### SaaS（Software as a Service）
完全なアプリケーションをサービスとして提供します。
ユーザーはブラウザからアクセスするだけで利用できます。
`,

  // 5. 短い記事（画像1枚になるはず）
  short: `今日はとても良い天気でした。公園を散歩していると、桜が満開でした。`
};

// テスト関数
async function runTests() {
  console.log('========================================');
  console.log('画像生成システム徹底検証開始');
  console.log('========================================\n');

  // 1. 画像枚数計算のテスト
  console.log('【TEST 1: 画像枚数計算】');
  for (const [name, content] of Object.entries(testArticles)) {
    const count = generator.calculateImageCount(content, 5);
    console.log(`  ${name}: ${content.length}文字 → ${count}枚`);
    
    // 検証
    if (name === 'short' && count !== 1) {
      console.error(`  ❌ エラー: 短い記事が${count}枚になった（期待値:1）`);
    }
    if (name === 'shoulderPain' && count < 3) {
      console.error(`  ❌ エラー: 長い記事が${count}枚だけ（期待値:3以上）`);
    }
  }
  console.log('');

  // 2. コンテンツ分割のテスト
  console.log('【TEST 2: コンテンツ分割】');
  for (const [name, content] of Object.entries(testArticles)) {
    console.log(`\n  ${name}の分割テスト:`);
    const targetCount = generator.calculateImageCount(content, 5);
    const chunks = await generator.splitContent(content, targetCount);
    
    console.log(`    目標: ${targetCount}個, 実際: ${chunks.length}個`);
    
    // 検証
    if (chunks.length !== targetCount) {
      console.error(`    ❌ エラー: チャンク数が不一致`);
    }
    
    // 各チャンクの内容確認
    chunks.forEach((chunk, i) => {
      console.log(`    Chunk ${i}: ${chunk.text.substring(0, 50)}...`);
      if (!chunk.text || chunk.text.length < 10) {
        console.error(`    ❌ エラー: チャンク${i}が空または短すぎる`);
      }
    });
  }
  console.log('');

  // 3. シーン抽出のテスト
  console.log('【TEST 3: シーン抽出】');
  const testChunks = [
    { index: 0, text: 'ニットを着ようと腕を上げた瞬間、肩に激痛が走った', heading: null },
    { index: 1, text: 'フライパンにオリーブオイルとニンニクを入れ、香りが出るまで炒めます', heading: null },
    { index: 2, text: 'クラウドコンピューティングとは、インターネット経由でコンピューティングリソースを提供するサービスです', heading: null }
  ];
  
  for (const chunk of testChunks) {
    const scene = await generator.extractScene(chunk);
    console.log(`  入力: "${chunk.text}"`);
    console.log(`  抽出: "${scene}"`);
    
    // 検証
    if (!scene || scene.length < 5) {
      console.error(`  ❌ エラー: シーン抽出が失敗`);
    }
    if (scene === chunk.text) {
      console.warn(`  ⚠ 警告: シーンが元のテキストと同じ（抽出されていない）`);
    }
  }
  console.log('');

  // 4. プロンプト生成のテスト
  console.log('【TEST 4: プロンプト生成】');
  const testScenes = [
    '女性が腕を上げて肩に痛みを感じている',
    'フライパンで料理を作っている',
    'コンピューターとネットワークのイメージ'
  ];
  
  const styles = ['photo', 'deformed', 'watercolor', 'detailed', 'pictogram'];
  
  for (const scene of testScenes) {
    console.log(`\n  シーン: "${scene}"`);
    for (const style of styles) {
      const prompt = await generator.sceneToPrompt(scene, style);
      console.log(`    ${style}: "${prompt}"`);
      
      // 検証
      if (!prompt.includes('no text')) {
        console.error(`    ❌ エラー: "no text"が含まれていない`);
      }
      if (prompt.length > 200) {
        console.error(`    ❌ エラー: プロンプトが長すぎる（${prompt.length}文字）`);
      }
      if (prompt.length < 20) {
        console.error(`    ❌ エラー: プロンプトが短すぎる（${prompt.length}文字）`);
      }
    }
  }
  console.log('');

  // 5. キーワード抽出のテスト
  console.log('【TEST 5: キーワード抽出（フォールバック）】');
  const testTexts = [
    '女性が部屋で本を読んでいる',
    '子供が公園で遊んでいる',
    'コンピューターの画面',
    '美しい風景'
  ];
  
  for (const text of testTexts) {
    const keywords = generator.extractKeywords(text);
    console.log(`  "${text}"`);
    console.log(`    → person: ${keywords.person}, action: ${keywords.action}, object: ${keywords.object}, setting: ${keywords.setting}`);
  }
  console.log('');

  // 6. エラーハンドリングのテスト
  console.log('【TEST 6: エラーハンドリング】');
  
  // 空のコンテンツ
  console.log('  空コンテンツテスト:');
  const emptyResult = await generator.generateImages('', { taste: 'photo' });
  console.log(`    結果: ${emptyResult.success ? '成功' : '失敗'} - ${emptyResult.message}`);
  
  // 不正なスタイル
  console.log('  不正なスタイルテスト:');
  const invalidStyleResult = await generator.generateImages('テスト', { taste: 'invalid_style' });
  console.log(`    結果: ${invalidStyleResult.success ? '成功' : '失敗'}`);
  
  // nullコンテンツ
  console.log('  nullコンテンツテスト:');
  try {
    const nullResult = await generator.generateImages(null);
    console.log(`    結果: ${nullResult.success ? '成功' : '失敗'}`);
  } catch (error) {
    console.log(`    エラー捕捉: ${error.message}`);
  }
  console.log('');

  // 7. 実際の生成テスト（短い記事で）
  console.log('【TEST 7: 実際の画像生成フロー】');
  const realResult = await generator.generateImages(testArticles.short, {
    taste: 'photo',
    aspectRatio: '1:1'
  });
  
  console.log(`  成功: ${realResult.success}`);
  console.log(`  画像数: ${realResult.images?.length || 0}`);
  if (realResult.images && realResult.images.length > 0) {
    realResult.images.forEach((img, i) => {
      console.log(`  画像${i + 1}:`);
      console.log(`    ID: ${img.id}`);
      console.log(`    タイトル: ${img.title}`);
      console.log(`    プロバイダー: ${img.provider}`);
      console.log(`    データURL: ${img.dataUrl ? img.dataUrl.substring(0, 50) + '...' : 'なし'}`);
    });
  }

  // 8. GPTレスポンスパースのテスト
  console.log('\n【TEST 8: GPTレスポンスパース】');
  const testResponses = [
    '```json\n[{"text":"test","summary":"summary"}]\n```',
    '[{"text":"test","summary":"summary"}]',
    'Invalid JSON',
    '{"text":"test","summary":"summary"}' // 単一オブジェクト
  ];
  
  for (const response of testResponses) {
    try {
      const parsed = generator.parseGPTResponse(response);
      console.log(`  入力: "${response.substring(0, 30)}..."`);
      console.log(`    パース結果: ${JSON.stringify(parsed)}`);
    } catch (error) {
      console.log(`  入力: "${response.substring(0, 30)}..."`);
      console.log(`    エラー: ${error.message}`);
    }
  }

  console.log('\n========================================');
  console.log('検証完了');
  console.log('========================================');
}

// 実行
runTests().catch(console.error);