# Skill picker

Kickoff does not offer a control for choosing a skill to start a task with. To
run a skill, the user starts the prompt template with its command, as
`/acme-skills:tdd {{task_key}}`.

## Why this is out of scope

The proposal was a "Start with a skill" `Select` in Start options, listing the
skills a new worktree of the project will load. Choosing one would put its
namespaced command at the start of the template.

The template already does this job. The agent reads the command straight from
the prompt it gets. Claude Code runs a skill command at the start of the
prompt, and it accepts a plugin skill's bare name as well as its namespaced one.
A picker would only write that same text into the template for the user.

A picker also wouldn't make a Start any safer. If the agent can't find the
skill, it fails the same way however the command got into the template:
`Unknown command: /<name>` on the terminal surface, or the model saying so on the
chat surface. Getting the list right would need the same prediction of what a
new worktree loads that
[skill-command-visibility-warning.md](skill-command-visibility-warning.md)
rejects as unreliable. A list that is sometimes wrong would mislead users more
than a plain text field.

The picker would also cost more than it saves:

- `Select` holds at most 500 options, so a long skill list needs a cap or a
  filter.
- The worker would have to run `claude plugin list --json`, read every plugin's
  skill folders, and refresh the list after each plugin install.
- It would only work for Claude Code, while a template works for every agent.

## Prior requests

- #41: "Pick a skill for the prompt template in Start options"
