// Cloudflare Workers Telegram 双向消息转发机器人
// 无状态设计 - 不依赖内存存储，Worker重启不影响功能
// 环境变量配置 - 在Cloudflare Workers控制台中设置以下变量：
// BOT_TOKEN: Telegram Bot Token (从 @BotFather 获取)
// ADMIN_CHAT_ID: 管理员的Chat ID (可以通过发送消息给机器人获取)
// WEBHOOK_SECRET: Webhook验证密钥 (可选，用于安全验证)

// 无状态设计，不需要内存存储

// 从消息中提取用户Chat ID的辅助函数
function extractUserChatId(messageText) {
  if (!messageText) return null
  const match = messageText.match(/\[USER:(\d+)\]/)
  return match ? match[1] : null
}

// 统一的Telegram API调用函数
async function callTelegramAPI(method, params, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params)
    })

    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  } catch (error) {
    console.error(`Failed to call Telegram API ${method}:`, error)
    throw error
  }
}

// 发送消息
async function sendMessage(chatId, text, botToken, options = {}) {
  const params = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    ...options
  }
  return await callTelegramAPI('sendMessage', params, botToken)
}

// 复制消息
async function copyMessage(chatId, fromChatId, messageId, botToken, options = {}) {
  const params = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
    ...options
  }
  return await callTelegramAPI('copyMessage', params, botToken)
}

// 设置Webhook
async function setWebhook(url, botToken, secret = '') {
  const params = {
    url: url,
    secret_token: secret
  }
  return await callTelegramAPI('setWebhook', params, botToken)
}

// 获取机器人信息
async function getMe(botToken) {
  return await callTelegramAPI('getMe', {}, botToken)
}

// 创建格式化的用户信息
function createUserInfo(message) {
  const { from, chat } = message
  const userName = from.username || from.first_name || 'Unknown'
  const userId = from.id
  const chatId = chat.id
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  
  return {
    userName,
    userId,
    chatId,
    time,
    header: `📩 *来自用户: ${userName}*\n🆔 ID: \`${userId}\`\n⏰ 时间: ${time}\n────────────────────`
  }
}

// 处理用户消息
async function handleUserMessage(message, env) {
  const userInfo = createUserInfo(message)
  
  try {
    // 发送欢迎消息给新用户
    if (message.text === '/start') {
      await sendMessage(
        userInfo.chatId, 
        `👋 你好！我是消息转发机器人。\n\n请发送你的消息，我会转发给管理员并尽快回复你。`, 
        env.BOT_TOKEN
      )
      return
    }

    // 创建包含用户信息的转发消息
    let forwardResult
    if (message.text) {
      // 文本消息
      const forwardText = `${userInfo.header}\n📝 *消息内容:*\n${message.text}\n\n\`[USER:${userInfo.chatId}]\``
      forwardResult = await sendMessage(env.ADMIN_CHAT_ID, forwardText, env.BOT_TOKEN)
    } else {
      // 媒体消息
      const caption = `${userInfo.header}\n${message.caption ? `📝 *说明:* ${message.caption}\n\n` : ''}\`[USER:${userInfo.chatId}]\``
      forwardResult = await copyMessage(env.ADMIN_CHAT_ID, userInfo.chatId, message.message_id, env.BOT_TOKEN, { caption })
    }

    if (forwardResult.ok) {
      console.log(`消息转发成功: 用户 ${userInfo.userName} -> 管理员`)
      
      // 给用户发送确认消息
      await sendMessage(userInfo.chatId, `✅ 你的消息已发送给管理员，请耐心等待回复。`, env.BOT_TOKEN)
    }
  } catch (error) {
    console.error('处理用户消息错误:', error)
    try {
      await sendMessage(userInfo.chatId, `❌ 抱歉，消息发送失败，请稍后再试。`, env.BOT_TOKEN)
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError)
    }
  }
}

// 处理管理员消息
async function handleAdminMessage(message, env) {
  try {
    // 管理员命令处理
    if (message.text === '/start') {
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🔧 *管理员面板*\n\n👋 欢迎使用消息转发机器人管理面板！\n\n📋 *可用命令:*\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示帮助信息\n\n💡 *使用说明:*\n• 直接回复用户消息即可回复给对应用户\n• 发送普通消息会作为广播消息（暂未实现）\n\n🤖 机器人已就绪，等待用户消息...`, 
        env.BOT_TOKEN
      )
      return
    }

    if (message.text === '/status') {
      await sendMessage(env.ADMIN_CHAT_ID, 
        `📊 *机器人状态*\n\n🟢 状态: 运行中\n🔄 模式: 无状态转发\n⏰ 查询时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, 
        env.BOT_TOKEN
      )
      return
    }

    if (message.text === '/help') {
      await sendMessage(env.ADMIN_CHAT_ID, 
        `❓ *帮助信息*\n\n🔄 *回复用户:*\n直接回复用户的消息即可发送回复给对应用户\n\n📝 *消息格式:*\n• 支持文本、图片、文件等各种消息类型\n• 支持Markdown格式\n\n⚙️ *命令列表:*\n• \`/start\` - 显示欢迎信息\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示此帮助信息`, 
        env.BOT_TOKEN
      )
      return
    }

    // 处理回复消息
    if (message.reply_to_message) {
      const repliedMessage = message.reply_to_message
      
      // 从被回复的消息中提取用户Chat ID
      const userChatId = extractUserChatId(repliedMessage.text || repliedMessage.caption)

      if (!userChatId) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `⚠️ 无法识别用户信息。请回复带有用户标识的转发消息。`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
        return
      }

      // 发送回复给用户
      let replyResult
      if (message.text) {
        replyResult = await sendMessage(userChatId, `💬 *管理员回复:*\n\n${message.text}`, env.BOT_TOKEN)
      } else {
        replyResult = await copyMessage(userChatId, env.ADMIN_CHAT_ID, message.message_id, env.BOT_TOKEN, {
          caption: message.caption ? `💬 *管理员回复:*\n\n${message.caption}` : '💬 *管理员回复:*'
        })
      }

      if (replyResult.ok) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `✅ 回复已发送给用户 (ID: ${userChatId})`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
        console.log(`回复发送成功: 管理员 -> 用户 ${userChatId}`)
      } else {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 回复发送失败: ${replyResult.description || '未知错误'}`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
      }
    } else {
      // 普通消息（非回复）
      await sendMessage(env.ADMIN_CHAT_ID, 
        `💡 *提示:* 请回复具体的用户消息来发送回复。\n\n如需查看帮助，请发送 /help`, 
        env.BOT_TOKEN, 
        { reply_to_message_id: message.message_id }
      )
    }
  } catch (error) {
    console.error('处理管理员消息错误:', error)
    try {
      await sendMessage(env.ADMIN_CHAT_ID, `❌ 处理消息时发生错误: ${error.message}`, env.BOT_TOKEN)
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError)
    }
  }
}

// 处理消息
async function handleMessage(message, env) {
  // 输入验证
  if (!message || !message.from || !message.chat) {
    console.error('无效的消息格式')
    return
  }

  const chatId = message.chat.id
  const userId = message.from.id
  const userName = message.from.username || message.from.first_name || 'Unknown'
  const isAdmin = chatId.toString() === env.ADMIN_CHAT_ID.toString()

  console.log(`收到消息: 来自 ${userName} (${userId}) 在聊天 ${chatId}`)

  if (isAdmin) {
    await handleAdminMessage(message, env)
  } else {
    await handleUserMessage(message, env)
  }
}

// 处理Webhook消息
async function handleWebhook(request, env, ctx) {
  try {
    // 验证Webhook密钥（如果设置了）
    if (env.WEBHOOK_SECRET) {
      const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
      if (secretToken !== env.WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 })
      }
    }

    const update = await request.json()
    
    if (update.message) {
      // 使用 ctx.waitUntil 进行后台消息处理，不阻塞响应
      ctx.waitUntil(handleMessage(update.message, env))
    }

    return new Response('OK', { status: 200 })
  } catch (error) {
    console.error('Webhook处理错误:', error)
    
    // 使用 ctx.waitUntil 进行后台错误记录
    ctx.waitUntil(
      sendMessage(env.ADMIN_CHAT_ID, `🚨 Bot错误: ${error.message}`, env.BOT_TOKEN)
        .catch(err => console.error('发送错误通知失败:', err))
    )
    
    return new Response('Internal Server Error', { status: 500 })
  }
}

// 处理HTTP请求
async function handleRequest(request, env, ctx) {
  // 输入验证
  if (!env.BOT_TOKEN || !env.ADMIN_CHAT_ID) {
    const missingVar = !env.BOT_TOKEN ? 'BOT_TOKEN' : 'ADMIN_CHAT_ID'
    return new Response(`Missing ${missingVar} environment variable`, { status: 500 })
  }

  const url = new URL(request.url)

  try {
    // 路由处理
    switch (true) {
      case request.method === 'POST' && url.pathname === '/webhook':
        return await handleWebhook(request, env, ctx)
        
      case request.method === 'GET' && url.pathname === '/setWebhook':
        const webhookUrl = `${url.origin}/webhook`
        const result = await setWebhook(webhookUrl, env.BOT_TOKEN, env.WEBHOOK_SECRET || '')
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        })
        
      case request.method === 'GET' && url.pathname === '/me':
        const botInfo = await getMe(env.BOT_TOKEN)
        return new Response(JSON.stringify(botInfo, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        })
        
      case request.method === 'GET' && url.pathname === '/':
        return new Response('Telegram Bot is running!', { status: 200 })
        
      default:
        return new Response('Not Found', { status: 404 })
    }
  } catch (error) {
    console.error('请求处理错误:', error)
    
    // 后台错误记录
    ctx.waitUntil(
      sendMessage(env.ADMIN_CHAT_ID, `🚨 系统错误: ${error.message}`, env.BOT_TOKEN)
        .catch(err => console.error('发送系统错误通知失败:', err))
    )
    
    return new Response('Internal Server Error', { status: 500 })
  }
}

// 导出处理函数（Cloudflare Workers需要）
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
} 