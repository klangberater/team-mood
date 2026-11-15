import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ISSUES = [
  {
    number: 42,
    title: 'Security: login page reveals which emails have accounts',
    url: 'https://github.com/o/r/issues/42',
    updatedAt: '2026-11-14T00:00:00Z',
    labels: [],
    author: { login: 'klangberater' },
  },
  {
    number: 57,
    title: 'Login crashes for new users',
    url: 'https://github.com/o/r/issues/57',
    updatedAt: '2026-11-14T00:00:00Z',
    labels: [{ name: 'bug' }],
    author: { login: 'app/sentry' },
  },
]

const PANE = {
  plugin: 'team-mood',
  component: 'Pane',
  requestId: 'team-mood',
  props: {
    title: 'Team Mood',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** The engine beneath the plugin: gh answers ISSUES, no config file, no model. */
function world(on: On, submitted: string[]) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'latest:/repo': { security: 0, qa: 2, performance: 0 } })
  on('command.register', () => ({ value: { command: 'team-mood' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'ENOENT: no such file' }))
  on('fs.stat', () => ({ deny: 'ENOENT: no such file' }))
  on('model.complete', () => ({
    value: {
      isAnswered: false,
      reason: 'empty-reply',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }))
  on('process.run', (_, e) => {
    const [cmd, sub] = e.argv
    const ok = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (cmd === 'gh' && sub === 'issue') return ok(JSON.stringify(ISSUES))
    if (cmd === 'gh' && sub === 'repo') return ok('o/r\n')
    if (cmd === 'git') return ok('', 1) // secret scan: nothing found

    return ok('', 127)
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return clock
}

test('the pane shows each persona, its mood and trend, on every surface', async ($, on) => {
  const clock = world(on, [])
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Security Engineer/ }))?.text).toContain('🛡️')
    expect((await ui.find({ type: 'Text', text: /Okay/ }))?.text).toContain('worse than last session')
    expect(await ui.find({ type: 'Text', text: /Performance Engineer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Snappy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /o\/r/ })).toBeDefined()
    await ui.unmount()
  }
})

test('opening a persona lists its issues and Fix this asks Claude', async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, submitted)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-security' })
  await clock.advance(10)
  expect((await ui.find({ type: 'Text', text: /#42/ }))?.text).toContain('reveals which emails')
  await ui.press({ key: 'fix-issue:42' })
  await clock.advance(10)
  expect(submitted[0]).toContain('The Security Engineer is unhappy about issue #42')
  expect(submitted[0]).toContain("don't close the issue yourself")
  await ui.unmount()
})

test('the guard puts a CI edit to the person, and lets ordinary edits through', async ($, on) => {
  const clock = world(on, [])
  on('tool.check', () => ({ decision: 'allow' }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)

  const ci = await $.tool.check({
    tool: 'Edit',
    input: { file_path: '/repo/.github/workflows/ci.yml', old_string: 'a', new_string: 'b' },
  })
  expect(ci.decision).toBe('ask')
  expect(ci.reason).toContain('.github/workflows/ci.yml')

  const noqa = await $.tool.check({
    tool: 'Edit',
    input: { file_path: '/repo/src/app.py', old_string: 'x = 1', new_string: 'x = 1  # noqa' },
  })
  expect(noqa.decision).toBe('ask')

  const close = await $.tool.check({ tool: 'Bash', input: { command: 'gh issue close 42' } })
  expect(close.decision).toBe('ask')

  const fine = await $.tool.check({
    tool: 'Edit',
    input: { file_path: '/repo/src/app.py', old_string: 'x = 1', new_string: 'x = 2' },
  })
  expect(fine.decision).toBe('allow')
})
