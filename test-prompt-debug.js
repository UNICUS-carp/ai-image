import ImageGeneratorV2 from './imageGenerator_v2.js';

async function testPromptGeneration() {
  console.log('Testing prompt generation with user content...');
  
  const imageGen = new ImageGeneratorV2();
  
  // ユーザーのテキストコンテンツ
  const userContent = `温泉に入っても改善しない慢性的な肩こりの本当の原因と根本治療

はじめに
温泉に入っても肩こりが治らない本当の理由
温泉だけでは届かない深い筋肉の硬さが原因かも
日常生活から変える肩こり根本治療の考え方
まとめ

小見出し1：はじめに
週末の温泉旅行から帰ってきて、「これで肩こりも楽になるはず」と期待していたのに、数日後にはまた同じ重だるさが戻ってくる。マッサージに行っても、湿布を貼っても、ストレッチをしても、一時的に楽になるだけで、根本的には何も変わらない。そんな慢性的な肩こりに、もう何年も悩まされ続けていませんか。

「温泉に入れば治ると思っていたのに」「どれだけお金をかけても改善しない」「この肩こりは一生付き合っていくしかないのか」という諦めにも似た気持ちを抱いている方も多いでしょう。特に、デスクワークが中心の方や、スマートフォンを長時間使う方にとって、肩こりは日常生活の質を大きく下げる深刻な問題です。

しかし、温泉やマッサージで改善しない肩こりには、実は温熱療法だけでは届かない深い部分に原因が隠れていることが多いのです。表面的な筋肉の緊張をほぐすだけでは、根本的な解決にはなりません。慢性的な肩こりを本当に改善するためには、なぜ肩こりが繰り返し起こるのか、その根本原因を理解し、生活習慣レベルからアプローチする必要があります。`;
  
  try {
    console.log(`\n[DEBUG] Testing with content length: ${userContent.length} chars`);
    
    // 5つのチャンクに分割をテスト
    const chunks = await imageGen.splitContent(userContent, 5);
    console.log(`\n[DEBUG] Split into ${chunks.length} chunks`);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`\n=== CHUNK ${i + 1} ===`);
      console.log(`Text (first 100 chars): ${chunk.text.substring(0, 100)}...`);
      console.log(`Heading: ${chunk.heading}`);
      
      // シーン抽出をテスト
      const scene = await imageGen.extractScene(chunk);
      console.log(`Scene: ${scene}`);
      
      // プロンプト生成をテスト
      const prompt = await imageGen.sceneToPrompt(scene, 'photo');
      console.log(`Prompt: ${prompt}`);
      
      console.log('---');
    }
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testPromptGeneration();