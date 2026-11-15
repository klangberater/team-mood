import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Mood, PersonaCard, Trend } from '../types'

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
    })
    wantEverything()
    $.clock.every(5_000, () => later($, () => tick($)))
    later($, () => tick($))
    void $.ui.open({ id: PANE, title: TITLE, rows: ROWS })

    return next(e)
  })

  on('command.run', { command: 'team-mood' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, rows: ROWS, focus: true })
    wantEverything()
    later($, () => tick($))

    return {
      text: opened.isPlaced ? 'Team Mood is open.' : 'Team Mood will show when there is room.',
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
