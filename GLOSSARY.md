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
A named way to ask the tracker for a project's tasks, made of tracker queries in order: JQL queries on Jira, GitHub issue searches on GitHub. A project can have several on each tracker, its own and the global ones, and the panel shows the tasks of one at a time. A task can be in several filters; its task worktree is the same in each.
_Avoid_: Task list, view, saved filter (on Jira that is a stored JQL query of Jira's own), board

**JQL query**:
One of the Jira queries, in order, that make up a filter on Jira. The filter shows the tasks of the first, then those of the next, each task once, where it first appears.
_Avoid_: Filter (that is the whole named set of queries), search

**Jira project key**:
The key of the Jira project a project's tasks are in, such as `WEB`, set in its Project settings. A JQL query can name it instead of writing the key, so one filter lists each project's own tasks.
_Avoid_: Project key (alone: a project here is an Orca project), Jira project id

**JQL recipe**:
A ready-made kind of filter on Jira, such as a board's tasks in board order, that writes the filter's JQL queries from a few answers, such as the Jira project and the statuses to leave out. The queries it writes are ordinary JQL queries the user can still edit.
_Avoid_: Preset, template (that is a prompt template), JQL template

**GitHub recipe**:
A ready-made filter on GitHub, **Open** or **Assigned to me**, that writes a new filter's name and GitHub search for the user to change before saving it.
_Avoid_: Preset, template (that is a prompt template)

**Tracker search**:
Asking the tracker for the tasks of the filter shown that match the user's words, including tasks not loaded yet. It only narrows that filter: it never finds tasks outside it.
_Avoid_: Search (alone), remote search, query

**Prompt template**:
A named text with task variables that becomes the prompt given to the agent when a task starts. A project has one or more, its own and the global ones; no two of its own share a name, nor two global ones. Each Start uses the one the user chooses for that task.
_Avoid_: Prompt (that is the filled-in result)

**Global**:
Said of a filter or prompt template kept once and offered in every project, beside the project's own; a global filter only in the projects on its tracker. Changing or deleting it changes it in every project, and no project can hide it. A project's own filter or prompt template can be made global, and a global one can be given back to a single project.
_Avoid_: Shared, common, default (that is the default template)

**Default template**:
The prompt template a project's tasks start with unless the user chooses another one for a task. A project has exactly one.
_Avoid_: Active template, first template

**Branch template**:
A text with task variables, set per project, that gives the git branch of the task worktree a Start creates. It names only the branch, never the worktree. A project without one leaves the branch to Orca.
_Avoid_: Naming convention, branch pattern, template (alone)

**Branch type**:
The word a branch template puts for a task's kind, such as `bugfix` for a Jira bug. The project chooses it per Jira issue type, with one fallback for every other task and for every GitHub task.
_Avoid_: Task type, issue type (that is the tracker's own value), prefix

**Title exclusion pattern**:
A regular expression, set per project, whose every match is removed from a task's title before the words of its worktree name and of `{{task_slug}}` are taken. It starts as one that removes bracketed tags such as `[FE]`.
_Avoid_: Title filter, title regex

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
What Kickoff keeps for one project: its tracker and how the provider reads it, its Jira project key, its own filters, its agent choice, its own prompt templates with the default template, and its branch template with its branch types and title exclusion pattern. Global filters and prompt templates are not part of any one project's settings.
_Avoid_: Settings, Kickoff settings, plugin settings, config

**Active project**:
The project of the worktree currently selected in Orca's sidebar.
_Avoid_: Current repo, selected workspace

**Login**:
Credentials held outside the plugin that a provider relies on: a CLI login (`gh auth login`, `twg login`) or the Jira connection in Orca's settings. The plugin never holds credentials itself.
_Avoid_: Session, auth, token
