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

    // =========处理按钮点击回调 callback_query=========
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
      return new Response("OK");
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
      // 1. 创建备忘录【纯文字，无图片标记】 默认PUBLIC公开
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

      // =====构造内联键盘菜单，刚创建默认公开、未置顶=====
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: "🔓公开模式", callback_data: `vis_public|${memoFullName}` },
            { text: "🔒私密模式", callback_data: `vis_private|${memoFullName}` }
          ],
          [
            { text: "📌置顶", callback_data: `pin_on|${memoFullName}` },
            { text: "🗑删除", callback_data: `del|${memoFullName}` }
          ]
        ]
      };
      const sendResult = await sendTgMessageMarkup(env.BOT_TOKEN, msg.chat.id, "✅ 成功存入 Memos（公开可见，附件预览）", inlineKeyboard);
      console.log("TG发送消息返回：", sendResult);

    } catch (e) {
      console.error(e);
      await sendTgMessage(env.BOT_TOKEN, msg.chat.id, `❌ 请求异常：${String(e)}`);
    }
    return new Response("OK");
  }
};

/** 处理按钮回调点击 */
async function handleCallbackQuery(cbQuery, env) {
  const { id: cbId, message, data } = cbQuery;
  const chatId = message.chat.id;
  const msgId = message.message_id;
  const parts = data.split("|");
  const action = parts[0];
  const memoName = parts[1];

  let tipText = "";
  let newKeyboard = null;

  try {
    switch (action) {
      case "vis_public": {
        // 修改为PUBLIC公开
        await fetch(`https://ss.z2m.store/api/v1/${memoName}?updateMask=visibility`, {
          method: "PATCH",
          headers: { "Authorization": `Bearer ${env.MEMOS_PAT}`, "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: "PUBLIC" })
        });
        tipText = "✅已切换为【公开模式】";
        newKeyboard = {
          inline_keyboard: [
            [
              { text: "✅🔓公开模式", callback_data: `vis_public|${memoName}` },
              { text: "🔒私密模式", callback_data: `vis_private|${memoName}` }
            ],
            [
              { text: "📌置顶", callback_data: `pin_on|${memoName}` },
              { text: "🗑删除", callback_data: `del|${memoName}` }
            ]
          ]
        };
        break;
      }
      case "vis_private": {
        // 修改为PRIVATE私密
        await fetch(`https://ss.z2m.store/api/v1/${memoName}?updateMask=visibility`, {
          method: "PATCH",
          headers: { "Authorization": `Bearer ${env.MEMOS_PAT}`, "Content-Type": "application/json" },
          body: JSON.stringify({ visibility: "PRIVATE" })
        });
        tipText = "✅已切换为【私密模式】";
        newKeyboard = {
          inline_keyboard: [
            [
              { text: "🔓公开模式", callback_data: `vis_public|${memoName}` },
              { text: "✅🔒私密模式", callback_data: `vis_private|${memoName}` }
            ],
            [
              { text: "📌置顶", callback_data: `pin_on|${memoName}` },
              { text: "🗑删除", callback_data: `del|${memoName}` }
            ]
          ]
        };
        break;
      }
      case "pin_on": {
        // 开启置顶 pinned=true
        await fetch(`https://ss.z2m.store/api/v1/${memoName}?updateMask=pinned`, {
          method: "PATCH",
          headers: { "Authorization": `Bearer ${env.MEMOS_PAT}`, "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: true })
        });
        tipText = "✅已【置顶】备忘录";
        newKeyboard = {
          inline_keyboard: [
            [
              { text: "🔓公开模式", callback_data: `vis_public|${memoName}` },
              { text: "🔒私密模式", callback_data: `vis_private|${memoName}` }
            ],
            [
              { text: "✅📌已置顶", callback_data: `pin_off|${memoName}` },
              { text: "🗑删除", callback_data: `del|${memoName}` }
            ]
          ]
        };
        break;
      }
      case "pin_off": {
        // 取消置顶 pinned=false
        await fetch(`https://ss.z2m.store/api/v1/${memoName}?updateMask=pinned`, {
          method: "PATCH",
          headers: { "Authorization": `Bearer ${env.MEMOS_PAT}`, "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: false })
        });
        tipText = "✅已【取消置顶】";
        newKeyboard = {
          inline_keyboard: [
            [
              { text: "🔓公开模式", callback_data: `vis_public|${memoName}` },
              { text: "🔒私密模式", callback_data: `vis_private|${memoName}` }
            ],
            [
              { text: "📌置顶", callback_data: `pin_on|${memoName}` },
              { text: "🗑删除", callback_data: `del|${memoName}` }
            ]
          ]
        };
        break;
      }
      case "del": {
        // 删除memo
        await fetch(`https://ss.z2m.store/api/v1/${memoName}`, {
          method: "DELETE",
          headers: { "Authorization": `Bearer ${env.MEMOS_PAT}` }
        });
        tipText = "🗑本条备忘录已删除";
        newKeyboard = { inline_keyboard: [] }; //清空按钮
        break;
      }
      default:
        tipText = "未知操作";
    }
  } catch (err) {
    console.error("callback操作异常", err);
    tipText = "❌操作失败，请检查权限";
  }

  // 必须应答callback_query，消除按钮loading状态
  const cbResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbId, text: tipText })
  });
  console.log("answerCallbackQuery返回：", await cbResp.json());

  // 更新消息上的按钮
  if (newKeyboard) {
    const editResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: msgId,
        reply_markup: newKeyboard
      })
    });
    console.log("editMessageReplyMarkup返回：", await editResp.json());
  }
}

/** TG发送消息封装（无键盘） */
async function sendTgMessage(botToken, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return await resp.json();
}

/** TG发送消息，携带inline键盘 */
async function sendTgMessageMarkup(botToken, chatId, text, replyMarkup) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup
    })
  });
  return await resp.json();
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
