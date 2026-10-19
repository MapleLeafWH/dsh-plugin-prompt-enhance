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
      registeredComponent = component
      return () => {}
    },
  },
}
module_.apply(fakeCtx)

check('注册到 conversation.input.right', Boolean(registeredSlot) && registeredSlot.name === 'conversation.input.right' && registeredSlot.id === 'prompt-enhance', JSON.stringify(registeredSlot))
check('注册项声明了 locale', Boolean(registeredSlot) && registeredSlot.locale === 'prompt-enhance', JSON.stringify(registeredSlot))
check('语言包已注册', Boolean(dictionary) && dictionary.namespace === 'prompt-enhance' && Boolean(dictionary.dict.zh && dictionary.dict.en))
check('注入了样式', styleEls.length === 1 && styleEls[0].textContent.includes('.pe-btn'))

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

globalThis.fetch = realFetch
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
