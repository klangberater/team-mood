import type { Board, CheckRun, Mood, MoodItem, PersonaCard, Trend } from '../types'

import type { MatchRule, PersonaConfig, TeamMoodConfig } from './config'

/** An open issue as `gh issue list --json number,title,labels,author,url,updatedAt` gives it. */
export type GhIssue = {
  number: number
  title: string
  url: string
  updatedAt: string
  labels: { name: string }[]
  author: { login: string }
  /** Present when a persona's `match` rule reads bodies. */
  body?: string
}

const anyLabel = (want: string[], issue: GhIssue) => {
  const labels = new Set(issue.labels.map(l => l.name.toLowerCase()))
  return want.some(l => labels.has(l.toLowerCase()))
}
const anyAuthor = (want: string[], issue: GhIssue) =>
  want.some(a => a.toLowerCase() === issue.author.login.toLowerCase())
const anyPattern = (want: string[], text: string) =>
  want.some(p => safeRegExp(p)?.test(text) ?? false)

function passes(rule: MatchRule, issue: GhIssue): boolean {
  if (rule.labels !== undefined && !anyLabel(rule.labels, issue)) return false
  if (rule.notLabels !== undefined && anyLabel(rule.notLabels, issue)) return false
  if (rule.authors !== undefined && !anyAuthor(rule.authors, issue)) return false
  if (rule.titlePatterns !== undefined && !anyPattern(rule.titlePatterns, issue.title)) return false
  if (rule.bodyPatterns !== undefined && !anyPattern(rule.bodyPatterns, issue.body ?? '')) return false

  return Object.keys(rule).length > 0
}

export function belongsTo(persona: PersonaConfig, issue: GhIssue): boolean {
  if (anyLabel(persona.labels ?? [], issue)) return true
  if (anyAuthor(persona.authors ?? [], issue)) return true
  if (anyPattern(persona.titlePatterns ?? [], issue.title)) return true

  return (persona.match ?? []).some(rule => passes(rule, issue))
}

/** Whether any persona's rules read issue bodies, so `gh` has to fetch them. */
export function needsBodies(config: TeamMoodConfig): boolean {
  return config.personas.some(p => (p.match ?? []).some(r => r.bodyPatterns !== undefined))
}

/** The highest severity label's weight, or the default when the issue carries none. */
export function issueWeight(config: TeamMoodConfig, issue: GhIssue): number {
  const weights = issue.labels
    .map(l => config.severity.labels[l.name.toLowerCase()])
    .filter((w): w is number => typeof w === 'number')

  return weights.length > 0 ? Math.max(...weights) : config.severity.default
}

export function moodFor(score: number, persona: PersonaConfig, config: TeamMoodConfig): Mood {
  const t = { ...config.thresholds, ...persona.thresholds }
  if (score <= 0) return 'happy'
  if (score >= t.alarmed) return 'alarmed'
  if (score >= t.worried) return 'worried'

  return 'neutral'
}

export function trendFor(score: number, previous: number | undefined): Trend {
  if (previous === undefined) return 'new'
  if (score < previous) return 'better'
  if (score > previous) return 'worse'

  return 'same'
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

const GENERIC_LINES: Record<Mood, string> = {
  happy: 'All good from where I sit.',
  neutral: '{n} small thing{s} on my list.',
  worried: "{n} thing{s} I'm worried about.",
  alarmed: '{n} serious problem{s}. Please look at these first.',
}

/** The persona's fixed sentence for its mood, used until (or instead of) a model-written one. */
export function fallbackLine(persona: PersonaConfig, mood: Mood, count: number): string {
  const template = persona.lines?.[mood] ?? GENERIC_LINES[mood]
  const n = WORDS[count] ?? String(count)

  return template
    .replaceAll('{n}', n)
    .replaceAll('{s}', count === 1 ? '' : 's')
    .replaceAll('{v}', count === 1 ? 's' : '')
}

/** Stable across refreshes while the persona's findings are the same. */
export function signature(card: Pick<PersonaCard, 'mood' | 'items'>): string {
  return `${card.mood}|${card.items.map(i => `${i.key}@${i.updatedAt ?? ''}`).join(',')}`
}

export type BoardInput = {
  config: TeamMoodConfig
  issues: GhIssue[]
  checks: Record<string, CheckRun>
  baseline: Record<string, number> | null
  lines: Record<string, string>
  repo?: string
  error?: string
  now: number
}

export function buildBoard(input: BoardInput): Board {
  const { config, issues, checks, baseline, lines } = input
  const cards = config.personas.map((persona): PersonaCard => {
    const items: MoodItem[] = issues
      .filter(issue => belongsTo(persona, issue))
      .map(issue => ({
        key: `issue:${issue.number}`,
        kind: 'issue' as const,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        updatedAt: issue.updatedAt,
        weight: issueWeight(config, issue),
      }))
    for (const run of Object.values(checks)) {
      if (run.persona !== persona.id || run.state !== 'fail') continue
      items.push({
        key: `check:${persona.id}:${run.name}`,
        kind: 'check',
        title: `Local check failing: ${run.name}`,
        weight: run.weight,
        command: run.command,
        output: run.output,
        updatedAt: String(run.ranAt),
      })
    }
    items.sort((a, b) => b.weight - a.weight)
    const score = items.reduce((sum, i) => sum + i.weight, 0)
    const mood = moodFor(score, persona, config)
    const base = { mood, items }
    const written = lines[`${persona.id}|${signature(base)}`]

    return {
      id: persona.id,
      name: persona.name,
      emoji: persona.emoji,
      mood,
      score,
      status: written ?? fallbackLine(persona, mood, items.length),
      trend: trendFor(score, baseline?.[persona.id]),
      items,
    }
  })

  return { cards, updatedAt: input.now, repo: input.repo, error: input.error }
}

export const FACES: Record<Mood, string> = {
  happy: '😊',
  neutral: '😐',
  worried: '😟',
  alarmed: '😱',
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return undefined
  }
}
