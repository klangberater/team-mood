/**
 * The anti-gaming guard's rules, as pure functions. Moods must only improve by
 * fixing things, never by weakening the checks that measure them.
 */

/** A gitignore-style glob as a RegExp: a pattern without "/" matches the name in any folder. */
export function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/')
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      out += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${out}$`, 'i')
}

/** The path relative to the project root, or undefined when it lies outside it. */
export function relativeTo(root: string, path: string): string | undefined {
  const r = root.replace(/\/+$/, '')
  if (!path.startsWith('/')) return path.replace(/^\.\//, '')
  if (path.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return path.slice(r.length + 1)

  return undefined
}

export type ProtectRules = { patterns: RegExp[]; roots: string[] }

export function compileRules(paths: string[], absoluteRoots: string[]): ProtectRules {
  return { patterns: paths.map(globToRegExp), roots: absoluteRoots.map(r => r.replace(/\/+$/, '')) }
}

/** The pattern or root a path falls under, if any. */
export function protectedBy(
  rules: ProtectRules,
  cwd: string,
  path: string,
): string | undefined {
  const lower = path.toLowerCase()
  const root = rules.roots.find(r => lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}/`))
  if (root !== undefined) return root
  const rel = relativeTo(cwd, path)
  if (rel === undefined) return undefined
  const hit = rules.patterns.find(p => p.test(rel))

  return hit?.source
}

const WRITE_VERBS =
  /(^|[\s;&|(])(rm|mv|cp|tee|truncate|chmod|ln|install|dd|unlink)\s|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bgit\s+(rm|mv|checkout|restore|apply)\b|\b(python3?|node|ruby)\s+-[ce]\b/

const REDIRECT = /(?:^|[^0-9&>])>>?\s*([^\s;&|)]+)/g

const unquote = (w: string) => w.replace(/^['"]|['"]$/g, '')

/**
 * A protected file a shell command might write: a redirect into it, or a
 * writing command that names it. Best effort: a command can always write a
 * file it never names.
 */
export function bashTouchesProtected(
  rules: ProtectRules,
  cwd: string,
  command: string,
): string | undefined {
  for (const [, target] of command.matchAll(REDIRECT)) {
    const file = unquote(target ?? '')
    if (file !== '' && protectedBy(rules, cwd, file) !== undefined) return file
  }
  if (!WRITE_VERBS.test(command)) return undefined
  const words = command.split(/[\s;&|<>()`=]+/).map(unquote).filter(w => w.length > 0)

  return words.find(word => protectedBy(rules, cwd, word) !== undefined)
}

const GH_GAMING: [RegExp, string][] = [
  [/\bgh\s+issue\s+(close|delete|transfer|lock)\b/, 'close or remove a GitHub issue'],
  [/\bgh\s+issue\s+edit\b.*--(remove|add)-label\b/, "change a GitHub issue's labels"],
  [/\bgh\s+label\s+(delete|edit)\b/, 'change GitHub labels'],
  [/\bgh\s+workflow\s+disable\b/, 'turn off a CI workflow'],
  [/\bgh\s+run\s+cancel\b/, 'cancel a CI run'],
  [
    /\bgh\s+api\b.*\/(issues|labels)\b.*(-X|--method)\s*(PATCH|DELETE|PUT)/i,
    'change GitHub issues through the API',
  ],
  [/\bgit\s+commit\b.*--no-verify\b/, "skip the repository's commit checks"],
  [/\bgit\s+push\b.*--no-verify\b/, "skip the repository's push checks"],
]

/** What a shell command would do to the scoreboard itself, in plain words. */
export function githubGaming(command: string): string | undefined {
  return GH_GAMING.find(([re]) => re.test(command))?.[1]
}

const SUPPRESSIONS: [RegExp, string][] = [
  [/eslint-disable/g, 'eslint-disable'],
  [/@ts-(ignore|nocheck|expect-error)/g, '@ts-ignore'],
  [/#\s*noqa\b/g, '# noqa'],
  [/#\s*nosec\b/g, '# nosec'],
  [/nosemgrep/g, 'nosemgrep'],
  [/gitleaks:allow/g, 'gitleaks:allow'],
  [/#\s*type:\s*ignore/g, '# type: ignore'],
  [/pragma:\s*no\s*cover/g, 'pragma: no cover'],
  [/(istanbul|c8)\s+ignore/g, 'coverage ignore'],
  [/NOSONAR/g, 'NOSONAR'],
  [/swiftlint:disable/g, 'swiftlint:disable'],
  [/@Suppress(Warnings)?\(/g, '@Suppress'],
  [/\b(it|test|describe)\.(skip|todo|fixme)\(/g, 'skipped test'],
  [/\b(xit|xdescribe|xtest)\(/g, 'skipped test'],
  [/@pytest\.mark\.(skip|skipif|xfail)\b/g, 'skipped test'],
  [/@unittest\.skip/g, 'skipped test'],
]

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length
}

/** The suppressions `after` has more of than `before`: each one hides a finding instead of fixing it. */
export function addedSuppressions(before: string, after: string): string[] {
  const found = new Set<string>()
  for (const [re, name] of SUPPRESSIONS) if (count(re, after) > count(re, before)) found.add(name)

  return [...found]
}
