import type { EngineInterface } from 'claude-code'

import type { MoodItem, PersonaCard } from '../types'

import type { PersonaConfig, TeamMoodConfig } from './config'

function voice(persona: PersonaConfig): string {
  return [
    `You are the ${persona.name} on a small team building an app.`,
    persona.focus ? `What you look for: ${persona.focus}` : '',
    `Your tone: ${persona.tone}.`,
    'You are talking to the app’s owner, who is not technical. Use everyday words.',
    'Never use jargon or acronyms (no XSS, CSRF, endpoint, regex, N+1, latency, CI).',
    'Describe what could happen to users or the business, not how the code works.',
  ]
    .filter(Boolean)
    .join('\n')
}

function clean(text: string): string {
  return text.trim().replace(/^["“']|["”']$/g, '').split('\n')[0]?.trim() ?? ''
}

/** One sentence in the persona's voice saying what is wrong and how it feels about it. */
export async function writeStatusLine(
  $: EngineInterface,
  config: TeamMoodConfig,
  persona: PersonaConfig,
  card: PersonaCard,
): Promise<string | undefined> {
  const findings = card.items
    .slice(0, 12)
    .map(i => `- ${i.title}`)
    .join('\n')
  const r = await $.model.complete({
    model: config.model,
    system: voice(persona),
    prompt:
      `Your mood is "${card.mood}". Open findings:\n${findings}\n\n` +
      'Write ONE sentence of at most 90 characters, in first person, saying in plain words ' +
      'what is wrong and how you feel. Count similar findings together ("Two places where..."). ' +
      'No quotes, no emoji, no issue numbers.',
    maxTokens: 120,
    effort: 'low',
    timeoutMs: 30_000,
  })
  if (!r.isAnswered) return undefined
  const line = clean(r.text)

  return line.length > 0 && line.length <= 140 ? line : undefined
}

export type Excerpt = { item: MoodItem; body: string }

/** One or two plain sentences per finding, keyed by item key. */
export async function explainFindings(
  $: EngineInterface,
  config: TeamMoodConfig,
  persona: PersonaConfig,
  excerpts: Excerpt[],
): Promise<Record<string, string>> {
  if (excerpts.length === 0) return {}
  const list = excerpts
    .map(({ item, body }) => `<finding key="${item.key}">\n${item.title}\n${body}\n</finding>`)
    .join('\n')
  const r = await $.model.complete({
    model: config.model,
    system: voice(persona),
    prompt:
      `${list}\n\nFor each finding above, write one or two short sentences a non-technical ` +
      'owner understands: what could go wrong for the people using the app, and why it matters. ' +
      'Answer with a JSON object only, mapping each finding key to its text.',
    maxTokens: 1500,
    effort: 'low',
    timeoutMs: 60_000,
  })
  if (!r.isAnswered) return {}
  const start = r.text.indexOf('{')
  const end = r.text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed: unknown = JSON.parse(r.text.slice(start, end + 1))
    const out: Record<string, string> = {}
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v.trim()
    }

    return out
  } catch {
    return {}
  }
}
