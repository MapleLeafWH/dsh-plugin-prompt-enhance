/**
 * Client 半冒烟：client.js 是浏览器脚本（window.__ModuleLoader__ + 注入的 require），
 * 这里用一个最小 React 垫片把它跑起来，驱动组件函数本身，覆盖状态机：
 *   初始 -> 点击增强（POST 草稿）-> 写入增强结果 -> 再点击还原原文；
 * 以及空草稿禁用、失败时给出可读错误。
 *
 * 不装 jsdom、不渲染 DOM：只验证「点击 -> 公开 action」这条链。
 */
import { readFileSync } from 'node:fs'

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

/* ---------------- 环境垫片 ---------------- */
let loaded = null
const styleEls = []
const fakeDocument = {
  createElement() {
    const el = { textContent: '', removed: false, setAttribute() {}, remove() { el.removed = true } }
    styleEls.push(el)
    return el
  },
  head: { appendChild() {} },
}

/* 最小 hooks 实现：state 存在闭包数组里，render 前重置索引，set 后由测试手动重渲染。 */
let hookIndex = 0
const hookStates = []
let pendingEffects = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value
    }
    return [hookStates[index], set]
  },
  useEffect(effect) {
    hookIndex += 1
    pendingEffects.push(effect)
  },
  useRef(initial) {
    const index = hookIndex++
    if (!(index in hookStates)) hookStates[index] = { current: initial }
    return hookStates[index]
  },
}

const fakeWindow = {
  __ModuleLoader__: { load(definition) { loaded = definition } },
  listeners: [],
  addEventListener(type, handler, capture) { this.listeners.push({ type, handler, capture }) },
  removeEventListener(type, handler) {
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.handler === handler))
  },
}

/* ---------------- 载入插件脚本 ---------------- */
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const run = new Function('window', 'document', 'fetch', 'console', source)
run(fakeWindow, fakeDocument, globalThis.fetch, console)

check('脚本调用了 __ModuleLoader__.load', Boolean(loaded && typeof loaded.factory === 'function'), JSON.stringify(loaded && Object.keys(loaded)))
const module_ = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
check('导出 inject = slots + locale', Array.isArray(module_.inject) && module_.inject.includes('slots') && module_.inject.includes('locale'), JSON.stringify(module_.inject))
check('导出 apply 函数', typeof module_.apply === 'function')

/* ---------------- 假 ctx：捕获 slot 注册 ---------------- */
let registeredSlot = null
let registeredComponent = null
let panelRegistration = null
const registrations = []
let dictionary = null
const fakeCtx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(namespace, dict) {
      dictionary = { namespace, dict }
    },
    bind() {
      return (key, message) => {
        const table = dictionary && dictionary.dict && dictionary.dict.en
        const raw = (table && table[key]) || key
        return message === undefined ? raw : raw.replace('{message}', message)
      }
    },
  },
  slots: {
    inject(name, callback) {
      registeredSlot = name
      return callback()
    },
    register(options, component) {
      registeredSlot = options
      registrations.push({ options, component })
      if (options && options.name === 'conversation.input.right') registeredComponent = component
      if (options && options.name === 'plugins.bundle.config') panelRegistration = { options, component }
      return () => {}
    },
  },
}
module_.apply(fakeCtx)

const buttonRegistration = registrations.find((entry) => entry.options && entry.options.name === 'conversation.input.right')

check('注册到 conversation.input.right', Boolean(buttonRegistration) && buttonRegistration.options.id === 'prompt-enhance', JSON.stringify(buttonRegistration && buttonRegistration.options))
check('注册项声明了 locale', Boolean(buttonRegistration) && buttonRegistration.options.locale === 'prompt-enhance', JSON.stringify(buttonRegistration && buttonRegistration.options))
check('语言包已注册', Boolean(dictionary) && dictionary.namespace === 'prompt-enhance' && Boolean(dictionary.dict.zh && dictionary.dict.en))
check('注入了样式', styleEls.length === 1 && styleEls[0].textContent.includes('.pe-btn'))
check('注入了配置面板样式', styleEls.length === 1 && styleEls[0].textContent.includes('.pe-panel'))
check('注册到插件详情页配置插槽', Boolean(panelRegistration) && panelRegistration.options.key === 'dsh-plugin-prompt-enhance', JSON.stringify(panelRegistration && panelRegistration.options))

/* ---------------- 渲染驱动 ---------------- */
const store = { draft: '帮我把登录页改成深色' }
const calls = { setDraft: [], persistDraft: 0, fetch: [] }
const props = {
  useInput: (selector) => selector(store),
  inputActions: {
    setDraft(text) {
      calls.setDraft.push(text)
      store.draft = text
    },
    persistDraft() {
      calls.persistDraft += 1
    },
  },
  t: fakeCtx.locale.bind(),
}

let pendingCleanups = []

function render() {
  // 模拟重渲染前的 effect 清理：不清理的话 keydown 监听会一层层叠加，
  // 测试就会打到旧闭包（拿错的 original）。
  for (const cleanup of pendingCleanups) cleanup()
  pendingCleanups = []
  hookIndex = 0
  pendingEffects = []
  const tree = registeredComponent(props)
  for (const effect of pendingEffects) {
    const dispose = effect()
    if (typeof dispose === 'function') pendingCleanups.push(dispose)
  }
  return tree
}

const fetchQueue = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.fetch.push({ url, init })
  const next = fetchQueue.shift() || { ok: true, status: 200, body: { ok: true, data: { text: '增强后的提示词' } } }
  if (next.pending) {
    return await new Promise((resolve, reject) => {
      const signal = init && init.signal
      if (signal) {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }
    })
  }
  return {
    ok: next.ok !== false,
    status: next.status || 200,
    text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
  }
}
// component 内部用的是全局 fetch，这里替换后重新 require 不会重新绑定，
// 因此在载入阶段传入的就是 globalThis.fetch 的引用——改为传入包装函数即可。
const originalRunFetch = realFetch

/* 由于脚本里闭包引用的是注入的 fetch 参数，这里重新载入一次以指向新 mock。 */
let loaded2 = null
const fakeWindow2 = {
  __ModuleLoader__: { load(definition) { loaded2 = definition } },
  listeners: [],
  addEventListener(type, handler, capture) { this.listeners.push({ type, handler, capture }) },
  removeEventListener(type, handler) {
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.handler === handler))
  },
}
new Function('window', 'document', 'fetch', 'console', source)(fakeWindow2, fakeDocument, globalThis.fetch, console)
const module2 = loaded2.factory((id) => (id === 'react' ? React : null))
module2.apply(fakeCtx)
registeredComponent = registeredComponent

let tree = render()
check('初始按钮可用且有标题', tree && tree.props && tree.props.disabled === false && tree.props.title === 'Enhance prompt', tree && JSON.stringify({ disabled: tree.props.disabled, title: tree.props.title, className: tree.props.className }))
check('按钮带 pe-btn 类', tree.props.className === 'pe-btn')

await tree.props.onClick()
check('点击后向 Host 发 POST', calls.fetch.length === 1 && calls.fetch[0].url === '/prompt-enhance/enhance' && calls.fetch[0].init.method === 'POST', JSON.stringify(calls.fetch.map((c) => c.url + ' ' + c.init?.method)))
check('请求体带草稿', calls.fetch.length === 1 && JSON.parse(calls.fetch[0].init.body).text === '帮我把登录页改成深色')
check('增强结果写回草稿', calls.setDraft.length === 1 && calls.setDraft[0] === '增强后的提示词', JSON.stringify(calls.setDraft))
check('写回后持久化草稿', calls.persistDraft === 1, String(calls.persistDraft))

tree = render()
check('增强后按钮变成还原态', tree.props.title === 'Revert to original', JSON.stringify(tree.props.title))

await tree.props.onClick()
check('再点击还原原文', calls.setDraft.length === 2 && calls.setDraft[1] === '帮我把登录页改成深色', JSON.stringify(calls.setDraft))
tree = render()
check('还原后按钮回到增强态', tree.props.title === 'Enhance prompt', JSON.stringify(tree.props.title))

/* 撤销快捷键：增强态下 Cmd+Z 应回到增强前，并把图标切回 ✨ */
store.draft = '再增强一次'
tree = render()
await tree.props.onClick()
check('第二次增强写回', store.draft === '增强后的提示词', store.draft)
tree = render()
check('挂上了 keydown 监听', fakeWindow2.listeners.some((entry) => entry.type === 'keydown'), String(fakeWindow2.listeners.length))
const undoListener = fakeWindow2.listeners.find((entry) => entry.type === 'keydown')
const undoEvent = {
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  key: 'z',
  target: { tagName: 'TEXTAREA', isContentEditable: false },
  prevented: false,
  preventDefault() { undoEvent.prevented = true },
  stopPropagation() {},
}
undoListener.handler(undoEvent)
check('Cmd+Z 被拦截', undoEvent.prevented === true)
check('Cmd+Z 回到增强前原文', store.draft === '再增强一次', store.draft)
check('Cmd+Z 后持久化草稿', calls.persistDraft >= 3, String(calls.persistDraft))
tree = render()
check('撤销后图标切回增强态', tree.props.title === 'Enhance prompt', JSON.stringify(tree.props.title))

/* 用户手动改字：撤销点失效，按钮回到增强态 */
store.draft = '再增强一次'
tree = render()
await tree.props.onClick()
tree = render()
store.draft = '用户自己改的内容'
tree = render()
tree = render()
check('手改后撤销点失效', tree.props.title === 'Enhance prompt', JSON.stringify(tree.props.title))

/* 空草稿：WorkBuddy 是整个按钮不渲染（不是禁用） */
store.draft = ''
tree = render()
check('空草稿时按钮不渲染', tree === null, JSON.stringify(tree && { title: tree.props.title }))

/* 失败路径：保留原文、给出可读错误 */
store.draft = '写个脚本'
fetchQueue.push({ ok: false, status: 502, body: { ok: false, error: { message: '模型炸了' } } })
tree = render()
const beforeFail = calls.setDraft.length
await tree.props.onClick()
check('失败时不覆盖草稿', calls.setDraft.length === beforeFail && store.draft === '写个脚本', JSON.stringify({ setDraft: calls.setDraft, draft: store.draft }))
tree = render()
check('失败时按钮标题给出原因', typeof tree.props.title === 'string' && tree.props.title.includes('模型炸了'), JSON.stringify(tree.props.title))

/* loading 态可点击取消（对齐 WorkBuddy 的 onCancel） */
store.draft = '写个脚本'
fetchQueue.push({ pending: true })
tree = render()
const pendingRun = tree.props.onClick()
tree = render()
check('loading 态图标/标题为增强中', tree.props.title === 'Enhancing…', JSON.stringify(tree.props.title))
check('loading 态可点击（用于取消）', tree.props.disabled === false, JSON.stringify(tree.props.disabled))
const beforeCancel = calls.setDraft.length
tree.props.onClick()
await pendingRun
tree = render()
check('取消后静默回到增强态', tree.props.title === 'Enhance prompt' && calls.setDraft.length === beforeCancel, JSON.stringify({ title: tree.props.title, setDraft: calls.setDraft }))

/* ---------------- 插件详情页配置面板 ---------------- */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  out.push(node)
  if (node.props && node.props.children !== undefined) walk(node.props.children, out)
  return out
}

const textOf = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props && node.props.children)
}

const allText = (tree) => textOf(tree)
const findAll = (tree, predicate) => walk(tree).filter((node) => typeof node.type === 'string' && predicate(node))

const panelSnapshot = (overrides = {}) => ({
  entryId: 'prompt-enhance',
  config: {
    enabled: true,
    provider: '',
    model: '',
    timeoutMs: 300000,
    maxTokens: null,
    temperature: null,
    priceInputPerM: 0,
    priceOutputPerM: 0,
    currency: 'CNY',
    systemPrompt: 'SYS-DEFAULT',
    userTemplate: 'USER {input}',
    ...(overrides.config || {}),
  },
  defaults: {
    enabled: true,
    provider: '',
    model: '',
    timeoutMs: 300000,
    maxTokens: null,
    temperature: null,
    priceInputPerM: 0,
    priceOutputPerM: 0,
    currency: 'CNY',
    systemPrompt: '',
    userTemplate: '',
  },
  templates: { system: 'SYS-DEFAULT', user: 'USER {input}' },
  runtime: { provider: 'deepseek-account', model: 'deepseek-flash', source: 'agentDefaultModel' },
  stats: {
    calls: 3,
    ok: 2,
    failed: 1,
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 0,
    cost: 0.0123,
    last: { at: Date.now(), durationMs: 900, ok: true, provider: 'deepseek-account', model: 'deepseek-flash', error: null },
  },
  canWrite: overrides.canWrite === undefined ? true : overrides.canWrite,
  patchPath: '/Users/x/.dsh-beta/profiles/desktop/cordis.patch.yml',
})

function resetHooks() {
  hookStates.length = 0
  hookIndex = 0
  pendingEffects = []
  pendingCleanups = []
}

/** 把函数组件就地展开成宿主元素树：假 React 的 h() 只建 vnode，不执行组件函数。 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  const props = { ...node.props }
  if (props.children !== undefined) props.children = expand(props.children)
  return { type: node.type, props }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 面板首次渲染会发一个 GET；这里跑三轮「渲染 -> effect -> 让出宏任务」，把异步状态收敛到位。 */
async function renderPanel(props = { view: 'page' }) {
  let tree = null
  for (let round = 0; round < 3; round += 1) {
    hookIndex = 0
    pendingEffects = []
    tree = expand(panelRegistration.component(props))
    for (const effect of pendingEffects) await effect()
    await tick()
  }
  return tree
}

calls.fetch.length = 0
resetHooks()
fetchQueue.push({ body: { ok: true, data: panelSnapshot() } })
hookIndex = 0
pendingEffects = []
const loadingTree = expand(panelRegistration.component({ view: 'page' }))
check('面板首屏是骨架屏', Boolean(loadingTree) && loadingTree.props['aria-busy'] === 'true', JSON.stringify(loadingTree && loadingTree.props))

const readyTree = await renderPanel()
check(
  '面板拉到快照后渲染',
  Boolean(readyTree) && readyTree.props['data-plugin-config-panel'] === 'dsh-plugin-prompt-enhance',
  JSON.stringify(readyTree && readyTree.props),
)
check('面板请求 GET /prompt-enhance/settings', calls.fetch.length >= 1 && calls.fetch[0].url === '/prompt-enhance/settings', JSON.stringify(calls.fetch.map((entry) => entry.url)))
const readyText = allText(readyTree)
check('运行状态展示启用与默认模型来源', readyText.includes('Enabled') && readyText.includes('agent default'), readyText.slice(0, 200))
check('运行状态展示累计费用与调用次数', readyText.includes('¥0.0123') && readyText.includes('Calls') && readyText.includes('3'), readyText.slice(0, 300))
check('展示当前生效模型', readyText.includes('deepseek-account / deepseek-flash'), readyText.slice(0, 240))
check('展示 profile patch 写入位置', readyText.includes('cordis.patch.yml'), readyText.slice(0, 320))

const modelInput = findAll(readyTree, (node) => node.type === 'input' && node.props.placeholder === 'deepseek-flash')[0]
check('参数区带 model 输入框', Boolean(modelInput) && modelInput.props.value === '', JSON.stringify(modelInput && modelInput.props))
modelInput.props.onChange({ target: { value: 'deepseek-pro' } })
const dirtyTree = await renderPanel()
const dirtyText = allText(dirtyTree)
check('改动后提示未保存', dirtyText.includes('Unsaved changes'), dirtyText.slice(0, 200))
const saveButton = findAll(dirtyTree, (node) => node.type === 'button' && textOf(node).includes('Save'))[0]
check('保存按钮在改动后可用', Boolean(saveButton) && saveButton.props.disabled === false, JSON.stringify(saveButton && saveButton.props.disabled))

calls.fetch.length = 0
fetchQueue.push({ body: { ok: true, data: { saved: true, appliesAt: 'loader' } } })
await saveButton.props.onClick()
const savedTree = await renderPanel()
const savedText = allText(savedTree)
const putCall = calls.fetch.find((entry) => entry.init && entry.init.method === 'PUT')
check('保存走 PUT /prompt-enhance/settings', Boolean(putCall) && putCall.url === '/prompt-enhance/settings', JSON.stringify(calls.fetch.map((entry) => entry.url)))
check('保存载荷带上修改后的 model', Boolean(putCall) && JSON.parse(putCall.init.body).config.model === 'deepseek-pro', putCall && putCall.init.body)
check('保存成功给出提示', savedText.includes('Saved; the plugin hot-reloads right away.'), savedText.slice(0, 200))
check('保存后表单不再处于未保存态', !savedText.includes('Unsaved changes'), savedText.slice(0, 200))

// 保存失败：错误信息展示 + 对应字段描红
resetHooks()
fetchQueue.push({ body: { ok: true, data: panelSnapshot() } })
let failTree = await renderPanel()
const modelInput2 = findAll(failTree, (node) => node.type === 'input' && node.props.placeholder === 'deepseek-flash')[0]
modelInput2.props.onChange({ target: { value: 'bad-model' } })
failTree = await renderPanel()
const saveButton2 = findAll(failTree, (node) => node.type === 'button' && textOf(node).includes('Save'))[0]
fetchQueue.push({ ok: false, status: 400, body: { ok: false, error: { message: 'model 必须是字符串', field: 'model' } } })
await saveButton2.props.onClick()
failTree = await renderPanel()
const failText = allText(failTree)
check('保存失败展示服务端错误', failText.includes('model 必须是字符串'), failText.slice(0, 240))
const invalidField = findAll(failTree, (node) => node.type === 'label' && node.props['data-invalid'] === 'true')[0]
check('失败字段描红', Boolean(invalidField), JSON.stringify(invalidField && invalidField.props))

// 无权限：只读 + 说明；保存按钮禁用
resetHooks()
fetchQueue.push({ body: { ok: true, data: panelSnapshot({ canWrite: false }) } })
const readOnlyTree = await renderPanel()
const readOnlyText = allText(readOnlyTree)
check('无权限时解释原因', readOnlyText.includes('configEditor'), readOnlyText.slice(0, 240))
const readOnlySave = findAll(readOnlyTree, (node) => node.type === 'button' && textOf(node).includes('Save'))[0]
check('无权限时保存禁用', Boolean(readOnlySave) && readOnlySave.props.disabled === true, JSON.stringify(readOnlySave && readOnlySave.props.disabled))

// 加载失败：错误 + 重试
resetHooks()
fetchQueue.push({ ok: false, status: 500, body: { ok: false, error: { message: '读取炸了' } } })
const errorTree = await renderPanel()
const errorText = allText(errorTree)
check('加载失败展示错误与重试', errorText.includes('读取炸了') && errorText.includes('Retry'), errorText.slice(0, 240))
const retryButton = findAll(errorTree, (node) => node.type === 'button')[0]
fetchQueue.push({ body: { ok: true, data: panelSnapshot() } })
await retryButton.props.onClick()
const retriedTree = await renderPanel()
check('重试后回到正常面板', Boolean(retriedTree) && retriedTree.props['data-plugin-config-panel'] === 'dsh-plugin-prompt-enhance', JSON.stringify(retriedTree && retriedTree.props))

// 一键试跑：POST 增强并展示结果
resetHooks()
fetchQueue.push({ body: { ok: true, data: panelSnapshot() } })
let trialTree = await renderPanel()
const trialTextarea = findAll(trialTree, (node) => node.type === 'textarea' && node.props.placeholder === 'Type a draft, e.g. how do I implement this feature?')[0]
check('有试跑输入框', Boolean(trialTextarea), JSON.stringify(trialTextarea && trialTextarea.props.placeholder))
trialTextarea.props.onChange({ target: { value: '这个功能怎么实现？' } })
trialTree = await renderPanel()
const runButton = findAll(trialTree, (node) => node.type === 'button' && textOf(node).includes('Run'))[0]
fetchQueue.push({ body: { ok: true, data: { text: '试跑结果', cost: 0.0002, currency: 'CNY', durationMs: 1234, usage: { inputTokens: 10, outputTokens: 20 } } } })
await runButton.props.onClick()
trialTree = await renderPanel()
const trialText = allText(trialTree)
check('试跑结果展示增强文本', trialText.includes('试跑结果'), trialText.slice(0, 240))
check('试跑结果展示用量与费用', trialText.includes('input 10') && trialText.includes('¥0.000200'), trialText.slice(0, 320))

globalThis.fetch = realFetch
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
