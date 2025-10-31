// プロンプト品質の詳細検証
import ImageGeneratorV2 from './imageGenerator_v2.js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const generator = new ImageGeneratorV2();

// 実際の記事サンプル（多様なジャンル）
const realArticles = {
  health: `
健康な生活を送るためには、規則正しい生活習慣が重要です。
毎朝6時に起床し、軽いストレッチをしてから朝食を摂ります。
バランスの取れた食事と適度な運動を心がけることで、免疫力を高めることができます。
夜は22時までには就寝し、十分な睡眠を確保しましょう。
`,

  technology: `
人工知能（AI）の技術は急速に発展しており、私たちの生活に大きな変化をもたらしています。
機械学習アルゴリズムにより、データから自動的にパターンを学習することが可能になりました。
自然言語処理技術の進歩により、コンピューターは人間の言葉を理解し、応答できるようになっています。
今後、医療、教育、交通など様々な分野でAI技術の活用が期待されています。
`,

  cooking: `
今日は家庭で簡単に作れる本格的なカレーライスのレシピをご紹介します。
まず、玉ねぎを薄切りにし、弱火でじっくりと炒めて甘みを引き出します。
牛肉を一口大に切り、玉ねぎと一緒に炒めてから水を加えて煮込みます。
市販のカレールーを加え、30分ほど煮込んで完成です。
ご飯と一緒に盛り付けて、お好みで福神漬けを添えてください。
`,

  travel: `
沖縄旅行の魅力は、美しい海と豊かな自然、独特の文化にあります。
那覇空港に到着したら、まずは首里城を見学して琉球王国の歴史を学びましょう。
青い海が広がるビーチでシュノーケリングを楽しんだり、マングローブの森をカヤックで探検することもできます。
沖縄そばやゴーヤチャンプルーなど、地元の料理も忘れずに味わってください。
夕日が沈む海を眺めながら、三線の音色に耳を傾ける時間は格別です。
`
};

async function testPromptQuality() {
  console.log('プロンプト品質検証開始\n');

  for (const [category, article] of Object.entries(realArticles)) {
    console.log(`==== ${category.toUpperCase()} 記事の検証 ====`);
    console.log(`記事: ${article.substring(0, 100)}...\n`);

    // 1. 画像枚数決定の適切性
    const imageCount = generator.calculateImageCount(article, 5);
    console.log(`画像枚数: ${imageCount}枚`);

    // 2. コンテンツ分割の品質
    const chunks = await generator.splitContent(article, imageCount);
    console.log(`実際のチャンク数: ${chunks.length}個`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`\nチャンク ${i + 1}:`);
      console.log(`  内容: "${chunk.text.substring(0, 80)}..."`);

      // 3. シーン抽出の精度
      const scene = await generator.extractScene(chunk);
      console.log(`  抽出シーン: "${scene.substring(0, 100)}..."`);

      // 4. プロンプト生成の品質（各スタイル）
      const styles = ['photo', 'deformed', 'watercolor'];
      for (const style of styles) {
        const prompt = await generator.sceneToPrompt(scene, style);
        console.log(`  ${style}プロンプト: "${prompt}"`);

        // プロンプト品質チェック
        const qualityCheck = checkPromptQuality(prompt, style);
        if (qualityCheck.issues.length > 0) {
          console.log(`    ⚠ 品質問題: ${qualityCheck.issues.join(', ')}`);
        } else {
          console.log(`    ✅ 品質良好`);
        }
      }
    }

    console.log('\n' + '='.repeat(50) + '\n');
  }

  // 5. フォールバック動作の検証
  console.log('==== フォールバック動作検証 ====');
  
  const ambiguousTexts = [
    'それは重要な問題です。',
    'その結果、状況が変わりました。',
    '多くの人が参加しました。',
    'システムが正常に動作します。'
  ];

  for (const text of ambiguousTexts) {
    console.log(`\n曖昧なテキスト: "${text}"`);
    const basicPrompt = generator.generateBasicPrompt(text, 'photo');
    console.log(`  フォールバックプロンプト: "${basicPrompt}"`);
    
    const qualityCheck = checkPromptQuality(basicPrompt, 'photo');
    console.log(`  品質: ${qualityCheck.score}/10`);
  }

  console.log('\nプロンプト品質検証完了');
}

// プロンプト品質をチェックする関数
function checkPromptQuality(prompt, style) {
  const issues = [];
  let score = 10;

  // 1. 必須要素チェック
  if (!prompt.includes('no text')) {
    issues.push('no textが含まれていない');
    score -= 3;
  }

  // 2. 長さチェック
  if (prompt.length < 20) {
    issues.push('プロンプトが短すぎる');
    score -= 2;
  }
  if (prompt.length > 200) {
    issues.push('プロンプトが長すぎる');
    score -= 1;
  }

  // 3. スタイル指定チェック
  const styleKeywords = {
    photo: ['photorealistic', 'photograph', 'photography'],
    deformed: ['deformed', 'chibi', 'anime'],
    watercolor: ['watercolor', 'painting'],
    detailed: ['detailed', 'illustration'],
    pictogram: ['pictogram', 'icon']
  };

  const hasStyleKeyword = styleKeywords[style]?.some(keyword => 
    prompt.toLowerCase().includes(keyword)
  );
  
  if (!hasStyleKeyword) {
    issues.push('スタイル指定が不適切');
    score -= 2;
  }

  // 4. 視覚的要素チェック
  const visualElements = /person|people|scene|object|setting|indoor|outdoor|action/i;
  if (!visualElements.test(prompt)) {
    issues.push('視覚的要素が不十分');
    score -= 2;
  }

  return {
    score: Math.max(0, score),
    issues
  };
}

testPromptQuality().catch(console.error);