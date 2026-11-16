/**
 * Everything that talks to the engine: GitHub, local checks, the model, the
 * guard's verdicts. Module state lives in `S` (rebuilt by `session.start`
 * after a reload); what the pane draws lives in $.state.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { CheckRun, MoodItem } from '../types'

import { runCheck } from './checks'
import { CONFIG_FILE, DEFAULT_CONFIG, mergeConfig } from './config'
import type { PersonaConfig, TeamMoodConfig } from './config'
import {
  addedSuppressions,
  bashTouchesProtected,
  compileRules,
  githubGaming,
  protectedBy,
  relativeTo,
} from './guard'
import type { ProtectRules } from './guard'
import { explainFindings, writeStatusLine } from './plain'
import type { Excerpt } from './plain'
import { checkupPrompt, fixPrompt, handleOf } from './prompts'
import { buildBoard, FACES, needsBodies, signature } from './score'
import type { GhIssue } from './score'

const board = atom({ plugin: 'team-mood', key: 'board' } as const, null)
const openCard = atom({ plugin: 'team-mood', key: 'open' } as const, null)
const busy = atom({ plugin: 'team-mood', key: 'busy' } as const, false)
const checks = atom({ plugin: 'team-mood', key: 'checks' } as const, {})
const baseline = atom({ plugin: 'team-mood', key: 'baseline' } as const, null)
const lines = atom({ plugin: 'team-mood', key: 'lines' } as const, {})
const plain = atom({ plugin: 'team-mood', key: 'plain' } as const, {})
const alert = atom({ plugin: 'team-mood', key: 'alert' } as const, null)

const GH_FIELDS = 'number,title,labels,author,url,updatedAt'
const STORE_CACHE_LIMIT = 300

export const S = {
  cwd: '.',
  config: DEFAULT_CONFIG as TeamMoodConfig,
  rules: compileRules(DEFAULT_CONFIG.protect.paths, []) as ProtectRules,
  issues: [] as GhIssue[],
  repo: undefined as string | undefined,
  ghError: undefined as string | undefined,
  lastRefresh: 0,
  wantRefresh: true,
  lastEdit: 0,
  lastChecks: -1,
  isTicking: false,
  /** The dashboard server, once started or found: where the mod reaches it, and its token. */
  dash: undefined as { base: string; port: number; token: string } | undefined,
  isDashStarting: false,
  isDashReported: false,
  dashFailures: 0,
}

export function persona(id: string): PersonaConfig | undefined {
  return S.config.personas.find(p => p.id === id)
}

/** Asks for a refresh (and a check run) at the next heartbeat. */
export function wantEverything(): void {
  S.wantRefresh = true
  S.lastRefresh = 0
  S.lastChecks = -1
}

/** Runs work outside the dispatch that asked for it, so a press or a hook returns at once. */
export function later($: EngineInterface, work: () => Promise<unknown>): void {
  $.clock.after(0, () => {
    work().catch(err => $.ui.log(`team-mood: ${String(err)}`, { to: 'debug' }))
  })
}

export async function loadConfig($: EngineInterface): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(`${S.cwd}/${CONFIG_FILE}`))
  } catch (err) {
    const isMissing = /ENOENT|no such file|not found|missing|does not exist/i.test(String(err))
    if (!isMissing) $.ui.toast(`Team Mood: ${CONFIG_FILE} could not be read, using defaults.`)
  }
  S.config = mergeConfig(raw)
  S.rules = compileRules(
    [...S.config.protect.paths, ...S.config.protect.extraPaths],
    [$.plugin.root],
  )
}

export async function loadBaseline($: EngineInterface): Promise<void> {
  if ((await read($, baseline)) !== null) return
  const stored = await $.store.get(`latest:${S.cwd}`)
  await update($, baseline, () => asNumbers(stored))
}

async function rebuild($: EngineInterface): Promise<void> {
  const next = buildBoard({
    config: S.config,
    issues: S.issues,
    checks: await read($, checks),
    baseline: await read($, baseline),
    lines: await read($, lines),
    repo: S.repo,
    error: S.ghError,
    now: await $.clock.now(),
  })
  await update($, board, () => next)
  $.ui.status(next.cards.map(c => `${c.emoji}${FACES[c.mood]}`).join(' '))
  const scores = Object.fromEntries(next.cards.map(c => [c.id, c.score]))
  await $.store.set(`latest:${S.cwd}`, scores)
  await pushState($)
}

async function fetchIssues($: EngineInterface): Promise<void> {
  try {
    const fields = needsBodies(S.config) ? `${GH_FIELDS},body` : GH_FIELDS
    const r = await $.process.run(
      ['gh', 'issue', 'list', '--state', 'open', '--limit', '300', '--json', fields],
      { cwd: S.cwd, timeoutMs: 30_000 },
    )
    if (r.exitCode !== 0) {
      S.ghError = explainGhError(r.stderr)
      return
    }
    S.issues = JSON.parse(r.stdout) as GhIssue[]
    S.ghError = undefined
    if (S.repo === undefined) {
      const v = await $.process.run(
        ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
        { cwd: S.cwd, timeoutMs: 15_000 },
      )
      S.repo = v.exitCode === 0 ? v.stdout.trim() : undefined
    }
  } catch {
    S.ghError = "GitHub can't be reached: install the GitHub CLI (gh) and run `gh auth login`."
  }
}

async function refresh($: EngineInterface): Promise<void> {
  await update($, busy, () => true)
  try {
    await fetchIssues($)
    S.lastRefresh = await $.clock.now()
    S.wantRefresh = false
    await rebuild($)
  } finally {
    await update($, busy, () => false)
  }
  await afterChange($)
}

/** Plain words for what changed: status lines always, explanations too while the page is up. */
async function afterChange($: EngineInterface): Promise<void> {
  await phraseLines($)
  if (S.dash === undefined) return
  for (const card of (await read($, board))?.cards ?? []) {
    if (card.items.length > 0) await explain($, card.id)
  }
  await pushState($)
}

/** Asks the model for a status line per persona whose findings changed; cached across sessions. */
async function phraseLines($: EngineInterface): Promise<void> {
  if (!S.config.plainLanguage) return
  const current = await read($, board)
  if (current === null) return
  const cache = asStrings(await $.store.get('lines'))
  let isChanged = false
  for (const card of current.cards) {
    const p = persona(card.id)
    if (p === undefined || card.items.length === 0) continue
    const key = `${card.id}|${signature(card)}`
    if ((await read($, lines))[key] !== undefined) continue
    const line = cache[key] ?? (await writeStatusLine($, S.config, p, card))
    if (line === undefined) continue
    cache[key] = line
    await update($, lines, all => ({ ...all, [key]: line }))
    isChanged = true
  }
  if (isChanged) {
    await $.store.set('lines', prune(cache))
    await rebuild($)
  }
}

export function plainKey(item: MoodItem): string {
  return `${item.key}@${item.updatedAt ?? ''}`
}

/** Plain-language explanations for one persona's findings, fetched when its card opens. */
export async function explain($: EngineInterface, id: string): Promise<void> {
  const p = persona(id)
  const card = (await read($, board))?.cards.find(c => c.id === id)
  if (!S.config.plainLanguage || p === undefined || card === undefined) return
  const cache = asStrings(await $.store.get('plain'))
  const known = await read($, plain)
  const todo: Excerpt[] = []
  const found: Record<string, string> = {}
  for (const item of card.items.slice(0, 8)) {
    const k = plainKey(item)
    if (known[k] !== undefined) continue
    const cached = cache[k]
    if (cached !== undefined) found[k] = cached
    else todo.push({ item, body: await excerpt($, item) })
  }
  if (todo.length > 0) {
    const written = await explainFindings($, S.config, p, todo)
    for (const { item } of todo) {
      const text = written[item.key]
      if (text !== undefined) found[plainKey(item)] = text
    }
  }
  if (Object.keys(found).length === 0) return
  await update($, plain, all => ({ ...all, ...found }))
  await $.store.set('plain', prune({ ...cache, ...found }))
  await pushState($)
}

async function excerpt($: EngineInterface, item: MoodItem): Promise<string> {
  if (item.kind === 'check') return (item.output ?? '').slice(0, 1500)
  try {
    const r = await $.process.run(
      ['gh', 'issue', 'view', String(item.number), '--json', 'body', '-q', '.body'],
      { cwd: S.cwd, timeoutMs: 15_000 },
    )
    return r.exitCode === 0 ? r.stdout.slice(0, 1500) : ''
  } catch {
    return ''
  }
}

async function runChecks($: EngineInterface): Promise<void> {
  S.lastChecks = await $.clock.now()
  if (!S.config.checks.enabled) return
  const jobs = S.config.personas.flatMap(p => (p.checks ?? []).map(c => ({ p, c })))
  if (jobs.length === 0) return
  await update($, busy, () => true)
  try {
    const results: Record<string, CheckRun> = {}
    for (const { p, c } of jobs) {
      results[`${p.id}:${c.name}`] = await runCheck($, p.id, c, S.cwd, S.config.checks.exclude)
    }
    await update($, checks, () => results)
    await rebuild($)
  } finally {
    await update($, busy, () => false)
  }
  await afterChange($)
}

/** The heartbeat: re-runs checks once edits settle, and asks GitHub again when due. */
export async function tick($: EngineInterface): Promise<void> {
  if (S.isTicking) return
  S.isTicking = true
  try {
    // Starting the page waits on python; the moods must not.
    if (S.dash === undefined) later($, () => ensureDashboard($))
    await takeActions($)
    const now = await $.clock.now()
    const isSettled = now - S.lastEdit >= S.config.checks.debounceSeconds * 1000
    if ((S.lastChecks < 0 || S.lastEdit > S.lastChecks) && isSettled) await runChecks($)
    const isDue = now - S.lastRefresh >= S.config.refreshMinutes * 60_000
    if (isDue || (S.wantRefresh && now - S.lastRefresh >= 30_000)) await refresh($)
  } finally {
    S.isTicking = false
  }
}

const DASH_START_TRIES = 3

/**
 * Starts the dashboard server (or finds the one already serving this project), and
 * tells the remote app about its port so it can show the page in its preview pane.
 */
async function ensureDashboard($: EngineInterface): Promise<void> {
  const { enabled, host, port } = S.config.dashboard
  if (!enabled || S.dash !== undefined || S.isDashStarting) return
  if (S.dashFailures >= DASH_START_TRIES) return
  S.isDashStarting = true
  try {
    const home = (await $.env.get('HOME')) ?? '/tmp'
    const dir = `${home}/.team-mood/${S.cwd.replace(/[^A-Za-z0-9]+/g, '-').slice(-80)}`
    const info = `${dir}/server.json`
    const reach = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    let found = await readInfo($, info, reach)
    if (found === undefined) {
      await $.process.run(['mkdir', '-p', dir])
      await $.process.run(['rm', '-f', info])
      // Arguments go in as $0..$3, never into the shell line itself.
      await $.process.run(
        [
          '/bin/sh',
          '-c',
          'nohup python3 "$0" --host "$1" --port "$2" --info "$3" >"$3.log" 2>&1 &',
          `${$.plugin.root}/web/serve.py`,
          host,
          String(port),
          info,
        ],
        { timeoutMs: 10_000 },
      )
      for (let i = 0; i < 20 && found === undefined; i++) {
        await $.clock.sleep(250)
        found = await readInfo($, info, reach)
      }
    }
    if (found === undefined) {
      S.dashFailures += 1
      $.ui.log('team-mood: the dashboard page did not start (is python3 installed?)', {
        to: 'debug',
      })
      return
    }
    S.dash = found
    await pushState($)
    if (!S.isDashReported) {
      S.isDashReported = true
      // Remote sessions: the app can show the page beside the chat. Elsewhere the tool is absent.
      await $.tool
        .call({ tool: 'mcp__claude-code-remote__report_preview_port', port: found.port, name: 'Team Mood' })
        .catch(() => undefined)
    }
  } finally {
    S.isDashStarting = false
  }
}

async function readInfo(
  $: EngineInterface,
  path: string,
  reach: string,
): Promise<typeof S.dash> {
  try {
    const info = JSON.parse(await $.fs.read(path)) as { port?: unknown; token?: unknown }
    if (typeof info.port !== 'number' || typeof info.token !== 'string') return undefined
    const base = `http://${reach}:${info.port}`
    const r = await $.http.fetch(`${base}/state`)

    return r.ok ? { base, port: info.port, token: info.token } : undefined
  } catch {
    return undefined
  }
}

/** The page's URL on this machine, while the dashboard runs. */
export function dashboardUrl(): string | undefined {
  return S.dash === undefined ? undefined : `http://127.0.0.1:${S.dash.port}`
}

/** What the page draws: the board, each finding's handle and plain words, and the guard's alert. */
export async function pushState($: EngineInterface): Promise<void> {
  const dash = S.dash
  if (dash === undefined) return
  const b = await read($, board)
  if (b === null) return
  const words = await read($, plain)
  const cards = b.cards.map(c => ({
    ...c,
    items: c.items.map(i => ({ ...i, handle: handleOf(i), wordKey: plainKey(i), output: undefined })),
  }))
  const body = JSON.stringify({
    board: { ...b, cards },
    words,
    busy: await read($, busy),
    alert: await read($, alert),
  })
  try {
    const r = await $.http.fetch(`${dash.base}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Team-Mood-Token': dash.token },
      body,
    })
    if (!r.ok) S.dash = undefined
  } catch {
    S.dash = undefined
  }
}

/** Presses made on the page since the last heartbeat, sent to Claude as the panel's buttons are. */
async function takeActions($: EngineInterface): Promise<void> {
  const dash = S.dash
  if (dash === undefined) return
  let actions: { kind: string; target: string }[] = []
  try {
    const r = await $.http.fetch(`${dash.base}/actions`, {
      headers: { 'X-Team-Mood-Token': dash.token },
    })
    if (!r.ok) throw new Error(String(r.status))
    actions = JSON.parse(r.text) as typeof actions
  } catch {
    S.dash = undefined // gone: the next heartbeat starts or finds it again
    return
  }
  const cards = (await read($, board))?.cards ?? []
  for (const { kind, target } of actions) {
    if (kind === 'refresh') {
      wantEverything()
      continue
    }
    if (kind === 'checkup') {
      const p = persona(target)
      if (p !== undefined) later($, () => $.prompt.submit({ text: checkupPrompt(p), asUser: true }))
      continue
    }
    const hit = cards.flatMap(c => c.items.map(item => ({ c, item }))).find(x => handleOf(x.item) === target)
    const p = hit ? persona(hit.c.id) : undefined
    if (hit !== undefined && p !== undefined) {
      const text = fixPrompt(p, hit.item)
      later($, () => $.prompt.submit({ text, asUser: true }))
    }
  }
}

/** Why a tool call needs the person's approval, or undefined when it does not. */
export async function guardReason(
  $: EngineInterface,
  tool: string,
  input: unknown,
): Promise<string | undefined> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  const { protect } = S.config

  if (tool === 'Bash') {
    const command = str('command') ?? ''
    const file = protect.bash ? bashTouchesProtected(S.rules, S.cwd, command) : undefined
    if (file !== undefined) return protectedReason(relativeTo(S.cwd, file) ?? file)
    const gaming = protect.github ? githubGaming(command) : undefined
    if (gaming === undefined) return undefined

    return (
      `Team Mood: this command would ${gaming}. That changes the scoreboard, not the app. ` +
      'Approve only if you asked for it.'
    )
  }

  const path = str('file_path') ?? str('notebook_path')
  if (path === undefined) return undefined
  const real = await realPath($, path)
  const hit = protectedBy(S.rules, S.cwd, path) ?? (real ? protectedBy(S.rules, S.cwd, real) : undefined)
  if (hit !== undefined) return protectedReason(relativeTo(S.cwd, path) ?? path)
  if (!protect.suppressions) return undefined

  let before = ''
  let after = ''
  if (tool === 'Edit') {
    before = str('old_string') ?? ''
    after = str('new_string') ?? ''
  } else if (tool === 'MultiEdit' && Array.isArray(args.edits)) {
    for (const one of args.edits as Record<string, unknown>[]) {
      before += `${String(one.old_string ?? '')}\n`
      after += `${String(one.new_string ?? '')}\n`
    }
  } else if (tool === 'Write') {
    after = str('content') ?? ''
    before = await $.fs.read(path).catch(() => '')
  }
  const added = addedSuppressions(before, after)
  if (added.length === 0) return undefined

  return (
    `Team Mood: this edit adds ${added.join(', ')}, which hides a warning or a test ` +
    "instead of fixing it. Approve only if that's really what you want."
  )
}

function protectedReason(path: string): string {
  return (
    `Team Mood: ${path} is part of how this app gets checked (CI, a checker's settings or an ` +
    'ignore list). Changing it could make the team look happier without fixing anything. ' +
    'Approve only if you asked for this change.'
  )
}

function explainGhError(stderr: string): string {
  if (/auth|log ?in|token/i.test(stderr)) {
    return 'GitHub needs a sign-in: run `gh auth login` in a terminal.'
  }
  if (/not a git repository|no git remote|could not determine/i.test(stderr)) {
    return "This folder isn't linked to a GitHub repository, so only local checks count."
  }

  return `GitHub didn't answer: ${stderr.trim().split('\n')[0] ?? 'unknown error'}`
}

async function realPath($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

function asStrings(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof v === 'object' && v !== null) {
    for (const [k, s] of Object.entries(v)) if (typeof s === 'string') out[k] = s
  }

  return out
}

function asNumbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof v === 'object' && v !== null) {
    for (const [k, n] of Object.entries(v)) if (typeof n === 'number') out[k] = n
  }

  return out
}

function prune(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).slice(-STORE_CACHE_LIMIT))
}
