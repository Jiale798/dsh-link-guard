/**
 * dsh-link-guard — Host 侧。
 *
 * 在 DSH 启动时体检所有 profile 里 `link:` 装的插件，把结果推给界面，并提供
 * 复查 / 一键修复 / 搬家预演。
 *
 * 为什么需要：`link:` 插件是指向工作区目录的软链接。目录被移动、改名或删除后，
 * 插件会**静默失效**——list_bundles 仍报 installed/enabled=true，只是 rows[] 少了
 * entryId，loader 里没这一行，界面不报错，功能就是没了。
 *
 * 设计要点：
 *   - 体检只读。启动时延迟 1.2 s 跑一次，之后可手动复查。
 *   - 自动修复只在用户点按时执行，改路径前先备份 profile 的 package.json。
 *   - 修完必须提醒去插件页关一次再开，因为 loader 不会自己重新装配。
 *   - 状态只在内存里，不写自己的持久化文件；重启即重新体检。
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  brokenLines,
  fingerprint,
  listProfiles,
  planMove,
  scanAll,
  STATUS,
} from './link-scan.mjs'

export const name = 'dsh-link-guard'

export const inject = ['sessions']

const DEFAULTS = {
  checkOnBoot: true,
  profiles: 'all',
  searchBudget: 4000,
  logOnBroken: true,
}

function normalize(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const budget = Number.isFinite(raw.searchBudget) && raw.searchBudget > 0
    ? Math.min(50000, Math.floor(raw.searchBudget))
    : DEFAULTS.searchBudget
  return {
    checkOnBoot: raw.checkOnBoot !== false,
    profiles: typeof raw.profiles === 'string' && raw.profiles.trim() !== ''
      ? raw.profiles.trim()
      : DEFAULTS.profiles,
    searchBudget: budget,
    logOnBroken: raw.logOnBroken !== false,
  }
}

function stamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 24 字预算内取第一个放得下的。 */
function pickFit(candidates) {
  for (const candidate of candidates) {
    if ([...candidate].length <= 24) return candidate
  }
  return candidates[candidates.length - 1]
}

const STATE_LABEL = {
  [STATUS.brokenTarget]: '目标目录不存在',
  [STATUS.notLinked]: '未链接',
  [STATUS.emptyPlaceholder]: '空占位',
  [STATUS.incomplete]: '包不完整',
  [STATUS.notDeclared]: '声明了 bundle 但没依赖',
}

const STATE_LABEL_EN = {
  [STATUS.brokenTarget]: 'target missing',
  [STATUS.notLinked]: 'not linked',
  [STATUS.emptyPlaceholder]: 'empty',
  [STATUS.incomplete]: 'incomplete',
  [STATUS.notDeclared]: 'not declared',
}

export function apply(ctx, config) {
  const options = normalize(config)

  /** 最近一次体检结果；at === null 表示还没跑过。 */
  const state = {
    at: null,
    durationMs: 0,
    scans: [],
    error: null,
  }

  const resolveProfiles = () => (options.profiles === 'all'
    ? listProfiles()
    : options.profiles.split(',').map((part) => part.trim()).filter(Boolean))

  const brokenCount = () => state.scans.reduce((sum, scan) => sum + scan.broken, 0)
  const totalCount = () => state.scans.reduce((sum, scan) => sum + scan.rows.length, 0)

  // ── 体检 ──────────────────────────────────────────────────────────────────

  const check = (profiles = resolveProfiles()) => {
    const started = Date.now()
    try {
      const fresh = scanAll({ suggest: true, profiles })
      // 只复检了部分 profile 时，用新结果覆盖这几条，其余保持原样——
      // 否则一次「只查 desktop」会把别的 profile 从状态里抹掉。
      const next = new Map(state.scans.map((scan) => [scan.profile, scan]))
      for (const scan of fresh) next.set(scan.profile, scan)
      // 按 profile 名排序，保证界面顺序稳定。
      state.scans = [...next.values()].sort((a, b) => a.profile.localeCompare(b.profile))
      state.error = null
    } catch (error) {
      state.error = String(error?.message ?? error)
    }
    state.at = Date.now()
    state.durationMs = Date.now() - started

    const broken = brokenCount()
    if (broken > 0) {
      if (options.logOnBroken) {
        ctx.logger?.warn?.(`[dsh-link-guard] ${broken} 个插件链接异常：\n  ${brokenLines(state.scans).join('\n  ')}`)
      }
    } else if (state.error === null) {
      ctx.logger?.info?.(`[dsh-link-guard] 体检通过（${state.scans.length} 个 profile，${state.durationMs} ms）`)
    }
    return state
  }

  // ── 修复 ──────────────────────────────────────────────────────────────────

  /**
   * 把一个坏链改到推断出的新位置并重装依赖。
   * 只处理 broken-target；其余状态不猜，返回需要手工处理。
   * @returns { ok, message, dir? }
   */
  const fixLink = (profileName, pluginName) => {
    const scan = state.scans.find((item) => item.profile === profileName)
    if (!scan) return { ok: false, message: '这个 profile 还没体检过，先复查一次' }
    const row = scan.rows.find((item) => item.name === pluginName)
    if (!row) return { ok: false, message: `找不到插件 ${pluginName}` }
    if (row.status === STATUS.ok) return { ok: true, message: '这个链接本来就是好的' }
    if (row.status !== STATUS.brokenTarget) {
      return { ok: false, message: `状态是「${STATE_LABEL[row.status] ?? row.status}」，不能自动改路径` }
    }
    if (!row.suggestion) {
      return { ok: false, message: '没找到目标目录被移到了哪里，请手工指定路径' }
    }

    const manifestPath = `${scan.dir}/package.json`
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      return { ok: false, message: `读不了 profile 的 package.json：${String(error?.message ?? error)}` }
    }

    try {
      writeFileSync(`${manifestPath}.bak-linkguard-${Date.now()}`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, message: `备份失败，已放弃修改：${String(error?.message ?? error)}` }
    }

    manifest.dependencies[pluginName] = `link:${row.suggestion.replace(/\\/g, '/')}`
    try {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, message: `写 package.json 失败：${String(error?.message ?? error)}` }
    }

    try {
      // Windows 上 pnpm 是 .cmd，execFileSync 直调会 EINVAL，必须走 cmd.exe。
      execSync('pnpm install --prefer-offline', {
        cwd: scan.dir,
        stdio: 'pipe',
        shell: 'cmd.exe',
        timeout: 120_000,
      })
    } catch (error) {
      return {
        ok: false,
        message: `路径已改，但 pnpm install 失败：${String(error?.message ?? error)}。手动执行：cd "${scan.dir}" && pnpm install`,
      }
    }

    check()
    return {
      ok: true,
      message: `已把 ${pluginName} 指到 ${row.suggestion}；请到插件页把该插件关一次再开，loader 才会重新装配`,
      dir: scan.dir,
    }
  }

  // ── 启动体检 ──────────────────────────────────────────────────────────────

  if (options.checkOnBoot) {
    const timer = setTimeout(() => { check() }, 1200)
    timer.unref?.()
    ctx.effect(() => () => clearTimeout(timer), 'dsh-link-guard: boot check timer')
  }

  // ── 界面数据 ──────────────────────────────────────────────────────────────

  /** 给界面用的形状：只给必要字段，不带完整 package.json。 */
  const summarize = () => ({
    ok: true,
    checkedAt: state.at,
    checkedText: state.at === null ? '尚未体检' : stamp(state.at),
    durationMs: state.durationMs,
    error: state.error,
    broken: brokenCount(),
    total: totalCount(),
    scope: `${state.scans.length} 个 profile`,
    profiles: state.scans.map((scan) => ({
      profile: scan.profile,
      dir: scan.dir,
      broken: scan.broken,
      error: scan.error,
      rows: scan.rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        status: row.status,
        statusLabel: STATE_LABEL[row.status] ?? row.status,
        isBundle: row.isBundle,
        version: row.version,
        path: row.path,
        problems: row.problems,
        suggestion: row.suggestion,
      })),
    })),
  })

  // ── HTTP 面 ───────────────────────────────────────────────────────────────

  if (typeof ctx.inject !== 'function') return

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer')
    if (typeof server?.register !== 'function') return

    const sendJson = (res, code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }

    const guard = (res, fn) => {
      try {
        fn()
      } catch (error) {
        sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    }

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-link-guard/state',
      handler: (_req, res) => guard(res, () => sendJson(res, 200, summarize())),
    }), 'dsh-link-guard: state route')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-link-guard/check',
      handler: (req, res) => guard(res, () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const scope = url.searchParams.get('profiles') ?? options.profiles
        check(scope === 'all'
          ? listProfiles()
          : scope.split(',').map((part) => part.trim()).filter(Boolean))
        sendJson(res, 200, summarize())
      }),
    }), 'dsh-link-guard: check route')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-link-guard/fix',
      handler: (req, res) => guard(res, () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const profile = url.searchParams.get('profile') ?? ''
        const target = url.searchParams.get('name') ?? ''
        if (profile === '' || target === '') {
          sendJson(res, 400, { ok: false, message: '需要 profile 与 name 两个参数' })
          return
        }
        const result = fixLink(profile, target)
        sendJson(res, result.ok ? 200 : 409, { ...result, state: summarize() })
      }),
    }), 'dsh-link-guard: fix route')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-link-guard/plan',
      handler: (req, res) => guard(res, () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const src = url.searchParams.get('src') ?? ''
        const dst = url.searchParams.get('dst') ?? ''
        if (src === '' || dst === '') {
          sendJson(res, 400, { ok: false, message: '需要 src 与 dst 两个参数' })
          return
        }
        const affected = planMove(src, dst)
        sendJson(res, 200, { ok: true, affected })
      }),
    }), 'dsh-link-guard: plan route')
  })

  // ── DSH Go 原生界面 ───────────────────────────────────────────────────────

  ctx.inject(['dshGo'], (goCtx) => {
    const go = goCtx.dshGo
    if (!go || typeof go.strip !== 'function') return
    const isZh = (caps) => !String(caps?.locale ?? '').toLowerCase().startsWith('en')

    const stripText = (locale) => {
      const zh = isZh({ locale })
      if (state.at === null) return zh ? '链接 · 未体检' : 'links · unchecked'
      const broken = brokenCount()
      if (broken === 0) {
        return pickFit(zh
          ? [`链接 ${totalCount()} 正常`, '链接 · 正常']
          : [`${totalCount()} links ok`, 'links ok'])
      }
      return pickFit(zh
        ? [`链接 ${broken} 坏`, '链接 · 异常', '链接!']
        : [`${broken} broken`, 'links bad', 'links!'])
    }

    go.strip('link-guard-strip', (_scope, emit, caps) => {
      const push = () => {
        const broken = brokenCount()
        emit({ text: stripText(caps?.locale), icon: 'link', tone: broken > 0 ? 'warn' : 'muted' })
      }
      push()
      const timer = setInterval(push, 4000)
      timer.unref?.()
      return () => clearInterval(timer)
    })

    if (typeof go.panel !== 'function') return

    go.panel('links', {
      view: (_scope, caps) => linksView(isZh(caps)),
      data: (_scope, emit, caps) => {
        const push = () => emit(linksData(isZh(caps)))
        push()
        const timer = setInterval(push, 4000)
        timer.unref?.()
        return () => clearInterval(timer)
      },
      actions: {
        check: () => {
          check()
          const broken = brokenCount()
          return { toast: broken === 0 ? '全部正常' : `发现 ${broken} 个异常` }
        },
      },
    })
  })

  // ── 面板视图与数据（用闭包读 state） ──────────────────────────────────────

  function linksView(isZh) {
    return {
      v: 1,
      type: 'stack',
      title: isZh ? '插件链接体检' : 'Plugin link check',
      children: [
        {
          type: 'row',
          children: [
            { type: 'metric', label: isZh ? '异常' : 'Broken', value: { $: 'data.broken' }, tone: 'warn' },
            { type: 'metric', label: isZh ? '总计' : 'Total', value: { $: 'data.total' } },
          ],
        },
        {
          type: 'keyValue',
          items: [
            [isZh ? '上次体检' : 'Checked', { $: 'data.checkedText' }],
            [isZh ? '耗时' : 'Took', { $: 'data.duration' }],
            [isZh ? '范围' : 'Scope', { $: 'data.scope' }],
          ],
        },
        { type: 'list', items: { $: 'data.issues' } },
        {
          type: 'text',
          tone: 'muted',
          text: isZh
            ? 'link: 装的插件指向工作区目录；目录被移动/改名后插件会静默失效（界面不报错）。修好后请到插件页把该插件关一次再开。'
            : 'Plugins installed with link: point at a workspace directory. Moving that directory breaks them silently. After a fix, toggle the plugin off and on in the Plugins page.',
        },
        {
          type: 'actions',
          items: [{ label: isZh ? '重新体检' : 'Re-check', action: 'check', icon: 'refresh', style: 'primary' }],
        },
      ],
    }
  }

  function linksData(isZh) {
    const labels = isZh ? STATE_LABEL : STATE_LABEL_EN
    const issues = []
    for (const scan of state.scans) {
      for (const row of scan.rows) {
        if (row.status === STATUS.ok) continue
        issues.push({
          title: row.name,
          subtitle: `${scan.profile} · ${labels[row.status] ?? row.status}`,
          trailing: row.status === STATUS.brokenTarget && row.suggestion
            ? (isZh ? '可修复' : 'fixable')
            : (isZh ? '手工' : 'manual'),
          tone: 'warn',
        })
      }
    }
    return {
      broken: String(brokenCount()),
      total: String(totalCount()),
      checkedText: state.at === null ? (isZh ? '尚未体检' : 'not checked yet') : stamp(state.at),
      duration: `${state.durationMs} ms`,
      scope: `${state.scans.length} ${isZh ? '个 profile' : 'profiles'}`,
      issues: issues.length > 0
        ? issues
        : [{ title: isZh ? '全部正常' : 'All good', subtitle: state.at === null ? '—' : stamp(state.at) }],
    }
  }
}
