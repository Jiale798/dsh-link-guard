// dsh-link-guard — Client half.
//
// 输入框下方一颗「链接」胶囊：平时不出现，只在体检发现异常时显形。
// 点开是面板：哪个 profile 的哪个插件坏了、能不能修、修完该做什么。
window.__ModuleLoader__.load({
  id: '@local/dsh-link-guard',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const POLL_MS = 15000

    const CSS = `
.lg-pill{display:inline-flex;align-items:center;gap:5px;height:24px;max-width:40vw;padding:0 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-state-warn-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden}
@media (hover:hover){.lg-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.lg-pill:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.lg-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.lg-svg{flex:none;opacity:.9}
.lg-panel{position:fixed;z-index:2147483000;box-sizing:border-box;width:400px;max-height:70vh;overflow:auto;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.26);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.lg-head{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:8px}
.lg-badge{margin-left:auto;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}
.lg-group{margin:8px 0 0}
.lg-profile{margin:6px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.lg-row{padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin-bottom:4px}
.lg-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.lg-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px}
.lg-actions{display:flex;gap:6px;margin-top:6px}
.lg-btn{flex:1;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
@media (hover:hover){.lg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.lg-btn[data-primary=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}
.lg-btn:disabled{opacity:.5;cursor:default}
.lg-note{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px}
.lg-ok{margin:10px 0;color:var(--dsw-alias-label-secondary);text-align:center}
`

    function useState_(sessionId) {
      const [data, setData] = useState(null)
      const load = useCallback(async () => {
        try {
          const res = await fetch('/dsh-link-guard/state', { cache: 'no-store' })
          setData(await res.json())
        } catch {
          setData((prev) => (prev && prev.ok ? { ...prev, stale: true } : prev))
        }
      }, [])
      useEffect(() => {
        let alive = true
        let timer = 0
        const tick = async () => {
          await load()
          if (alive) timer = setTimeout(() => { void tick() }, POLL_MS)
        }
        void tick()
        return () => { alive = false; clearTimeout(timer) }
      }, [load, sessionId])
      return [data, load]
    }

    const LINK_ICON = h('svg', { className: 'lg-svg', width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true },
      h('path', {
        d: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
      }))

    function Panel({ data, rect, panelRef, onReload }) {
      const [note, setNote] = useState('')
      const [busy, setBusy] = useState('')
      const left = Math.min(Math.max(8, rect.left), Math.max(8, (window.innerWidth || 1280) - 408))
      const style = { left: `${String(left)}px`, bottom: `${String((window.innerHeight || 800) - rect.top + 8)}px` }

      const check = async () => {
        setBusy('check')
        setNote('正在体检…')
        try {
          const res = await fetch('/dsh-link-guard/check')
          const json = await res.json()
          setNote(json.broken === 0 ? '全部正常' : `发现 ${json.broken} 个异常`)
          await onReload()
        } catch (error) {
          setNote(`体检失败：${String(error.message ?? error)}`)
        } finally {
          setBusy('')
        }
      }

      const fix = async (profile, name) => {
        setBusy(`${profile}/${name}`)
        setNote('正在修复…')
        try {
          const url = `/dsh-link-guard/fix?profile=${encodeURIComponent(profile)}&name=${encodeURIComponent(name)}`
          const res = await fetch(url)
          const json = await res.json()
          setNote(json.message ?? (json.ok ? '已修复' : '修复失败'))
          await onReload()
        } catch (error) {
          setNote(`修复失败：${String(error.message ?? error)}`)
        } finally {
          setBusy('')
        }
      }

      const groups = (data.profiles || []).filter((group) => group.broken > 0 || group.error)

      return h('div', { ref: panelRef, className: 'lg-panel', role: 'dialog', 'aria-label': '插件链接体检', style },
        h('div', { className: 'lg-head' },
          LINK_ICON,
          h('span', null, '插件链接体检'),
          h('span', { className: 'lg-badge' }, `${String(data.broken)} / ${String(data.total)}`)),

        groups.length === 0
          ? h('div', { className: 'lg-ok' }, `全部正常 · ${data.checkedText}`)
          : h('div', { className: 'lg-group' }, groups.map((group) => h('div', { key: group.profile },
            h('div', { className: 'lg-profile' }, group.dir ?? group.profile),
            group.error
              ? h('div', { className: 'lg-row' }, h('div', { className: 'lg-name' }, '!'), h('div', { className: 'lg-meta' }, group.error))
              : group.rows.filter((row) => row.status !== 'ok').map((row) => h('div', { key: row.name, className: 'lg-row' },
                h('div', { className: 'lg-name' }, row.name),
                h('div', { className: 'lg-meta' },
                  `${row.statusLabel}${row.path ? ` · ${row.path}` : ''}`),
                row.suggestion ? h('div', { className: 'lg-meta' }, `→ ${row.suggestion}`) : null,
                row.suggestion
                  ? h('div', { className: 'lg-actions' },
                    h('button', {
                      type: 'button',
                      className: 'lg-btn',
                      'data-primary': true,
                      disabled: busy === `${group.profile}/${row.name}`,
                      onClick: () => { void fix(group.profile, row.name) },
                    }, '修复到这个路径'))
                  : null))))),

        h('div', { className: 'lg-actions' },
          h('button', { type: 'button', className: 'lg-btn', disabled: busy === 'check', onClick: () => { void check() } },
            busy === 'check' ? '体检中…' : '重新体检')),

        h('div', { className: 'lg-note' },
          note || `上次体检 ${data.checkedText} · 耗时 ${String(data.durationMs)} ms · ${data.scope}`,
          h('div', { style: { marginTop: '4px' } },
            '修好后到插件页把该插件关一次再开，loader 才会重新装配。')))
    }

    function LinkGuardPill(props) {
      const [data, reload] = useState_(props.sessionId)
      const [open, setOpen] = useState(false)
      const [rect, setRect] = useState(null)
      const pillRef = useRef(null)
      const panelRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          if (pillRef.current) setRect(pillRef.current.getBoundingClientRect())
        }
        const onDown = (event) => {
          const target = event.target
          if (panelRef.current && panelRef.current.contains(target)) return
          if (pillRef.current && pillRef.current.contains(target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        measure()
        document.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('resize', measure)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('resize', measure)
        }
      }, [open])

      // 只在有异常或体检本身失败时才出现——正常时完全不占位置。
      if (!data || data.ok !== true) return null
      if (data.broken === 0 && !data.error) return null

      // 输入框右边那排很挤（实测只有约 5 个字宽）：正文只给「N 条异常」这种最短形式，
      // 完整清单放 title 与面板里，避免被省略号吃掉关键信息。
      const text = data.error ? '链接检查失败' : `${String(data.broken)} 条异常`
      const detail = data.error
        ? `链接体检出错：${data.error}`
        : `${String(data.broken)} 个插件链接异常（共 ${String(data.total)} 条）：\n` +
          (data.profiles || [])
            .flatMap((group) => group.rows.filter((row) => row.status !== 'ok').map((row) => `· ${group.profile} / ${row.name} — ${row.statusLabel}`))
            .join('\n')
      const pill = h('button', {
        ref: pillRef,
        type: 'button',
        className: 'lg-pill',
        'data-composer-stat': 'dsh-link-guard',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': detail,
        title: detail,
        onClick: () => {
          if (pillRef.current) setRect(pillRef.current.getBoundingClientRect())
          setOpen(!open)
        },
      }, LINK_ICON, h('span', { className: 'lg-text' }, text))

      const panel = open && rect
        ? createPortal(h(Panel, { data, rect, panelRef, onReload: reload }), document.body)
        : null
      return h(React.Fragment, null, pill, panel)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-link-guard'
          style.dataset.pluginCss = 'dsh-link-guard/pill.css'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-link-guard: styles')

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-link-guard',
          order: 4,
          inject: (sessionId) => ({ sessionId }),
        }, LinkGuardPill))
      },
    }
  },
})
