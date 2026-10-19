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
 * 设计上刻意零依赖：profile 里的本地插件经 pnpm link 安装后，裸包名
 * （@deepseek-ai/*）解析不到 profile 的依赖树，因此这里只依赖宿主注入的
 * ctx.llm / ctx.webServer，不静态 import 任何第三方包。
 *
 * 唯一例外是费用估算：为了和 dsh-cost-meter 的价目表、峰谷档位、汇率口径完全一致，
 * 插件在运行时按 profile 目录动态载入它的 lib/pricing.js（纯函数模块），载入失败就
 * 退回配置里的兜底单价——装了 cost-meter 就有真实估价，没装也不会崩。
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROUTE_PREFIX = '/prompt-enhance'
const ROUTE_APPLY = '/prompt-enhance/enhance'
const MAX_BODY_BYTES = 256 * 1024
const MAX_DRAFT_CHARS = 20_000
/** WorkBuddy 侧 sidecar 请求超时（3e5ms）对齐。 */
const DEFAULT_TIMEOUT_MS = 300_000

/** 本插件在 profile 组合里的 Loader 条目 id（cordis.patch.yml 的 insert.id）。 */
const ENTRY_ID = 'prompt-enhance'
/** 模板类配置的上限，防止把整本手册塞进 patch。 */
const MAX_TEMPLATE_CHARS = 20_000

/**
 * 配置默认值。「空对象即全部默认」：保存时与默认值相同的键会被清掉，
 * 于是「恢复默认」等价于把那一项删掉，profile patch 里不会留冗余行。
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  provider: '',
  model: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTokens: null,
  temperature: null,
  priceInputPerM: 0,
  priceOutputPerM: 0,
  currency: 'CNY',
  systemPrompt: '',
  userTemplate: '',
})

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

/** 数字字段：非法/越界一律当「没配」，回落到默认值。 */
function numberInRange(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

/** 把任意（可能残缺、可能被手改坏的）config 归一成下发给运行时的有效配置。 */
function effectiveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (key, max) => (typeof source[key] === 'string' ? source[key].trim().slice(0, max) : '')
  return {
    enabled: source.enabled === undefined ? DEFAULTS.enabled : source.enabled !== false,
    provider: text('provider', 200),
    model: text('model', 200),
    timeoutMs: numberInRange(source.timeoutMs, 1000, 600000) ?? DEFAULTS.timeoutMs,
    maxTokens: numberInRange(source.maxTokens, 1, 200_000),
    temperature: numberInRange(source.temperature, 0, 2),
    priceInputPerM: numberInRange(source.priceInputPerM, 0, 100_000) ?? 0,
    priceOutputPerM: numberInRange(source.priceOutputPerM, 0, 100_000) ?? 0,
    currency: source.currency === 'USD' ? 'USD' : 'CNY',
    systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : '',
    userTemplate: typeof source.userTemplate === 'string' ? source.userTemplate : '',
  }
}

const systemPromptFor = (config) => (config.systemPrompt.trim() === '' ? SYSTEM_PROMPT : config.systemPrompt)

/** user 模板必须保留 {input} 占位符，否则草稿会被吞掉，回落到默认模板。 */
const userTemplateFor = (config) =>
  config.userTemplate.trim() === '' || !config.userTemplate.includes('{input}') ? USER_TEMPLATE : config.userTemplate

function userPromptFor(draft, config) {
  return userTemplateFor(config).replace('{input}', draft)
}

/**
 * 进程内调用统计。插件配置保存后 Loader 会重新 apply，但模块实例被复用，
 * 所以这里的累计值不会因为改一次配置就清零。
 */
const stats = {
  calls: 0,
  ok: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  /** 按 dsh-cost-meter 价目表估算的累计美元成本（本插件的调用不入它的账本）。 */
  costUsd: 0,
  /** 没装 cost-meter 时按兜底单价估的累计金额，币种见配置。 */
  costManual: 0,
  last: null,
}

/** 兜底口径：完全按用户在配置页填的单价算（货币/百万 token）。 */
function manualCostOf(config, usage) {
  const input = Number(usage?.inputTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  const value = (input / 1e6) * config.priceInputPerM + (output / 1e6) * config.priceOutputPerM
  return Number.isFinite(value) && value > 0 ? value : 0
}

// ── 费用估算：借用 dsh-cost-meter 的价格表与计价引擎 ─────────────────────────

/**
 * cost-meter 把账本与配置整体持久化在 `$DSH_HOME/storages/cost-meter/ledger.json`，
 * 其中 config.prices / priceOverrides / 峰谷与汇率设置就是它界面用的同一份数据。
 * 直接读文件比调它的 getLocalState()（会顺带刷新余额、可能阻塞十几秒）更轻，
 * 读不到再退回服务接口。
 */
const PRICING_TTL_MS = 60_000
const pricingCache = {
  engine: null,
  engineAt: 0,
  engineFailedAt: 0,
  config: null,
  configAt: 0,
}
/** 测试注入点：替换掉「动态载入 cost-meter」这条路径。 */
let pricingContextForTest = null

export function __setPricingContextForTest(context) {
  pricingContextForTest = context === undefined ? null : context
}

export function __resetPricingCacheForTest() {
  pricingCache.engine = null
  pricingCache.engineAt = 0
  pricingCache.engineFailedAt = 0
  pricingCache.config = null
  pricingCache.configAt = 0
}

function profileOf(scope) {
  const profile = peek(scope, 'profileContext')
  return profile !== null && typeof profile === 'object' ? profile : {}
}

/** DSH_HOME：优先用 profileContext 的 home，退而由 profiles/<name> 反推。 */
function homeOf(scope) {
  const profile = profileOf(scope)
  if (typeof profile.home === 'string' && profile.home !== '') return profile.home
  if (typeof profile.dir === 'string' && profile.dir !== '') return dirname(dirname(profile.dir))
  return ''
}

/** 已注册的模型路由（就是设置页「模型」里那批 provider），供配置页下拉候选。 */
async function providerList(scope) {
  const llm = peek(scope, 'llm')
  if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return []
  try {
    const list = await llm.listProviders()
    if (!Array.isArray(list)) return []
    const out = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id : ''
      if (id === '') continue
      out.push({ id, name: typeof item.name === 'string' && item.name !== '' ? item.name : id })
    }
    return out
  } catch (error) {
    scope.logger?.warn?.('[prompt-enhance] 读取模型路由失败：' + String(error?.message ?? error))
    return []
  }
}

/** 某个 provider 下适配器自报的模型列表，供 model 输入框下拉候选。 */
async function modelList(scope, provider) {
  const llm = peek(scope, 'llm')
  if (llm === null || llm === undefined || typeof llm.listModels !== 'function') {
    return { error: '宿主没有 llm.listModels，无法列出候选模型' }
  }
  try {
    const list = await llm.listModels(provider)
    if (!Array.isArray(list)) return { models: [] }
    const models = []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const id = typeof item.id === 'string' ? item.id : ''
      if (id === '') continue
      models.push({
        id,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : id,
        description: typeof item.description === 'string' ? item.description : '',
      })
    }
    return { models }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/** 动态载入 cost-meter 的纯函数计价引擎（按 profile 目录解析绝对路径）。 */
async function loadPricingEngine(scope) {
  const now = Date.now()
  if (pricingCache.engine !== null && now - pricingCache.engineAt < PRICING_TTL_MS) return pricingCache.engine
  if (now - pricingCache.engineFailedAt < PRICING_TTL_MS) return null
  const dir = profileOf(scope).dir
  if (typeof dir !== 'string' || dir === '') return null
  try {
    const require = createRequire(join(dir, 'package.json'))
    const packageJson = require.resolve('dsh-cost-meter/package.json')
    const engine = await import(pathToFileURL(join(dirname(packageJson), 'lib', 'pricing.js')).href)
    pricingCache.engine = engine
    pricingCache.engineAt = now
    return engine
  } catch (error) {
    pricingCache.engineFailedAt = now
    scope.logger?.warn?.(
      '[prompt-enhance] 未能载入 dsh-cost-meter 计价引擎，费用将按兜底单价估算：' + String(error?.message ?? error),
    )
    return null
  }
}

/** 读 cost-meter 的生效配置（价目表 + 峰谷 + 汇率/币种）。 */
async function loadCostMeterConfig(scope) {
  const now = Date.now()
  if (pricingCache.config !== null && now - pricingCache.configAt < PRICING_TTL_MS) return pricingCache.config
  const home = homeOf(scope)
  if (home !== '') {
    try {
      const raw = await readFile(join(home, 'storages', 'cost-meter', 'ledger.json'), 'utf8')
      const ledger = JSON.parse(raw)
      const config = ledger !== null && typeof ledger === 'object' ? ledger.config : null
      if (config !== null && typeof config === 'object' && config.prices !== undefined) {
        pricingCache.config = config
        pricingCache.configAt = now
        return config
      }
    } catch {
      // 文件缺失/半写：落到服务接口再试一次。
    }
  }
  const service = peek(scope, 'costMeter')
  if (service === null || service === undefined || typeof service.getLocalState !== 'function') return null
  try {
    const state = await service.getLocalState()
    const config = state !== null && typeof state === 'object' ? state.config : null
    if (config === null || typeof config !== 'object' || config.prices === undefined) return null
    pricingCache.config = config
    pricingCache.configAt = now
    return config
  } catch (error) {
    scope.logger?.warn?.('[prompt-enhance] 读取 dsh-cost-meter 配置失败：' + String(error?.message ?? error))
    return null
  }
}

/** 计价上下文：{ config, engine }；任一不可用就返回 null（走兜底单价）。 */
async function pricingContext(scope) {
  if (pricingContextForTest !== null) return pricingContextForTest
  const [config, engine] = await Promise.all([loadCostMeterConfig(scope), loadPricingEngine(scope)])
  if (config === null || engine === null) return null
  return { config, engine }
}

/** 展示口径：币种/符号/小数位/汇率，与 cost-meter 设置页一致。 */
function displayOf(config) {
  const currency = typeof config?.currency === 'string' && config.currency !== '' ? config.currency : 'CNY'
  const rate = Number(config?.fxRates?.[currency] ?? config?.exchangeRate)
  const decimals = Number(config?.decimals)
  return {
    currency,
    symbol: typeof config?.symbol === 'string' && config.symbol !== '' ? config.symbol : currency === 'USD' ? '$' : '¥',
    decimals: Number.isFinite(decimals) ? Math.max(0, Math.min(10, Math.floor(decimals))) : 4,
    exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
  }
}

/** 本地金额格式化：cost-meter 未加载时用，写法对齐它的 formatMoney。 */
function formatMoney(value, display) {
  const amount = Number(value) * (Number.isFinite(display.exchangeRate) && display.exchangeRate > 0 ? display.exchangeRate : 1)
  const decimals = display.decimals
  let effective = decimals
  if (amount > 0 && amount < 10 ** -decimals) effective = decimals + 2
  const fixed = amount.toFixed(effective)
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return display.symbol + trimmed
}

function peakOf(config, resolved) {
  return {
    enabled: ['deepseek-peak', 'utc-peak'].includes(resolved?.billingMode) && config?.peakEnabled === true,
    effectiveAtMs: Date.parse(config?.peakEffectiveAt ?? ''),
    windows: config?.peakWindows,
    holidays: config?.peakHolidays,
  }
}

function tierOf(engine, entry, atMs, peak) {
  if (typeof engine?.isPeakHour !== 'function') return null
  if (peak.enabled !== true) return null
  return engine.isPeakHour(atMs, peak.effectiveAtMs, peak.windows, peak.holidays) ? 'peak' : 'offPeak'
}

/**
 * 估算一次调用的费用，返回给面板/接口展示的结构。
 * - 装了 cost-meter：provider/model/峰谷/汇率全部走它的口径，`usd` 为入账美元值，
 *   `value` 为按展示币种折算的金额。
 * - 没装：按配置里的兜底单价估（`value` 即展示币种金额）。
 */
async function estimateCost(scope, config, info) {
  const usage = info.usage ?? null
  const manual = manualCostOf(config, usage)
  const context = await pricingContext(scope)
  if (context === null) {
    const display = { currency: config.currency, symbol: config.currency === 'USD' ? '$' : '¥', decimals: 4, exchangeRate: 1 }
    return {
      source: 'manual',
      priced: manual > 0,
      usd: null,
      value: manual,
      currency: config.currency,
      symbol: display.symbol,
      text: manual > 0 ? formatMoney(manual, display) : null,
      reason: '未检测到 dsh-cost-meter，按配置里的兜底单价估算（未填单价时为 0）',
    }
  }
  const { config: costConfig, engine } = context
  const display = displayOf(costConfig)
  const rawProvider = typeof info.provider === 'string' ? info.provider : ''
  const wrapped = typeof engine.isWrapperProviderId === 'function' && engine.isWrapperProviderId(rawProvider)
  const effectiveProvider = wrapped ? engine.wrapperUpstreamProvider(rawProvider) ?? rawProvider : rawProvider
  const resolved = engine.providerPriceEntryFor(effectiveProvider, info.model, costConfig.prices, {
    mode: costConfig.priceMatch === 'exact' ? 'exact' : 'auto',
    overrides: costConfig.priceOverrides,
  })
  if (resolved === null || resolved === undefined || resolved.priced !== true) {
    return {
      source: 'dsh-cost-meter',
      priced: false,
      usd: 0,
      value: 0,
      currency: display.currency,
      symbol: display.symbol,
      text: null,
      reason: 'dsh-cost-meter 价目表里没有 ' + effectiveProvider + ' / ' + info.model + ' 的价格',
    }
  }
  const atMs = Number.isFinite(info.atMs) ? info.atMs : Date.now()
  const peak = peakOf(costConfig, resolved)
  const buckets = {
    input: Number(usage?.inputTokens) || 0,
    output: Number(usage?.outputTokens) || 0,
    cacheRead: Number(usage?.cacheReadTokens) || 0,
    cacheWrite: Number(usage?.cacheWriteTokens) || 0,
    reasoning: Number(usage?.reasoningTokens) || 0,
  }
  const official = engine.costOf(buckets, resolved.entry, atMs, peak)
  const rate = display.exchangeRate
  const usd = engine.usdFromCost(official, resolved.currency, rate)
  const text =
    typeof engine.formatMoney === 'function' ? engine.formatMoney(usd, display) : formatMoney(usd, display)
  return {
    source: 'dsh-cost-meter',
    priced: true,
    usd,
    value: usd * rate,
    currency: display.currency,
    symbol: display.symbol,
    exchangeRate: rate,
    officialCurrency: resolved.currency,
    billingMode: typeof resolved.billingMode === 'string' ? resolved.billingMode : null,
    tier: tierOf(engine, resolved.entry, atMs, peak),
    text,
    provider: effectiveProvider,
    model: info.model,
  }
}

function recordCall(entry) {
  stats.calls += 1
  if (entry.ok === true) stats.ok += 1
  else stats.failed += 1
  if (entry.usage) {
    stats.inputTokens += Number(entry.usage.inputTokens) || 0
    stats.outputTokens += Number(entry.usage.outputTokens) || 0
    stats.cacheReadTokens += Number(entry.usage.cacheReadTokens) || 0
  }
  const cost = entry.cost
  if (cost !== null && typeof cost === 'object' && cost.priced === true) {
    if (cost.source === 'dsh-cost-meter') stats.costUsd += Number(cost.usd) || 0
    else stats.costManual += Number(cost.value) || 0
  }
  stats.last = entry
}

/** 保存时只接受白名单字段，逐项校验范围和类型。 */
function validateConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: '缺少 config 对象', field: 'config' }
  }
  const out = {}
  const bad = (field, message) => ({ error: message, field })

  for (const [field, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, field)) return bad(field, '未知配置项：' + field)
    switch (field) {
      case 'enabled': {
        if (typeof value !== 'boolean') return bad(field, 'enabled 必须是布尔值')
        out.enabled = value
        break
      }
      case 'provider':
      case 'model': {
        if (typeof value !== 'string') return bad(field, field + ' 必须是字符串')
        if (/[\r\n]/.test(value)) return bad(field, field + ' 不能包含换行')
        if (value.trim().length > 200) return bad(field, field + ' 过长（上限 200 字符）')
        out[field] = value.trim()
        break
      }
      case 'timeoutMs': {
        const n = numberInRange(value, 1000, 600_000)
        if (n === null) return bad(field, 'timeoutMs 必须在 1000–600000 之间')
        out.timeoutMs = n
        break
      }
      case 'maxTokens': {
        if (value === null || value === '') {
          out.maxTokens = null
          break
        }
        const n = numberInRange(value, 1, 200_000)
        if (n === null) return bad(field, 'maxTokens 必须在 1–200000 之间，或留空')
        out.maxTokens = n
        break
      }
      case 'temperature': {
        if (value === null || value === '') {
          out.temperature = null
          break
        }
        const n = numberInRange(value, 0, 2)
        if (n === null) return bad(field, 'temperature 必须在 0–2 之间，或留空')
        out.temperature = n
        break
      }
      case 'priceInputPerM':
      case 'priceOutputPerM': {
        const n = numberInRange(value, 0, 100_000)
        if (n === null) return bad(field, field + ' 必须是 0–100000 之间的数字')
        out[field] = n
        break
      }
      case 'currency': {
        if (value !== 'CNY' && value !== 'USD') return bad(field, 'currency 只能是 CNY 或 USD')
        out.currency = value
        break
      }
      case 'systemPrompt': {
        if (typeof value !== 'string') return bad(field, 'systemPrompt 必须是字符串')
        if (value.length > MAX_TEMPLATE_CHARS) return bad(field, 'system 模板过长（上限 ' + MAX_TEMPLATE_CHARS + ' 字符）')
        out.systemPrompt = value
        break
      }
      case 'userTemplate': {
        if (typeof value !== 'string') return bad(field, 'userTemplate 必须是字符串')
        if (value.length > MAX_TEMPLATE_CHARS) return bad(field, 'user 模板过长（上限 ' + MAX_TEMPLATE_CHARS + ' 字符）')
        if (value.trim() !== '' && !value.includes('{input}')) {
          return bad(field, 'user 模板必须保留 {input} 占位符，否则草稿会丢失')
        }
        out.userTemplate = value
        break
      }
      default:
        return bad(field, '未知配置项：' + field)
    }
  }
  return { value: out }
}

/** 与默认值相同的键不写进 patch，于是「恢复默认」= 删掉该项。 */
function storedConfig(config) {
  const stored = {}
  for (const [field, value] of Object.entries(config)) {
    const fallback = DEFAULTS[field]
    const same =
      value === fallback ||
      (value === null && fallback === null) ||
      (typeof value === 'string' && typeof fallback === 'string' && value === fallback)
    if (!same) stored[field] = value
  }
  return stored
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
  let usage = null
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    // usage 分片在 finish 之前到达，用来统计本次调用的 token（费用估算的依据）。
    if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      usage = chunk.usage
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
  return { text, failure, usage }
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
  const timeoutMs = config.timeoutMs
  // WorkBuddy 的 sidecar 请求不带 temperature/maxTokens（交给网关默认值）。
  // 这里保持同样行为：只有用户在插件配置里显式写了才下发。
  const maxTokens = config.maxTokens === null ? undefined : config.maxTokens
  const temperature = config.temperature === null ? undefined : config.temperature

  /** 配置页读的那份快照：有效配置 + 默认模板原文 + 运行状态 + 累计统计。 */
  /**
   * 费用信息：优先 dsh-cost-meter 的价目表（含峰谷档、汇率、币种），缺装时退回兜底口径。
   * 面板据此显示「累计费用 / 最近一次费用 / 当前生效单价」，避免只给一个 0 让人猜。
   */
  async function pricingSnapshot(target) {
    const lastCost = stats.last !== null && stats.last.cost ? stats.last.cost : null
    const lastText = lastCost !== null && typeof lastCost.text === 'string' ? lastCost.text : null
    const context = await pricingContext(scope)
    if (context === null) {
      const display = { currency: config.currency, symbol: config.currency === 'USD' ? '$' : '¥', decimals: 4, exchangeRate: 1 }
      return {
        available: false,
        source: 'manual',
        display,
        totalsText: formatMoney(stats.costManual, display),
        lastText,
        current: null,
        note: '未检测到 dsh-cost-meter，费用按配置里的兜底单价估算（未填单价时为 0）。',
      }
    }
    const { config: costConfig, engine } = context
    const display = displayOf(costConfig)
    const totalsText =
      typeof engine.formatMoney === 'function' ? engine.formatMoney(stats.costUsd, display) : formatMoney(stats.costUsd, display)
    let current = null
    if (target !== null) {
      const rawProvider = target.provider
      const wrapped = typeof engine.isWrapperProviderId === 'function' && engine.isWrapperProviderId(rawProvider)
      const effectiveProvider = wrapped ? engine.wrapperUpstreamProvider(rawProvider) ?? rawProvider : rawProvider
      const resolved = engine.providerPriceEntryFor(effectiveProvider, target.model, costConfig.prices, {
        mode: costConfig.priceMatch === 'exact' ? 'exact' : 'auto',
        overrides: costConfig.priceOverrides,
      })
      if (resolved !== null && resolved !== undefined && resolved.priced === true) {
        const peak = peakOf(costConfig, resolved)
        const tierPrices =
          typeof engine.tierFor === 'function' ? engine.tierFor(resolved.entry, Date.now(), peak) : resolved.entry
        current = {
          priced: true,
          provider: effectiveProvider,
          model: target.model,
          officialCurrency: resolved.currency,
          billingMode: typeof resolved.billingMode === 'string' ? resolved.billingMode : null,
          tier: tierOf(engine, resolved.entry, Date.now(), peak),
          input: Number(tierPrices?.cacheMiss ?? 0),
          cacheHit: Number(tierPrices?.cacheHit ?? 0),
          output: Number(tierPrices?.output ?? 0),
        }
      } else {
        current = {
          priced: false,
          provider: effectiveProvider,
          model: target.model,
          officialCurrency: display.currency,
          billingMode: null,
          tier: null,
          input: 0,
          cacheHit: 0,
          output: 0,
        }
      }
    }
    return {
      available: true,
      source: 'dsh-cost-meter',
      display,
      totalsText,
      lastText,
      current,
      note:
        '按 dsh-cost-meter 价目表估算（官方价 × 汇率 ' +
        display.exchangeRate +
        ' → ' +
        display.currency +
        '）；本插件的调用不计入它的账本。',
    }
  }

  async function settingsSnapshot() {
    const target = resolveTarget(scope, config)
    const editor = peek(scope, 'configEditor')
    const pricing = await pricingSnapshot(target)
    return {
      entryId: ENTRY_ID,
      // 模板在编辑态展示「生效文本」：没覆盖就是内置原文，用户改回逐字相同即视为未覆盖。
      config: { ...config, systemPrompt: systemPromptFor(config), userTemplate: userTemplateFor(config) },
      defaults: { ...DEFAULTS },
      templates: { system: SYSTEM_PROMPT, user: USER_TEMPLATE },
      runtime: target === null ? null : { provider: target.provider, model: target.model, source: target.source },
      providers: await providerList(scope),
      stats: {
        ...stats,
        last: stats.last === null ? null : { ...stats.last },
      },
      pricing,
      canWrite: Boolean(editor && typeof editor.edit === 'function'),
      patchPath: editor && typeof editor.documentPath === 'string' ? editor.documentPath : null,
    }
  }

  async function handleGetSettings(req, res) {
    const data = await settingsSnapshot()
    sendJson(res, 200, { ok: true, data })
  }

  /** 候选模型：供配置页 model 输入框的 datalist 用；provider 省略时按生效路由取。 */
  async function handleListModels(req, res, url) {
    const wanted = (url.searchParams.get('provider') || '').trim()
    const target = resolveTarget(scope, config)
    const provider = wanted !== '' ? wanted : target === null ? '' : target.provider
    if (provider === '') {
      sendJson(res, 400, { ok: false, error: { message: '需要一个 provider 才能列出候选模型', code: 'NO_PROVIDER' } })
      return
    }
    if (provider.length > 200 || /[\r\n]/.test(provider)) {
      sendJson(res, 400, { ok: false, error: { message: 'provider 不合法', code: 'BAD_PROVIDER' } })
      return
    }
    const result = await modelList(scope, provider)
    if (typeof result.error === 'string') {
      // 候选只是输入辅助：列不出来不算失败，返回空列表并带上原因。
      sendJson(res, 200, { ok: true, data: { provider, models: [], note: result.error } })
      return
    }
    sendJson(res, 200, { ok: true, data: { provider, models: result.models } })
  }

  /**
   * 保存配置：只写当前 profile 的 patch 层（cordis.patch.yml），交给官方
   * configEditor 完成校验、原子写盘和 Loader 协调——它保留 YAML 注释，
   * 写完立即热重载本插件，不需要重启应用。
   */
  async function handleSaveSettings(req, res) {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error), code: 'BAD_BODY' } })
      return
    }
    const validated = validateConfigPatch(body && typeof body === 'object' ? body.config ?? body : null)
    if (validated.error !== undefined) {
      sendJson(res, 400, {
        ok: false,
        error: { message: validated.error, code: 'INVALID_CONFIG', field: validated.field },
      })
      return
    }
    // 与内置模板逐字相同的文本按「未覆盖」处理：这样「恢复默认」等价于删掉该键，
    // profile patch 里不会存一份 2 万字的内置 prompt 副本。
    if (validated.value.systemPrompt !== undefined && validated.value.systemPrompt.trim() === SYSTEM_PROMPT.trim()) {
      validated.value.systemPrompt = ''
    }
    if (validated.value.userTemplate !== undefined && validated.value.userTemplate.trim() === USER_TEMPLATE.trim()) {
      validated.value.userTemplate = ''
    }
    const editor = peek(scope, 'configEditor')
    if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
      sendJson(res, 503, {
        ok: false,
        error: { message: '当前宿主没有 configEditor 服务，无法写入 profile 配置', code: 'NO_EDITOR' },
      })
      return
    }
    const entry = editor.entries().find((row) => row?.options?.id === ENTRY_ID)
    if (!entry) {
      sendJson(res, 503, {
        ok: false,
        error: { message: '找不到 Loader 条目 ' + ENTRY_ID + '，无法写入 profile 配置', code: 'NO_ENTRY' },
      })
      return
    }
    const next = { ...config, ...validated.value }
    try {
      await editor.edit(entry, () => storedConfig(next))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      scope.logger?.warn?.('[prompt-enhance] 保存配置失败：' + message)
      sendJson(res, 409, {
        ok: false,
        error: { message: '写入 profile 配置失败：' + message, code: 'WRITE_FAILED' },
      })
      return
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        saved: true,
        appliesAt: 'loader',
        config: effectiveConfig(next),
      },
    })
  }

  async function handleEnhance(req, res) {
    if (config.enabled === false) {
      sendJson(res, 409, {
        ok: false,
        error: { message: '提示词增强已在插件设置里关闭', code: 'DISABLED' },
      })
      return
    }
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
    const startedAt = Date.now()
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
        recordCall({
          at: startedAt,
          durationMs: Date.now() - startedAt,
          ok: false,
          error: '模型未就绪：' + message,
          provider: target.provider,
          model: target.model,
          usage: null,
          cost: null,
        })
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
      system: systemPromptFor(config),
      messages: [{ role: 'user', content: [{ type: 'text', text: userPromptFor(text, config) }] }],
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
        usage: null,
      }
    } finally {
      clearTimeout(timer)
    }

    const durationMs = Date.now() - startedAt
    const usage = result.usage === null || result.usage === undefined ? null : result.usage
    // 费用口径：优先 dsh-cost-meter 的价目表/峰谷/汇率，缺装时用兜底单价。
    const cost = await estimateCost(scope, config, {
      provider: target.provider,
      model: target.model,
      usage,
      atMs: startedAt,
    })

    if (result.failure !== null) {
      recordCall({
        at: startedAt,
        durationMs,
        ok: false,
        error: result.failure.message,
        provider: target.provider,
        model: target.model,
        usage,
        cost,
      })
      scope.logger?.warn?.('[prompt-enhance] 模型调用失败：' + result.failure.code + ' ' + result.failure.message)
      const timedOut = controller.signal.aborted
      sendJson(res, timedOut ? 504 : 502, {
        ok: false,
        error: {
          message: result.failure.message,
          code: result.failure.code,
          provider: target.provider,
          model: target.model,
          usage,
          cost,
          durationMs,
        },
      })
      return
    }

    const enhanced = unwrapOutput(result.text)
    if (enhanced === '') {
      recordCall({
        at: startedAt,
        durationMs,
        ok: false,
        error: '模型返回了空结果',
        provider: target.provider,
        model: target.model,
        usage,
        cost,
      })
      sendJson(res, 502, { ok: false, error: { message: '模型返回了空结果', usage, cost, durationMs } })
      return
    }
    recordCall({
      at: startedAt,
      durationMs,
      ok: true,
      error: null,
      provider: target.provider,
      model: target.model,
      usage,
      cost,
    })
    sendJson(res, 200, {
      ok: true,
      data: {
        text: enhanced,
        provider: target.provider,
        model: target.model,
        via: target.source,
        usage,
        cost,
        currency: cost.currency,
        durationMs,
      },
    })
  }

  return async function handler(req, res) {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { message: '仅允许 loopback 同源请求' } })
      return
    }
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    const settingsPath = ROUTE_PREFIX + '/settings'
    const modelsPath = ROUTE_PREFIX + '/models'
    try {
      if (req.method === 'POST' && pathname === ROUTE_APPLY) {
        await handleEnhance(req, res)
        return
      }
      if (pathname === settingsPath) {
        if (req.method === 'GET') {
          await handleGetSettings(req, res)
          return
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          await handleSaveSettings(req, res)
          return
        }
        sendJson(res, 405, { ok: false, error: { message: '配置接口只支持 GET/PUT' } })
        return
      }
      if (req.method === 'GET' && pathname === modelsPath) {
        await handleListModels(req, res, url)
        return
      }
      if (req.method === 'GET' && (pathname === ROUTE_PREFIX || pathname === ROUTE_PREFIX + '/')) {
        sendJson(res, 200, {
          ok: true,
          data: { plugin: 'prompt-enhance', routes: [ROUTE_APPLY, ROUTE_PREFIX + '/settings', ROUTE_PREFIX + '/models'] },
        })
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
  owner.logger?.info?.(
    '[prompt-enhance] routes mounted at ' + ROUTE_PREFIX + ' (prompt rev wb-1:1, config ui rev 3)',
  )
  return dispose
}

export const name = 'prompt-enhance'
/** 内置模板导出给测试与外部审计用（配置页的「恢复默认」也读快照里的同一份文本）。 */
export { SYSTEM_PROMPT, USER_TEMPLATE }

export function apply(ctx, config = {}) {
  const resolved = effectiveConfig(config)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'llm'], (scope) => {
      mountRoutes(scope, scope.webServer, resolved)
    })
    return
  }
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[prompt-enhance] 当前组合没有 webServer，增强路由不会挂载')
    return
  }
  mountRoutes(ctx, webServer, resolved)
}
