export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/bot") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "GET") {
      return new Response("GET OK | TG Bot Webhook running", {
        headers: { "Content-Type": "text/plain" }
      });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let update;
    try {
      update = await request.json();
      console.log("收到TG消息", update);
    } catch (err) {
      console.log("JSON解析异常", err);
      return new Response("Bad JSON", { status: 400 });
    }

    if (!update.message) {
      return new Response("OK");
    }
    const msg = update.message;
    if (msg.chat.type !== "private") {
      return new Response("OK");
    }

    const textRaw = msg.text || msg.caption || "";
    if (textRaw.startsWith("/")) {
      await sendTgMessage(env.BOT_TOKEN, msg.chat.id, "直接发送文字/多张图片相册，自动保存至Memos");
      return new Response("OK");
    }

    const username = msg.from.username || "博主";
    // 正文：纯文本，不添加任何图片代码
    let content = `# Telegram Bot 备忘录
发送人：@${username} (ID:${msg.from.id})
来源：TG私聊机器人

`;
    if (textRaw) {
      content += textRaw;
    }

    let imageBase64 = null;

    // 处理图片
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo.at(-1);
      const fileId = photo.file_id;
      try {
        const fileInfo = await fetchTgApi(env.BOT_TOKEN, "getFile", { file_id: fileId });
        const filePath = fileInfo.result.file_path;
        const fileDownloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;

        const imageResp = await fetch(fileDownloadUrl);
        const arrayBuf = await imageResp.arrayBuffer();
        // ArrayBuffer 转 base64
        const uint8 = new Uint8Array(arrayBuf);
        let binaryStr = "";
        for (const byte of uint8) {
          binaryStr += String.fromCharCode(byte);
        }
        imageBase64 = btoa(binaryStr);
      } catch (imgErr) {
        console.log("图片下载失败：", imgErr);
        content += "\n【⚠️ 图片下载异常】";
      }
    }

    try {
      // 1. 创建备忘录【纯文字，无图片标记】
      const memoResp = await fetch("https://ss.z2m.store/api/v1/memos", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.MEMOS_PAT}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content,
          visibility: "PUBLIC"
        })
      });

      const resText = await memoResp.text();
      if (!memoResp.ok) {
        await sendTgMessage(env.BOT_TOKEN, msg.chat.id, `❌ 保存失败：${memoResp.status} ${resText.slice(0,200)}`);
        return new Response("OK");
      }
      const memoData = JSON.parse(resText);
      const memoFullName = memoData.name; // 格式 memos/xxxxxx

      // 2. 如果存在图片，调用v1接口上传并直接绑定memo
      if (imageBase64) {
        const attachPayload = {
          filename: "tg-image.jpg",
          type: "image/jpeg",
          content: imageBase64,
          memo: memoFullName // 关键！上传时直接归属这条备忘录
        };

        const attachResp = await fetch("https://ss.z2m.store/api/v1/attachments", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.MEMOS_PAT}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(attachPayload)
        });
        const attachResult = await attachResp.json();
        console.log("附件上传完成：", attachResult);
        // 打印你需要的缩略图链接（仅日志，**不写入正文**）
        const thumbnailUrl = `https://ss.z2m.store/file/${attachResult.name}/${attachResult.filename}?thumbnail=true`;
        console.log("缩略图地址：", thumbnailUrl);
      }

      await sendTgMessage(env.BOT_TOKEN, msg.chat.id, "✅ 成功存入 Memos（公开可见，附件预览）");
    } catch (e) {
      console.error(e);
      await sendTgMessage(env.BOT_TOKEN, msg.chat.id, `❌ 请求异常：${String(e)}`);
    }

    return new Response("OK");
  }
};

/** TG发送消息封装 */
async function sendTgMessage(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/** 调用TG Bot API通用方法 */
async function fetchTgApi(botToken, method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await resp.json();
}
