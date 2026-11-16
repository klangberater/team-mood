import type { Mood } from '../types'

export type CheckConfig = {
  name: string
  /** A shell line, an argv list, or "builtin:secrets". Runs over the whole project. */
  run: string | string[]
  /** Score added to the persona while the check fails. Default 4. */
  weight?: number
  timeoutSeconds?: number
}

/** One way an issue belongs to a persona: every field given must hold (each by any of its values). */
export type MatchRule = {
  labels?: string[]
  /** Labels the issue must not carry. */
  notLabels?: string[]
  titlePatterns?: string[]
  authors?: string[]
  /** Regexes (case-insensitive) on the issue's body, e.g. a combined report's finding categories. */
  bodyPatterns?: string[]
}

export type PersonaConfig = {
  id: string
  name: string
  emoji: string
  /** What this persona looks for. Shapes its voice, the explanations, and "Get a check-up". */
  focus: string
  /** How it talks, e.g. "calm, protective, a little dry". */
  tone: string
  /** Issue labels that belong to this persona (case-insensitive). */
  labels?: string[]
  /** Regexes (case-insensitive) on issue titles, for issues CI files without a label. */
  titlePatterns?: string[]
  /** Issue authors that belong to this persona, e.g. "app/sentry". */
  authors?: string[]
  /** Stricter ways in: an issue that passes any one rule belongs here too. */
  match?: MatchRule[]
  /** Local checks, run after Claude edits files. */
  checks?: CheckConfig[]
  /** Fallback status lines per mood; {n} is the count in words, {s} the plural "s". */
  lines?: Partial<Record<Mood, string>>
  thresholds?: Partial<Thresholds>
  enabled?: boolean
}

export type Thresholds = { worried: number; alarmed: number }

export type DashboardConfig = {
  /** A local web page of the team, for sessions with no panel (remote mode). */
  enabled: boolean
  /** Preferred port; another is picked when it is taken. Who can reach it is a per-machine setting. */
  port: number
}

export type TeamMoodConfig = {
  refreshMinutes: number
  /** Ask a small model to rewrite findings in plain language. Off: fixed sentences. */
  plainLanguage: boolean
  model: string
  severity: { labels: Record<string, number>; default: number }
  thresholds: Thresholds
  personas: PersonaConfig[]
  checks: { enabled: boolean; debounceSeconds: number; exclude: string[] }
  dashboard: DashboardConfig
  protect: {
    paths: string[]
    extraPaths: string[]
    /** Ask before shell commands that write to protected paths. */
    bash: boolean
    /** Ask before closing/relabelling issues or disabling workflows with gh. */
    github: boolean
    /** Ask before an edit adds a suppression (eslint-disable, # noqa, .skip(...)). */
    suppressions: boolean
  }
}

export const CONFIG_FILE = '.team-mood.json'

const SEVERITY: Record<string, number> = {
  critical: 10,
  'severity:critical': 10,
  'severity: critical': 10,
  'severity/critical': 10,
  p0: 10,
  blocker: 10,
  high: 6,
  'severity:high': 6,
  'severity: high': 6,
  'severity/high': 6,
  p1: 6,
  priority: 6,
  urgent: 6,
  medium: 3,
  'severity:medium': 3,
  'severity: medium': 3,
  'severity/medium': 3,
  p2: 3,
  low: 1,
  'severity:low': 1,
  'severity: low': 1,
  'severity/low': 1,
  p3: 1,
}

export const DEFAULT_PERSONAS: PersonaConfig[] = [
  {
    id: 'security',
    name: 'Security Engineer',
    emoji: '🛡️',
    focus:
      'Leaked passwords, keys or tokens; places where someone could see or change data ' +
      "that isn't theirs; missing login or permission checks; unsafe handling of what " +
      'users type in; outdated dependencies with known holes.',
    tone: 'calm, protective, a little dry; never alarmist unless it really is bad',
    labels: ['security', 'vulnerability', 'type: security', 'secrets'],
    titlePatterns: ['^security\\b', '\\bvulnerabilit(y|ies)\\b', '\\bCVE-\\d'],
    checks: [{ name: 'Secret scan', run: 'builtin:secrets', weight: 6 }],
    lines: {
      happy: "All doors locked. I can't see a way in.",
      neutral: '{n} small thing{s} to tighten up. Nothing urgent.',
      worried: "{n} way{s} someone could get in where they shouldn't. I'm worried.",
      alarmed: '{n} serious hole{s} open. Please fix these before anything else.',
    },
  },
  {
    id: 'qa',
    name: 'QA Lead',
    emoji: '🧪',
    focus:
      'Things that are broken or behave wrongly for users: crashes, errors, failing or ' +
      'flaky tests, features that silently do nothing, edge cases nobody tried.',
    tone: 'friendly, practical, detail-loving',
    labels: ['bug', 'qa', 'test-failure', 'flaky-test', 'ci-failure', 'regression'],
    lines: {
      happy: 'Everything I tried works. Ship it.',
      neutral: '{n} thing{s} behave{v} oddly. Worth a look soon.',
      worried: '{n} thing{s} broken or flaky. Users will notice.',
      alarmed: '{n} problem{s}: parts of the app are breaking. Time to stop and fix.',
    },
  },
  {
    id: 'performance',
    name: 'Performance Engineer',
    emoji: '⚡',
    focus:
      'Anything that makes the app slow or expensive: slow pages and requests, heavy ' +
      'database queries, big downloads, work repeated for no reason, memory that keeps growing.',
    tone: 'upbeat, impatient with waiting, speaks in seconds people feel',
    labels: ['performance', 'perf', 'slow'],
    titlePatterns: ['\\bslow\\b', '\\blatency\\b', '\\bperformance\\b'],
    lines: {
      happy: 'Snappy. Nothing is slowing people down.',
      neutral: '{n} spot{s} feel{v} a bit slow.',
      worried: '{n} place{s} where the app is getting sluggish.',
      alarmed: '{n} serious slowdown{s}. People will give up waiting.',
    },
  },
]

export const DEFAULT_PROTECTED = [
  // CI
  '.github/workflows/**',
  '.github/actions/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  // This mod's own config
  '.team-mood.json',
  // Ignore files of checkers
  '.eslintignore',
  '.prettierignore',
  '.stylelintignore',
  '.semgrepignore',
  '.gitleaksignore',
  '.trivyignore',
  '.secretsignore',
  '.snyk',
  '.bandit',
  '.coveragerc',
  // Checker configs
  '.eslintrc',
  '.eslintrc.*',
  'eslint.config.*',
  'semgrep.yml',
  'semgrep.yaml',
  '.semgrep.yml',
  '.semgrep.yaml',
  '.semgrep/**',
  '.gitleaks.toml',
  'ruff.toml',
  '.ruff.toml',
  '.flake8',
  '.pylintrc',
  'mypy.ini',
  '.pre-commit-config.yaml',
  '.husky/**',
  'lefthook.yml',
  '.swiftlint.yml',
  'detekt.yml',
  'sonar-project.properties',
  'codecov.yml',
  '.codecov.yml',
]

export const DEFAULT_CONFIG: TeamMoodConfig = {
  refreshMinutes: 5,
  plainLanguage: true,
  model: 'haiku',
  severity: { labels: SEVERITY, default: 2 },
  thresholds: { worried: 4, alarmed: 10 },
  personas: DEFAULT_PERSONAS,
  checks: {
    enabled: true,
    debounceSeconds: 3,
    exclude: [
      'tests/**',
      'test/**',
      '**/__tests__/**',
      '**/fixtures/**',
      '*.test.*',
      '*.spec.*',
      '*.lock',
      'package-lock.json',
    ],
  },
  dashboard: { enabled: true, port: 4873 },
  protect: {
    paths: DEFAULT_PROTECTED,
    extraPaths: [],
    bash: true,
    github: true,
    suppressions: true,
  },
}

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The repo's `.team-mood.json` over the defaults. Personas merge by `id`:
 * fields given replace the default's, a new id adds a persona, `enabled: false` drops one.
 */
export function mergeConfig(raw: unknown): TeamMoodConfig {
  if (!isObject(raw)) return DEFAULT_CONFIG
  const base = DEFAULT_CONFIG
  const personas = mergePersonas(base.personas, raw.personas)
  const severity = isObject(raw.severity) ? raw.severity : {}
  const checks = isObject(raw.checks) ? raw.checks : {}
  const protect = isObject(raw.protect) ? raw.protect : {}
  const dashboard = isObject(raw.dashboard) ? raw.dashboard : {}

  return {
    refreshMinutes: num(raw.refreshMinutes, base.refreshMinutes, 1),
    plainLanguage: bool(raw.plainLanguage, base.plainLanguage),
    model: typeof raw.model === 'string' ? raw.model : base.model,
    severity: {
      labels: {
        ...base.severity.labels,
        ...lowerKeys(isObject(severity.labels) ? severity.labels : {}),
      },
      default: num(severity.default, base.severity.default, 0),
    },
    thresholds: {
      worried: num(isObject(raw.thresholds) ? raw.thresholds.worried : undefined, 4, 0),
      alarmed: num(isObject(raw.thresholds) ? raw.thresholds.alarmed : undefined, 10, 0),
    },
    personas,
    checks: {
      enabled: bool(checks.enabled, base.checks.enabled),
      debounceSeconds: num(checks.debounceSeconds, base.checks.debounceSeconds, 0),
      exclude: strings(checks.exclude) ?? base.checks.exclude,
    },
    dashboard: {
      enabled: bool(dashboard.enabled, base.dashboard.enabled),
      port: num(dashboard.port, base.dashboard.port, 0),
    },
    protect: {
      paths: strings(protect.paths) ?? base.protect.paths,
      extraPaths: strings(protect.extraPaths) ?? [],
      bash: bool(protect.bash, base.protect.bash),
      github: bool(protect.github, base.protect.github),
      suppressions: bool(protect.suppressions, base.protect.suppressions),
    },
  }
}

function mergePersonas(defaults: PersonaConfig[], raw: unknown): PersonaConfig[] {
  if (!Array.isArray(raw)) return defaults
  const out = defaults.map(p => ({ ...p }))
  for (const one of raw) {
    if (!isObject(one) || typeof one.id !== 'string') continue
    const i = out.findIndex(p => p.id === one.id)
    const merged: PersonaConfig = {
      ...(i >= 0 ? (out[i] as PersonaConfig) : blankPersona(one.id)),
      ...(one as Partial<PersonaConfig>),
      id: one.id,
    }
    if (i >= 0) out[i] = merged
    else out.push(merged)
  }

  return out.filter(p => p.enabled !== false)
}

function blankPersona(id: string): PersonaConfig {
  return { id, name: id, emoji: '🙂', focus: '', tone: 'friendly and plain-spoken' }
}

function num(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
}

function lowerKeys(o: Raw): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number') out[k.toLowerCase()] = v

  return out
}
