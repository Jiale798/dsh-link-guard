# dsh-link-guard

[中文](README.md) | English

A DeepSeek Harness (DSH) plugin that **checks, at boot, whether the plugins you installed with `link:` still point at an existing workspace directory** — and tells you the moment one of them silently breaks.

## The problem it solves

A plugin installed into a profile with `link:` is a **symlink to a workspace directory**. Move, rename, or delete that directory and the plugin **fails silently**:

| What you see | What it means |
| --- | --- |
| `list_bundles` reports `installed: true` / `enabled: true` | looks completely fine |
| `rows[]` has no `entryId` | **the actual failure signal** |
| No matching row in the loader | the plugin is not running |
| The UI | no error, no warning — the feature is simply gone |

That happened here on 2026-11-25: tidying the workspace moved four plugins into `01-项目代码/`, and `local-concise`, `local-token-speed`, `hanbao-balance` and `local-set-default-model` all stopped working at once, with zero indication.

## What it does

| When | Action |
| --- | --- |
| 1.2 s after DSH starts | checks every profile and logs the result (disable with `logOnBroken`) |
| A broken link is found | an orange `1 条异常` pill appears beside the composer |
| Everything is fine | the pill **does not appear at all** — it occupies no space |
| Click the pill | a panel lists which profile, which plugin, the old path, the inferred new path, and a **fix** button |
| Click fix | backs up `package.json` → repoints the `link:` → `pnpm install` → re-checks |

Only links whose new location can be **inferred** are auto-fixed. Anything else is reported, never guessed.

## The six states it detects

| Status | Meaning |
| --- | --- |
| `ok` | target exists, link exists, `main` entry and `bundle patch` are both present |
| `broken-target` | target directory is gone (moved / renamed / deleted) |
| `not-linked` | target exists but `node_modules` has no link (needs `pnpm install`) |
| `empty-placeholder` | link exists but `package.json` is missing |
| `incomplete` | package present, but `main` or `dsh.bundle.patch` points at a missing file |
| `not-declared` | listed in `dsh.profile.bundles` but absent from `dependencies` (official `@deepseek-ai/*` packages are exempt) |

## Inferring where a directory went

For `broken-target`, the scan starts from the old path's drive root, `<drive>/Users/<name>`, the old path's common ancestor, and `$HOME`, then does a **bounded breadth-first search** (at most 6 levels / `searchBudget` directories, skipping `node_modules`, `.git`, `AppData`, …). Directories with the same name and a `package.json` are ranked by how many trailing path segments they share with the old path.

Measured: `…/default-workspace/hanbao-balance` → `…/default-workspace/01-项目代码/hanbao-balance`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /dsh-link-guard/state` | current results (every profile, every plugin, status and suggestion) |
| `GET /dsh-link-guard/check?profiles=all` | re-check now; partial checks merge instead of replacing |
| `GET /dsh-link-guard/fix?profile=<name>&name=<plugin>` | fix one link; `200` ok, `409` cannot auto-fix (with reason) |
| `GET /dsh-link-guard/plan?src=<dir>&dst=<dir>` | dry-run a move: which links would break |

## CLI

```bash
dsh-link-guard                       # check every profile
dsh-link-guard --profile desktop     # just one
dsh-link-guard --quiet               # report only problems
dsh-link-guard --json                # machine readable
dsh-link-guard --fix                 # repoint + pnpm install
dsh-link-guard --fix --dry-run       # show what would change
dsh-link-guard --plan SRC DST        # dry-run a move
```

Exit codes: `0` all good / `1` broken links / `2` usage error / `3` `--plan` says the move would break links.

The CLI and the plugin share one scan kernel, [`lib/link-scan.mjs`](lib/link-scan.mjs) — there is no second implementation to drift.

## DSH Go (mobile)

One line above the composer: `链接 15 正常` / `链接 2 坏` (within a 24-character budget, orange when broken). Tapping it opens the "plugin link check" panel: broken/total counts, last check time and duration, each problem (fixable ones are tagged), and a re-check button.

## Configuration

```yaml
- name: '@local/dsh-link-guard'
  config:
    checkOnBoot: true        # check automatically at startup
    profiles: all            # all, or a comma-separated list like "desktop,web"
    searchBudget: 4000       # directories visited while inferring a moved path
    logOnBroken: true        # write one warn line when something is broken
```

## After a fix

Repointing the file is only half the job. DSH's loader does not re-assemble on its own — **toggle the plugin off and on in the Plugins page** (or restart dsh). To confirm recovery, check that the `rows[]` entry in `list_bundles` has its `entryId` back. The panel says the same thing.

## Tests

```bash
node tests/host.test.mjs
```

Runs `apply()` against a stub `ctx`, builds three fixture profiles in a temp directory (good link / broken link / bundle declared without a dependency) and asserts 16 things: broken links detected, new location inferred, fixes refused when no path can be inferred, an actual fix performed with the backup file present, partial re-checks not wiping other profiles, strip text within 24 characters, view structure valid, and more.

## Limitations

- Inference relies on a same-named directory plus path-tail similarity. If the plugin directory itself was renamed, it cannot be found — set the path by hand.
- The check is a synchronous walk; with many profiles and deep trees it costs a little startup time. Measured: 4 profiles in ~3 ms.
- `pnpm install` has a 120 s timeout; on timeout the panel reports it honestly and shows a copy-pasteable manual command.

## License

MIT
