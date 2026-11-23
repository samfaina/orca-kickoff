---
status: accepted
---

# Read Orca's agents from `orca agent installed`

Supersedes ADR-0003. Since Orca 1.4.271 (the oldest version it was seen in), `orca agent installed --json` lists the available agents on a workspace's host: the agents Orca detects there that are not turned off in its settings, each with an id, a display name and a `default` flag. Kickoff uses it for two things. It fills the agent choice's options. It also resolves "Orca default" to the agent marked `default`. Kickoff no longer reads Orca's private `profile-state.db` and `orca-data.json`, so it no longer needs `node:sqlite` or has to work out Orca's data folder.

## Considered options

- **Keep reading the profile store for "Orca default"** and use the CLI only for the list. Rejected: it keeps the dependency on Orca's private storage layout, which can break on any Orca update.
- **Read the profile store only when no agent is marked `default`**, to tell `blank` (Orca's "no agent") apart from an unset or stale default. Rejected for the same reason, to cover one case the user can pick directly as "No agent".

## Consequences

- Orca marks an agent `default` only when its saved default agent is available. It doesn't fall back as Orca's own picker does. A `blank`, unset, turned-off or missing default marks nothing. So "Orca default" with nothing marked makes a Start or a Run here fail with a message instead of launching without an agent. Kickoff still doesn't reproduce Orca's fallback to the first installed agent.
- `engines.orca` is `>=1.4.271`. Whether an older Orca has the command is not known.
- When the list can't be read at launch time, a named agent is passed to Orca as it is (Orca refuses an unknown id), and only "Orca default" fails.
