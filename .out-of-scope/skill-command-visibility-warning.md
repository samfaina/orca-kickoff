# Skill command visibility warning

Kickoff does not check whether the skill command at the start of a prompt
template will load in the new task worktree, and does not warn about it.

## Why this is out of scope

A prompt template can start with a Claude Code skill command such as
`/acme-skills:tdd {{task_key}}`. The new worktree is a different folder from the
main checkout, so a skill that works there may be missing in the new worktree:
for example a plugin installed with `local` scope. The proposal was for
Kickoff to spot this case before a Start and show a warning with the fix.

The failure is already visible where it happens. On the terminal surface,
Claude Code prints `Unknown command: /<name>` on the first line of the new
agent's terminal. On the chat surface, the model replies that it can't find the
skill. The panel's help text under the template already gives the fix: install
plugins with `user` scope and commit project skills.

A warning from Kickoff would also be unreliable, because what the new worktree
loads depends on things Kickoff can't see before the Start:

- Whether a `local` plugin reaches the worktree depends on the OS. According
  to Claude Code's docs, inside a git repo the local settings are read from the
  main checkout, except on Windows.
- A linked worktree with no `.claude/skills` of its own loads the main
  checkout's skills, so an uncommitted skill isn't always missing.
- Orca copies the entries in `.worktreeinclude` into the new worktree, and
  there is no CLI command that reports the base ref before `worktree create`.
  So the repository state alone doesn't say whether a skill will be in the
  new worktree.
- Kickoff can't list built-in commands, and a built-in wins over a plugin skill
  with the same name.

Getting this right would mean copying Claude Code's loading rules for
plugins and skills, and those change between versions. Each wrong warning, false
or missing, makes users trust the panel less.

## Prior requests

- #40: "Warn when the template's skill command won't load in the new worktree"
