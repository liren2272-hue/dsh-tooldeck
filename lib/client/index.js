/**
 * 工具台设置卡片（客户端）。
 *
 * 绑定到 `plugins.bundle.config` 槽位，出现在「设置 → 插件」里（与 dsh-api-rules 同款）。
 *
 * 扩展性原则（用户核心要求）：卡片不写死任何动作。挂载时从
 * GET /api/dsh-tooldeck/actions 拉「动作清单」，按清单自动渲染按钮；
 * 宿主侧新增一条 action（内置或别处经 ctx.tooldeck.register 注入）卡片零改动即出现。
 *
 * 实现要点（全部经 app.asar + 既有插件取证，勿改）：
 *  - `t` 是函数 `t(key, vars)`，绝不可 `t.xxx`。
 *  - 字典必须扁平「点号字面量 key」：`localeSeat` 只是 `face.bind(ns)` 薄包装，不会展平嵌套。
 *  - 纯 React DOM + 组件级 `<style>`；CSS 只用真实存在的 `--dsw-alias-*` token 并带兜底。
 *  - 深浅色靠 token 自身翻转；主按钮 = button-primary-fill 底 + label-primary-foreground 字。
 *  - 卡片内 GET 的相对 fetch 走页面 baseURI，可耐受反向代理前缀。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-tooldeck',
  factory(require) {
    const name = 'dsh-tooldeck-client'
    const inject = ['slots', 'locale']
    const ReactTop = require('react')

    const zh = {
      'card.title': '工具台',
      'card.subtitle': '把多个运维动作集中到一个面板，点击即可运行。新增功能只需在宿主侧注册一条动作。',
      'card.loading': '加载动作清单中…',
      'card.loadError': '动作清单加载失败：{message}',
      'card.retry': '重试',
      'card.empty': '暂无可用的动作。',
      'card.foot': '动作由 dsh-tooldeck 宿主路由 /api/dsh-tooldeck/run 派发；其它插件可经 ctx.tooldeck 运行时注入。',

      'group.health': 'DSH 健康',
      'group.workspace': '工作区整理',
      'group.general': '其他',

      'run.running': '运行中…',
      'run.done': '完成',
      'run.failed': '失败',

      'result.title': '最近一次结果',
      'result.empty': '还没有运行过动作。',
      'result.ok': '成功',
      'result.error': '出错',
      'result.copy': '复制',
      'result.copied': '已复制',
    }

    const en = {
      'card.title': 'Tool Deck',
      'card.subtitle': 'Run ops actions from one panel. Adding a feature is just registering an action on the host.',
      'card.loading': 'Loading actions…',
      'card.loadError': 'Failed to load actions: {message}',
      'card.retry': 'Retry',
      'card.empty': 'No actions available yet.',
      'card.foot': 'Actions are dispatched by the dsh-tooldeck host route /api/dsh-tooldeck/run; other plugins can inject via ctx.tooldeck at runtime.',

      'group.health': 'DSH Health',
      'group.workspace': 'Workspace Tidying',
      'group.general': 'Other',

      'run.running': 'Running…',
      'run.done': 'Done',
      'run.failed': 'Failed',

      'result.title': 'Last result',
      'result.empty': 'No action has been run yet.',
      'result.ok': 'OK',
      'result.error': 'Error',
      'result.copy': 'Copy',
      'result.copied': 'Copied',
    }

    const STYLE = `
      .td-card { display:flex; flex-direction:column; gap:14px; padding:4px 2px; box-sizing:border-box; }
      .td-sub { font-size:12px; color:var(--dsw-alias-label-tertiary,#6b6b6b); line-height:1.6; margin:-4px 0 2px; }
      .td-list { display:flex; flex-direction:column; gap:10px; }
      /* 大类翻页标签：与 dsh-api-rules 同款 pill tab（token 全部来自该插件实测集合） */
      .td-tabs { display:flex; gap:4px; padding:0 0 12px; overflow-x:auto; scrollbar-width:none; }
      .td-tabs::-webkit-scrollbar { display:none; }
      .td-tab { flex:0 0 auto; display:inline-flex; align-items:center; gap:7px; height:30px; padding:0 12px;
        border:.5px solid transparent; border-radius:999px; background:transparent; font-family:inherit;
        font-size:var(--dsw-font-xs-13-font-size,13px); line-height:1; font-weight:500;
        color:var(--dsw-alias-label-secondary,#5c5c5c); cursor:pointer;
        transition:background 140ms ease,color 140ms ease,border-color 140ms ease; }
      .td-tab:hover { color:var(--dsw-alias-label-primary,CanvasText); background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)); }
      .td-tab[aria-selected="true"] { color:var(--dsw-alias-label-primary,CanvasText); font-weight:600;
        background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.16)); border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.2)); }
      .td-tab:focus-visible { outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6)); outline-offset:1px; }
      .td-tab__count { font-size:11px; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-quaternary,#b5b5b5); }
      .td-pane { display:flex; flex-direction:column; gap:10px; }
      .td-item { display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px;
        padding:12px; border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14)); border-radius:var(--dsw-radius-md,6px);
        background:var(--dsw-alias-settings-card-fill,#fff); }
      .td-meta { flex:1 1 220px; min-width:200px; }
      .td-ico { font-size:18px; line-height:1; }
      .td-name { font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary,CanvasText); }
      .td-desc { font-size:12px; color:var(--dsw-alias-label-tertiary,#6b6b6b); margin-top:3px; line-height:1.5; }
      .td-btn { flex:0 0 auto; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer;
        border-radius:var(--dsw-radius-md,6px); border:1px solid transparent;
        background:var(--dsw-alias-button-primary-fill,#1b1b1c); color:var(--dsw-alias-label-primary-foreground,#fff);
        transition:background .15s ease, opacity .15s ease; }
      .td-btn:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover,#43454a); }
      .td-btn:disabled { opacity:.55; cursor:default; }
      .td-btn.ghost { background:transparent; border-color:var(--dsw-alias-border-l4,rgba(127,127,127,.28));
        color:var(--dsw-alias-label-secondary,#8a8a8a); }
      .td-btn.ghost:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)); color:var(--dsw-alias-label-primary,CanvasText); }
      .td-btn.danger { color:var(--dsw-alias-state-error-primary,#d64545); border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 42%,transparent);
        background:transparent; }
      .td-btn.danger:hover:not(:disabled) { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 12%,transparent); color:var(--dsw-alias-state-error-primary,#d64545); }
      .td-state { font-size:12px; color:var(--dsw-alias-label-secondary,#8a8a8a); }
      .td-state.err { color:var(--dsw-alias-state-error-primary,#d64545); }
      .td-result { margin-top:2px; padding:12px; border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));
        border-radius:var(--dsw-radius-md,6px); background:var(--dsw-alias-settings-card-fill,#fff); }
      .td-result h4 { margin:0 0 8px; font-size:13px; color:var(--dsw-alias-label-primary,CanvasText); }
      .td-result pre { margin:0; white-space:pre-wrap; word-break:break-word; font-size:12px;
        color:var(--dsw-alias-label-secondary,#8a8a8a); max-height:240px; overflow:auto;
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
      .td-result .td-badge { font-size:11px; padding:2px 8px; border-radius:999px; margin-left:8px; vertical-align:middle; }
      .td-result .ok { background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 14%,transparent); color:var(--dsw-alias-state-success-primary,#1a7f37); }
      .td-result .err { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 14%,transparent); color:var(--dsw-alias-state-error-primary,#d64545); }
      .td-foot { font-size:11px; color:var(--dsw-alias-label-tertiary,#6b6b6b); line-height:1.6; }
      .td-err { padding:12px; border:1px solid var(--dsw-alias-state-error-primary,#d64545); border-radius:var(--dsw-radius-md,6px);
        color:var(--dsw-alias-state-error-primary,#d64545); font-size:13px; background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 10%,transparent); }
    `

    function ToolDeckCard({ React, t }) {
      const { useState, useEffect, useCallback } = React
      const [actions, setActions] = useState(null) // null=loading, []=empty
      const [loadError, setLoadError] = useState(null)
      const [busy, setBusy] = useState({}) // id -> bool
      const [states, setStates] = useState({}) // id -> {status:'done'|'failed', text}
      const [result, setResult] = useState(null) // {ok,text,data}
      const [tab, setTab] = useState('') // 当前大类；空=落到第一个

      const load = useCallback(async () => {
        setLoadError(null)
        try {
          const res = await fetch('/api/dsh-tooldeck/actions', { method: 'GET', credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          setActions(Array.isArray(data.actions) ? data.actions : [])
        } catch (error) {
          setActions(null)
          setLoadError(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        load().catch(() => {})
      }, [load])

      const runAction = useCallback(async (actionId) => {
        setBusy((b) => ({ ...b, [actionId]: true }))
        setStates((s) => ({ ...s, [actionId]: undefined }))
        try {
          const res = await fetch('/api/dsh-tooldeck/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: actionId, params: {} }),
            credentials: 'same-origin',
          })
          const data = await res.json().catch(() => ({}))
          const ok = Boolean(data?.ok)
          const text = typeof data?.text === 'string' ? data.text : (ok ? t('run.done') : t('run.failed'))
          setStates((s) => ({ ...s, [actionId]: { status: ok ? 'done' : 'failed', text } }))
          setResult({ ok, text, data: data?.data ?? null })
        } catch (error) {
          const text = String(error?.message ?? error)
          setStates((s) => ({ ...s, [actionId]: { status: 'failed', text } }))
          setResult({ ok: false, text, data: null })
        } finally {
          setBusy((b) => ({ ...b, [actionId]: false }))
        }
      }, [t])

      const copyResult = useCallback(() => {
        if (!result) return
        const text = typeof result.text === 'string' ? result.text : JSON.stringify(result.data, null, 2)
        try {
          navigator.clipboard?.writeText(text).catch(() => {})
        } catch {}
      }, [result])

      // 大类分组：按 group 聚合，保持动作各自的注册顺序；未知分组归入 general。
      // 注意：actions 在 loading/error 阶段可能是 null，这里必须先兜底再遍历。
      const groups = (() => {
        const order = []
        const buckets = new Map()
        const list = Array.isArray(actions) ? actions : []
        for (const action of list) {
          const key = typeof action.group === 'string' && action.group.length > 0 ? action.group : 'general'
          if (!buckets.has(key)) {
            buckets.set(key, [])
            order.push(key)
          }
          buckets.get(key).push(action)
        }
        return order.map((key) => ({ key, items: buckets.get(key) }))
      })()

      // 翻页：当前只渲染选中大类（与 dsh-api-rules 的面板行为一致）。「最近一次结果」跨大类常驻可见。
      const activeGroup = groups.find((g) => g.key === tab) ? tab : (groups[0] && groups[0].key) || ''

      const renderItem = (action) => {
        const isBusy = Boolean(busy[action.id])
        const state = states[action.id]
        const cls = 'td-btn' + (action.danger ? ' danger' : '')
        return React.createElement('div', { className: 'td-item', key: action.id },
          action.icon
            ? React.createElement('span', { className: 'td-ico' }, action.icon)
            : null,
          React.createElement('div', { className: 'td-meta' },
            React.createElement('div', { className: 'td-name' }, action.title),
            React.createElement('div', { className: 'td-desc' }, action.description || ''),
          ),
          React.createElement('button', {
            className: cls,
            disabled: isBusy,
            onClick: () => runAction(action.id),
          }, isBusy ? t('run.running') : action.title),
          state
            ? React.createElement('span', {
                className: 'td-state' + (state.status === 'failed' ? ' err' : ''),
              }, state.status === 'failed' ? t('run.failed') : t('run.done'))
            : null,
        )
      }

      // ── loading / error / empty ──
      if (actions === null && loadError === null) {
        return React.createElement('div', { className: 'td-card' },
          React.createElement('div', { className: 'td-sub' }, t('card.loading')),
        )
      }
      if (loadError !== null) {
        return React.createElement('div', { className: 'td-card' },
          React.createElement('div', { className: 'td-err' }, t('card.loadError', { message: loadError })),
          React.createElement('button', { className: 'td-btn ghost', onClick: load }, t('card.retry')),
        )
      }
      if (Array.isArray(actions) && actions.length === 0) {
        return React.createElement('div', { className: 'td-card' },
          React.createElement('div', { className: 'td-sub' }, t('card.empty')),
        )
      }

      return React.createElement('div', { className: 'td-card' },
        React.createElement('style', null, STYLE),
        React.createElement('div', { className: 'td-sub' }, t('card.subtitle')),
        React.createElement('div', { className: 'td-tabs', role: 'tablist' },
          groups.map((group) =>
            React.createElement('button', {
              key: group.key,
              type: 'button',
              role: 'tab',
              'aria-selected': group.key === activeGroup ? 'true' : 'false',
              className: 'td-tab',
              onClick: () => setTab(group.key),
            },
              t('group.' + group.key),
              React.createElement('span', { className: 'td-tab__count' }, String(group.items.length)),
            ),
          ),
        ),
        React.createElement('div', { className: 'td-pane', role: 'tabpanel' },
          React.createElement('div', { className: 'td-list' },
            ((groups.find((g) => g.key === activeGroup) || { items: [] }).items).map(renderItem),
          ),
        ),
        result
          ? React.createElement('div', { className: 'td-result' },
              React.createElement('h4', null,
                t('result.title'),
                React.createElement('span', {
                  className: 'td-badge ' + (result.ok ? 'ok' : 'err'),
                }, result.ok ? t('result.ok') : t('result.error')),
                React.createElement('button', {
                  className: 'td-btn ghost',
                  style: { marginLeft: 8, padding: '2px 10px', fontSize: 12 },
                  onClick: copyResult,
                }, t('result.copy')),
              ),
              React.createElement('pre', null,
                typeof result.text === 'string' && result.text.length > 0
                  ? result.text
                  : JSON.stringify(result.data, null, 2)),
            )
          : null,
        React.createElement('div', { className: 'td-foot' }, t('card.foot')),
      )
    }

    function apply(ctx) {
      try {
        const namespace = 'settings.dsh-tooldeck'
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-tooldeck: settings copy')
        const t = ctx.locale.bind(namespace)
        const React = require('react')
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: '@local/dsh-tooldeck', locale: namespace },
            () => React.createElement(ToolDeckCard, { React, t }),
          ),
        )
      } catch (error) {
        // 与 dsh-api-rules 一致：暴露挂载失败，便于定位（静默吞掉会让卡片凭空消失且无日志）。
        console.error('[dsh-tooldeck] client apply failed:', error)
      }
    }

    return { apply, inject, name }
  },
})
