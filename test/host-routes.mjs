/**
 * Host 半冒烟：用假的 ctx / webServer / llm 挂载真实路由，覆盖几条容易回归的约定：
 *   1. 前缀路由的 path 不能带尾部斜杠（webserver 只认 pathname === prefix 或
 *      pathname.startsWith(prefix + '/')）；
 *   2. GET /prompt-enhance 可当健康检查；
 *   3. 非同源请求一律 403（浏览器之外的本机页面不能驱动模型调用）；
 *   4. 空草稿 400、无 llm 服务 503、模型失败 502、成功时把分片流拼成文本；
 *   5. provider/model 缺省时跟随 agentDefaultModel。
 *
 * 不触网：llm 是本地假实现。
 */
import { Readable } from 'node:stream'

const { apply } = await import('../index.js')

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log('  ok   ' + label)
  } else {
    fail += 1
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
  }
}

const matches = (prefix, pathname) => pathname === prefix || pathname.startsWith(prefix + '/')

/* ---------------- 假 webServer / ctx ---------------- */
const routes = []
const fakeWebServer = {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}
const logger = { info() {}, warn() {}, error() {} }

function makeCtx(overrides = {}) {
  const calls = { enhance: 0, options: null }
  const llmStream = overrides.llmStream || (async function* stream(options) {
    calls.enhance += 1
    calls.options = options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '增强后的' }
    yield { type: 'text-delta', index: 0, text: '提示词' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '增强后的提示词' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const services = {
    webServer: fakeWebServer,
    llm: { stream: llmStream },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    ...(overrides.services || {}),
  }
  const scope = {
    webServer: services.webServer,
    llm: services.llm,
    agentDefaultModel: services.agentDefaultModel,
    logger,
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  const ctx = {
    logger,
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(names, callback) {
      check('apply 注入 webServer 与 llm', Array.isArray(names) && names.includes('webServer') && names.includes('llm'), JSON.stringify(names))
      return callback(scope)
    },
  }
  return { ctx, calls, services }
}

function call(handler, { method = 'GET', url = '/prompt-enhance', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:43120', 'sec-fetch-site': 'same-origin', ...headers }
  return new Promise((resolve, reject) => {
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) {
        status = code
      },
      setHeader() {},
      end(chunk) {
        payload = chunk === undefined ? '' : String(chunk)
        resolve({ status, payload, json: () => JSON.parse(payload) })
      },
      on() {},
      writableEnded: false,
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

/* ---------------- 1. 挂载 ---------------- */
const first = makeCtx()
apply(first.ctx, {})
check('挂载了一条路由', routes.length === 1, JSON.stringify(routes.map((r) => r.path)))
const route = routes[0]
check('路由是 prefix 且没有尾部斜杠', Boolean(route) && route.kind === 'prefix' && route.path === '/prompt-enhance', route && route.kind + ' ' + route.path)
check('能匹配 /prompt-enhance/enhance', matches(route.path, '/prompt-enhance/enhance'))

/* ---------------- 2. 健康检查 / 403 ---------------- */
const handler = route.handler
const health = await call(handler, { url: '/prompt-enhance' })
check('GET /prompt-enhance 健康检查', health.status === 200 && health.payload.includes('prompt-enhance'), health.status + ' ' + health.payload.slice(0, 120))

const crossSite = await call(handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ text: 'x' }),
})
check('非同源 POST 被 403 拒绝', crossSite.status === 403, crossSite.status + ' ' + crossSite.payload.slice(0, 120))

const lanHost = await call(handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  headers: { host: '192.168.1.5:43120' },
  body: JSON.stringify({ text: 'x' }),
})
check('非 loopback Host 被 403 拒绝', lanHost.status === 403, lanHost.status + ' ' + lanHost.payload.slice(0, 120))

/* ---------------- 3. 参数校验 ---------------- */
const emptyDraft = await call(handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: '   ' }),
})
check('空草稿返回 400', emptyDraft.status === 400, emptyDraft.status + ' ' + emptyDraft.payload.slice(0, 120))

const badJson = await call(handler, { method: 'POST', url: '/prompt-enhance/enhance', body: '{not json' })
check('非法 JSON 返回 400', badJson.status === 400, badJson.status + ' ' + badJson.payload.slice(0, 120))

/* ---------------- 4. 正常增强 ---------------- */
const ok = await call(handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: '帮我把登录页改成深色' }),
})
const okBody = ok.json()
check('成功返回 200 与文本', ok.status === 200 && okBody.ok === true && okBody.data.text === '增强后的提示词', ok.status + ' ' + ok.payload.slice(0, 200))
check('缺省时跟随默认模型', okBody.data && okBody.data.provider === 'deepseek-account' && okBody.data.model === 'deepseek-flash', JSON.stringify(okBody.data))
check('一次请求只调一次模型', first.calls.enhance === 1, String(first.calls.enhance))
check(
  '请求带上 WorkBuddy system prompt',
  Boolean(first.calls.options && typeof first.calls.options.system === 'string' && first.calls.options.system.includes('Prompt Engineering Expert')),
  JSON.stringify({ system: String(first.calls.options?.system ?? '').slice(0, 60) }),
)
check(
  '未显式配置时不下发 temperature / maxTokens',
  first.calls.options?.temperature === undefined && first.calls.options?.maxTokens === undefined,
  JSON.stringify({ temperature: first.calls.options?.temperature, maxTokens: first.calls.options?.maxTokens }),
)
const userMessage = first.calls.options?.messages?.[0]?.content?.[0]?.text ?? ''
check(
  'user message 套用 Bn 模板并内嵌原文',
  userMessage !== '帮我把登录页改成深色' &&
    userMessage.startsWith('You are a prompt enhancement assistant.') &&
    userMessage.includes('CRITICAL PRIORITY - LANGUAGE CONSISTENCY') &&
    userMessage.includes('帮我把登录页改成深色'),
  userMessage.slice(0, 80),
)

/* ---------------- 5. 配置优先 + 结果去包裹 ---------------- */
routes.length = 0
const second = makeCtx({
  llmStream: async function* stream() {
    yield { type: 'text-delta', index: 0, text: '"\u200B配置模型的输出\u200B"' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})
apply(second.ctx, { provider: 'my-provider', model: 'my-model', maxChars: 800 })
const customRoute = routes[0]
const custom = await call(customRoute.handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: '写一个迁移脚本' }),
})
const customBody = custom.json()
check('配置的 provider/model 优先', customBody.data?.provider === 'my-provider' && customBody.data?.model === 'my-model', JSON.stringify(customBody.data))
check('与 WorkBuddy 一致：去零宽空格 + 削首尾引号（不处理围栏）', customBody.data?.text === '配置模型的输出', JSON.stringify(customBody.data?.text))

/* ---------------- 6. 失败与缺服务 ---------------- */
routes.length = 0
const failing = makeCtx({
  llmStream: async function* stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: '太频繁了' } } }
  },
})
apply(failing.ctx, {})
const failed = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
check('模型报错映射成 502', failed.status === 502 && failed.json().error.code === 'RATE_LIMITED', failed.status + ' ' + failed.payload.slice(0, 200))

routes.length = 0
const noLlm = makeCtx({ services: { llm: undefined } })
apply(noLlm.ctx, {})
const unavailable = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
check('没有 llm 服务返回 503', unavailable.status === 503, unavailable.status + ' ' + unavailable.payload.slice(0, 200))

routes.length = 0
const noDefault = makeCtx({ services: { agentDefaultModel: undefined } })
apply(noDefault.ctx, {})
const noTarget = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
check('无默认模型且未配置时返回 503', noTarget.status === 503, noTarget.status + ' ' + noTarget.payload.slice(0, 200))

/* ---------------- 7. prepareCall 路径（适配器默认值先物化） ---------------- */
routes.length = 0
let preparedOptions = null
const preparedCtx = makeCtx({
  services: {
    llm: {
      stream() {
        throw new Error('有 prepareCall 时不应直连 stream')
      },
      async prepareCall(request) {
        return {
          config: { provider: request.provider, model: request.model, temperature: 0.2, maxTokens: 900 },
          stream(options) {
            preparedOptions = options
            return (async function* gen() {
              yield { type: 'text-delta', index: 0, text: 'prepared ok' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      },
    },
  },
})
apply(preparedCtx.ctx, {})
const preparedRes = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
check('prepareCall 路径成功', preparedRes.status === 200 && preparedRes.json().data.text === 'prepared ok', preparedRes.status + ' ' + preparedRes.payload.slice(0, 160))
check('沿用适配器物化的默认值', Boolean(preparedOptions) && preparedOptions.temperature === 0.2 && preparedOptions.maxTokens === 900, JSON.stringify({ temperature: preparedOptions?.temperature, maxTokens: preparedOptions?.maxTokens }))
const preparedUser = preparedOptions?.messages?.[0]?.content?.[0]?.text ?? ''
check(
  'system 与 messages 覆盖在 config 之上',
  typeof preparedOptions?.system === 'string' &&
    preparedOptions.system.includes('Prompt Engineering Expert') &&
    preparedUser.includes('USER INPUT:\nhi') &&
    preparedUser.includes('ENHANCEMENT REQUIREMENTS'),
  preparedUser.slice(0, 80),
)

routes.length = 0
const badAdapter = makeCtx({
  services: {
    llm: {
      stream() {
        throw new Error('unused')
      },
      async prepareCall() {
        const error = new Error('no adapter for provider')
        error.code = 'NO_ADAPTER'
        throw error
      },
    },
  },
})
apply(badAdapter.ctx, {})
const badAdapterRes = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
check('适配器缺失返回 503 与 NO_ADAPTER', badAdapterRes.status === 503 && badAdapterRes.json().error.code === 'NO_ADAPTER', badAdapterRes.status + ' ' + badAdapterRes.payload.slice(0, 200))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
