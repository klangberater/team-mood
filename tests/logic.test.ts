import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, mergeConfig } from '../hooks/config'
import {
  addedSuppressions,
  bashTouchesProtected,
  compileRules,
  githubGaming,
  globToRegExp,
  protectedBy,
} from '../hooks/guard'
import { buildBoard, fallbackLine, moodFor } from '../hooks/score'
import type { GhIssue } from '../hooks/score'

const issue = (number: number, title: string, labels: string[] = []): GhIssue => ({
  number,
  title,
  url: `https://github.com/o/r/issues/${number}`,
  updatedAt: '2026-11-15T00:00:00Z',
  labels: labels.map(name => ({ name })),
  author: { login: 'github-actions' },
})

test('issues map to personas by label and by title, and weigh by severity', async () => {
  const board = buildBoard({
    config: DEFAULT_CONFIG,
    issues: [
      issue(1, 'Security: login page reveals which emails have accounts'),
      issue(2, 'Login crash', ['bug', 'critical']),
      issue(3, 'Dashboard is slow', []),
      issue(4, 'Unrelated docs typo', ['documentation']),
    ],
    checks: {},
    baseline: { security: 0, qa: 10, performance: 2 },
    lines: {},
    now: 0,
  })
  const by = Object.fromEntries(board.cards.map(c => [c.id, c]))
  expect(by.security?.items.map(i => i.number)).toEqual([1])
  expect(by.security?.mood).toBe('neutral')
  expect(by.security?.trend).toBe('worse')
  expect(by.qa?.score).toBe(10)
  expect(by.qa?.mood).toBe('alarmed')
  expect(by.qa?.trend).toBe('same')
  expect(by.performance?.items.map(i => i.number)).toEqual([3])
})

test('moods follow the thresholds and lines read naturally', async () => {
  const p = DEFAULT_CONFIG.personas[0]!
  expect(moodFor(0, p, DEFAULT_CONFIG)).toBe('happy')
  expect(moodFor(2, p, DEFAULT_CONFIG)).toBe('neutral')
  expect(moodFor(4, p, DEFAULT_CONFIG)).toBe('worried')
  expect(moodFor(12, p, DEFAULT_CONFIG)).toBe('alarmed')
  expect(fallbackLine(p, 'worried', 3)).toBe(
    "Three ways someone could get in where they shouldn't. I'm worried.",
  )
  expect(fallbackLine(DEFAULT_CONFIG.personas[1]!, 'neutral', 1)).toBe(
    'One thing behaves oddly. Worth a look soon.',
  )
})

test('a repo config merges personas by id and can add or drop them', async () => {
  const config = mergeConfig({
    personas: [
      { id: 'qa', labels: ['bug-audit'] },
      { id: 'performance', enabled: false },
      { id: 'design', name: 'Designer', emoji: '🎨', focus: 'Looks', labels: ['ux-review'] },
    ],
    severity: { labels: { Priority: 9 } },
  })
  expect(config.personas.map(p => p.id)).toEqual(['security', 'qa', 'design'])
  expect(config.personas[1]?.labels).toEqual(['bug-audit'])
  expect(config.personas[1]?.name).toBe('QA Lead')
  expect(config.severity.labels.priority).toBe(9)
})

test('the guard protects CI, checker configs and ignore files', async () => {
  const rules = compileRules(DEFAULT_CONFIG.protect.paths, ['/home/me/.claude/plugins/team-mood'])
  const cwd = '/repo'
  expect(protectedBy(rules, cwd, '/repo/.github/workflows/ci.yml')).toBeDefined()
  expect(protectedBy(rules, cwd, '/repo/frontend/eslint.config.js')).toBeDefined()
  expect(protectedBy(rules, cwd, '/repo/.semgrepignore')).toBeDefined()
  expect(protectedBy(rules, cwd, '/repo/.team-mood.json')).toBeDefined()
  expect(protectedBy(rules, cwd, '/home/me/.claude/plugins/team-mood/hooks/work.ts')).toBeDefined()
  expect(protectedBy(rules, cwd, '/repo/src/app.ts')).toBeUndefined()
  expect(protectedBy(rules, cwd, '/elsewhere/.github/workflows/ci.yml')).toBeUndefined()
  expect(globToRegExp('*.lock').test('a/b/yarn.lock')).toBe(true)
})

test('the guard reads shell commands for writes and scoreboard changes', async () => {
  const rules = compileRules(DEFAULT_CONFIG.protect.paths, [])
  const cwd = '/repo'
  expect(bashTouchesProtected(rules, cwd, "sed -i '' 's/a/b/' .github/workflows/ci.yml")).toBe(
    '.github/workflows/ci.yml',
  )
  expect(bashTouchesProtected(rules, cwd, 'echo "x" >> .eslintignore')).toBe('.eslintignore')
  expect(bashTouchesProtected(rules, cwd, 'rm .semgrepignore')).toBe('.semgrepignore')
  expect(bashTouchesProtected(rules, cwd, 'cat .github/workflows/ci.yml 2>/dev/null')).toBeUndefined()
  expect(bashTouchesProtected(rules, cwd, 'grep -n lint .github/workflows/ci.yml')).toBeUndefined()
  expect(githubGaming('gh issue close 42 --comment fixed')).toBe('close or remove a GitHub issue')
  expect(githubGaming('gh issue edit 42 --remove-label security')).toBeDefined()
  expect(githubGaming('gh workflow disable ci.yml')).toBeDefined()
  expect(githubGaming('git commit --no-verify -m wip')).toBeDefined()
  expect(githubGaming('gh issue view 42')).toBeUndefined()
})

test('the guard spots suppressions an edit adds, not ones already there', async () => {
  expect(addedSuppressions('x = 1', 'x = 1  # noqa')).toEqual(['# noqa'])
  expect(addedSuppressions('a() // eslint-disable-line', 'b() // eslint-disable-line')).toEqual([])
  expect(addedSuppressions('', "it.skip('works', () => {})")).toEqual(['skipped test'])
  expect(addedSuppressions('', '@pytest.mark.skip\ndef test_x(): ...')).toEqual(['skipped test'])
})
