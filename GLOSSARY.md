# Kickoff

An Orca plugin that lists open tasks from a project's tracker and starts each one in its own worktree, with an agent and a prompt built from a template.

## Language

**Project**:
An Orca project: one repository registered in Orca, which owns its worktrees.
_Avoid_: Repo (except for the GitHub `owner/name` a project points to), workspace

**Tracker**:
The external system a project's tasks come from, such as GitHub Issues or Jira.
_Avoid_: Provider (that is the code that talks to a tracker), backend, source

**Provider**:
The plugin's adapter that reads tasks from one tracker through one tool. A tracker can have more than one provider: Jira is read either through Orca's own Jira support or through `twg`.
_Avoid_: Integration, connector

**Task**:
One open item in a tracker, in a shape that does not depend on which tracker it came from.
_Avoid_: Issue, work item, ticket (except inside a single provider, where the tracker's own word is fine)

**Task key**:
The identifier a tracker gives a task and users recognise: `#42` in GitHub, `WEB-12` in Jira.
_Avoid_: Task id, number

**Status category**:
The tracker-independent stage of a task: to do, in progress or done. Unlike the status name, it does not change with the tracker's language or workflow.
_Avoid_: State

**Prompt template**:
The per-project text, with task variables, that becomes the prompt given to the agent when a task starts.
_Avoid_: Prompt (that is the filled-in result)

**Start**:
The user action that creates a task worktree for a task and launches an agent in it with the filled-in prompt.
_Avoid_: Launch, kick off, run

**Task worktree**:
A non-archived Orca worktree in the active project that is linked to a task, together with the agent running in it, if any.
_Avoid_: Session, workspace

**Link**:
The association between a task and a task worktree, recorded by Orca on the worktree itself.
_Avoid_: Mapping, binding

**Agent choice**:
The per-project setting that says which agent a Start launches: Orca's default agent, a named agent, or none.
_Avoid_: Default agent (that is Orca's own setting)

**Active project**:
The project of the worktree currently selected in Orca's sidebar.
_Avoid_: Current repo, selected workspace

**Login**:
Credentials held outside the plugin that a provider relies on: a CLI login (`gh auth login`, `twg login`) or the Jira connection in Orca's settings. The plugin never holds credentials itself.
_Avoid_: Session, auth, token
