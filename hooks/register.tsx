import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mood, MoodItem, PersonaCard, Trend } from '../types'

import { checkupPrompt, fixPrompt } from './prompts'
import { FACES } from './score'
import {
  explain,
  guardReason,
  later,
  loadBaseline,
  loadConfig,
  persona,
  plainKey,
  S,
  tick,
  wantEverything,
} from './work'

// The same state work.ts writes; the state scan needs each reference written in the file that reads it.
const board = atom({ plugin: 'team-mood', key: 'board' } as const, null)
const openCard = atom({ plugin: 'team-mood', key: 'open' } as const, null)
const busy = atom({ plugin: 'team-mood', key: 'busy' } as const, false)
const plain = atom({ plugin: 'team-mood', key: 'plain' } as const, {})
const alert = atom({ plugin: 'team-mood', key: 'alert' } as const, null)

const PANE = 'team-mood'
const TITLE = 'Team Mood'
// Inline (narrow terminals), room for three cards and the footer; the dock ignores it.
const ROWS = 24

const MOOD_COLOR: Record<Mood, string> = {
  happy: 'success',
  neutral: 'subtle',
  worried: 'warning',
  alarmed: 'error',
}

const MOOD_WORD: Record<Mood, string> = {
  happy: 'Happy',
  neutral: 'Okay',
  worried: 'Worried',
  alarmed: 'Alarmed',
}

const TREND: Record<Trend, string> = {
  better: '↗ better than last session',
  worse: '↘ worse than last session',
  same: 'same as last session',
  new: '',
}

const HELP = 'Try /team-mood to see the list, /team-mood fix <issue>, or /team-mood checkup <persona>.'

/** What `/team-mood fix` takes for an item: the issue number, or the check's name as a slug. */
function handleOf(item: MoodItem): string {
  if (item.number !== undefined) return String(item.number)

  return item.title
    .replace(/^Local check failing: /, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function label(item: MoodItem): string {
  return item.number !== undefined ? `issue #${item.number}` : `"${item.title}"`
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`

  return `${Math.floor(min / 60)} h ago`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.cwd = e.cwd
    await loadConfig($)
    await loadBaseline($)
    await $.command.register({
      name: 'team-mood',
      description: 'Show how the Security, QA and Performance personas feel about this app',
      argumentHint: '[fix <issue> | checkup <persona>]',
    })
    wantEverything()
    $.clock.every(5_000, () => later($, () => tick($)))
    later($, () => tick($))
    void $.ui.open({ id: PANE, title: TITLE, rows: ROWS })

    return next(e)
  })

  // `/team-mood` opens the panel; where none can show (remote mode, headless) it answers in text.
  // `/team-mood fix <issue>` and `/team-mood checkup <persona>` are the panel's buttons, typed.
  on('command.run', { command: 'team-mood' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const target = rest.join(' ').replace(/^#/, '').toLowerCase()
    const b = await read($, board)
    const cards = b?.cards ?? []

    if (verb.toLowerCase() === 'fix') {
      const hit = cards
        .flatMap(c => c.items.map(item => ({ c, item })))
        .find(({ item }) => handleOf(item) === target)
      const p = hit ? persona(hit.c.id) : undefined
      if (hit === undefined || p === undefined) {
        return { text: `Nothing on the team's list is called "${target}". ${HELP}` }
      }
      later($, () => $.prompt.submit({ text: fixPrompt(p, hit.item), asUser: true }))

      return { text: `Asked Claude to fix ${label(hit.item)} for the ${p.name}.` }
    }

    if (verb.toLowerCase() === 'checkup') {
      const p = S.config.personas.find(
        one => one.id.toLowerCase() === target || one.name.toLowerCase().includes(target),
      )
      if (target === '' || p === undefined) {
        const ids = S.config.personas.map(one => one.id).join(', ')
        return { text: `Which persona? One of: ${ids}. ${HELP}` }
      }
      later($, () => $.prompt.submit({ text: checkupPrompt(p), asUser: true }))

      return { text: `Asked Claude for a ${p.name} check-up.` }
    }

    const opened = await $.ui.open({ id: PANE, title: TITLE, rows: ROWS, focus: true })
    wantEverything()
    later($, () => tick($))
    if (opened.isPlaced) return { text: 'Team Mood is open.' }
    if (cards.length === 0) return { text: 'Still asking the team; run /team-mood again in a moment.' }

    // No panel here: the moods as text, each finding in plain words with its fix command.
    for (const c of cards) if (c.items.length > 0) await explain($, c.id)
    const words = await read($, plain)
    const blocks = cards.map(c => {
      const trend = TREND[c.trend] ? ` (${TREND[c.trend]})` : ''
      const items = c.items.slice(0, 5).map(item => {
        const said = words[plainKey(item)] ?? item.title
        return `\n  • ${said}\n    → /team-mood fix ${handleOf(item)}`
      })
      const more = c.items.length > 5 ? `\n  …and ${c.items.length - 5} more.` : ''
      const checkup = c.items.length === 0 ? `\n  → /team-mood checkup ${c.id}` : ''

      return (
        `${c.emoji} ${c.name}: ${FACES[c.mood]} ${MOOD_WORD[c.mood]}${trend}\n` +
        `  “${c.status}”${items.join('')}${more}${checkup}`
      )
    })

    return {
      text:
        `${blocks.join('\n\n')}\n\n` +
        `(The panel can't be shown here: ${opened.reason}. These commands do what its buttons do.)`,
    }
  })

  on('turn.complete', ($, e, next) => {
    S.wantRefresh = true

    return next(e)
  })

  // Any change Claude makes re-runs the local checks once edits settle.
  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, async ($, e, next) => {
    // The guard's question (tool.check, beneath) shows no reason of its own: say it while it is up.
    const { tool_use_id: _id, tool, ...input } = e
    const reason = await guardReason($, String(tool), input)
    if (reason !== undefined) {
      await update($, alert, () => reason)
      $.ui.toast(reason, { timeoutMs: 20_000 })
    }
    const ran = await next(e).finally(() => {
      if (reason !== undefined) void update($, alert, () => null)
    })
    if (ran.deny === undefined && ran.isError !== true && ran.isReadOnly !== true) {
      S.lastEdit = await $.clock.now()
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The anti-gaming guard: changes that could improve a mood without fixing anything
  // go to the person, whatever the permission mode. Nobody to ask means no.
  on('tool.check', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, async ($, e, next) => {
    const reason = await guardReason($, String(e.tool), e.input)
    const below = await next(e)
    if (reason === undefined || below.decision === 'deny') return below

    return { decision: 'ask', reason }
  }).catch(($, e, next) =>
    next.called
      ? next(e)
      : {
          decision: 'ask',
          reason: 'Team Mood could not check this change, so please confirm it yourself.',
        },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const open = await read($, openCard)
    const isBusy = await read($, busy)
    const words = await read($, plain)
    const warning = await read($, alert)

    if (b === null) return <Text dimColor>Asking the team how they feel…</Text>

    const toggle = (id: string) => async () => {
      const isOpening = (await read($, openCard)) !== id
      await update($, openCard, () => (isOpening ? id : null))
      if (isOpening) later($, () => explain($, id))
    }
    const send = (text: string, what: string) => () => {
      later($, () => $.prompt.submit({ text, asUser: true }))
      $.ui.toast(`Sent to Claude: ${what}`)
    }
    const refreshNow = () => {
      wantEverything()
      later($, () => tick($))
    }

    const card = (c: PersonaCard) => {
      const p = persona(c.id)
      const isOpen = open === c.id
      const shown = c.items.slice(0, 8)
      const trend = TREND[c.trend]

      return (
        <Box
          key={`card-${c.id}`}
          flexDirection="column"
          borderStyle="round"
          borderColor={MOOD_COLOR[c.mood]}
          paddingX={1}
        >
          <Text bold>
            {c.emoji} {c.name}
          </Text>
          <Text color={MOOD_COLOR[c.mood]}>
            {FACES[c.mood]} {MOOD_WORD[c.mood]}
            {trend ? <Text dimColor> · {trend}</Text> : ''}
          </Text>
          <Text>{c.status}</Text>
          {c.items.length > 0 && (
            <Button key={`open-${c.id}`} plain onPress={toggle(c.id)}>
              {isOpen ? '▾ Hide details' : `▸ What's wrong? (${c.items.length})`}
            </Button>
          )}
          {p !== undefined && c.items.length === 0 && (
            <Button
              key={`checkup-${c.id}`}
              plain
              onPress={send(checkupPrompt(p), `${c.name} check-up`)}
            >
              ▸ Get a check-up
            </Button>
          )}
          {isOpen && p !== undefined && (
            <Box flexDirection="column" gap={1} marginTop={1}>
              {shown.map(item => (
                <Box key={`item-${item.key}`} flexDirection="column">
                  <Text bold>
                    {item.number !== undefined ? `#${item.number} ` : ''}
                    {item.title}
                  </Text>
                  <Text dimColor>
                    {words[plainKey(item)] ??
                      (S.config.plainLanguage ? 'Putting this into plain words…' : '')}
                  </Text>
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key={`fix-${item.key}`}
                      label="Fix this"
                      variant="primary"
                      onPress={send(
                        fixPrompt(p, item),
                        `fix ${item.number !== undefined ? `#${item.number}` : item.title}`,
                      )}
                    />
                    {item.url !== undefined && (
                      <Link key={`link-${item.key}`} href={item.url} label="Open on GitHub" />
                    )}
                  </Box>
                </Box>
              ))}
              {c.items.length > shown.length && (
                <Text dimColor>…and {c.items.length - shown.length} more.</Text>
              )}
              <Button
                key={`checkup-${c.id}`}
                plain
                onPress={send(checkupPrompt(p), `${c.name} check-up`)}
              >
                ▸ Ask for a full check-up
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} width={e.props.bodyColumns}>
        {warning !== null && (
          <Box key="alert" borderStyle="bold" borderColor="error" paddingX={1}>
            <Text color="error">⚠ {warning}</Text>
          </Box>
        )}
        {b.error !== undefined && <Text color="warning">{b.error}</Text>}
        {b.cards.map(card)}
        <Box flexDirection="row" gap={1}>
          <Text dimColor>
            {isBusy ? 'Checking…' : `Updated ${ago(Date.now() - b.updatedAt)}`}
            {b.repo !== undefined ? ` · ${b.repo}` : ''}
          </Text>
          <Button key="refresh" plain onPress={refreshNow}>
            ↻ Refresh
          </Button>
        </Box>
      </Box>
    )
  })
}
