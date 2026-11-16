import { expect, mock, test } from 'claude-code/testing'
import type { On, UiOpenResult } from 'claude-code'

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
type World = {
  placed?: UiOpenResult
  files?: Record<string, string>
  env?: Record<string, string>
  ran?: (readonly string[])[]
}

function world(
  on: On,
  submitted: string[],
  { placed = { isPlaced: true }, files = {}, env = {}, ran = [] }: World = {},
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { 'latest:/repo': { security: 0, qa: 2, performance: 0 } })
  on('command.register', () => ({ value: { command: 'team-mood' } }))
  on('ui.open', () => ({ value: placed }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  mock.env(on, env)
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path] as string } : { deny: 'ENOENT: no such file' }))
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
    ran.push(e.argv)
    const [cmd, sub] = e.argv
    const ok = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (cmd === 'gh' && sub === 'issue') return ok(JSON.stringify(ISSUES))
    if (cmd === 'gh' && sub === 'repo') return ok('o/r\n')
    if (cmd === 'git') return ok('', 1) // secret scan: nothing found
    if (cmd === 'tailscale') {
      return ok(JSON.stringify({ Self: { TailscaleIPs: ['100.64.0.7', 'fd7a::7'], DNSName: 'mac.tail.ts.net.' } }))
    }
    if (cmd === 'mkdir' || cmd === 'rm' || cmd === '/bin/sh') return ok('')

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

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

test('where no panel can be placed, /team-mood answers in text with typed actions', async ($, on) => {
  const submitted: string[] = []
  const clock = world(on, submitted, { placed: { isPlaced: false, reason: 'no-surface: nothing is attached' } })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.advance(1000)

  const list = await $.command.run({ command: 'team-mood', args: '', ...RUN })
  expect(list.text).toContain('🛡️ Security Engineer: 😐 Okay')
  expect(list.text).toContain('Security: login page reveals which emails have accounts')
  expect(list.text).toContain('/team-mood fix 42')
  expect(list.text).toContain('/team-mood checkup performance')
  expect(list.text).toContain("can't be shown here: no-surface: nothing is attached")

  const fix = await $.command.run({ command: 'team-mood', args: 'fix #42', ...RUN })
  expect(fix.text).toBe('Asked Claude to fix issue #42 for the Security Engineer.')
  const checkup = await $.command.run({ command: 'team-mood', args: 'checkup qa', ...RUN })
  expect(checkup.text).toBe('Asked Claude for a QA Lead check-up.')
  await clock.advance(10)
  expect(submitted[0]).toContain('The Security Engineer is unhappy about issue #42')
  expect(submitted[1]).toContain('Act as the QA Lead')

  const unknown = await $.command.run({ command: 'team-mood', args: 'fix 999', ...RUN })
  expect(unknown.text).toContain('Nothing on the team')
})

test('the page: the mod starts it, posts the team to it, and sends its presses to Claude', async ($, on) => {
  const submitted: string[] = []
  const info = '/home/me/.team-mood/-repo/server.json'
  const clock = world(on, submitted, {
    env: { HOME: '/home/me' },
    files: { [info]: JSON.stringify({ port: 4873, token: 'mod-token' }) },
  })
  const posted: string[] = []
  let presses = [{ kind: 'fix', target: '42' }]
  on('http.fetch', (_, e) => {
    const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    if (e.url.endsWith('/state') && e.init?.method === 'POST') {
      expect(e.init.headers?.['X-Team-Mood-Token']).toBe('mod-token')
      posted.push(String(e.init.body))
      return ok('')
    }
    if (e.url.endsWith('/actions')) {
      const taken = presses
      presses = []
      return ok(JSON.stringify(taken))
    }
    return ok('{}')
  })
  const reported: unknown[] = []
  on('tool.call', (_, e) => {
    reported.push(e)
    return { result: {} }
  })

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.advance(6000)
  await clock.advance(6000)

  const last = JSON.parse(posted.at(-1) ?? '{}')
  expect(last.board.cards[0].items[0].handle).toBe('42')
  expect(submitted[0]).toContain('The Security Engineer is unhappy about issue #42')
  expect(reported).toContainEqual(
    expect.objectContaining({ tool: 'mcp__claude-code-remote__report_preview_port', port: 4873 }),
  )
})

test('shared on Tailscale, the page listens there too and is given by its Tailscale name', { options: { dashboardHost: 'tailscale' } }, async ($, on) => {
  const ran: (readonly string[])[] = []
  const info = '/home/me/.team-mood/-repo/server.json'
  const files: Record<string, string> = {}
  const clock = world(on, [], {
    placed: { isPlaced: false, reason: 'no-surface' },
    env: { HOME: '/home/me' },
    files,
    ran,
  })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '[]' } }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await clock.advance(100)
  // The server "starts": it writes its info file, as serve.py does.
  files[info] = JSON.stringify({ port: 4873, token: 't', pid: 1, hosts: ['127.0.0.1', '100.64.0.7'] })
  await clock.advance(6000)

  const start = ran.find(argv => argv[0] === '/bin/sh') ?? []
  expect(start).toContain('100.64.0.7')
  expect(start.filter(a => a === '--host')).toHaveLength(2)
  const text = (await $.command.run({ command: 'team-mood', args: '', ...RUN })).text
  expect(text).toContain('http://mac.tail.ts.net:4873')
})
