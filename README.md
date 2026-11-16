# Team Mood

A Claude Code mod that turns your CI findings into a small team of personas sitting beside the
chat: a **Security Engineer** 🛡️, a **QA Lead** 🧪 and a **Performance Engineer** ⚡. Each shows a
mood (😊 happy, 😐 okay, 😟 worried, 😱 alarmed), one plain-language sentence about the app, and
whether things got better or worse since the last session. Click a persona to see what's wrong in
everyday words, then press **Fix this** to hand the problem to Claude.

It is built for people who make apps with Claude Code without being engineers. Moods reflect the
whole codebase (every open issue, and checks over the whole project), not just the latest change.

For the people you install it for, see [PERSONAS.md](PERSONAS.md).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install team-mood --marketplace klangberater/team-mood
```

Answer `y` to add the marketplace, then pick the **user** scope so it runs in every project.

From a shell instead: `claude plugin install team-mood --marketplace klangberater/team-mood`.
In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with
`klangberater/team-mood` → **Add plugin**.

### What each machine needs

- A recent Claude Code (the mod uses function hooks, which are early access).
- The GitHub CLI, signed in: `brew install gh` (or see cli.github.com), then `gh auth login`.
  Without it, Team Mood still runs local checks and says GitHub can't be reached.
- The project open in Claude Code must be a GitHub repository.

The panel opens by itself in a wide terminal (144+ columns) or the desktop app. Anywhere else,
type `/team-mood`. A short mood summary also sits in the status line.

### Remote mode: the live page

A session viewed from the desktop app or a phone in remote mode draws no mod panels. For that,
Team Mood also serves the team as a **live web page** from the machine the session runs on
(`http://127.0.0.1:4873`, another port if that one is taken). In remote mode the mod tells the app
about it, so the app can show the page in its **preview pane** beside the chat. The page
updates every few seconds and its **Fix this**, **Get a check-up** and **Refresh** buttons work:
a press reaches the session within seconds and is sent to Claude as the panel's would be.

The page needs `python3` (macOS and Linux have it). Its server is a short standard-library
script (`web/serve.py`) that stops by itself two minutes after the session ends. It listens on
this machine only. Pressing buttons needs a token that only the page itself carries, so other
websites can't press them. To open it from other devices, set `"dashboard": { "host": "0.0.0.0" }`
(or your Tailscale address), but only on a network you trust: anyone who can load the page can
press its buttons. `"dashboard": { "enabled": false }` turns it off.

Where neither a panel nor the page is at hand, `/team-mood` answers in text instead: each persona's mood and findings in plain
words, with typed commands for the buttons:

- `/team-mood fix 42` (an issue number, or a check's name like `secret-scan`) does what
  **Fix this** does;
- `/team-mood checkup security` does what **Get a check-up** does.

## How moods are worked out

1. **GitHub issues.** Every open issue is matched to personas by **label**, **title pattern** or
   **author** (one issue can count for several). Each issue weighs by its highest severity label
   (`critical`/`P0` 10, `high`/`P1`/`priority` 6, `medium`/`P2` 3, `low`/`P3` 1), or 2 without
   one. The sum is the persona's score: 0 is happy, under 4 okay, under 10 worried, 10+ alarmed.
2. **Local checks.** After Claude changes files, and once the edits settle (3 s), each persona's
   checks run over the **whole project**. A failing check adds its weight (default 4). The
   built-in `builtin:secrets` check looks for leaked keys and tokens with `git grep`, and never
   shows the secret itself, only where it is.
3. **Plain language.** A small model (`haiku`) rewrites findings into one sentence per persona
   and a short explanation per issue, in the persona's voice. Results are cached. Set
   `"plainLanguage": false` to use fixed sentences and send nothing to a model.

GitHub is checked at start, every 5 minutes, after each turn (at most every 30 s), and on
**↻ Refresh**.

## Configure a project: `.team-mood.json`

Put it at the repository root. Everything is optional, and personas merge with the defaults by
`id`:

```json
{
  "refreshMinutes": 5,
  "plainLanguage": true,
  "severity": { "labels": { "priority": 6 }, "default": 2 },
  "thresholds": { "worried": 4, "alarmed": 10 },
  "personas": [
    {
      "id": "security",
      "labels": ["security"],
      "titlePatterns": ["^security\\b"],
      "focus": "Leaked secrets, missing login checks, unsafe handling of user input."
    },
    {
      "id": "qa",
      "labels": ["bug", "ci-failure"],
      "authors": ["app/sentry"],
      "checks": [{ "name": "Tests", "run": "npm test --silent", "weight": 4, "timeoutSeconds": 180 }]
    },
    { "id": "performance", "enabled": false },
    {
      "id": "design",
      "name": "Designer",
      "emoji": "🎨",
      "focus": "Confusing screens, inconsistent styling, text that is hard to read.",
      "tone": "warm and visual",
      "labels": ["ux-review"]
    }
  ],
  "checks": { "enabled": true, "debounceSeconds": 3, "exclude": ["tests/**", "docs/**"] },
  "protect": { "extraPaths": ["pyproject.toml"], "bash": true, "github": true, "suppressions": true }
}
```

Persona fields: `id`, `name`, `emoji`, `focus` (what it looks for, the persona's brief), `tone`,
`labels`, `titlePatterns` (case-insensitive regexes), `authors`, `match`, `checks`, `lines` (fallback
sentences per mood: `{n}` is the count in words, `{s}` a plural "s", `{v}` a verb's "s"),
`thresholds`, `enabled`.

`labels`, `titlePatterns` and `authors` each let an issue in on their own. `match` is for stricter
cases: a list of rules, each with any of `labels`, `notLabels`, `titlePatterns`, `authors` and
`bodyPatterns`, where everything a rule names must hold. That splits a combined report between
personas by what its body says:

```json
{
  "id": "performance",
  "labels": [],
  "titlePatterns": [],
  "match": [
    { "labels": ["performance"], "notLabels": ["weekly-report"] },
    { "titlePatterns": ["Nightly Audit"], "bodyPatterns": ["Category:\\*\\* (database|memory)"] }
  ]
}
```

A persona's own `labels`/`titlePatterns` replace the defaults, so set them to `[]` when only
`match` rules should count. Body rules make Team Mood fetch issue bodies, which is slower on
repos with many long issues.

A check's `run` is a shell line, an argv list, or `builtin:secrets`. Exit 0 passes. Exit
126/127 (tool not installed) counts as skipped, not failed.

The `focus` brief is used three ways: it sets the voice of the status line and explanations, it
goes into **Fix this**, and it is what **Get a check-up** asks Claude to review the codebase for.

## The anti-gaming guard

Moods must only improve by fixing things. Before any of these, Claude Code asks the person at the
keyboard, **in every permission mode, auto mode included**. With nobody to ask, the answer is no:

- editing CI (`.github/workflows/**`, `.gitlab-ci.yml`, …), checker configs (`eslint.config.*`,
  `semgrep.yml`, `ruff.toml`, `.pre-commit-config.yaml`, …), ignore files (`.eslintignore`,
  `.semgrepignore`, `.gitleaksignore`, …), `.team-mood.json`, or the mod's own files;
- shell commands that write to those files (best effort: a command can write a file it never
  names);
- `gh issue close/delete/transfer`, relabelling issues, `gh label delete`, `gh workflow disable`,
  `gh run cancel`, `git commit/push --no-verify`;
- edits that add suppressions: `eslint-disable`, `@ts-ignore`, `# noqa`, `# nosec`, `nosemgrep`,
  `.skip(`, `@pytest.mark.skip`, coverage ignores, and similar.

**Fix this** also tells Claude not to weaken checks and not to close the issue itself.

Limits: whoever is at the keyboard approves (on a friend's machine, that is your friend). The
person is asked, but in a narrow terminal the question covers the panel, so the reason shown in
the panel is not visible until it is answered.

## Develop

```
claude --plugin-dir ./team-mood     # load from this folder; saving a file reloads it
claude plugin validate ./team-mood
claude plugin test ./team-mood      # tests/*.test.ts(x)
```

`hooks/register.tsx` holds the hooks and the panel, `hooks/work.ts` the GitHub/check/model
work, `hooks/guard.ts` and `hooks/score.ts` pure rules, `hooks/config.ts` the defaults.

## License

MIT
