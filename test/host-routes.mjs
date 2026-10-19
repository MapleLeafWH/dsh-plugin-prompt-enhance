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

/* ---------------- 8. 配置页：读快照 / 写 profile patch ---------------- */
function makeEditor(current = {}) {
  const state = { stored: undefined, edits: 0 }
  const editor = {
    documentPath: '/tmp/fake-profile/cordis.patch.yml',
    entries() {
      return [{ options: { id: 'prompt-enhance', name: 'dsh-plugin-prompt-enhance', config: current } }]
    },
    async edit(entry, change) {
      state.edits += 1
      state.stored = change({ ...current }, {})
    },
  }
  return { editor, state }
}

routes.length = 0
const editorKit = makeEditor({ provider: '', model: '', timeoutMs: 300000 })
const settingsCtx = makeCtx({ services: { configEditor: editorKit.editor } })
apply(settingsCtx.ctx, {})
const settingsRes = await call(routes[0].handler, { method: 'GET', url: '/prompt-enhance/settings' })
const settings = settingsRes.json().data
check('GET settings 返回 200 且可写', settingsRes.status === 200 && settings.canWrite === true, settingsRes.status + ' ' + settingsRes.payload.slice(0, 160))
check(
  'GET settings 带回默认模板原文（供「恢复默认」）',
  typeof settings.templates?.system === 'string' &&
    settings.templates.system.includes('Prompt Engineering Expert') &&
    settings.templates.user.includes('{input}'),
  JSON.stringify(Object.keys(settings.templates ?? {})),
)
check(
  'GET settings 给出默认值与运行模型',
  settings.defaults?.timeoutMs === 300000 &&
    settings.defaults?.enabled === true &&
    settings.runtime?.provider === 'deepseek-account' &&
    settings.runtime?.source === 'agentDefaultModel',
  JSON.stringify({ defaults: settings.defaults, runtime: settings.runtime }),
)

const saveRes = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({
    config: {
      enabled: false,
      provider: '  p1  ',
      model: 'm1',
      timeoutMs: 5000,
      maxTokens: 100,
      temperature: null,
      userTemplate: 'Q: {input}',
      priceInputPerM: 2,
      priceOutputPerM: 8,
    },
  }),
})
const saveBody = saveRes.json()
const stored = editorKit.state.stored
check('PUT settings 调用 configEditor.edit', saveRes.status === 200 && saveBody.data?.saved === true && editorKit.state.edits === 1, saveRes.status + ' ' + saveRes.payload.slice(0, 160))
check('保存值会 trim provider', stored?.provider === 'p1' && stored?.model === 'm1', JSON.stringify(stored))
check('与默认值相同的项不写入 patch（temperature=null 被清掉）', stored !== undefined && !Object.hasOwn(stored, 'temperature'), JSON.stringify(stored))
check(
  '显式改动的项写进 patch',
  stored?.enabled === false && stored?.timeoutMs === 5000 && stored?.maxTokens === 100 && stored?.userTemplate === 'Q: {input}',
  JSON.stringify(stored),
)

const builtinTemplates = settingsRes.json().data.templates
editorKit.state.stored = undefined
const sameTemplateSave = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { systemPrompt: builtinTemplates.system, userTemplate: builtinTemplates.user } }),
})
const sameTemplateStored = editorKit.state.stored
check(
  '逐字相同的内置模板不算覆盖（不写进 patch）',
  sameTemplateSave.status === 200 &&
    sameTemplateStored !== undefined &&
    !Object.hasOwn(sameTemplateStored, 'systemPrompt') &&
    !Object.hasOwn(sameTemplateStored, 'userTemplate'),
  JSON.stringify({ status: sameTemplateSave.status, stored: sameTemplateStored }),
)

const customTemplateSave = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { userTemplate: 'CUSTOM {input}' } }),
})
check(
  '自定义模板会写进 patch',
  customTemplateSave.status === 200 && editorKit.state.stored?.userTemplate === 'CUSTOM {input}',
  JSON.stringify(editorKit.state.stored),
)

const invalidField = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { nonsense: 1 } }),
})
check('未知配置项返回 400', invalidField.status === 400 && invalidField.json().error.field === 'nonsense', invalidField.status + ' ' + invalidField.payload.slice(0, 160))

const invalidTimeout = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { timeoutMs: 10 } }),
})
check('timeoutMs 越界返回 400', invalidTimeout.status === 400 && invalidTimeout.json().error.field === 'timeoutMs', invalidTimeout.status + ' ' + invalidTimeout.payload.slice(0, 160))

const invalidTemplate = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { userTemplate: '没有占位符' } }),
})
check('user 模板缺 {input} 返回 400', invalidTemplate.status === 400 && invalidTemplate.json().error.field === 'userTemplate', invalidTemplate.status + ' ' + invalidTemplate.payload.slice(0, 160))

const invalidCurrency = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { currency: 'EUR' } }),
})
check('不支持的币种返回 400', invalidCurrency.status === 400 && invalidCurrency.json().error.field === 'currency', invalidCurrency.status + ' ' + invalidCurrency.payload.slice(0, 160))

routes.length = 0
const noEditorCtx = makeCtx()
apply(noEditorCtx.ctx, {})
const noEditorRead = await call(routes[0].handler, { method: 'GET', url: '/prompt-enhance/settings' })
check('没有 configEditor 时只读（canWrite=false）', noEditorRead.status === 200 && noEditorRead.json().data.canWrite === false, noEditorRead.status + ' ' + noEditorRead.payload.slice(0, 160))
const noEditorSave = await call(routes[0].handler, {
  method: 'PUT',
  url: '/prompt-enhance/settings',
  body: JSON.stringify({ config: { provider: 'p' } }),
})
check('没有 configEditor 时保存返回 503', noEditorSave.status === 503 && noEditorSave.json().error.code === 'NO_EDITOR', noEditorSave.status + ' ' + noEditorSave.payload.slice(0, 160))

/* ---------------- 9. 关闭开关 / 自定义模板生效 ---------------- */
routes.length = 0
const disabledCtx = makeCtx()
apply(disabledCtx.ctx, { enabled: false })
const disabledRes = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
check('enabled=false 时拒绝增强（409）', disabledRes.status === 409 && disabledRes.json().error.code === 'DISABLED', disabledRes.status + ' ' + disabledRes.payload.slice(0, 160))

routes.length = 0
const overrideCtx = makeCtx()
apply(overrideCtx.ctx, { systemPrompt: 'CUSTOM SYSTEM', userTemplate: 'Q: {input}' })
await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
const overrideOptions = overrideCtx.calls.options
check(
  '自定义 system / user 模板覆盖默认值',
  overrideOptions?.system === 'CUSTOM SYSTEM' && overrideOptions?.messages?.[0]?.content?.[0]?.text === 'Q: hi',
  JSON.stringify({ system: overrideOptions?.system, user: overrideOptions?.messages?.[0]?.content?.[0]?.text }),
)

/* ---------------- 10. 用量与费用统计 ---------------- */
routes.length = 0
const usageCtx = makeCtx({
  llmStream: async function* stream() {
    yield { type: 'text-delta', index: 0, text: '带用量' }
    yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, totalTokens: 1500 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})
apply(usageCtx.ctx, { priceInputPerM: 2, priceOutputPerM: 8 })
const usageRes = await call(routes[0].handler, {
  method: 'POST',
  url: '/prompt-enhance/enhance',
  body: JSON.stringify({ text: 'hi' }),
})
const usageBody = usageRes.json().data
check(
  '响应带回 token 用量',
  usageBody?.usage?.inputTokens === 1000 && usageBody?.usage?.outputTokens === 500,
  JSON.stringify(usageBody?.usage),
)
check(
  '按配置单价估算费用（1000/1M*2 + 500/1M*8）',
  Math.abs((usageBody?.cost ?? 0) - 0.006) < 1e-9 && usageBody?.currency === 'CNY',
  JSON.stringify({ cost: usageBody?.cost, currency: usageBody?.currency }),
)
const statsRes = await call(routes[0].handler, { method: 'GET', url: '/prompt-enhance/settings' })
const statsBody = statsRes.json().data.stats
check(
  '累计统计包含本次调用',
  statsBody?.calls >= 1 && statsBody?.ok >= 1 && statsBody?.inputTokens >= 1000 && statsBody?.outputTokens >= 500,
  JSON.stringify(statsBody),
)
check(
  '统计里保留最近一次调用摘要',
  statsBody?.last?.ok === true && statsBody?.last?.provider === 'deepseek-account',
  JSON.stringify(statsBody?.last),
)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)