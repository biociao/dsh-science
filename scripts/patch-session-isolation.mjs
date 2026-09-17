#!/usr/bin/env node
/**
 * patch-session-isolation.mjs — workspace-isolation guard for the DSH web UI.
 *
 * WHY
 *   DSH's shared "New Session" action resolves its target Workspace with an
 *   implicit fallback to the most-recently-used workspace:
 *     dsh <= 0.1.0-rc.6: workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId
 *     dsh >= 0.1.5:      workspaceId ?? currentWorkspaceId ?? recent
 *   (0.1.5 only renamed the third term: `recent` is computed by the
 *   `recentWorkspace(items, byId)` helper — the fallback itself is unchanged.)
 *   That fallback lets automation driving the web UI (e.g. a Playwright script,
 *   or any programmatic session creator) spawn sessions into whatever project
 *   happened to be most recently used — a cross-project pollution vector.
 *   This plugin ships the one-line guard:
 *     workspaceId ?? currentWorkspaceId            (no recent fallback)
 *   so a new session without an explicit Workspace clears into the New
 *   Session view state and the user must pick one.
 *
 *   The fix lives in DSH core
 *   (packages/client/runtime/src/client/workspaces/service.ts, `startSession`)
 *   and upstream currently cannot accept external PRs, so dsh-science carries
 *   it as an idempotent patch you re-apply after every `dsh` upgrade. See
 *   docs/workspace-isolation.md.
 *
 *   TARGET FILE (moved in 0.1.5 — the old package no longer exists):
 *     dsh >= 0.1.5   @deepseek-ai/dsh-client-ui-workspace/lib/client.js
 *     dsh <  0.1.5   @deepseek-ai/dsh-client-runtime/lib/client.js
 *
 * USAGE
 *   node scripts/patch-session-isolation.mjs [apply|revert|status] [--file <path>]
 *   - apply   (default) apply the guard if not already applied (backup first)
 *   - revert  restore the pristine file from the backup
 *   - status  report whether the guard is applied / a backup exists
 *
 *   The target file is auto-detected from the global @deepseek-ai/dsh install;
 *   override with --file or the DSH_CLIENT_RUNTIME env var.
 *
 * EXIT CODES
 *   0 ok (apply was a no-op or succeeded; status printed)
 *   1 file not found / pattern not matched / revert had no backup
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const GUARD_COMMENT = 'Workspace-isolation guard'
const FIXED = 'const target = workspaceId ?? currentWorkspaceId;'
const BACKUP_SUFFIX = '.bak-science-isolation'

// Pristine expressions shipped by DSH, newest first. Each entry names the DSH
// series it belongs to purely for diagnostics.
const VARIANTS = [
  {
    since: '0.1.5',
    package: '@deepseek-ai/dsh-client-ui-workspace',
    pristine: 'const target = workspaceId ?? currentWorkspaceId ?? recent;',
  },
  {
    since: '0.1.0-rc.6',
    package: '@deepseek-ai/dsh-client-runtime',
    pristine: 'const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId;',
  },
]

// Package subpaths to probe, newest first.
const CLIENT_SUBPATHS = [
  '@deepseek-ai/dsh-client-ui-workspace/lib/client.js',
  '@deepseek-ai/dsh-client-runtime/lib/client.js',
]

function fail(msg) {
  console.error(`[patch-session-isolation] ${msg}`)
  process.exit(1)
}

function findClientJs(override) {
  if (override) return override
  const candidates = []
  const require = createRequire(import.meta.url)
  for (const subpath of CLIENT_SUBPATHS) {
    try {
      candidates.push(require.resolve(subpath))
    } catch { /* not resolvable from this package */ }
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    for (const subpath of CLIENT_SUBPATHS) {
      candidates.push(
        path.join(globalRoot, '@deepseek-ai/dsh/node_modules', subpath),
        path.join(globalRoot, subpath),
      )
    }
  } catch { /* npm root unavailable */ }
  for (const c of candidates) if (c && existsSync(c)) return c
  return undefined
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0] : ''
}

/** Which pristine variant this file currently matches (or undefined). */
function matchedVariant(src) {
  return VARIANTS.find((v) => src.includes(v.pristine))
}

function apply(file) {
  const src = readFileSync(file, 'utf8')
  if (src.includes(GUARD_COMMENT) && src.includes(FIXED)) {
    console.log(`[patch-session-isolation] already applied: ${file}`)
    return 0
  }
  const variant = matchedVariant(src)
  if (variant === undefined) {
    console.error(`[patch-session-isolation] no known pristine pattern found in ${file}`)
    for (const v of VARIANTS) console.error(`  dsh ${v.since}: expected ${v.pristine}`)
    console.error('  → DSH likely refactored `startSession` again; update VARIANTS in this script.')
    return 1
  }
  const lines = src.split('\n')
  const idx = lines.findIndex((l) => l.includes(variant.pristine))
  if (idx === -1) return 1
  const indent = indentOf(lines[idx])
  const guard = [
    `${indent}// ${GUARD_COMMENT}: only create a new session into an EXPLICITLY`,
    `${indent}// chosen workspace. The implicit recent-workspace fallback let`,
    `${indent}// automation driving the web UI spawn sessions into whatever project`,
    `${indent}// happened to be most recent — the cross-project pollution vector that`,
    `${indent}// created demo sessions in an unrelated project.`,
    `${indent}${FIXED}`,
  ]
  lines.splice(idx, 1, ...guard)
  const backup = file + BACKUP_SUFFIX
  copyFileSync(file, backup)
  writeFileSync(file, lines.join('\n'))
  // verify
  const out = readFileSync(file, 'utf8')
  if (!out.includes(FIXED) || matchedVariant(out) !== undefined) {
    copyFileSync(backup, file)
    rmSync(backup)
    console.error('[patch-session-isolation] apply failed verification; restored backup')
    return 1
  }
  console.log(`[patch-session-isolation] applied (dsh ${variant.since} layout, backup: ${backup})`)
  return 0
}

function revert(file) {
  const backup = file + BACKUP_SUFFIX
  if (!existsSync(backup)) {
    console.error(`[patch-session-isolation] no backup at ${backup}`)
    return 1
  }
  copyFileSync(backup, file)
  rmSync(backup)
  console.log(`[patch-session-isolation] reverted ${file}`)
  return 0
}

function status(file) {
  const src = readFileSync(file, 'utf8')
  const applied = src.includes(GUARD_COMMENT) && src.includes(FIXED)
  const variant = matchedVariant(src)
  console.log(`[patch-session-isolation] file: ${file}`)
  console.log(`[patch-session-isolation] guard applied: ${applied ? 'yes' : 'no'}`)
  console.log(
    `[patch-session-isolation] pristine expression present: ${
      variant === undefined ? 'no' : `yes (dsh ${variant.since} layout)`
    }`,
  )
  console.log(`[patch-session-isolation] backup exists: ${existsSync(file + BACKUP_SUFFIX) ? 'yes' : 'no'}`)
  return 0
}

const argv = process.argv.slice(2)
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'apply'
const fileFlag = argv.find((a) => a === '--file')
const override = fileFlag ? argv[argv.indexOf(fileFlag) + 1] : (process.env.DSH_CLIENT_RUNTIME || undefined)

const file = findClientJs(override)
if (!file) {
  fail(
    'could not locate the DSH web client runtime — tried '
    + CLIENT_SUBPATHS.join(', ')
    + '; pass --file <path>',
  )
}

let code = 0
if (cmd === 'apply') code = apply(file)
else if (cmd === 'revert') code = revert(file)
else if (cmd === 'status') code = status(file)
else fail(`unknown command: ${cmd} (use apply|revert|status)`)
process.exit(code)
