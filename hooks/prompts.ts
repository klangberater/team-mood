import type { MoodItem } from '../types'

import type { PersonaConfig } from './config'

const NO_GAMING =
  "Fix the real cause: don't weaken, skip or switch off any check, test, CI workflow or " +
  "ignore list to make it go away, and don't close the issue yourself; the check that " +
  'found it should confirm the fix.'

const ENDING = 'Then explain in simple terms what you changed and why it matters.'

/** What "Fix this" sends Claude. */
export function fixPrompt(p: PersonaConfig, item: MoodItem): string {
  const cares = p.focus ? ` (What the ${p.name} cares about: ${p.focus})` : ''
  if (item.kind === 'issue') {
    return (
      `The ${p.name} is unhappy about issue #${item.number} ("${item.title}"). ` +
      `Read it with \`gh issue view ${item.number}\` and fix the underlying problem in the code. ` +
      `${ENDING} ${NO_GAMING}${cares}`
    )
  }
  if (item.command === 'secret scan') {
    return (
      `The ${p.name} is unhappy: the secret scan found what look like passwords or keys ` +
      `written into the code at:\n${item.output ?? ''}\n\nMove each one out of the code ` +
      '(for example into an environment variable), and tell me which keys should be replaced ' +
      `because they were exposed. ${ENDING} ${NO_GAMING}`
    )
  }
  const name = item.title.replace(/^Local check failing: /, '')

  return (
    `The ${p.name} is unhappy: the local check "${name}" fails. Run \`${item.command ?? ''}\` ` +
    `to see the problem and fix the underlying code. Its last output ended with:\n` +
    `${item.output ?? ''}\n\n${ENDING} ${NO_GAMING}${cares}`
  )
}

/** What "Get a check-up" sends Claude: the persona's brief, over the whole codebase. */
export function checkupPrompt(p: PersonaConfig): string {
  return (
    `Act as the ${p.name} on this project. What you look for: ${p.focus} ` +
    'Review the whole codebase from that angle, not just recent changes. Tell me the most ' +
    'important problems you find in plain, non-technical language, most serious first, with ' +
    "what could go wrong for the people using the app. Don't change anything yet; ask me " +
    'which ones to fix.'
  )
}
