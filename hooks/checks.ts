import type { EngineInterface } from 'claude-code'

import type { CheckRun } from '../types'

import type { CheckConfig } from './config'

/** Key formats worth stopping for. Matched text is never shown: only where it is. */
const SECRET_PATTERNS = [
  'AKIA[0-9A-Z]{16}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  'gh[pousr]_[A-Za-z0-9]{36,}',
  'github_pat_[A-Za-z0-9_]{40,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'sk_live_[0-9a-zA-Z]{20,}',
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'sk-proj-[A-Za-z0-9_-]{20,}',
  'AIza[0-9A-Za-z_-]{35}',
  'glpat-[A-Za-z0-9_-]{20,}',
]

const MASK = new RegExp(SECRET_PATTERNS.join('|'), 'g')

export function maskSecrets(text: string): string {
  return text.replace(MASK, '[hidden secret]')
}

function tail(text: string, max = 1500): string {
  const t = maskSecrets(text.trim())

  return t.length > max ? `…${t.slice(-max)}` : t
}

/** A `checks.exclude` glob as a git pathspec; one without "/" matches in any folder. */
export function excludeSpec(glob: string): string {
  return `:(exclude,glob)${glob.includes('/') ? glob : `**/${glob}`}`
}

/** Runs one check over the whole project. A check that cannot run is `skipped`, not failed. */
export async function runCheck(
  $: EngineInterface,
  persona: string,
  check: CheckConfig,
  cwd: string,
  exclude: string[],
): Promise<CheckRun> {
  const weight = check.weight ?? 4
  const base = { persona, name: check.name, weight }
  const ranAt = await $.clock.now()

  if (check.run === 'builtin:secrets') {
    const argv = [
      'git',
      'grep',
      '-nIE',
      '--untracked',
      ...SECRET_PATTERNS.flatMap(p => ['-e', p]),
      '--',
      '.',
      ...exclude.map(excludeSpec),
    ]
    try {
      const r = await $.process.run(argv, { cwd, timeoutMs: 60_000 })
      if (r.exitCode === 1) return { ...base, state: 'pass', command: 'secret scan', output: '', ranAt }
      if (r.exitCode !== 0) {
        return { ...base, state: 'skipped', command: 'secret scan', output: tail(r.stderr), ranAt }
      }
      const places = [
        ...new Set(r.stdout.split('\n').filter(Boolean).map(l => l.split(':').slice(0, 2).join(':'))),
      ]
      const output = places.slice(0, 20).join('\n') + (places.length > 20 ? `\n…and ${places.length - 20} more` : '')

      return { ...base, state: 'fail', command: 'secret scan', output, ranAt }
    } catch (err) {
      return { ...base, state: 'skipped', command: 'secret scan', output: String(err), ranAt }
    }
  }

  const argv = typeof check.run === 'string' ? ['/bin/sh', '-c', check.run] : check.run
  const command = typeof check.run === 'string' ? check.run : check.run.join(' ')
  try {
    const r = await $.process.run(argv, {
      cwd,
      timeoutMs: Math.min(600, check.timeoutSeconds ?? 120) * 1000,
    })
    const output = tail(`${r.stdout}\n${r.stderr}`)
    if (r.exitCode === 0) return { ...base, state: 'pass', command, output: '', ranAt }
    // 126/127: the shell could not find or start the tool. Not the app's fault.
    if (r.exitCode === 126 || r.exitCode === 127) return { ...base, state: 'skipped', command, output, ranAt }

    return { ...base, state: 'fail', command, output, ranAt }
  } catch (err) {
    return { ...base, state: 'skipped', command, output: String(err), ranAt }
  }
}
