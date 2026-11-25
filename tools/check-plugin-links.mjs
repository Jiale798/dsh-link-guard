#!/usr/bin/env node
/**
 * dsh-link-guard CLI — 同一个体检内核，命令行入口。
 *
 * 与独立脚本 03-系统运维/check-plugin-links.mjs 的区别：
 *   - 扫描逻辑来自 ../lib/link-scan.mjs（插件运行时用的也是同一份），不会分叉
 *   - 参数更克制，避免和插件里的 HTTP 路由重复
 *
 * 用法：
 *   dsh-link-guard                        体检全部 profile
 *   dsh-link-guard --profile desktop      只查一个
 *   dsh-link-guard --quiet                只报异常
 *   dsh-link-guard --json                 机器可读
 *   dsh-link-guard --fix                  自动改路径 + pnpm install
 *   dsh-link-guard --plan SRC DST         移动前预演
 *
 * 退出码：0 全好 / 1 有坏链 / 2 用法错误 / 3 --plan 判定会坏
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  brokenLines,
  fingerprint,
  listProfiles,
  planMove,
  profileRoot,
  scanAll,
  STATUS,
} from '../lib/link-scan.mjs'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (argv[i + 1] ?? fallback)
}

const LABEL = {
  [STATUS.brokenTarget]: '目标目录不存在',
  [STATUS.notLinked]: '未链接',
  [STATUS.emptyPlaceholder]: '空占位',
  [STATUS.incomplete]: '包不完整',
  [STATUS.notDeclared]: '声明了 bundle 但没依赖',
}

const EXIT = { ok: 0, broken: 1, usage: 2, wouldBreak: 3 }

function showHeader() {
  const root = profileRoot()
  if (!existsSync(root)) {
    console.error(`找不到 profile 目录：${root}（可用 $DSH_HOME 指定）`)
    process.exit(EXIT.usage)
    }
}

// ── --plan ─────────────────────────────────────────────────────────────────

if (has('plan')) {
  const i = argv.indexOf('--plan')
  const [src, dst] = [argv[i + 1], argv[i + 2]]
  if (!src || !dst) {
    console.error('用法：--plan <源目录> <目标目录>')
    process.exit(EXIT.usage)
  }
  const affected = planMove(src, dst)
  if (affected.length === 0) {
    console.log('没有 link 依赖这个目录，可以放心移动。')
    process.exit(EXIT.ok)
  }
  console.log(`把 ${src} 移到 ${dst} 会让 ${affected.length} 条链接失效：\n`)
  for (const item of affected) {
    console.log(`  ${item.profile} / ${item.name}`)
    console.log(`    ${item.was}`)
    console.log(`    → ${item.willBe}`)
  }
  console.log('\n移动后跑一次 --fix，或在插件页把插件关掉再开。')
  process.exit(EXIT.wouldBreak)
}

// ── 体检 ───────────────────────────────────────────────────────────────────

showHeader()

const only = argOf('profile', null)
const names = only ? [only] : listProfiles()
if (names.length === 0) {
  console.error(`没有可体检的 profile（在 ${profileRoot()} 下）`)
  process.exit(EXIT.usage)
}

const scans = scanAll({ profiles: names })
const totalBroken = scans.reduce((sum, scan) => sum + scan.broken, 0)

if (has('json')) {
  console.log(JSON.stringify({ root: profileRoot(), scans, broken: totalBroken }, null, 2))
  process.exit(totalBroken === 0 ? EXIT.ok : EXIT.broken)
}

// ── --fix ──────────────────────────────────────────────────────────────────

if (has('fix') && totalBroken > 0) {
  const dry = has('dry-run')
  for (const scan of scans) {
    const manifestPath = `${scan.dir}/package.json`
    const fixable = scan.rows.filter((row) => row.status === STATUS.brokenTarget && row.suggestion)
    const manual = scan.rows.filter((row) => row.status !== STATUS.ok && !fixable.includes(row))
    if (fixable.length === 0) {
      for (const row of manual) {
        console.log(`  手工处理  ${scan.profile} / ${row.name} — ${LABEL[row.status] ?? row.status}`)
      }
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      console.error(`  读不了 ${manifestPath}：${String(error?.message ?? error)}`)
      continue
    }
    for (const row of fixable) console.log(`  ${dry ? '将改' : '已改'}  ${scan.profile} / ${row.name}\n         ${row.path}\n      → ${row.suggestion}`)
    for (const row of manual) console.log(`  手工处理  ${scan.profile} / ${row.name} — ${LABEL[row.status] ?? row.status}`)
    if (dry) continue

    writeFileSync(`${manifestPath}.bak-linkguard-${Date.now()}`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    for (const row of fixable) manifest.dependencies[row.name] = `link:${row.suggestion.replace(/\\/g, '/')}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    try {
      // Windows 上 pnpm 是 .cmd，必须走 cmd.exe，否则 EINVAL。
      execSync('pnpm install --prefer-offline', { cwd: scan.dir, stdio: 'inherit', shell: 'cmd.exe' })
    } catch (error) {
      console.error(`  pnpm install 失败：${String(error?.message ?? error)}`)
      console.error(`  手动执行：cd "${scan.dir}" && pnpm install`)
    }
  }
  console.log('')
}

// ── 报告 ───────────────────────────────────────────────────────────────────

const quiet = has('quiet')
for (const scan of scans) {
  if (quiet && scan.broken === 0) continue
  console.log(`\nprofile  ${scan.dir}`)
  if (scan.error) {
    console.log(`   ! ${scan.error}`)
    continue
  }
  if (scan.rows.length === 0) {
    console.log('   （没有依赖）')
    continue
  }
  const width = Math.max(...scan.rows.map((row) => row.name.length), 10)
  const ordered = [
    ...scan.rows.filter((row) => row.status !== STATUS.ok),
    ...scan.rows.filter((row) => row.status === STATUS.ok),
  ]
  for (const row of ordered) {
    const mark = row.status === STATUS.ok ? 'OK  ' : 'BAD '
    const where = row.kind === 'link' ? ` -> ${row.path ?? ''}` : row.kind === 'copy' ? ' （实体目录）' : ''
    console.log(`  ${mark}${row.name.padEnd(width)}${where}`)
    for (const problem of row.problems ?? []) console.log(`        ${problem}`)
    if (row.suggestion) console.log(`        建议改到：${row.suggestion}`)
  }
}

console.log('')
if (totalBroken === 0) console.log('全部正常。')
else if (!has('fix')) console.log(`有 ${totalBroken} 个需要处理；加 --fix 自动改路径并重装。`)
else console.log('已处理；记得在插件页把对应插件关一次再开，让 loader 重新装配。')

process.exit(totalBroken === 0 ? EXIT.ok : EXIT.broken)
