/**
 * 提示词增强 · Client 半。
 *
 * 在会话输入框右侧的工具条（slot `conversation.input.right`）上加一个 ✨ 按钮：
 *   点一下 -> 把当前草稿交给 Host 的 /prompt-enhance/enhance 路由改写
 *   再点一下 -> 还原成增强前的原文
 *
 * 草稿读写只走公开通道：
 *   - 读：session 作用域注入的 useInput(s => s.draft)
 *   - 写：inputActions.setDraft(text)（内部是 history-merge，Ctrl+Z 不可靠，所以自己存原文做撤销）
 *
 * 注意：这里不 require 任何 @deepseek-ai/* 包（primitives 不对外开放），
 * 只用 react + 内联 SVG/CSS，并靠宿主注入的 ctx.slots / ctx.locale。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-prompt-enhance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'prompt-enhance';
    const ROUTE = '/prompt-enhance/enhance';

    const DICT = {
      zh: {
        'button.title': '增强提示词',
        'button.enhancing': '增强中…',
        'button.revert': '恢复原文',
        'button.empty': '先写点内容再增强',
        'error.failed': '增强失败：{message}',
        'error.network': '增强失败：网络错误',
        'error.timeout': '增强超时，请重试',
        'settings.title': '提示词增强',
        'settings.subtitle': '配置这个插件的模型、参数与提示词，并查看运行状态与费用估算。',
        'settings.loadFailed': '读取配置失败：{message}',
        'settings.retry': '重试',
        'settings.network': '网络错误，请重试',
        'settings.readonly': '当前宿主没有配置写入权限（未挂载 configEditor 服务），以下内容只读。',
        'settings.status': '运行状态',
        'settings.statusEnabled': '已启用',
        'settings.statusDisabled': '已关闭',
        'settings.runtimeModel': '生效模型',
        'settings.runtimeSource.config': '插件配置',
        'settings.runtimeSource.agentDefaultModel': '跟随默认模型',
        'settings.runtimeSource.none': '未解析到模型',
        'settings.patchPath': '写入位置',
        'settings.calls': '调用次数',
        'settings.ok': '成功',
        'settings.failed': '失败',
        'settings.inputTokens': '输入 tokens',
        'settings.outputTokens': '输出 tokens',
        'settings.cost': '估算费用',
        'settings.lastCall': '最近一次',
        'settings.lastNone': '还没有调用记录',
        'settings.params': '生成参数',
        'settings.paramsHint': '留空的项会交给模型适配器的默认值，与 WorkBuddy 的行为一致。',
        'settings.enabled': '启用提示词增强',
        'settings.enabledHint': '关闭后输入框的 ✨ 按钮调用会被拒绝。',
        'settings.provider': 'Provider',
        'settings.providerHint': '与 model 同时填写才会覆盖默认模型。',
        'settings.model': 'Model',
        'settings.timeoutMs': '超时（毫秒）',
        'settings.maxTokens': 'maxTokens',
        'settings.temperature': 'temperature',
        'settings.emptyHint': '留空 = 适配器默认',
        'settings.priceInput': '输入单价（每百万 token）',
        'settings.priceOutput': '输出单价（每百万 token）',
        'settings.currency': '费用币种',
        'settings.templates': '提示词模板',
        'settings.templatesHint': '默认值就是 WorkBuddy 5.8.3 使用的原文；改回逐字一致即视为「未覆盖」。',
        'settings.systemPrompt': 'System Prompt',
        'settings.systemHint': '决定增强的分析流程与红线。',
        'settings.userTemplate': 'User 模板',
        'settings.userHint': '必须保留 {input} 占位符，否则草稿会丢失。',
        'settings.restoreDefault': '恢复默认',
        'settings.test': '一键试跑',
        'settings.testHint': '用已保存的配置真实调用一次模型，验证链路是否通畅。',
        'settings.testPlaceholder': '输入一段草稿，比如：这个功能怎么实现？',
        'settings.testRun': '试跑',
        'settings.testRunning': '试跑中…',
        'settings.testEmpty': '先输入草稿再试跑',
        'settings.testResult': '增强结果',
        'settings.testUsage': '输入 {input} / 输出 {output} tokens · 耗时 {duration} · 估算 {cost}',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '已保存，插件会随即热重载生效。',
        'settings.saveFailed': '保存失败：{message}',
        'settings.unsaved': '有未保存的改动',
        'settings.reset': '撤销改动',
      },
      en: {
        'button.title': 'Enhance prompt',
        'button.enhancing': 'Enhancing…',
        'button.revert': 'Revert to original',
        'button.empty': 'Write something first',
        'error.failed': 'Enhance failed: {message}',
        'error.network': 'Enhance failed: network error',
        'error.timeout': 'Enhance timed out, try again',
        'settings.title': 'Prompt enhance',
        'settings.subtitle': 'Configure the model, parameters and prompts of this plugin, and inspect runtime status and cost estimates.',
        'settings.loadFailed': 'Failed to load settings: {message}',
        'settings.retry': 'Retry',
        'settings.network': 'Network error, try again',
        'settings.readonly': 'This host has no config write permission (configEditor service missing); everything below is read-only.',
        'settings.status': 'Runtime',
        'settings.statusEnabled': 'Enabled',
        'settings.statusDisabled': 'Disabled',
        'settings.runtimeModel': 'Model',
        'settings.runtimeSource.config': 'plugin config',
        'settings.runtimeSource.agentDefaultModel': 'agent default',
        'settings.runtimeSource.none': 'not resolved',
        'settings.patchPath': 'Written to',
        'settings.calls': 'Calls',
        'settings.ok': 'OK',
        'settings.failed': 'Failed',
        'settings.inputTokens': 'Input tokens',
        'settings.outputTokens': 'Output tokens',
        'settings.cost': 'Estimated cost',
        'settings.lastCall': 'Last call',
        'settings.lastNone': 'No calls yet',
        'settings.params': 'Generation parameters',
        'settings.paramsHint': 'Empty values fall back to the adapter defaults, matching WorkBuddy.',
        'settings.enabled': 'Enable prompt enhancement',
        'settings.enabledHint': 'When off, the composer ✨ call is rejected.',
        'settings.provider': 'Provider',
        'settings.providerHint': 'Overrides the default model only when model is filled too.',
        'settings.model': 'Model',
        'settings.timeoutMs': 'Timeout (ms)',
        'settings.maxTokens': 'maxTokens',
        'settings.temperature': 'temperature',
        'settings.emptyHint': 'empty = adapter default',
        'settings.priceInput': 'Input price (per 1M tokens)',
        'settings.priceOutput': 'Output price (per 1M tokens)',
        'settings.currency': 'Currency',
        'settings.templates': 'Prompt templates',
        'settings.templatesHint': 'Defaults are the verbatim WorkBuddy 5.8.3 prompts; text identical to them counts as not overridden.',
        'settings.systemPrompt': 'System prompt',
        'settings.systemHint': 'Drives the analysis process and red lines.',
        'settings.userTemplate': 'User template',
        'settings.userHint': 'Must keep the {input} placeholder or the draft is lost.',
        'settings.restoreDefault': 'Restore default',
        'settings.test': 'Try it',
        'settings.testHint': 'Runs one real model call with the saved config to verify the pipeline.',
        'settings.testPlaceholder': 'Type a draft, e.g. how do I implement this feature?',
        'settings.testRun': 'Run',
        'settings.testRunning': 'Running…',
        'settings.testEmpty': 'Type a draft first',
        'settings.testResult': 'Enhanced prompt',
        'settings.testUsage': 'input {input} / output {output} tokens · {duration} · est. {cost}',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved; the plugin hot-reloads right away.',
        'settings.saveFailed': 'Save failed: {message}',
        'settings.unsaved': 'Unsaved changes',
        'settings.reset': 'Discard changes',
      },
    };

    const CSS = [
      '.pe-btn{width:28px;height:28px;display:grid;place-items:center;border:none;border-radius:999px;',
      'background:var(--dsw-specific-selector);color:var(--dsw-alias-label-primary);cursor:pointer;padding:0;',
      'corner-shape:round;transition:background .15s ease}',
      '.pe-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.pe-btn:disabled{opacity:.45;cursor:default}',
      '.pe-btn[data-busy="true"] svg{animation:pe-spin 1s linear infinite;transform-origin:50% 50%}',
      '.pe-btn[data-revert="true"]{color:var(--dsw-alias-label-secondary, currentColor)}',
      '@keyframes pe-spin{to{transform:rotate(360deg)}}',
      /* ---- 插件详情页配置面板 ---- */
      '.pe-panel{display:flex;flex-direction:column;gap:14px;padding:2px 0 8px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:980px}',
      '.pe-panel-head{display:flex;flex-direction:column;gap:4px}',
      '.pe-panel-title{margin:0;font-size:15px;font-weight:600}',
      '.pe-panel-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pe-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.pe-section-title{margin:0;font-size:13px;font-weight:600}',
      '.pe-section-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pe-status-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pe-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.pe-badge[data-on="true"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.pe-runtime{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pe-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}',
      '.pe-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.pe-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pe-stat-value{font-size:14px;font-weight:600}',
      '.pe-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pe-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}',
      '.pe-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.pe-label{display:flex;align-items:baseline;gap:6px;font-size:12px;font-weight:500}',
      '.pe-hint{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pe-input,.pe-textarea{width:100%;box-sizing:border-box;padding:6px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;outline:none}',
      '.pe-input:focus,.pe-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.pe-input:disabled,.pe-textarea:disabled{opacity:.6;cursor:not-allowed}',
      '.pe-textarea{resize:vertical;min-height:72px;line-height:1.5}',
      '.pe-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.pe-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}',
      '.pe-field[data-invalid="true"] .pe-input,.pe-field[data-invalid="true"] .pe-textarea{border-color:var(--dsw-alias-state-error-primary)}',
      '.pe-row-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
      '.pe-button{font:inherit;font-size:12px;padding:5px 12px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.pe-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.pe-button:disabled{opacity:.5;cursor:not-allowed}',
      '.pe-button-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.pe-banner{padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.pe-banner-error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.pe-banner-ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.pe-result{display:flex;flex-direction:column;gap:6px}',
      '.pe-result-title{font-size:12px;font-weight:600}',
      '.pe-result-body{margin:0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;word-break:break-word;font-size:12px}',
      '.pe-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;position:sticky;bottom:0;padding:10px 0;background:var(--dsw-alias-bg-base)}',
      '.pe-skel{border-radius:8px;background:var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2))}',
      '.pe-skel-title{height:18px;width:180px}',
      '.pe-skel-block{height:96px}',
      '.pe-skel-line{height:14px}',
    ].join('');

    /** 语言包没就绪时退化为英文兜底，保证按钮永远有可读文案。 */
    const fallbackText = (key, message) => {
      const table = DICT.zh;
      const raw = table[key] || key;
      return message === undefined ? raw : raw.replace('{message}', message);
    };

    function SparkleIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }),
        h('path', { d: 'M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z' }),
      );
    }

    function UndoIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M9 7H5V3' }),
        h('path', { d: 'M5.5 7.2A8 8 0 1 1 4.6 15' }),
      );
    }

    async function callEnhance(draft, signal) {
      let response;
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ text: draft }),
          signal,
        });
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        throw new Error(fallbackText('error.network'));
      }
      const raw = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error(raw.slice(0, 200) || 'HTTP ' + response.status);
      }
      if (!response.ok || !payload || payload.ok === false) {
        const message = (payload && payload.error && payload.error.message) || 'HTTP ' + response.status;
        throw new Error(message);
      }
      const text = payload.data && payload.data.text;
      if (typeof text !== 'string' || text.trim() === '') throw new Error(fallbackText('error.failed', 'empty result'));
      return text;
    }

    /**
     * 按钮本体。session 作用域条目会拿到 useInput / inputActions；
     * 这里不假设 sessionId，也不碰 DOM，全部走公开 action。
     */
    function EnhanceButton(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => fallbackText(key);
      const useInput = typeof props.useInput === 'function' ? props.useInput : null;
      const inputActions = props.inputActions || null;

      // 无条件调用：hooks 顺序必须稳定。
      const draftState = useInput ? useInput((state) => state.draft) : '';
      const draft = typeof draftState === 'string' ? draftState : '';

      const [busy, setBusy] = React.useState(false);
      const [original, setOriginal] = React.useState(null);
      const [enhanced, setEnhanced] = React.useState(null);
      const [problem, setProblem] = React.useState('');
      // 请求取消句柄：loading 态点按钮 = 取消（对齐 WorkBuddy 的 onCancel）。
      const abortRef = React.useRef(null);

      const clearRevert = () => {
        setOriginal(null);
        setEnhanced(null);
      };

      // 草稿一旦不再是「我们写回去的那段增强文本」，撤销点就作废：
      // 覆盖发送后清空、用户自己改字、以及用户用别的方式撤销（命令面板/右键等）。
      React.useEffect(() => {
        if (original === null) return;
        if (draft === enhanced) return;
        setOriginal(null);
        setEnhanced(null);
      }, [draft, enhanced, original]);

      // 撤销：DSH 的 inputActions.setDraft 带着 history-merge，Cmd+Z 撤不回去，
      // 所以这里在「增强结果仍然原样在框里」时拦截一次撤销键，自己还原并切回 ✨ 图标。
      React.useEffect(() => {
        if (original === null || enhanced === null) return;
        if (!inputActions || typeof inputActions.setDraft !== 'function') return;
        const onKeyDown = (event) => {
          if (!event.metaKey && !event.ctrlKey) return;
          if (event.altKey || event.shiftKey) return;
          if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'z') return;
          const target = event.target;
          // 只在输入区里拦截，避免抢走页面别处（终端、搜索框）的撤销键。
          const editable =
            Boolean(target) &&
            (target.isContentEditable === true ||
              target.tagName === 'INPUT' ||
              target.tagName === 'TEXTAREA' ||
              (typeof target.closest === 'function' && target.closest('[contenteditable="true"]') !== null));
          if (!editable) return;
          if (draft !== enhanced) return;
          event.preventDefault();
          event.stopPropagation();
          try {
            inputActions.setDraft(original);
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
            clearRevert();
            setProblem('');
          } catch (error) {
            setProblem(error && error.message ? error.message : String(error));
          }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [original, enhanced, draft, inputActions]);

      const canWrite = inputActions && typeof inputActions.setDraft === 'function';
      const reverting = original !== null;
      const empty = draft.trim() === '';
      // WorkBuddy：空输入且没有任何状态时按钮整个不渲染。
      if (!busy && !reverting && problem === '' && empty) return null;
      // loading 态可点击 = 取消（WorkBuddy 的 onCancel），其余情况照常按可用性禁用。
      const disabled = busy ? false : !canWrite || (!reverting && empty);

      const label = busy
        ? t('button.enhancing')
        : reverting
          ? t('button.revert')
          : problem !== ''
            ? t('error.failed').replace('{message}', problem)
            : draft.trim() === ''
              ? t('button.empty')
              : t('button.title');

      const onClick = async () => {
        if (busy) {
          // 取消：WorkerBuddy loading 态点按钮 = onCancel，静默复位、草稿保持增强前原文。
          try {
            abortRef.current?.abort();
          } catch {}
          return;
        }
        if (!canWrite) return;
        if (reverting) {
          try {
            inputActions.setDraft(original);
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
            clearRevert();
            setProblem('');
          } catch (error) {
            setProblem(error && error.message ? error.message : String(error));
          }
          return;
        }
        const before = draft;
        if (before.trim() === '') return;
        setBusy(true);
        setProblem('');
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        try {
          const next = await callEnhance(before, controller ? controller.signal : undefined);
          inputActions.setDraft(next);
          if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
          setEnhanced(next);
          setOriginal(before);
        } catch (error) {
          const aborted = Boolean(error) && error.name === 'AbortError';
          if (!aborted) setProblem(error && error.message ? error.message : String(error));
        } finally {
          abortRef.current = null;
          setBusy(false);
        }
      };

      return h(
        'button',
        {
          type: 'button',
          className: 'pe-btn',
          'data-busy': busy ? 'true' : 'false',
          'data-error': problem !== '' ? 'true' : 'false',
          'data-revert': reverting ? 'true' : 'false',
          'aria-label': label,
          title: label,
          disabled,
          onClick,
        },
        busy ? h(SparkleIcon) : reverting ? h(UndoIcon) : h(SparkleIcon),
      );
    }

    const BUNDLE = 'dsh-plugin-prompt-enhance';
    const SETTINGS_ROUTE = '/prompt-enhance/settings';

    /** 带错误字段的 JSON 请求：把 Host 的 {error:{message,field,code}} 变成可展示的 Error。 */
    async function requestJson(url, init) {
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        throw new Error(fallbackText('settings.network'));
      }
      const raw = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error(raw.slice(0, 200) || 'HTTP ' + response.status);
      }
      if (!response.ok || !payload || payload.ok === false) {
        const detail = (payload && payload.error) || {};
        const failure = new Error(detail.message || 'HTTP ' + response.status);
        failure.field = detail.field;
        failure.code = detail.code;
        throw failure;
      }
      return payload.data;
    }

    const numText = (value) => (value === null || value === undefined ? '' : String(value));

    /** 快照 -> 表单：模板展示生效文本，数字转成可控的字符串。 */
    function formFromSnapshot(data) {
      const config = (data && data.config) || {};
      const templates = (data && data.templates) || {};
      return {
        enabled: config.enabled !== false,
        provider: config.provider || '',
        model: config.model || '',
        timeoutMs: numText(config.timeoutMs),
        maxTokens: numText(config.maxTokens),
        temperature: numText(config.temperature),
        priceInputPerM: numText(config.priceInputPerM),
        priceOutputPerM: numText(config.priceOutputPerM),
        currency: config.currency || 'CNY',
        systemPrompt: config.systemPrompt || templates.system || '',
        userTemplate: config.userTemplate || templates.user || '',
      };
    }

    /** 表单 -> 保存载荷。空串一律按「默认」发 null，交给 Host 与 DEFAULTS 比对后决定写不写。 */
    function formToPatch(form) {
      const numberOrNull = (value) => {
        const text = String(value).trim();
        return text === '' ? null : Number(text);
      };
      return {
        enabled: form.enabled === true,
        provider: String(form.provider).trim(),
        model: String(form.model).trim(),
        timeoutMs: numberOrNull(form.timeoutMs),
        maxTokens: numberOrNull(form.maxTokens),
        temperature: numberOrNull(form.temperature),
        priceInputPerM: numberOrNull(form.priceInputPerM) === null ? 0 : Number(form.priceInputPerM),
        priceOutputPerM: numberOrNull(form.priceOutputPerM) === null ? 0 : Number(form.priceOutputPerM),
        currency: form.currency,
        systemPrompt: String(form.systemPrompt),
        userTemplate: String(form.userTemplate),
      };
    }

    const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' };

    function formatMoney(value, currency) {
      const symbol = CURRENCY_SYMBOL[currency] || '';
      const n = Number(value);
      if (!Number.isFinite(n) || n === 0) return symbol + '0.0000';
      return symbol + n.toFixed(n < 0.01 ? 6 : 4);
    }

    function formatTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
      try {
        return new Date(at).toLocaleString();
      } catch {
        return '—';
      }
    }

    function Skeleton() {
      return h(
        'div',
        { className: 'pe-panel', 'aria-busy': 'true' },
        h('div', { className: 'pe-skel pe-skel-title' }),
        h('div', { className: 'pe-skel pe-skel-block' }),
        h('div', { className: 'pe-skel pe-skel-line' }),
        h('div', { className: 'pe-skel pe-skel-line' }),
        h('div', { className: 'pe-skel pe-skel-block' }),
      );
    }

    function Field(props) {
      return h(
        'label',
        { className: 'pe-field', 'data-invalid': props['data-invalid'] === 'true' ? 'true' : undefined },
        h(
          'span',
          { className: 'pe-label' },
          props.label,
          props.hint ? h('span', { className: 'pe-hint' }, props.hint) : null,
        ),
        props.children,
      );
    }

    function Section(props) {
      return h(
        'section',
        { className: 'pe-section' },
        h('h3', { className: 'pe-section-title' }, props.title),
        props.description ? h('p', { className: 'pe-section-desc' }, props.description) : null,
        props.children,
      );
    }

    function Stat(props) {
      return h(
        'div',
        { className: 'pe-stat' },
        h('span', { className: 'pe-stat-label' }, props.label),
        h('strong', { className: 'pe-stat-value' }, props.value),
      );
    }

    /**
     * 插件详情页里的配置面板（slot `plugins.bundle.config`，key = 包名）。
     * 职责：读快照 -> 展示运行状态与累计统计 -> 编辑参数/模板 -> 保存到 profile patch -> 一键试跑。
     */
    function SettingsPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => fallbackText(key);
      const [phase, setPhase] = React.useState('loading');
      const [snapshot, setSnapshot] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [loadError, setLoadError] = React.useState('');
      const [save, setSave] = React.useState({ busy: false, error: '', field: '', ok: '' });
      const [trial, setTrial] = React.useState({ text: '', busy: false, error: '', result: null, meta: '' });
      const started = React.useRef(false);

      const load = async () => {
        setPhase('loading');
        setLoadError('');
        try {
          const data = await requestJson(SETTINGS_ROUTE, { headers: { accept: 'application/json' } });
          setSnapshot(data);
          setForm(formFromSnapshot(data));
          setPhase('ready');
        } catch (error) {
          setLoadError(error && error.message ? error.message : String(error));
          setPhase('error');
        }
      };

      // 只在首次挂载时拉一次；面板重渲染不能重复请求。
      React.useEffect(() => {
        if (started.current) return;
        started.current = true;
        load();
      }, []);

      if (phase === 'loading') return Skeleton();
      if (phase === 'error') {
        return h(
          'div',
          { className: 'pe-panel' },
          h('div', { className: 'pe-banner pe-banner-error', role: 'alert' }, t('settings.loadFailed').replace('{message}', loadError)),
          h('button', { type: 'button', className: 'pe-button', onClick: load }, t('settings.retry')),
        );
      }
      if (snapshot === null || form === null) return Skeleton();

      const canWrite = snapshot.canWrite === true;
      const patch = formToPatch(form);
      const original = formToPatch(formFromSnapshot(snapshot));
      const dirty = JSON.stringify(patch) !== JSON.stringify(original);
      const errorField = save.field;
      const mark = (field) => (errorField === field ? { 'data-invalid': 'true' } : {});

      const update = (patchValue) => {
        setForm({ ...form, ...patchValue });
        if (save.error !== '' || save.ok !== '') setSave({ busy: false, error: '', field: '', ok: '' });
      };

      const onSave = async () => {
        if (!canWrite || save.busy === true) return;
        setSave({ busy: true, error: '', field: '', ok: '' });
        try {
          await requestJson(SETTINGS_ROUTE, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ config: patch }),
          });
          const next = { ...snapshot, config: { ...snapshot.config, ...patch } };
          setSnapshot(next);
          setForm(formFromSnapshot(next));
          setSave({ busy: false, error: '', field: '', ok: t('settings.saved') });
        } catch (error) {
          setSave({
            busy: false,
            error: error && error.message ? error.message : String(error),
            field: (error && error.field) || '',
            ok: '',
          });
        }
      };

      const onTrial = async () => {
        if (trial.busy === true) return;
        if (trial.text.trim() === '') {
          setTrial({ ...trial, error: t('settings.testEmpty') });
          return;
        }
        setTrial({ ...trial, busy: true, error: '', result: null, meta: '' });
        try {
          const data = await requestJson('/prompt-enhance/enhance', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ text: trial.text }),
          });
          const usage = data.usage || {};
          const meta = t('settings.testUsage')
            .replace('{input}', String(usage.inputTokens ?? 0))
            .replace('{output}', String(usage.outputTokens ?? 0))
            .replace('{duration}', String(data.durationMs ?? 0) + ' ms')
            .replace('{cost}', formatMoney(data.cost, data.currency || form.currency));
          setTrial({ ...trial, busy: false, error: '', result: data.text, meta });
        } catch (error) {
          setTrial({ ...trial, busy: false, error: error && error.message ? error.message : String(error), result: null, meta: '' });
        }
      };

      const stats = snapshot.stats || {};
      const runtime = snapshot.runtime;
      const readOnlyNote =
        canWrite === false
          ? h('div', { className: 'pe-banner', role: 'status' }, t('settings.readonly'))
          : null;

      const statusSection = h(
        Section,
        { title: t('settings.status') },
        h(
          'div',
          { className: 'pe-status-row' },
          h(
            'span',
            { className: 'pe-badge', 'data-on': form.enabled ? 'true' : 'false' },
            form.enabled ? t('settings.statusEnabled') : t('settings.statusDisabled'),
          ),
          h(
            'span',
            { className: 'pe-runtime' },
            t('settings.runtimeModel') +
              '：' +
              (runtime === null
                ? t('settings.runtimeSource.none')
                : runtime.provider + ' / ' + runtime.model + '（' + t('settings.runtimeSource.' + runtime.source) + '）'),
          ),
        ),
        h(
          'div',
          { className: 'pe-stats' },
          h(Stat, { label: t('settings.calls'), value: String(stats.calls ?? 0) }),
          h(Stat, { label: t('settings.ok'), value: String(stats.ok ?? 0) }),
          h(Stat, { label: t('settings.failed'), value: String(stats.failed ?? 0) }),
          h(Stat, { label: t('settings.inputTokens'), value: String(stats.inputTokens ?? 0) }),
          h(Stat, { label: t('settings.outputTokens'), value: String(stats.outputTokens ?? 0) }),
          h(Stat, { label: t('settings.cost'), value: formatMoney(stats.cost, form.currency) }),
        ),
        h(
          'p',
          { className: 'pe-note' },
          stats.last
            ? t('settings.lastCall') +
              '：' +
              formatTime(stats.last.at) +
              ' · ' +
              (stats.last.ok ? t('settings.ok') : t('settings.failed')) +
              ' · ' +
              String(stats.last.durationMs ?? 0) +
              ' ms' +
              (stats.last.error ? ' · ' + stats.last.error : '')
            : t('settings.lastNone'),
        ),
        snapshot.patchPath
          ? h('p', { className: 'pe-note' }, t('settings.patchPath') + '：' + snapshot.patchPath)
          : null,
      );

      const paramsSection = h(
        Section,
        { title: t('settings.params'), description: t('settings.paramsHint') },
        h(
          'div',
          { className: 'pe-grid' },
          h(Field, { label: t('settings.enabled'), hint: t('settings.enabledHint') },
            h('input', {
              type: 'checkbox',
              className: 'pe-check',
              checked: form.enabled,
              disabled: !canWrite,
              onChange: (event) => update({ enabled: event.target.checked }),
            }),
          ),
          h(Field, { label: t('settings.provider'), hint: t('settings.providerHint'), ...mark('provider') },
            h('input', {
              type: 'text',
              className: 'pe-input',
              value: form.provider,
              disabled: !canWrite,
              placeholder: 'deepseek-account',
              onChange: (event) => update({ provider: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.model'), ...mark('model') },
            h('input', {
              type: 'text',
              className: 'pe-input',
              value: form.model,
              disabled: !canWrite,
              placeholder: 'deepseek-flash',
              onChange: (event) => update({ model: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.timeoutMs'), ...mark('timeoutMs') },
            h('input', {
              type: 'number',
              className: 'pe-input',
              value: form.timeoutMs,
              min: 1000,
              max: 600000,
              step: 1000,
              disabled: !canWrite,
              onChange: (event) => update({ timeoutMs: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.maxTokens'), hint: t('settings.emptyHint'), ...mark('maxTokens') },
            h('input', {
              type: 'number',
              className: 'pe-input',
              value: form.maxTokens,
              min: 1,
              disabled: !canWrite,
              placeholder: t('settings.emptyHint'),
              onChange: (event) => update({ maxTokens: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.temperature'), hint: t('settings.emptyHint'), ...mark('temperature') },
            h('input', {
              type: 'number',
              className: 'pe-input',
              value: form.temperature,
              min: 0,
              max: 2,
              step: 0.1,
              disabled: !canWrite,
              placeholder: t('settings.emptyHint'),
              onChange: (event) => update({ temperature: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.priceInput'), ...mark('priceInputPerM') },
            h('input', {
              type: 'number',
              className: 'pe-input',
              value: form.priceInputPerM,
              min: 0,
              step: 0.01,
              disabled: !canWrite,
              onChange: (event) => update({ priceInputPerM: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.priceOutput'), ...mark('priceOutputPerM') },
            h('input', {
              type: 'number',
              className: 'pe-input',
              value: form.priceOutputPerM,
              min: 0,
              step: 0.01,
              disabled: !canWrite,
              onChange: (event) => update({ priceOutputPerM: event.target.value }),
            }),
          ),
          h(Field, { label: t('settings.currency'), ...mark('currency') },
            h(
              'select',
              {
                className: 'pe-input',
                value: form.currency,
                disabled: !canWrite,
                onChange: (event) => update({ currency: event.target.value }),
              },
              h('option', { value: 'CNY' }, 'CNY ¥'),
              h('option', { value: 'USD' }, 'USD $'),
            ),
          ),
        ),
      );

      const templateSection = h(
        Section,
        { title: t('settings.templates'), description: t('settings.templatesHint') },
        h(Field, { label: t('settings.systemPrompt'), hint: t('settings.systemHint'), ...mark('systemPrompt') },
          h('textarea', {
            className: 'pe-textarea pe-mono',
            rows: 8,
            value: form.systemPrompt,
            disabled: !canWrite,
            onChange: (event) => update({ systemPrompt: event.target.value }),
          }),
        ),
        h('div', { className: 'pe-row-actions' },
          h('button', {
            type: 'button',
            className: 'pe-button',
            disabled: !canWrite,
            onClick: () => update({ systemPrompt: snapshot.templates.system }),
          }, t('settings.restoreDefault')),
        ),
        h(Field, { label: t('settings.userTemplate'), hint: t('settings.userHint'), ...mark('userTemplate') },
          h('textarea', {
            className: 'pe-textarea pe-mono',
            rows: 8,
            value: form.userTemplate,
            disabled: !canWrite,
            onChange: (event) => update({ userTemplate: event.target.value }),
          }),
        ),
        h('div', { className: 'pe-row-actions' },
          h('button', {
            type: 'button',
            className: 'pe-button',
            disabled: !canWrite,
            onClick: () => update({ userTemplate: snapshot.templates.user }),
          }, t('settings.restoreDefault')),
        ),
      );

      const trialSection = h(
        Section,
        { title: t('settings.test'), description: t('settings.testHint') },
        h('textarea', {
          className: 'pe-textarea',
          rows: 3,
          value: trial.text,
          placeholder: t('settings.testPlaceholder'),
          'data-invalid': trial.error !== '' ? 'true' : 'false',
          onChange: (event) => setTrial({ ...trial, text: event.target.value, error: '' }),
        }),
        h('div', { className: 'pe-row-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'pe-button pe-button-primary',
              disabled: trial.busy === true,
              onClick: onTrial,
            },
            trial.busy === true ? t('settings.testRunning') : t('settings.testRun'),
          ),
        ),
        trial.error !== '' ? h('div', { className: 'pe-banner pe-banner-error', role: 'alert' }, trial.error) : null,
        trial.result !== null
          ? h(
              'div',
              { className: 'pe-result' },
              h('div', { className: 'pe-result-title' }, t('settings.testResult')),
              h('pre', { className: 'pe-result-body' }, trial.result),
              h('p', { className: 'pe-note' }, trial.meta),
            )
          : null,
      );

      const saveBar = h(
        'footer',
        { className: 'pe-footer' },
        h(
          'span',
          { className: 'pe-note' },
          save.error !== ''
            ? t('settings.saveFailed').replace('{message}', save.error)
            : save.ok !== ''
              ? save.ok
              : dirty
                ? t('settings.unsaved')
                : '',
        ),
        h(
          'div',
          { className: 'pe-row-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'pe-button',
              disabled: !canWrite || save.busy === true || !dirty,
              onClick: () => setForm(formFromSnapshot(snapshot)),
            },
            t('settings.reset'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pe-button pe-button-primary',
              disabled: !canWrite || save.busy === true || !dirty,
              onClick: onSave,
            },
            save.busy === true ? t('settings.saving') : t('settings.save'),
          ),
        ),
      );

      return h(
        'div',
        { className: 'pe-panel', 'data-plugin-config-panel': BUNDLE },
        h('header', { className: 'pe-panel-head' },
          h('h2', { className: 'pe-panel-title' }, t('settings.title')),
          h('span', { className: 'pe-panel-sub' }, t('settings.subtitle')),
        ),
        readOnlyNote,
        save.error !== '' ? h('div', { className: 'pe-banner pe-banner-error', role: 'alert' }, save.error) : null,
        save.ok !== '' ? h('div', { className: 'pe-banner pe-banner-ok', role: 'status' }, save.ok) : null,
        statusSection,
        paramsSection,
        templateSection,
        trialSection,
        saveBar,
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'prompt-enhance: dictionaries');

      // 详情页面板用 apply 时绑定的 t：keyed 插槽不额外注入 locale 文案函数。
      const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => fallbackText(key);

      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-prompt-enhance', '');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'prompt-enhance: styles');

      // 插槽声明是异步到位的：用 inject 等它、用 effect 管回收，插件停用/热重载时按钮会被摘掉。
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.right',
                id: NS,
                order: 0,
                locale: NS,
              },
              EnhanceButton,
            ),
          ),
        'prompt-enhance: input button',
      );

      // 「插件」面板 -> 已安装插件 -> 详情页里的配置区。keyed 插槽的 key 就是包名，
      // 插件管理页用 ledger.bundles.has(pkg.name) 判断详情页要不要渲染这一块。
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: BUNDLE,
                locale: NS,
              },
              (panelProps) => h(SettingsPanel, { ...(panelProps || {}), t }),
            ),
          ),
        'prompt-enhance: plugin detail config',
      );
    }

    return { inject, apply };
  },
});
