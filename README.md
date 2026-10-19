# dsh-plugin-prompt-enhance · 提示词增强

给 DSH（DeepSeek Harness）的会话输入框加一个 **✨ 增强提示词** 按钮：
点一下，把当前草稿改写成更完整、更可执行的提示词；再点一下，还原成原文。

复刻 WorkBuddy 那个「提示词增强」按钮的交互，但实现完全落在 DSH 自己的插件机制上：
**Host 半**用 `ctx.llm` 调当前 profile 的默认模型，**Client 半**用输入框的公开 action 读写草稿。

---

## 交互

```
输入框草稿 ──[✨ 点击]──> POST /prompt-enhance/enhance ──> ctx.llm（一次性补全）
     ^                                                          │
     │                                      增强文本（只输出提示词本身）
     └──────── inputActions.setDraft(text) ◄───────────────────┘

再点一次（图标变成 ↺）或按 Cmd/Ctrl+Z ──> setDraft(原文)  // 两种撤销都支持
```

- 按钮在 `conversation.input.right`（输入框工具条右侧、模型选择器旁边），28px 圆角，跟随 DSH 主题 token。
- **busy**：图标旋转、按钮禁用；浏览器断开或超时会 abort 掉模型调用。
- **可撤销**：增强成功后按钮切到 ↺「恢复原文」；此时按 **Cmd/Ctrl+Z** 也会回到增强前，图标同步切回 ✨（见下文「撤销」）。
- **失败**：不覆盖草稿，按钮 `title` 直接显示失败原因（无 toast 基础设施，保持轻量）。
- **空草稿时按钮整个不渲染**（与 WorkBuddy 一致：没有内容就没有增强按钮）。
- **loading 态点按钮 = 取消请求**（对齐 WorkBuddy 的 `onCancel`，静默复位、草稿不动）。

## 架构

| 半 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | `webServer.register({kind:'prefix', path:'/prompt-enhance'})`；校验同源 → 读草稿 → `ctx.llm.prepareCall` + `stream` → 拼接 `text-delta` → 返回 `{text, provider, model}` |
| Client | `client.js` | 注册 slot 条目；`useInput(s => s.draft)` 读、`inputActions.setDraft()` / `persistDraft()` 写；纯 `fetch` 调 Host 路由 |

设计约束（都已照做）：

- Host 侧 **零 import**：本地 link 安装的插件解析不到 profile 的 `@deepseek-ai/*` 依赖树，所以只依赖注入的 `ctx.llm` / `ctx.webServer`，`text-delta` 自己拼。
- Client 侧 **只 require('react')**：不碰 `@deepseek-ai/*` 的 primitives，图标与样式内联，通过 `ctx.locale.register()` 拿 `t`。
- 路由**自带同源校验**（loopback host + `sec-fetch-site` + `Origin`），非 loopback / 跨站一律 403 —— 和 agent-db-ui 一致。
- 热重载撞到旧路由只 `logger.warn`，不让插件挂掉；插槽与路由都挂在 `ctx.effect` 里，停用即回收。

## 提示词策略（1:1 对齐 WorkBuddy 5.8.3）

Host 侧的 `SYSTEM_PROMPT` / `USER_TEMPLATE` 直接取自 WorkBuddy 主进程常量 `zn` / `Bn`
（`/Applications/WorkBuddy.app` 的 `app.asar` → `main/server.js`），语义逐字一致：

- **system**：扮演 Prompt Engineering Expert，先分析原提示词（目标、歧义、缺失上下文），
  再按「具体、有上下文、有约束、有输出格式」的原则改写；红线是
  *不索要指南、不索要代码、不擅自指定技术栈、只讲 WHAT 不讲 HOW、不回答问题只扩写问题*；
  语言必须与输入一致；篇幅约 800 字符；**只输出改写后的提示词**。
- **user**：`USER_TEMPLATE.replace('{input}', draft)`，把语言一致性（6 条）、7 条增强要求、
  中/英/混排示例和 BAD/GOOD 反例一起发过去 —— WorkBuddy 就是这么发的，不是只发一句「请增强」。

因此输出是**一段连贯、更具体的提示词**，而不是「目标/背景/问题/约束/假设/输出」这种固定小标题。
Host 仍会在末尾剥掉整段代码围栏与首尾包裹引号（WorkBuddy 只剥引号，围栏是这里的兜底）。

## 撤销

`inputActions.setDraft` 在宿主里是 `history-merge` 的编辑，原生 Cmd+Z 撤不回增强前。
Client 半的处理：

1. 增强成功后记住 `{ original, enhanced }`；
2. 当草稿仍等于 `enhanced`、焦点在输入区时，拦截 **Cmd/Ctrl+Z**，`setDraft(original)` 并清空撤销点
   —— 图标随之切回 ✨，语义与 WorkBuddy 一致；
3. 草稿一旦不再等于 `enhanced`（用户手改、发送清空、用别的方式撤销），撤销点自动失效。

## 与 WorkBuddy 5.8.3 的行为对齐（取证要点）

对 `/Applications/WorkBuddy.app` 的 `app.asar` 做静态切片后，WorkBuddy 的真实行为是：

| 行为 | WorkBuddy | 本插件 |
| --- | --- | --- |
| 结果写回 | 一次性整段替换编辑器内容（Slate 单事务） | 一次性 `setDraft(全文)`（Lexical 单次 update，`history-merge`） |
| Cmd+Z | Slate 原生 undo，一次回到增强前 | 拦截一次 Cmd/Ctrl+Z 自己还原（DSH 的 `setDraft` 被固定成 `history-merge`，原生 undo 不可靠） |
| 图标 | ✨ → 旋转加载 → ↺（次级文字色）→ 内容分歧即回 ✨ | 相同；另有「草稿 != 增强结果」自动作废撤销点 |
| 空输入 | 按钮不渲染 | 相同 |
| loading | 可点 = 取消 | 相同（fetch abort） |
| 失败 | 只改 tooltip，无 toast、内容不动 | 相同 |
| 流式 | 无，单次 request/response | 相同（Host 内是流式聚合，但对 UI 一次性写回） |
| 后处理 | 渲染侧去 ZWSP + trim；主进程削首尾引号；**不处理围栏** | 相同 |

差异仅剩两处，都是有意的：①DSH 没有 Slate 的 `replaceContent`，撤销靠拦截按键而不是原生 undo 栈；
②模型不同（WorkBuddy 用自家 sidecar 模型，这里跟随 profile 默认模型，可通过配置换）。

## 配置

在 bundle 自带的 `cordis.patch.yml` 里，也可在 profile 的 `cordis.patch.yml` 用同 id 覆盖：

```yaml
- id: prompt-enhance
  name: dsh-plugin-prompt-enhance
  config:
    provider: ''        # 留空 = 跟随 agentDefaultModel（本机是 deepseek-account / deepseek-flash）
    model: ''
    # maxTokens / temperature 默认不下发，交给适配器/网关默认值（与 WorkBuddy 一致）
    # maxTokens: 1200
    # temperature: 0.4
    timeoutMs: 300000   # 与 WorkBuddy sidecar 的 3e5ms 超时对齐
```

## 安装

**方式 A · 脚本（推荐，幂等，可回滚）**

```bash
node install.mjs --dry-run   # 先看计划
node install.mjs             # 建软链 + 写 profile package.json + 追加 dsh.profile.bundles
node install.mjs --uninstall # 卸载
```

HMR 有 ~2s 的写稳定延迟；装完 **刷新页面** 就能看到按钮，通常不需要重启。若宿主半没加载，Cmd+Q 完全退出再打开。

注意：**改 Host 半（`index.js`/`cordis.patch.yml`）后必须重启应用**——profile 重组会复用已 import 的模块，改文件不会自动生效（实测 12:14 重组后仍是旧代码）；改 Client 半（`client.js`/locale/icon）刷新页面即可。

**方式 B · Web UI 插件管理页**：安装本地包路径即可（内部就是 `installBundle`：pnpm add + 追加 `dsh.profile.bundles`）。

注意：`dsh plugin --profile desktop add ...` 会被 CLI 主动拒绝（desktop profile 只由 Electron 应用管理）。

## 验证

```bash
node test/host-routes.mjs   # 30 项：路由匹配/403/400/200/502/503、prepareCall、system/user 模板、输出去包裹
node test/client-smoke.mjs  # 26 项：slot 注册、语言包、状态机（增强→点击撤销→Cmd+Z 撤销→手改失效）、失败不覆盖草稿
node --check index.js && node --check client.js

# 装好之后：宿主插件路由在 Desktop 的渲染器门禁之后，普通 curl 会拿到 403（预期）
# 真正可用性以页面里点按钮为准；宿主日志出现 "routes mounted at /prompt-enhance" 即已挂载
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:43120/prompt-enhance
```

两个测试都只用假的 `ctx` / `webServer` / `llm` / `fetch`，不触网、不读写 profile。

## 已知限制

- **撤销靠插件自己拦截**：宿主 `setDraft` 是 `history-merge` 编辑，原生 Cmd+Z 回不到增强前。插件在「草稿==增强文本」时拦截一次 Cmd/Ctrl+Z 自己还原；如果焦点不在输入区，或草稿已被改过，就不拦截，交回宿主。
- `inputActions` 只有 `setDraft`，没有按选区替换；增强会整体替换草稿（附件、引用 chip 不受影响，但 `setDraft` 传的是纯文本）。
- 输入框进入「活动面板」（语音输入展开）时宿主会隐藏整条 standardControls，按钮随之为隐藏 —— 宿主行为，不是 bug。
- 不做流式回填：一次性拿到整段文本再写入，逻辑简单、撤销语义清晰。
- 模型调用失败没有重试（`ctx.llm` 本身不含重试，重试在 agent failed-step 层）；直接报错，用户可再点一次。

## 文件

```
dsh-plugin-prompt-enhance/
├── index.js            # Host：路由 + LLM 调用
├── client.js           # Client：slot 按钮 + 状态机
├── cordis.patch.yml    # bundle 层：插入 prompt-enhance 条目与默认 config
├── package.json        # dsh.bundle.patch / dsh.client 声明
├── install.mjs         # 手动安装/卸载脚本
├── locale/{en,zh}.json # 列表展示用的 meta.title / description
├── icon.svg
└── test/
    ├── host-routes.mjs
    └── client-smoke.mjs
```
