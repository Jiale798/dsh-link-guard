/**
 * 离线 harness：用假 ctx 跑 lib/index.js 的 apply，验证体检、修复、路由与 dshGo 面。
 *
 * 跑法：node tests/host.test.mjs
 * 退出码：0 全过 / 1 有断言失败
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../lib/index.js'

const root = join(tmpdir(), `lg-test-${Date.now()}`)
const profiles = join(root, 'profiles')
const goodDir = join(root, 'ws', 'good-plugin')
const movedDir = join(root, 'ws', '01-projects', 'moved-plugin')

const mkPkg = (dir, body) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), body, 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n', 'utf8')
}

const mkProfile = (name, deps, bundles) => {
  const dir = join(profiles, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    private: true,
    dsh: { profile: { bundles: bundles ?? Object.keys(deps) } },
    dependencies: deps,
  }, null, 2), 'utf8')
  return dir
}

/** 建软链接，模拟 pnpm 装好的样子。 */
const linkInto = (profileDir, name, target) => {
  const dest = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(target, dest, 'junction')
}

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push([label, true, ''])
  } catch (error) {
    results.push([label, false, String(error?.message ?? error)])
  }
}

// ── fixture ──────────────────────────────────────────────────────────────────

mkPkg(goodDir, JSON.stringify({ name: 'good-plugin', version: '1.0.0', main: 'index.js' }))
mkPkg(movedDir, JSON.stringify({ name: 'moved-plugin', version: '2.0.0', main: 'index.js' }))

const goodProfile = mkProfile('t-good', {
  'good-plugin': `link:${goodDir.replace(/\\/g, '/')}`,
})
linkInto(goodProfile, 'good-plugin', goodDir)

// 旧路径不存在，真实位置在 01-projects/ —— 用来验证能推断出来。
const brokenProfile = mkProfile('t-broken', {
  'moved-plugin': `link:${join(root, 'ws', 'moved-plugin').replace(/\\/g, '/')}`,
  'ghost-plugin': `link:${join(root, 'ws', 'nowhere').replace(/\\/g, '/')}`,
})

// 声明了 bundle 但没有依赖的第三方包；官方 @deepseek-ai/* 应当被豁免。
mkProfile('t-declared', {}, ['third-party-bundle', '@deepseek-ai/dsh-base'])

process.env.DSH_HOME = root

// ── 搭假 ctx ─────────────────────────────────────────────────────────────────

const strips = new Map()
const panels = new Map()
const routes = new Map()
const logs = []
const timers = []

const ctx = {
  logger: {
    info: (message) => logs.push(['info', message]),
    warn: (message) => logs.push(['warn', message]),
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  on() {
    return () => {}
  },
  inject(names, callback) {
    if (names.includes('dshGo')) {
      callback({
        dshGo: {
          strip: (id, fn) => strips.set(id, fn),
          panel: (id, definition) => panels.set(id, definition),
          refresh: () => {},
        },
      })
    }
    if (names.includes('webServer')) {
      callback({
        get: () => ({ register: (route) => { routes.set(route.path, route.handler); return () => {} } }),
        effect: (fn) => fn(),
      })
    }
  },
}

apply(ctx, { checkOnBoot: false, profiles: 'all', logOnBroken: false })

// 手动跑一次，替代启动时的延迟体检。
const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeRes = () => {
  const out = { status: 0, body: null, headers: {} }
  return {
    out,
    writeHead(code, headers) { out.status = code; out.headers = headers ?? {} },
    end(text) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

const callRoute = async (path, query = '') => {
  const handler = routes.get(path)
  if (!handler) throw new Error(`没有注册路由 ${path}`)
  const res = fakeRes()
  await handler({ url: `${path}${query}` }, res)
  return res.out
}

// ── 断言 ─────────────────────────────────────────────────────────────────────

await callRoute('/dsh-link-guard/check', '?profiles=all')

const state = await callRoute('/dsh-link-guard/state')
check('state 路由返回全部 profile', () => {
  assert.equal(state.status, 200)
  assert.ok(state.body.total > 0)
  assert.ok(Array.isArray(state.body.profiles))
})

const brokenProfileState = state.body.profiles.find((item) => item.profile === 't-broken')
check('识别目标目录不存在的坏链', () => {
  const row = brokenProfileState.rows.find((item) => item.name === 'moved-plugin')
  assert.equal(row.status, 'broken-target')
  assert.match(row.statusLabel, /不存在/)
})

check('能推断出被移动后的新位置', () => {
  const row = brokenProfileState.rows.find((item) => item.name === 'moved-plugin')
  assert.ok(row.suggestion, '应当给出建议路径')
  assert.ok(row.suggestion.includes('01-projects'), `建议路径应含 01-projects，实际 ${row.suggestion}`)
})

check('推断不出的坏链不给建议', () => {
  const row = brokenProfileState.rows.find((item) => item.name === 'ghost-plugin')
  assert.equal(row.status, 'broken-target')
  assert.equal(row.suggestion, null)
})

const goodProfileState = state.body.profiles.find((item) => item.profile === 't-good')
check('好链判定为 ok 且带版本号', () => {
  const row = goodProfileState.rows.find((item) => item.name === 'good-plugin')
  assert.equal(row.status, 'ok')
  assert.equal(row.version, '1.0.0')
})

const declaredState = state.body.profiles.find((item) => item.profile === 't-declared')
check('第三方 bundle 缺依赖会报 not-declared', () => {
  const row = declaredState.rows.find((item) => item.name === 'third-party-bundle')
  assert.equal(row.status, 'not-declared')
})

check('官方 @deepseek-ai/* 被豁免，不报缺失', () => {
  const hit = declaredState.rows.find((item) => item.name === '@deepseek-ai/dsh-base')
  assert.equal(hit, undefined)
})

// 修一个推断得出来的：把 moved-plugin 指到 01-projects（已经是了，改用 ghost 手工验证拒绝）
check('推断不出的坏链拒绝自动修复', async () => {
  const res = await callRoute('/dsh-link-guard/fix', '?profile=t-broken&name=ghost-plugin')
  assert.equal(res.status, 409)
  assert.match(res.body.message, /没找到|不能自动/)
})

// 真正修一次：先把 broken 的 link 指到错的地方，再修复。
const fixManifest = join(brokenProfile, 'package.json')
const original = JSON.parse(readFileSync(fixManifest, 'utf8'))
original.dependencies['moved-plugin'] = `link:${join(root, 'ws', 'moved-plugin').replace(/\\/g, '/')}`
writeFileSync(fixManifest, JSON.stringify(original, null, 2), 'utf8')
await callRoute('/dsh-link-guard/check', '?profiles=t-broken')
const fixRes = await callRoute('/dsh-link-guard/fix', '?profile=t-broken&name=moved-plugin')
check('能按推断路径自动修复', () => {
  assert.equal(fixRes.status, 200, `修复应成功，实际 ${fixRes.status} ${fixRes.body?.message ?? ''}`)
  assert.match(fixRes.body.message, /关一次再开/)
  const after = JSON.parse(readFileSync(fixManifest, 'utf8'))
  assert.ok(after.dependencies['moved-plugin'].includes('01-projects'))
})

check('修复前会备份 package.json', () => {
  const files = readdirSync(brokenProfile)
  assert.ok(files.some((f) => f.startsWith('package.json.bak-linkguard-')), `实际文件：${files.join(',')}`)
})

// 只复检一个 profile 时，其它 profile 的结果不能丢（曾经在这里出过问题）。
check('局部复检不会抹掉其它 profile 的结果', async () => {
  await callRoute('/dsh-link-guard/check', '?profiles=all')
  const all = await callRoute('/dsh-link-guard/state')
  const namesBefore = all.body.profiles.map((item) => item.profile).sort()
  assert.ok(namesBefore.length >= 3, `应当有 3 个以上 profile，实际 ${namesBefore.join(',')}`)

  await callRoute('/dsh-link-guard/check', '?profiles=t-good')
  const partial = await callRoute('/dsh-link-guard/state')
  const namesAfter = partial.body.profiles.map((item) => item.profile).sort()
  assert.deepEqual(namesAfter, namesBefore, '局部复检后 profile 列表应保持不变')
})

// plan
const plan = await callRoute('/dsh-link-guard/plan', `?src=${encodeURIComponent(join(root, 'ws'))}&dst=${encodeURIComponent(join(root, 'ws2'))}`)
check('plan 能列出受影响链接', () => {
  assert.equal(plan.status, 200)
  assert.ok(plan.body.affected.length > 0)
})

// dshGo
check('注册了状态条与面板', () => {
  assert.ok(strips.has('link-guard-strip'))
  assert.ok(panels.has('links'))
})

const stripOut = []
const stopStrip = strips.get('link-guard-strip')({}, (value) => stripOut.push(value), { locale: 'zh-CN' })
await wait(30)
stopStrip()
check('状态条文案在 24 字内且带 tone', () => {
  const last = stripOut.at(-1)
  assert.ok(last, '应当 emit 过')
  assert.ok([...last.text].length <= 24, `实际 ${[...last.text].length} 字：${last.text}`)
  assert.equal(last.icon, 'link')
})

const dataOut = []
const stopData = panels.get('links').data({}, (value) => dataOut.push(value), { locale: 'zh-CN' })
await wait(30)
stopData()
check('面板数据含 issues 与统计', () => {
  const last = dataOut.at(-1)
  assert.ok(last)
  assert.ok(/^\d+$/.test(last.broken))
  assert.ok(Array.isArray(last.issues))
})

const view = panels.get('links').view({}, { locale: 'zh-CN' })
check('面板视图结构合法', () => {
  assert.equal(view.type, 'stack')
  // metric 在 row 里，不是 stack 的直接子节点。
  const flat = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'string') flat.push(node.type)
    for (const child of node.children ?? []) walk(child)
    if (node.items && !Array.isArray(node.items)) walk(node.items)
  }
  walk(view)
  assert.ok(flat.includes('metric'), `应当有 metric，实际 ${flat.join(',')}`)
  assert.ok(flat.includes('actions'), `应当有 actions，实际 ${flat.join(',')}`)
  assert.ok(flat.includes('list'), `应当有 list，实际 ${flat.join(',')}`)
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────

for (const timer of timers) clearTimeout(timer)
try {
  rmSync(root, { recursive: true, force: true })
} catch {
  // 清不掉不影响结论。
}

let pass = true
for (const [label, ok, detail] of results) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${ok ? '' : `\n        ${detail}`}`)
  if (!ok) pass = false
}
console.log(pass ? `\n全部 ${results.length} 项通过。` : '\n有断言失败。')
process.exit(pass ? 0 : 1)
