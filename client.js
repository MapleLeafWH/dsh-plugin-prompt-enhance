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
      },
      en: {
        'button.title': 'Enhance prompt',
        'button.enhancing': 'Enhancing…',
        'button.revert': 'Revert to original',
        'button.empty': 'Write something first',
        'error.failed': 'Enhance failed: {message}',
        'error.network': 'Enhance failed: network error',
        'error.timeout': 'Enhance timed out, try again',
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

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'prompt-enhance: dictionaries');

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
    }

    return { inject, apply };
  },
});
