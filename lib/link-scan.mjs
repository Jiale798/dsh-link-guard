/**
 * link-scan.mjs — 链接体检查询内核。
 *
 * 只做「读」，不写任何文件，供两个调用方共用：
 *   1. 独立 CLI（tools/check-plugin-links.mjs）：人手动跑、带 --fix。
 *   2. Host 插件（lib/index.js）：DSH 启动时自动体检，把结果推给界面。
 *
 * 为什么要有它：`link:` 装进 profile 的插件是指向工作区目录的软链接。目录被
 * 移动、改名或删除后插件会**静默失效**——list_bundles 仍报 installed/enabled=true，
 * 只是 rows[] 少了 entryId，loader 里没这一行，界面不报错，功能就是没了。
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

export const STATUS = {
  ok: 'ok',
  brokenTarget: 'broken-target',
  notLinked: 'not-linked',
  emptyPlaceholder: 'empty-placeholder',
  incomplete: 'incomplete',
  notDeclared: 'not-declared',
}

/**
 * 这些目录不参与坏链位置推断。
 * 只跳过「搜进去也几乎不可能找到插件」的系统/缓存目录；不要把 Temp、Local、
 * Roaming 这类普通名字放进来——测试夹具、临时工作区都可能在里面。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', 'AppData', 'Windows', 'WindowsApps',
  '$Recycle.Bin', '.venv', '__pycache__',
])

/** 按 `--profile`/`$DSH_PROFILE` 的约定定位 profile 目录。 */
export function profileRoot(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(dshHome, 'profiles')
}

/** 列出所有带 package.json 的 profile 名。 */
export function listProfiles(dshHome) {
  const root = profileRoot(dshHome)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, name, 'package.json')))
      .sort()
  } catch {
    return []
  }
}

/** 两条路径尾部相同的层数，用于给候选位置打分。 */
export function commonTail(a, b) {
  const pa = String(a).replace(/\\/g, '/').split('/').filter(Boolean).reverse()
  const pb = String(b).replace(/\\/g, '/').split('/').filter(Boolean).reverse()
  let score = 0
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    if (pa[i].toLowerCase() !== pb[i].toLowerCase()) break
    score += 1
  }
  return score
}

/**
 * 推断坏链指向的目录被挪到了哪儿。
 * @param brokenPath 原路径
 * @param budget 最多访问多少个目录（默认 4000，防止在大盘上卡住）
 * @returns 最像的新路径，或 null
 */
export function suggestTarget(brokenPath, budget = 4000) {
  const parts = String(brokenPath).replace(/\\/g, '/').split('/').filter(Boolean)
  const leaf = parts.pop()
  if (!leaf) return null

  const roots = new Set()
  if (parts.length > 0) {
    roots.add(`${parts[0]}${sep}`)
    if (parts.length > 2) roots.add(parts.slice(0, 3).join(sep))
    if (parts.length > 4) roots.add(parts.slice(0, 5).join(sep))
  }
  roots.add(homedir())

  const hits = []
  /** 有界广度优先：最多 6 层、budget 个目录。 */
  const walk = (root, maxDepth) => {
    let queue = [{ dir: root, depth: 0 }]
    let seen = 0
    while (queue.length > 0 && seen < budget) {
      const next = []
      for (const { dir, depth } of queue) {
        if (seen >= budget) break
        seen += 1
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
          const child = join(dir, entry.name)
          if (entry.name === leaf && existsSync(join(child, 'package.json'))) hits.push(child)
          if (depth + 1 < maxDepth) next.push({ dir: child, depth: depth + 1 })
        }
      }
      queue = next
    }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    walk(root, root.endsWith(sep) || root.endsWith('/') ? 6 : 5)
    if (hits.length > 0) break
  }

  return hits
    .map((hit) => ({ hit, score: commonTail(brokenPath, hit) }))
    .sort((x, y) => y.score - x.score)
    .map((x) => x.hit)[0] ?? null
}

/** 包自身是否完整：main 入口能落到文件、bundle patch 也在。 */
function inspectTarget(dir, pkg) {
  const problems = []
  const main = pkg.main ?? 'index.js'
  if (!existsSync(join(dir, main))) {
    const alt = ['.js', '.mjs', '.cjs']
      .map((ext) => join(dir, main + ext))
      .find((candidate) => existsSync(candidate))
    if (!alt) problems.push(`入口 ${main} 不存在`)
  }
  const patch = pkg.dsh?.bundle?.patch
  if (typeof patch === 'string' && !existsSync(join(dir, patch))) {
    problems.push(`bundle patch ${patch} 不存在`)
  }
  return problems
}

/** 读一个包的 package.json，失败给 null。 */
function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 体检一个 profile。
 * @param profileName profile 目录名
 * @param options.dshHome 覆盖 $DSH_HOME
 * @param options.suggest 是否推断坏链新位置（默认 true）
 * @returns { profile, dir, error, rows, broken }
 */
export function scanProfile(profileName, { dshHome, suggest = true } = {}) {
  const dir = join(profileRoot(dshHome), profileName)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return null

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return {
      profile: profileName,
      dir,
      error: `package.json 解析失败：${String(error?.message ?? error)}`,
      rows: [],
      broken: 0,
    }
  }

  const deps = manifest.dependencies ?? {}
  const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
  const rows = []

  for (const [name, spec] of Object.entries(deps)) {
    const isLink = String(spec).startsWith('link:')
    const linkedPath = isLink ? String(spec).slice(5) : null
    const modulesDir = join(dir, 'node_modules', name)

    const targetExists = isLink ? existsSync(linkedPath) : true
    let linked = existsSync(modulesDir)
    // 断链在 existsSync 下就是 false；再看一眼软链接本身是否存在，区分「没建链接」。
    if (!linked && isLink) {
      try {
        readlinkSync(modulesDir)
        linked = true
      } catch {
        linked = false
      }
    }

    const pkg = targetExists ? readPkg(linkedPath ?? modulesDir) : null

    const problems = []
    let status = STATUS.ok
    if (isLink && !targetExists) {
      status = STATUS.brokenTarget
      problems.push('目标目录已不存在（被移动 / 改名 / 删除）')
    } else if (!linked) {
      status = STATUS.notLinked
      problems.push('node_modules 里没有链接（需要 pnpm install）')
    } else if (pkg === null) {
      status = STATUS.emptyPlaceholder
      problems.push('链接存在但缺 package.json')
    } else {
      const issues = inspectTarget(linkedPath ?? modulesDir, pkg)
      if (issues.length > 0) {
        status = STATUS.incomplete
        problems.push(...issues)
      }
    }

    rows.push({
      name,
      kind: isLink ? 'link' : 'copy',
      spec: String(spec),
      path: linkedPath,
      isBundle: bundles.has(name),
      version: pkg?.version ?? null,
      description: pkg?.description ?? null,
      status,
      problems,
      suggestion: status === STATUS.brokenTarget && suggest ? suggestTarget(linkedPath) : null,
    })
  }

  // 声明成 bundle 却没写依赖。官方 @deepseek-ai/* 从 dsh 安装目录解析，
  // 本来就不该出现在 profile 的 dependencies 里，直接豁免，否则全是误报。
  for (const name of bundles) {
    if (Object.hasOwn(deps, name)) continue
    if (name.startsWith('@deepseek-ai/')) continue
    rows.push({
      name,
      kind: 'missing',
      spec: '',
      path: null,
      isBundle: true,
      version: null,
      description: null,
      status: STATUS.notDeclared,
      problems: ['在 dsh.profile.bundles 里，但 dependencies 中没有这一条'],
      suggestion: null,
    })
  }

  return {
    profile: profileName,
    dir,
    error: null,
    rows,
    broken: rows.filter((row) => row.status !== STATUS.ok).length,
  }
}

/** 体检多个 profile，默认全部。 */
export function scanAll({ dshHome, suggest = true, profiles } = {}) {
  const names = profiles ?? listProfiles(dshHome)
  return names.map((name) => scanProfile(name, { dshHome, suggest })).filter(Boolean)
}

/** 把结果压成短指纹，用于比较「有没有变化」。 */
export function fingerprint(scans) {
  return scans
    .map((scan) => `${scan.profile}:${scan.rows
      .filter((row) => row.status !== STATUS.ok)
      .map((row) => `${row.name}=${row.status}`)
      .sort()
      .join(',')}`)
    .join('|')
}

/** 坏链明细，一行一条，给日志与提示用。 */
export function brokenLines(scans) {
  const lines = []
  for (const scan of scans) {
    for (const row of scan.rows) {
      if (row.status === STATUS.ok) continue
      lines.push(`${scan.profile} / ${row.name} — ${row.status}`)
    }
  }
  return lines
}

/**
 * 预演：把 src 移到 dst 会影响哪些 link。
 * @returns 受影响的 { profile, name, was, willBe } 列表
 */
export function planMove(src, dst, { dshHome } = {}) {
  const from = String(src).replace(/\\/g, '/').replace(/\/+$/, '')
  const to = String(dst).replace(/\\/g, '/').replace(/\/+$/, '')
  const affected = []
  for (const scan of scanAll({ dshHome, suggest: false })) {
    for (const row of scan.rows) {
      if (row.kind !== 'link' || !row.path) continue
      const p = row.path.replace(/\\/g, '/')
      if (p !== from && !p.startsWith(`${from}/`)) continue
      affected.push({ profile: scan.profile, name: row.name, was: row.path, willBe: to + p.slice(from.length) })
    }
  }
  return affected
}
