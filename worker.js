// Cloudflare Workers Telegram 双向消息转发机器人
// 无状态设计 - 不依赖内存存储，Worker重启不影响功能
// 环境变量配置 - 在Cloudflare Workers控制台中设置以下变量：
// BOT_TOKEN: Telegram Bot Token (从 @BotFather 获取)
// ADMIN_CHAT_ID: 管理员的Chat ID (可以通过发送消息给机器人获取)
// WEBHOOK_SECRET: Webhook验证密钥 (可选，用于安全验证)
// ENABLE_USER_TRACKING: 启用用户跟踪 (可选，需要绑定KV存储)
// USER_ID_SECRET: 用户ID签名密钥 (建议设置，用于防止身份伪造攻击)

// 无状态设计，不需要内存存储

// 生成用户ID的HMAC签名
async function generateUserIdSignature(userId, secret) {
  if (!secret) {
    // 如果没有配置密钥，使用简单的哈希作为后备
    const data = new TextEncoder().encode(`user:${userId}:fallback`)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16)
  }
  
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  
  const data = new TextEncoder().encode(`user:${userId}`)
  const signature = await crypto.subtle.sign('HMAC', key, data)
  const signatureArray = Array.from(new Uint8Array(signature))
  return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16)
}

// 验证用户ID签名
async function verifyUserIdSignature(userId, signature, secret) {
  const expectedSignature = await generateUserIdSignature(userId, secret)
  return signature === expectedSignature
}

// 创建安全的用户标识符
async function createSecureUserTag(userId, secret) {
  const signature = await generateUserIdSignature(userId, secret)
  return `[USER:${userId}:${signature}]`
}

// 从消息中安全提取用户Chat ID的辅助函数
async function extractUserChatId(messageText, secret) {
  if (!messageText) return null
  
  // 新的安全格式：[USER:id:signature] 
  const secureMatch = messageText.match(/\[USER:(\d+):([a-f0-9]{16})\]/)
  if (secureMatch) {
    const userId = secureMatch[1]
    const signature = secureMatch[2]
    
    // 验证签名
    const isValid = await verifyUserIdSignature(userId, signature, secret)
    if (isValid) {
      return userId
    } else {
      console.warn(`检测到无效的用户ID签名: ${userId}:${signature}`)
      return null
    }
  }
  
  // 兼容旧格式（逐步淘汰，仅在没有新格式时使用）
  const legacyMatch = messageText.match(/\[USER:(\d+)\](?![:\w])/)
  if (legacyMatch && !secureMatch) {
    console.warn(`使用了不安全的旧格式用户标识: ${legacyMatch[1]}`)
    return legacyMatch[1]
  }
  
  return null
}

// 解析群发命令的目标用户
function parsePostTargets(commandText) {
  if (!commandText) return { userIds: [], message: '' }
  
  const parts = commandText.split(' ')
  if (parts.length < 2) return { userIds: [], message: '' }
  
  const targetsStr = parts[0]
  const message = parts.slice(1).join(' ')
  
  // 处理特殊关键词
  if (targetsStr === 'all') {
    return { userIds: 'all', message }
  }
  
  // 解析用户ID列表（逗号分隔）
  const userIds = targetsStr.split(',')
    .map(id => id.trim())
    .filter(id => /^\d+$/.test(id))
  
  return { userIds, message }
}

// 从KV存储获取用户列表
async function getUsersFromKV(env) {
  try {
    if (!env.USER_STORAGE) {
      console.log('KV存储未配置')
      return []
    }
    
    const usersData = await env.USER_STORAGE.get('user_list')
    if (!usersData) return []
    
    const users = JSON.parse(usersData)
    return Array.isArray(users) ? users : []
  } catch (error) {
    console.error('从KV获取用户列表失败:', error)
    return []
  }
}

// 向KV存储添加用户
async function addUserToKV(chatId, userInfo, env) {
  try {
    if (!env.USER_STORAGE) return
    
    const users = await getUsersFromKV(env)
    const existingIndex = users.findIndex(u => u.chatId === chatId)
    
    const userData = {
      chatId,
      userName: userInfo.userName,
      userId: userInfo.userId,
      lastActive: new Date().toISOString()
    }
    
    if (existingIndex >= 0) {
      users[existingIndex] = userData
    } else {
      users.push(userData)
    }
    
    // 保持最多1000个用户记录
    if (users.length > 1000) {
      users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      users.splice(1000)
    }
    
    await env.USER_STORAGE.put('user_list', JSON.stringify(users))
  } catch (error) {
    console.error('添加用户到KV失败:', error)
  }
}

// 群发消息功能
async function broadcastMessage(userIds, message, env, isMedia = false, mediaOptions = {}) {
  const results = { success: 0, failed: 0, errors: [] }
  
  // 获取实际的用户ID列表
  let targetUserIds = []
  if (userIds === 'all') {
    const users = await getUsersFromKV(env)
    targetUserIds = users.map(u => u.chatId)
    if (targetUserIds.length === 0) {
      return { success: 0, failed: 1, errors: ['未找到可广播的用户，请确保已启用用户跟踪功能'] }
    }
  } else {
    targetUserIds = userIds
  }
  
  if (targetUserIds.length === 0) {
    return { success: 0, failed: 1, errors: ['未指定有效的用户ID'] }
  }
  
  // 限制并发数量以避免API限制
  const batchSize = 10
  for (let i = 0; i < targetUserIds.length; i += batchSize) {
    const batch = targetUserIds.slice(i, i + batchSize)
    
    const promises = batch.map(async (chatId) => {
      try {
        if (isMedia) {
          await copyMessage(chatId, env.ADMIN_CHAT_ID, mediaOptions.messageId, env.BOT_TOKEN, {
            caption: `📢 *管理员广播:*\n\n${message}`
          })
        } else {
          await sendMessage(chatId, `📢 *管理员广播:*\n\n${message}`, env.BOT_TOKEN)
        }
        results.success++
      } catch (error) {
        results.failed++
        results.errors.push(`用户 ${chatId}: ${error.message}`)
        console.error(`发送给用户 ${chatId} 失败:`, error)
      }
    })
    
    await Promise.allSettled(promises)
    
    // 添加短暂延迟以避免触发速率限制
    if (i + batchSize < targetUserIds.length) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  
  return results
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
    // 自动跟踪用户（如果启用）
    if (env.ENABLE_USER_TRACKING === 'true') {
      await addUserToKV(userInfo.chatId, userInfo, env)
    }
    
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
    const secureUserTag = await createSecureUserTag(userInfo.chatId, env.USER_ID_SECRET)
    let forwardResult
    if (message.text) {
      // 文本消息
      const forwardText = `${userInfo.header}\n📝 *消息内容:*\n${message.text}\n\n\`${secureUserTag}\``
      forwardResult = await sendMessage(env.ADMIN_CHAT_ID, forwardText, env.BOT_TOKEN)
    } else {
      // 媒体消息
      const caption = `${userInfo.header}\n${message.caption ? `📝 *说明:* ${message.caption}\n\n` : ''}\`${secureUserTag}\``
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
      const userTrackingStatus = env.ENABLE_USER_TRACKING === 'true' ? '🟢 已启用' : '🔴 未启用'
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🔧 *管理员面板*\n\n👋 欢迎使用消息转发机器人管理面板！\n\n📋 *可用命令:*\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示帮助信息\n• \`/post\` - 群发消息功能\n• \`/users\` - 查看用户列表（需启用用户跟踪）\n\n💡 *使用说明:*\n• 直接回复用户消息即可回复给对应用户\n• 使用 /post 命令进行消息群发\n\n📊 *系统状态:*\n• 用户跟踪: ${userTrackingStatus}\n\n🤖 机器人已就绪，等待用户消息...`, 
        env.BOT_TOKEN
      )
      return
    }

    if (message.text === '/status') {
      const userCount = env.ENABLE_USER_TRACKING === 'true' 
        ? (await getUsersFromKV(env)).length 
        : '未启用跟踪'
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `📊 *机器人状态*\n\n🟢 状态: 运行中\n🔄 模式: 无状态转发\n👥 已跟踪用户: ${userCount}\n⏰ 查询时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, 
        env.BOT_TOKEN
      )
      return
    }

    if (message.text === '/help') {
      await sendMessage(env.ADMIN_CHAT_ID, 
        `❓ *帮助信息*\n\n🔄 *回复用户:*\n直接回复用户的消息即可发送回复给对应用户\n\n📢 *群发消息:*\n• \`/post all 消息内容\` - 向所有用户群发（需启用用户跟踪）\n• \`/post 123,456,789 消息内容\` - 向指定用户群发\n• 回复媒体消息并使用 /post 命令可群发媒体\n\n👥 *用户管理:*\n• \`/users\` - 查看已跟踪的用户列表\n\n📝 *消息格式:*\n• 支持文本、图片、文件等各种消息类型\n• 支持Markdown格式\n\n⚙️ *命令列表:*\n• \`/start\` - 显示欢迎信息\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示此帮助信息\n• \`/post\` - 群发消息功能\n• \`/users\` - 查看用户列表`, 
        env.BOT_TOKEN
      )
      return
    }

    if (message.text && message.text.startsWith('/post')) {
      const commandText = message.text.substring(5).trim()
      
      if (!commandText) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `📢 *群发功能使用说明*\n\n🎯 *命令格式:*\n• \`/post all 消息内容\` - 向所有用户群发\n• \`/post 123,456,789 消息内容\` - 向指定用户群发\n\n💡 *示例:*\n• \`/post all 系统维护通知：今晚22:00-23:00进行维护\`\n• \`/post 123456789,987654321 您好，这是一条测试消息\`\n\n📎 *群发媒体:*\n回复包含图片/文件的消息，然后使用 /post 命令\n\n⚠️ *注意:*\n• 使用 'all' 需要启用用户跟踪功能\n• 手动指定用户ID时，请用英文逗号分隔\n• 群发会自动限速以避免API限制`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
        return
      }

      const { userIds, message: postMessage } = parsePostTargets(commandText)
      
      if (!postMessage) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 请提供要群发的消息内容`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
        return
      }

      if (userIds === 'all' && env.ENABLE_USER_TRACKING !== 'true') {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 使用 'all' 群发需要启用用户跟踪功能\n\n请设置环境变量 \`ENABLE_USER_TRACKING=true\` 并绑定KV存储`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
        return
      }

      if (Array.isArray(userIds) && userIds.length === 0) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 未找到有效的用户ID\n\n请检查格式: \`/post 123,456,789 消息内容\``, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )
        return
      }

      // 发送确认消息
      const targetCount = userIds === 'all' ? (await getUsersFromKV(env)).length : userIds.length
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🚀 开始群发消息...\n\n📊 目标用户数: ${targetCount}\n⏳ 请稍候...`, 
        env.BOT_TOKEN, 
        { reply_to_message_id: message.message_id }
      )

      // 执行群发
      const results = await broadcastMessage(userIds, postMessage, env)
      
      // 发送结果报告
      const reportText = `📊 *群发完成报告*\n\n✅ 成功: ${results.success}\n❌ 失败: ${results.failed}\n\n${results.errors.length > 0 ? `🔍 *错误详情:*\n${results.errors.slice(0, 5).join('\n')}${results.errors.length > 5 ? `\n... 还有 ${results.errors.length - 5} 个错误` : ''}` : '🎉 全部发送成功！'}`
      
      await sendMessage(env.ADMIN_CHAT_ID, reportText, env.BOT_TOKEN)
      return
    }

    if (message.text === '/users') {
      if (env.ENABLE_USER_TRACKING !== 'true') {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 用户跟踪功能未启用\n\n请设置环境变量 \`ENABLE_USER_TRACKING=true\` 并绑定KV存储`, 
          env.BOT_TOKEN
        )
        return
      }

      const users = await getUsersFromKV(env)
      if (users.length === 0) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `📭 暂无用户记录\n\n用户首次发送消息后会自动记录`, 
          env.BOT_TOKEN
        )
        return
      }

      // 按最后活跃时间排序，显示最近的20个用户
      users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      const recentUsers = users.slice(0, 20)
      
      const userList = recentUsers.map((user, index) => {
        const lastActive = new Date(user.lastActive).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        return `${index + 1}. ${user.userName}\n   ID: \`${user.chatId}\`\n   最后活跃: ${lastActive}`
      }).join('\n\n')

      await sendMessage(env.ADMIN_CHAT_ID, 
        `👥 *用户列表* (最近 ${recentUsers.length}/${users.length})\n\n${userList}${users.length > 20 ? '\n\n...' : ''}`, 
        env.BOT_TOKEN
      )
      return
    }

    // 处理回复消息（支持群发媒体）
    if (message.reply_to_message) {
      const repliedMessage = message.reply_to_message
      
      // 检查是否是群发媒体命令（确保不是回复用户消息）
      const hasUserTag = repliedMessage.text?.includes('[USER:') || repliedMessage.caption?.includes('[USER:')
      if (message.text && message.text.startsWith('/post') && !hasUserTag) {
        const commandText = message.text.substring(5).trim()
        const { userIds, message: postMessage } = parsePostTargets(commandText)
        
        if (!postMessage) {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `❌ 请提供要群发的消息内容`, 
            env.BOT_TOKEN, 
            { reply_to_message_id: message.message_id }
          )
          return
        }

        // 群发媒体消息
        const targetCount = userIds === 'all' ? (await getUsersFromKV(env)).length : userIds.length
        await sendMessage(env.ADMIN_CHAT_ID, 
          `🚀 开始群发媒体消息...\n\n📊 目标用户数: ${targetCount}`, 
          env.BOT_TOKEN, 
          { reply_to_message_id: message.message_id }
        )

        const results = await broadcastMessage(userIds, postMessage, env, true, { 
          messageId: repliedMessage.message_id 
        })
        
        const reportText = `📊 *媒体群发完成*\n\n✅ 成功: ${results.success}\n❌ 失败: ${results.failed}`
        await sendMessage(env.ADMIN_CHAT_ID, reportText, env.BOT_TOKEN)
        return
      }
      
      // 普通回复处理
      const userChatId = await extractUserChatId(repliedMessage.text || repliedMessage.caption, env.USER_ID_SECRET)

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
        `💡 *提示:* 请回复具体的用户消息来发送回复，或使用群发命令。\n\n📢 群发: \`/post all 消息内容\`\n❓ 帮助: \`/help\``, 
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