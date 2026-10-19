/**
 * 提示词增强 · Host 半。
 *
 * 职责：在 loopback web 服务器上挂一个 POST /prompt-enhance/enhance 路由，
 * 收到草稿后调用当前 profile 已配置的 LLM 跑一次「改写提示词」的补全，
 * 把结果原样返回给 Client 半（输入框工具条上的 ✨ 按钮）。
 *
 * 为什么放在 Host：浏览器端没有模型凭据，也不能直连提供方；Host 的
 * ctx.llm 是唯一受支持的调用路径（见 @deepseek-ai/dsh-llm）。
 *
 * 设计上刻意零 import：profile 里的本地插件经 pnpm link 安装后，裸包名
 * （@deepseek-ai/*）解析不到 profile 的依赖树，因此这里只依赖宿主注入的
 * ctx.llm / ctx.webServer，不 import 任何 @deepseek-ai 包。
 */

const ROUTE_PREFIX = '/prompt-enhance'
const ROUTE_APPLY = '/prompt-enhance/enhance'
const MAX_BODY_BYTES = 256 * 1024
const MAX_DRAFT_CHARS = 20_000
/** WorkBuddy 侧 sidecar 请求超时（3e5ms）对齐。 */
const DEFAULT_TIMEOUT_MS = 300_000

/**
 * 与 WorkBuddy 5.8.3 主进程常量 `zn` 逐字一致（仅去掉源码行首制表符）。
 * 这是增强效果的「产品定义」：只给分析流程 + 改写原则 + 5 条红线，
 * 没有六段式模板，所以输出是一段连贯、更具体的提示词，而不是固定小标题。
 */
const SYSTEM_PROMPT = `You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.

TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.

ANALYSIS PROCESS:

Evaluate the original prompt:
Identify the main objective
Note any ambiguities or gaps
Assess the clarity of instructions
Check for missing context
Apply these prompt engineering principles:
Write clear, specific instructions
Include necessary context
Set explicit parameters and constraints
Structure the output format
Add relevant examples
Match tone and complexity to the use case
Remove redundant information
Create the enhanced version:
Maintain the original goal
Incorporate identified improvements
Ensure clarity and completeness
Be realistic in the features to add
Do NOT request guides/how-tos unless the user asks
Do NOT ask for code snippets
Do NOT suggest specific technologies unless mentioned in the user's prompt
Do NOT explain HOW to do things, focus on WHAT
Do NOT answer questions - expand/rewrite them to be more detailed
IMPORTANT CONSTRAINTS:
1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English; if the user uses another language, respond in that same language. Do not mix languages unless the user's input itself mixes languages.
2. Keep the enhanced prompt concise - maximum length should be around 800 characters
FORMAT: Provide only the enhanced prompt with no additional commentary.

Example:
"A website for my dog"

Enhanced prompt:
"Design a personalized Next.js website dedicated to showcasing my dog. Include sections such as a photo gallery, a biography detailing the dog's breed, age, and personality traits, and a blog for sharing stories or updates about your dog's adventures. Add a contact form for visitors to reach out with questions or comments. Ensure the website is visually appealing and easy to navigate, with a responsive design that works well on both desktop and mobile devices."

Example:
"Convert this to a friendly tone, maintain technical details but reduce bullets in favor of narrative. Remove any jargon like 'genie router'. Use canvas"

Enhanced prompt:
"Transform the provided content into a friendly narrative format while preserving all technical details. Minimize bullet points in favor of flowing prose. Eliminate any technical jargon such as 'genie router'. Incorporate the concept of using canvas elements naturally within the narrative structure to enhance the technical explanation."`

/**
 * 与 WorkBuddy 常量 `Bn` 一致的 user 模板：语言一致性、7 条增强要求、
 * 中/英/混排示例和 BAD/GOOD 反例都放在 user 消息里（WorkBuddy 就是这么发的）。
 */
const USER_TEMPLATE = `You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.

USER INPUT:
{input}

TASK:
Rewrite the user input into a clearer, more specific prompt for the target AI assistant.

CRITICAL PRIORITY - LANGUAGE CONSISTENCY:
1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.
2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.
3. If the user writes in English, the enhanced prompt MUST be entirely in English.
4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.
5. If the user mixes languages, keep a natural matching mix. Do not translate the user's intent into a single language.
6. These language rules are behavior instructions only; never include language analysis or language labels in the output.

ENHANCEMENT REQUIREMENTS:
1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.
2. Do not include language labels or meta notes such as "User input is in Chinese" or "Response must be in Chinese".
3. Preserve the user's original intent, topic, constraints, and target output type. Do not answer the request.
4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.
5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.
6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.
7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.

EXAMPLES:
User input (Chinese): "请帮我解释这段代码的功能"
Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"

User input (English): "Please explain what this code does"
Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."

User input (Mixed): "这段代码有 bug，can you help me fix it?"
Enhanced prompt: "请分析这段代码中的 bug，explain the root cause, and provide a minimal fix with necessary verification steps."

BAD OUTPUT EXAMPLE:
User input is in Chinese → Response must be in Chinese.
请解释这段代码的主要功能

GOOD OUTPUT EXAMPLE:
请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。`

function userPromptFor(draft) {
  return USER_TEMPLATE.replace('{input}', draft)
}

/** 只信任 loopback 同源请求，避免本机其他页面驱动模型调用（抄自 agent-db-ui）。 */
function isTrustedRequest(req) {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  if (!(hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1')) {
    return false
  }
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        rejectPromise(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', rejectPromise)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 可选服务读取：服务没挂载时返回 undefined，而不是抛错。 */
function peek(ctx, name) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

/** provider/model：显式 config 优先，其次跟随 profile 的默认模型。 */
function resolveTarget(scope, config) {
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  if (provider !== '' && model !== '') return { provider, model, source: 'config' }
  const defaults = peek(scope, 'agentDefaultModel')
  const selection = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
  if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model, source: 'agentDefaultModel' }
  }
  return null
}

/** 把 llm 分片流收成一段纯文本；终止分片决定成功还是失败。 */
async function collectText(stream) {
  let text = ''
  let failure = null
  let ended = false
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    // 容错：只吃 delta 的实现，若提供方改成整块 text 也能拿到结果。
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      if (text === '' && typeof chunk.block.text === 'string') text = chunk.block.text
      continue
    }
    if (chunk.type === 'finish') {
      ended = true
      const reason = chunk.reason || {}
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const f = reason.failure || {}
        failure = { kind: reason.kind, code: f.code || reason.kind, message: f.message || reason.kind }
      } else if (reason.kind === 'tool-calls') {
        // 增强只需要一段文本，模型却想调工具：当成失败，别把空结果写回输入框。
        failure = { kind: 'tool-calls', code: 'TOOL_CALLS', message: '模型返回了工具调用而不是文本' }
      }
      // 'max-tokens' 是「被截断的成功」，照常返回已生成的部分。
      break
    }
  }
  if (!ended && failure === null) failure = { kind: 'error', code: 'NO_FINISH', message: '模型流没有给出结束分片' }
  return { text, failure }
}

/**
 * 与 WorkBuddy 完全一致的后处理：
 *   1. 渲染侧 normalizeEnhanceText：去掉零宽空格 \u200B 后 trim；
 *   2. 主进程 stripWrappingQuotes：trim 后削掉首/尾各一个引号字符。
 * WorkBuddy 不处理代码围栏，这里也不处理（保持 1:1）。
 */
function unwrapOutput(raw) {
  const text = String(raw ?? '').split('\u200B').join('').trim()
  return text.replace(/^["'“”‘’]|["'“”‘’]$/g, '')
}

function createRoutes(scope, config) {
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS
  // WorkBuddy 的 sidecar 请求不带 temperature/maxTokens（交给网关默认值）。
  // 这里保持同样行为：只有用户在插件配置里显式写了才下发。
  const maxTokens = Number.isFinite(Number(config.maxTokens)) ? Number(config.maxTokens) : undefined
  const temperature = Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : undefined

  async function handleEnhance(req, res) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
      return
    }
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') {
      sendJson(res, 400, { ok: false, error: { message: '草稿为空，没有可增强的内容' } })
      return
    }
    if (text.length > MAX_DRAFT_CHARS) {
      sendJson(res, 400, { ok: false, error: { message: '草稿过长（上限 ' + MAX_DRAFT_CHARS + ' 字符）' } })
      return
    }

    const llm = peek(scope, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      sendJson(res, 503, { ok: false, error: { message: '当前 profile 没有挂载 llm 服务，无法增强提示词' } })
      return
    }
    const target = resolveTarget(scope, config)
    if (!target) {
      sendJson(res, 503, {
        ok: false,
        error: { message: '无法确定模型：请在插件配置里填写 provider/model，或先设置默认模型' },
      })
      return
    }

    // 浏览器关掉面板时顺手取消这次模型调用，别让它白跑。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('增强超时')), timeoutMs)
    if (res && typeof res.on === 'function') {
      res.on('close', () => { if (res.writableEnded !== true) controller.abort(new Error('客户端已断开')) })
    }

    // prepareCall 让适配器把 maxTokens / reasoning 等默认值先物化出来；没有它就直连 stream。
    // 只有显式配置了 temperature/maxTokens 才下发，行为对齐 WorkBuddy（其余交给适配器默认值）。
    const request = { provider: target.provider, model: target.model }
    if (maxTokens !== undefined) request.maxTokens = maxTokens
    if (temperature !== undefined) request.temperature = temperature
    let prepared = null
    if (typeof llm.prepareCall === 'function') {
      try {
        prepared = await llm.prepareCall(request, controller.signal)
      } catch (error) {
        clearTimeout(timer)
        const message = error instanceof Error ? error.message : String(error)
        scope.logger?.warn?.('[prompt-enhance] prepareCall 失败：' + message)
        sendJson(res, 503, {
          ok: false,
          error: { message: '模型未就绪：' + message, code: 'NO_ADAPTER', provider: target.provider, model: target.model },
        })
        return
      }
    }

    const options = {
      ...(prepared && prepared.config ? prepared.config : request),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userPromptFor(text) }] }],
      signal: controller.signal,
    }

    let result
    try {
      const stream = prepared && typeof prepared.stream === 'function' ? prepared.stream(options) : llm.stream(options)
      result = await collectText(stream)
    } catch (error) {
      result = {
        text: '',
        failure: { kind: 'error', code: 'THROWN', message: error instanceof Error ? error.message : String(error) },
      }
    } finally {
      clearTimeout(timer)
    }

    if (result.failure !== null) {
      scope.logger?.warn?.('[prompt-enhance] 模型调用失败：' + result.failure.code + ' ' + result.failure.message)
      const timedOut = controller.signal.aborted
      sendJson(res, timedOut ? 504 : 502, {
        ok: false,
        error: {
          message: result.failure.message,
          code: result.failure.code,
          provider: target.provider,
          model: target.model,
        },
      })
      return
    }

    const enhanced = unwrapOutput(result.text)
    if (enhanced === '') {
      sendJson(res, 502, { ok: false, error: { message: '模型返回了空结果' } })
      return
    }
    sendJson(res, 200, {
      ok: true,
      data: { text: enhanced, provider: target.provider, model: target.model, via: target.source },
    })
  }

  return async function handler(req, res) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { message: '仅允许 loopback 同源请求' } })
      return
    }
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    try {
      if (req.method === 'POST' && pathname === ROUTE_APPLY) {
        await handleEnhance(req, res)
        return
      }
      if (req.method === 'GET' && (pathname === ROUTE_PREFIX || pathname === ROUTE_PREFIX + '/')) {
        sendJson(res, 200, { ok: true, data: { plugin: 'prompt-enhance', routes: [ROUTE_APPLY] } })
        return
      }
      sendJson(res, 404, { ok: false, error: { message: '未知路由 ' + pathname } })
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/** 挂载路由并接进 Cordis 生命周期；热重载撞到旧路由时只告警。 */
function mountRoutes(owner, webServer, config) {
  let unregister = null
  try {
    unregister = webServer.register({
      name: 'prompt-enhance',
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createRoutes(owner, config),
    })
  } catch (error) {
    owner.logger?.warn?.('[prompt-enhance] 路由挂载失败：' + String(error?.message || error))
    return () => {}
  }
  const dispose = () => {
    try {
      if (typeof unregister === 'function') unregister()
    } catch (error) {
      owner.logger?.warn?.('[prompt-enhance] 路由卸载失败：' + String(error?.message || error))
    }
  }
  const effect = owner.effect || owner.ctx?.effect
  if (typeof effect === 'function') effect(() => dispose)
  owner.logger?.info?.('[prompt-enhance] routes mounted at ' + ROUTE_PREFIX + ' (prompt rev wb-1:1)')
  return dispose
}

export const name = 'prompt-enhance'

export function apply(ctx, config = {}) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'llm'], (scope) => {
      mountRoutes(scope, scope.webServer, config)
    })
    return
  }
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[prompt-enhance] 当前组合没有 webServer，增强路由不会挂载')
    return
  }
  mountRoutes(ctx, webServer, config)
}
