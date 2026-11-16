# Meet your team

Next to your chat with Claude sits a small team. They don't write code. They watch your app and
tell you, in plain words, how they feel about it right now. Their mood covers the whole app, not
just the last thing Claude changed.

| | Who | What they watch for |
|---|---|---|
| 🛡️ | **Security Engineer** | Passwords or keys left in the code, places where someone could see or change things that aren't theirs, doors left unlocked. |
| 🧪 | **QA Lead** | Things that are broken or behave wrongly: errors, crashes, buttons that do nothing, tests that fail. |
| ⚡ | **Performance Engineer** | Anything that makes the app slow or expensive to run: pages that take ages, work done twice. |

## What the faces mean

- 😊 **Happy**: nothing on their list.
- 😐 **Okay**: one or two small things. No rush, but worth a look.
- 😟 **Worried**: several problems, or one serious one. Fix these soon.
- 😱 **Alarmed**: something serious is open. Fix this before adding new features.

Under the face you may see **better than last session** or **worse than last session**: whether
things improved since you last opened Claude.

## What to do

1. Click **What's wrong?** on a persona. You'll see each problem explained in everyday words.
2. Press **Fix this**. Claude gets a message from that persona, fixes the problem, and explains
   what it changed and why it matters.
3. Their mood updates on its own once the fix is in (local checks within seconds; problems found
   by GitHub after the next automatic check, usually minutes).

All happy? Press **Get a check-up** to have Claude look over the whole app from that persona's
point of view. It tells you what it finds and asks before changing anything.

Using Claude in remote mode (from the desktop app or your phone)? The team shows up as a page in
the app's preview pane instead, with the same buttons.

If you don't see the panel, type `/team-mood` and press Enter. Your terminal window may need to
be wider. If the team still answers as text, the panel can't be shown where you are; the text
lists the same problems, and you type the buttons instead: `/team-mood fix 42` to fix problem 42,
`/team-mood checkup security` for a check-up.

## The one rule: no cheating

The team's mood should only get better by fixing the app, never by switching off the alarms. So
if Claude wants to change one of the files that check your app (the automatic tests on GitHub,
the settings of the checking tools, their "ignore" lists), mark a GitHub problem as done, or
add a note telling a checker to look away, Claude Code stops and asks you first.

**Say No unless you asked for exactly that change.** If you're not sure, say No and ask Claude
to explain why it wanted to.
