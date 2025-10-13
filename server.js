// ChatKit セッション作成（修正版）
const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "OpenAI-Beta": "chatkit_beta=v1"
  },
  body: JSON.stringify({
    // ← user は「文字列」で渡す（例: クッキーやリクエストから識別子を決める）
    user: userId, // 例: "stage-user"

    // ← workflow は「オブジェクト」。少なくとも id。必要なら version も付与
    workflow: {
      id: process.env.CHATKIT_WORKFLOW_ID,  // 例: wf_xxxxx（Agent Builder の Publish 画面の値）
      // version: "1"   // Agent Builder 側で明示的な version を使うなら追加
    }
  })
});
