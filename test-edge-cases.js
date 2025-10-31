// 追加のエッジケーステスト
import ImageGeneratorV2 from './imageGenerator_v2.js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const generator = new ImageGeneratorV2();

async function testEdgeCases() {
  console.log('エッジケーステスト開始\n');

  // 1. 非常に長い記事
  const longArticle = 'これは非常に長い記事です。'.repeat(500);
  console.log('【長い記事テスト】');
  const longResult = await generator.generateImages(longArticle);
  console.log(`結果: ${longResult.success ? '成功' : '失敗'}, 画像数: ${longResult.images?.length || 0}`);

  // 2. 特殊文字を含む記事
  const specialChars = 'これは"特殊文字"を含む記事です。<HTML>タグや&エンティティもあります。';
  console.log('\n【特殊文字テスト】');
  const specialResult = await generator.generateImages(specialChars);
  console.log(`結果: ${specialResult.success ? '成功' : '失敗'}`);

  // 3. 数字のみの記事
  const numbersOnly = '123456789 0987654321 1234567890';
  console.log('\n【数字のみテスト】');
  const numbersResult = await generator.generateImages(numbersOnly);
  console.log(`結果: ${numbersResult.success ? '成功' : '失敗'}`);

  // 4. 英語記事
  const englishArticle = 'This is an English article about cooking pasta. First, boil water in a large pot. Add salt to taste. Cook the pasta according to package instructions.';
  console.log('\n【英語記事テスト】');
  const englishResult = await generator.generateImages(englishArticle);
  console.log(`結果: ${englishResult.success ? '成功' : '失敗'}, 画像数: ${englishResult.images?.length || 0}`);

  // 5. 改行のみの記事
  const newlinesOnly = '\n\n\n\n\n';
  console.log('\n【改行のみテスト】');
  const newlinesResult = await generator.generateImages(newlinesOnly);
  console.log(`結果: ${newlinesResult.success ? '成功' : '失敗'}`);

  // 6. チャンク処理でエラーが起こりやすいケース
  const problematicText = '。。。。。。。。';
  console.log('\n【問題のある文字テスト】');
  const problematicResult = await generator.generateImages(problematicText);
  console.log(`結果: ${problematicResult.success ? '成功' : '失敗'}`);

  // 7. 非常に短い記事（文字数制限テスト）
  const veryShort = 'テスト';
  console.log('\n【極短記事テスト】');
  const veryShortResult = await generator.generateImages(veryShort);
  console.log(`結果: ${veryShortResult.success ? '成功' : '失敗'}`);

  // 8. キーワード抽出精度テスト
  console.log('\n【キーワード抽出精度テスト】');
  const testTexts = [
    '老人が公園でゆっくりと散歩している',
    '子どもたちが学校の校庭で元気に遊んでいる',
    'コンピューターがオフィスの机の上に置かれている',
    '美しい夜景が窓から見える',
    'レストランで美味しい料理を食べている女性'
  ];
  
  for (const text of testTexts) {
    const keywords = generator.extractKeywords(text);
    console.log(`"${text}"`);
    console.log(`  → person: ${keywords.person}, action: ${keywords.action}, object: ${keywords.object}, setting: ${keywords.setting}`);
  }

  console.log('\nエッジケーステスト完了');
}

testEdgeCases().catch(console.error);