import ImageGeneratorV2 from './imageGenerator_v2.js';

async function test() {
  console.log('Testing image generation system...');
  
  const imageGen = new ImageGeneratorV2();
  const testContent = 'テスト用の記事コンテンツです。これは画像生成のテストを行うための短いサンプルテキストです。';
  
  try {
    const result = await imageGen.generateImages(testContent, {
      taste: 'photo',
      aspectRatio: '1:1',
      maxImages: 2
    });
    
    console.log('Generation result:', {
      success: result.success,
      imageCount: result.images?.length || 0,
      message: result.message,
      hasImages: result.images?.every(img => img.dataUrl?.startsWith('data:')) || false
    });
    
    if (result.images) {
      result.images.forEach((img, i) => {
        console.log(`Image ${i + 1}:`, {
          id: img.id,
          title: img.title,
          provider: img.provider,
          hasDataUrl: !!img.dataUrl,
          dataUrlPrefix: img.dataUrl?.substring(0, 50) + '...'
        });
      });
    }
  } catch (error) {
    console.error('Test failed:', error);
  }
}

test();