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

**Assignee**:
A person the tracker says a task is assigned to, by the name the tracker shows for them: the login on GitHub, the display name on Jira. A GitHub task can have several; a Jira task has at most one. A task can have none.
_Avoid_: Owner, responsible

**Status category**:
The tracker-independent stage of a task: to do, in progress or done. Unlike the status name, it does not change with the tracker's language or workflow.
_Avoid_: State

**Text filter**:
Narrowing the tasks already loaded in the panel to those whose task key, title or a label contains what the user typed. It never asks the tracker.
_Avoid_: Filter (that is a named set of tracker queries), search, local search

**Filter**:
A named way to ask the tracker for a project's tasks, made of tracker queries in order, such as JQL queries on Jira. A project can have several, and the panel shows the tasks of one at a time. A task can be in several filters; its task worktree is the same in each.
_Avoid_: Task list, view, saved filter (on Jira that is a stored JQL query of Jira's own), board

**JQL query**:
One of the Jira queries, in order, that make up a filter on Jira. The filter shows the tasks of the first, then those of the next, each task once, where it first appears.
_Avoid_: Filter (that is the whole named set of queries), search

**JQL recipe**:
A ready-made kind of filter on Jira, such as a board's tasks in board order, that writes the filter's JQL queries from a few answers, such as the Jira project and the statuses to leave out. The queries it writes are ordinary JQL queries the user can still edit.
_Avoid_: Preset, template (that is a prompt template), JQL template

**Tracker search**:
Asking the tracker for the tasks of the filter shown that match the user's words, including tasks not loaded yet. It only narrows that filter: it never finds tasks outside it.
_Avoid_: Search (alone), remote search, query

**Prompt template**:
A named text with task variables that becomes the prompt given to the agent when a task starts. A project has one or more, each with a name of its own, and each Start uses the one the user chooses for that task.
_Avoid_: Prompt (that is the filled-in result)

**Default template**:
The prompt template a project's tasks start with unless the user chooses another one for a task. A project has exactly one.
_Avoid_: Active template, first template

**Start**:
The user action that creates a task worktree for a task and launches an agent in it with the prompt filled from the chosen prompt template. A task is started once; a task that already has a task worktree can't be started again.
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

**Project settings**:
What Kickoff keeps for one project: its tracker and how the provider reads it, its filters, its agent choice, and its prompt templates with the default template.
_Avoid_: Settings, Kickoff settings, plugin settings, config

**Active project**:
The project of the worktree currently selected in Orca's sidebar.
_Avoid_: Current repo, selected workspace

**Login**:
Credentials held outside the plugin that a provider relies on: a CLI login (`gh auth login`, `twg login`) or the Jira connection in Orca's settings. The plugin never holds credentials itself.
_Avoid_: Session, auth, token
