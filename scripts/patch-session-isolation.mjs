#!/usr/bin/env node
/**
 * patch-session-isolation.mjs — workspace-isolation guard for the DSH web UI.
 *
 * WHY
 *   DSH's shared "New Session" action used to resolve its target Workspace as
 *     workspaceId ?? currentWorkspaceId ?? recentWorkspaceId
 *   The implicit `recentWorkspaceId` fallback let automation driving the web
 *   UI (e.g. a Playwright script, or any programmatic session creator) spawn
 *   sessions into whatever project happened to be most recently used — a
 *   cross-project pollution vector. This plugin ships the one-line guard:
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
// The pristine expression shipped by @deepseek-ai/dsh-client-runtime
// (lib/client.js, WorkspaceRuntime#startSession).
const PRISTINE = 'const target = workspaceId ?? currentWorkspaceId ?? workspace.recentWorkspaceId;'
const FIXED = 'const target = workspaceId ?? currentWorkspaceId;'
const BACKUP_SUFFIX = '.bak-science-isolation'

function fail(msg) {
  console.error(`[patch-session-isolation] ${msg}`)
  process.exit(1)
}

function findClientJs(override) {
  if (override) return override
  const candidates = []
  try {
    const require = createRequire(import.meta.url)
    candidates.push(require.resolve('@deepseek-ai/dsh-client-runtime/lib/client.js'))
  } catch { /* not resolvable from this package */ }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    candidates.push(
      path.join(globalRoot, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js'),
      path.join(globalRoot, '@deepseek-ai/dsh-client-runtime/lib/client.js'),
    )
  } catch { /* npm root unavailable */ }
  for (const c of candidates) if (c && existsSync(c)) return c
  return undefined
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0] : ''
}

function apply(file) {
  const src = readFileSync(file, 'utf8')
  if (src.includes(GUARD_COMMENT) && src.includes(FIXED)) {
    console.log(`[patch-session-isolation] already applied: ${file}`)
    return 0
  }
  if (!src.includes(PRISTINE)) {
    console.error(`[patch-session-isolation] pristine pattern not found in ${file}`)
    console.error('  expected: ' + PRISTINE)
    return 1
  }
  const lines = src.split('\n')
  const idx = lines.findIndex(l => l.includes(PRISTINE))
  if (idx === -1) return 1
  const indent = indentOf(lines[idx])
  const guard = [
    `${indent}// ${GUARD_COMMENT}: only create a new session into an EXPLICITLY`,
    `${indent}// chosen workspace. The implicit \`recentWorkspaceId\` fallback let`,
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
  if (!out.includes(FIXED) || out.includes(PRISTINE)) {
    copyFileSync(backup, file)
    rmSync(backup)
    console.error('[patch-session-isolation] apply failed verification; restored backup')
    return 1
  }
  console.log(`[patch-session-isolation] applied (backup: ${backup})`)
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
  const pristine = src.includes(PRISTINE)
  console.log(`[patch-session-isolation] file: ${file}`)
  console.log(`[patch-session-isolation] guard applied: ${applied ? 'yes' : 'no'}`)
  console.log(`[patch-session-isolation] pristine expression present: ${pristine ? 'yes' : 'no'}`)
  console.log(`[patch-session-isolation] backup exists: ${existsSync(file + BACKUP_SUFFIX) ? 'yes' : 'no'}`)
  return 0
}

const argv = process.argv.slice(2)
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'apply'
const fileFlag = argv.find(a => a === '--file')
const override = fileFlag ? argv[argv.indexOf(fileFlag) + 1] : (process.env.DSH_CLIENT_RUNTIME || undefined)

const file = findClientJs(override)
if (!file) fail(`could not locate @deepseek-ai/dsh-client-runtime/lib/client.js — pass --file <path>`)

let code = 0
if (cmd === 'apply') code = apply(file)
else if (cmd === 'revert') code = revert(file)
else if (cmd === 'status') code = status(file)
else fail(`unknown command: ${cmd} (use apply|revert|status)`)
process.exit(code)
