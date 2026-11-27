# Orca's linked items are the task link

A task worktree is recognised by Orca's own link metadata on the worktree, not by a table kept in plugin storage. Start passes `--issue <n>` for GitHub, `--reference <task URL>` for Jira and `--reference <issue URL>` for Linear to `orca worktree create`. Reading checks `linkedItems` (and `linkedIssue` for GitHub): on Linear, an item with `provider: 'linear'` links the worktree to its `linearIdentifier`, else its `identifier`. The full URL is passed rather than the bare key because a bare key makes Orca look the task up through its own Jira connection, which a `twg` user may not have, and Orca reads a bare Linear identifier as a Jira key. A worktree linked to a Linear issue this way lets an agent in it find the issue with `orca linear issue --current`. The first design linked by worktree name alone: it broke on rename and could not parse Jira keys containing `_`. A worktree whose name starts with the task key still counts as a fallback, so worktrees created by hand are recognised too.

## Consequences

`engines.orca` is `>=1.4.255`, the first version where `--reference` was observed. The worktree name still starts with the task key, but only as a readable name and a fallback.
