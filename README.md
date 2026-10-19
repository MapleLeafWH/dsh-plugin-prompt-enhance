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
- Host 路由：`POST /prompt-enhance/enhance`（增强）、`GET|PUT /prompt-enhance/settings`（配置快照/保存）、`GET /prompt-enhance/models?provider=`（候选模型）。

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

配置有三层，优先级从低到高：`DEFAULTS`（代码内默认）→ bundle 的 `cordis.patch.yml` → profile 的 `cordis.patch.yml`（配置页写的就是这一层）。

**方式 A · 插件详情页（推荐）**：「插件」→「已安装插件」→ 提示词增强 →「详情」，页面里直接改：

| 分组 | 配置项 | 默认 | 说明 |
| --- | --- | --- | --- |
| 运行状态 | 启用 / 生效模型 / 调用次数 / 成功 / 失败 / tokens / 估算费用 / 写入位置 | — | 只读；统计是进程内累计，重启后清零 |
| 生成参数 | `enabled` | `true` | 关掉后 ✨ 调用返回 409 `DISABLED` |
| | `provider` / `model` | 空 | 可下拉选也可手填；同时填写才覆盖，空 = 跟随 `agentDefaultModel`。provider 候选来自 `ctx.llm.listProviders()`（就是「设置 → 模型」里那批路由），model 候选来自 `ctx.llm.listModels(provider)` |
| | `timeoutMs` | `300000` | 与 WorkBuddy sidecar 的 3e5ms 对齐；范围 1000–600000 |
| | `maxTokens` / `temperature` | 空 | 留空 = 不下发，交给适配器默认（与 WorkBuddy 一致） |
| | `priceInputPerM` / `priceOutputPerM` | `0` | **兜底**单价（货币/百万 token）：只在没装 `dsh-cost-meter` 时用于估算 |
| | `currency` | `CNY` | 兜底估算的币种：`CNY` / `USD` |
| 提示词模板 | `systemPrompt` / `userTemplate` | 内置 WorkBuddy 原文 | 可编辑；`userTemplate` 必须保留 `{input}`；「恢复默认」= 改回内置文本 |
| 一键试跑 | — | — | 用**已保存**的配置真实调一次模型，展示结果、tokens、耗时、估算费用 |

保存走官方 `configEditor` 服务：保留 profile patch 里的注释、原子写盘、写完后 Loader 重新 apply 本插件，不需要重启应用。与默认值相同的项不会写进 patch，「恢复默认」等于把那一项删掉。模板逐字等于内置原文时同样视为未覆盖。

## 费用估算

装没装 `dsh-cost-meter`，费用口径不同，面板会明确标出来源：

| 条件 | 费用来源 | 算法 |
| --- | --- | --- |
| 已装 `dsh-cost-meter` | 它的价目表 | 运行时动态载入它 `lib/pricing.js` 的纯函数：`providerPriceEntryFor` 找价 → `costOf` 按三桶（cacheMiss / cacheHit / output）与峰谷档计价 → `usdFromCost` 折美元 → `formatMoney` 按它的币种/小数位/汇率显示。价目表、峰谷窗口、`priceOverrides`、汇率都直接读它 `storages/cost-meter/ledger.json` 里的配置，所以和它的界面数字同源。 |
| 没装 | 配置里的兜底单价 | `tokens/1M × priceInputPerM` + `tokens/1M × priceOutputPerM`，单价默认 0 时显示 `¥0.0000` 并提示是兜底口径。 |
| 装了但价目表没收录该模型 | 不编造 | 显示「价目表未收录这个模型，费用无法估算」，而不是给 0 假装免费。 |

注意两点：一是本插件的调用是**带外调用**，不会进 `dsh-cost-meter` 的账本，所以面板里的「累计费用」是插件自己按同一套价格算出来的，不是它账本里的数字；二是计价的 provider/model 是这次请求实际用的（包装层会取上游 provider）。

**方式 B · 手改 YAML**。bundle 自带的 `cordis.patch.yml`，或 profile 的 `cordis.patch.yml`（同 id 覆盖）：

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

这是一个**普通包形态的 bundle**（`package.json` 里声明了 `dsh.bundle.patch` 与 `dsh.client`），所以下面三种路径都能装，装完都会自动写进 profile 的 `dsh.profile.bundles`。

**方式 A · 桌面版应用内（推荐）**

「插件」→「已安装插件」→「安装插件」→ 包名或地址填：

```
github:MapleLeafWH/dsh-plugin-prompt-enhance
```

走官方 `plugin_manager` → `installBundle`（`pnpm add` + 登记 bundle + HMR 重组），装完刷新页面就能看到 ✨ 按钮和详情页面板。

**方式 B · 普通 profile（web / tui / headless）**

`dsh plugin` 把参数转发给 profile 目录里的 pnpm，装完同样自动登记 bundle：

```bash
dsh plugin --profile web add github:MapleLeafWH/dsh-plugin-prompt-enhance
dsh --profile web --dump-config | grep prompt-enhance   # → - id: prompt-enhance
```

> 桌面版 profile 名字是 `desktop`，CLI 会直接拒绝：`error: profile "desktop" is managed exclusively by the Electron application`（`@deepseek-ai/dsh/lib/bin.js:36`），所以桌面版走方式 A。

**方式 C · 本地开发（改代码即时生效）**

用目录而不是远端包，pnpm 会建 `link:` 依赖，profile 里读到的是工作区源码：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-plugin-prompt-enhance
```

桌面版没有 CLI 通道，等价的手工操作是 `node install.mjs`（建软链 + 写依赖 + 追加 bundles，幂等、可回滚），`node install.mjs --uninstall` 撤销。

卸载：应用内移除，或 `dsh plugin --profile web remove dsh-plugin-prompt-enhance`。

改 **Host 半**（`index.js` / `cordis.patch.yml`）后必须重启应用——profile 重组会复用已 import 的模块，改文件不会自动生效（实测 12:14 重组后仍是旧代码）；改 **Client 半**（`client.js` / locale / icon）刷新页面即可。

## 验证

```bash
node test/host-routes.mjs   # 71 项：路由/403/参数校验/模板/失败映射/prepareCall、配置读写、模板归一、用量与费用（cost-meter + 兜底）、provider/model 候选
node test/client-smoke.mjs  # 62 项：两个 slot 的注册、按钮状态机与撤销、配置面板（骨架/只读/保存/失败/试跑/费用来源/候选下拉）
node --check index.js && node --check client.js

# 装好之后：宿主插件路由在 Desktop 的渲染器门禁之后，普通 curl 会拿到 403（预期）
# 真正可用性以页面里点按钮为准；宿主日志出现 "routes mounted at /prompt-enhance" 即已挂载
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:43120/prompt-enhance
```

两个测试都只用假的 `ctx` / `webServer` / `llm` / `configEditor` / `fetch`，不触网、不读写 profile。

## 已知限制

- **撤销靠插件自己拦截**：宿主 `setDraft` 是 `history-merge` 编辑，原生 Cmd+Z 回不到增强前。插件在「草稿==增强文本」时拦截一次 Cmd/Ctrl+Z 自己还原；如果焦点不在输入区，或草稿已被改过，就不拦截，交回宿主。
- `inputActions` 只有 `setDraft`，没有按选区替换；增强会整体替换草稿（附件、引用 chip 不受影响，但 `setDraft` 传的是纯文本）。
- 输入框进入「活动面板」（语音输入展开）时宿主会隐藏整条 standardControls，按钮随之为隐藏 —— 宿主行为，不是 bug。
- 不做流式回填：一次性拿到整段文本再写入，逻辑简单、撤销语义清晰。
- 模型调用失败没有重试（`ctx.llm` 本身不含重试，重试在 agent failed-step 层）；直接报错，用户可再点一次。
- **费用是估算**：`ctx.llm` 的 `usage` 只给 token 数，金额按 `dsh-cost-meter` 的价目表算（缺装时按兜底单价）。计价引擎是运行时从 profile 目录动态 import 的，属于对 `dsh-cost-meter` 内部模块（`lib/pricing.js`）的复用；它改了大版本接口时这里会载入失败并自动退回兜底单价，不会影响增强功能本身。
- 统计只在本进程内累计（插件重新 apply 不会清零，但重启应用会）。
- 配置页表格里的「无权限」指宿主没挂 `configEditor` 服务（例如手改 profile 版本较旧）：此时整个面板只读，保存返回 503 `NO_EDITOR`。

## 文件

```
dsh-plugin-prompt-enhance/
├── index.js            # Host：增强路由 + 配置读写 + 候选模型 + LLM 调用/用量/费用统计
├── client.js           # Client：输入框 ✨ 按钮 + 插件详情页配置面板
├── cordis.patch.yml    # bundle 层：插入 prompt-enhance 条目与默认 config
├── package.json        # dsh.bundle.patch / dsh.client 声明
├── install.mjs         # 桌面版手工安装/卸载（desktop profile 没有 CLI 通道）
├── locale/{en,zh}.json # 列表展示用的 meta.title / description
├── icon.svg
└── test/
    ├── host-routes.mjs
    └── client-smoke.mjs
```
