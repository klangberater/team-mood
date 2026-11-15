export type Mood = 'happy' | 'neutral' | 'worried' | 'alarmed'

export type Trend = 'better' | 'worse' | 'same' | 'new'

/** One thing a persona is unhappy about: an open issue or a failing local check. */
export type MoodItem = {
  key: string
  kind: 'issue' | 'check'
  title: string
  weight: number
  number?: number
  url?: string
  updatedAt?: string
  /** For a check: the command that failed, to hand to Claude. */
  command?: string
  /** For a check: the tail of its output (secrets masked). */
  output?: string
}

export type PersonaCard = {
  id: string
  name: string
  emoji: string
  mood: Mood
  score: number
  status: string
  trend: Trend
  items: MoodItem[]
}

export type Board = {
  cards: PersonaCard[]
  updatedAt: number
  repo?: string
  error?: string
}

export type CheckRun = {
  persona: string
  name: string
  state: 'pass' | 'fail' | 'skipped'
  command: string
  output: string
  weight: number
  ranAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'team-mood': {
      board: Board | null
      open: string | null
      busy: boolean
      checks: Record<string, CheckRun>
      baseline: Record<string, number> | null
      lines: Record<string, string>
      plain: Record<string, string>
      /** The guard's reason while its question is up. */
      alert: string | null
    }
  }
}
