# Kickoff

An Orca plugin that lists open tasks from a project's tracker and starts each one in its own worktree, with an agent and a prompt built from a template.

## Language

**Project**:
An Orca project: one repository registered in Orca, which owns its worktrees.
_Avoid_: Repo (except for the GitHub `owner/name` a project points to), workspace

**Tracker**:
The external system a project's tasks come from: GitHub Issues, Jira or Linear.
_Avoid_: Provider (that is the code that talks to a tracker), backend, source

**Provider**:
The plugin's adapter that reads tasks from one tracker through one tool. A tracker can have more than one provider: Jira is read either through Orca's own Jira support or through `twg`. Linear is read through Orca's own Linear support.
_Avoid_: Integration, connector

**Task**:
One open item in a tracker, in a shape that does not depend on which tracker it came from.
_Avoid_: Issue, work item, ticket (except inside a single provider, where the tracker's own word is fine)

**Task key**:
The identifier a tracker gives a task and users recognise: `#42` in GitHub, `WEB-12` in Jira, the identifier `ENG-12` in Linear.
_Avoid_: Task id, number

**Assignee**:
A person the tracker says a task is assigned to, by the name the tracker shows for them: the login on GitHub, the display name on Jira and Linear. A GitHub task can have several; a Jira or Linear task has at most one. A task can have none.
_Avoid_: Owner, responsible

**Status category**:
The tracker-independent stage of a task: to do, in progress or done. Unlike the status name, it does not change with the tracker's language or workflow.
_Avoid_: State

**Text filter**:
Narrowing the tasks already loaded in the panel to those whose task key, title or a label contains what the user typed. It never asks the tracker.
_Avoid_: Filter (that is a named set of tracker queries), search, local search

**Filter**:
A named way to ask the tracker for a project's tasks, made of tracker queries in order: JQL queries on Jira, GitHub issue searches on GitHub, Linear queries on Linear. A project can have several on each tracker, its own and the global ones, and the panel shows the tasks of one at a time. A task can be in several filters; its task worktree is the same in each.
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

**Linear query**:
One of the queries, in order, that make up a filter on Linear. Linear has no query language, so a Linear query is a set of fields whose values the user chooses from lists rather than types, such as a team of the workspace or the project's Linear team key, one of the team's states or labels, the assignee, one of the workspace's Linear projects and the order; a field left unchosen keeps its default, such as any team, and the state is open unless one is chosen. A state or label can be chosen only once a team is. The filter shows the tasks of the first, then those of the next, each task once, where it first appears.
_Avoid_: Filter (that is the whole named set of queries), search, view (Linear's own saved filter)

**Linear recipe**:
A ready-made filter on Linear, **Assigned to me** or **Team open**, that writes a new filter's name and Linear queries for the user to change before saving it. **Team open** takes the project's Linear team key when it has one, and otherwise leaves the team for the user to choose.
_Avoid_: Preset, template (that is a prompt template)

**Linear team key**:
The key of the Linear team a project's tasks are in, such as `ENG`, chosen among the workspace's teams in its Project settings. It is optional. A Linear query's team can be the Linear team key instead of a named team, so one filter lists each project's own team.
_Avoid_: Team key (alone), team id, Jira project key (that is Jira's)

**Tracker search**:
Asking the tracker for the tasks of the filter shown that match the user's words, including tasks not loaded yet. It only narrows that filter, on GitHub, Jira and Linear alike: it never finds tasks outside it. On Linear it matches the whole text as one phrase of the title or the description, not word by word and not the task key.
_Avoid_: Search (alone), remote search, query

**Prompt template**:
A named text with task variables that becomes the prompt given to the agent of a Start or a Run here. A project has one or more, its own and the global ones; no two of its own share a name, nor two global ones. Each Start or Run here uses the one the user chooses for that task.
_Avoid_: Prompt (that is the filled-in result)

**Global**:
Said of what is kept once for every project instead of for one. A global filter or prompt template is offered in every project beside the project's own, a global filter only in the projects on its tracker, and no project can hide it. The global branch settings are used instead of a project's own, by every project that has none of its own. Changing a global one changes it in every project that offers or uses it. A project's own filter, prompt template or branch settings can be made global, and a global one can be given back to a single project.
_Avoid_: Shared, common, default (that is the default template)

**Default template**:
The prompt template a project's tasks start with unless the user chooses another one for a task. A project has exactly one.
_Avoid_: Active template, first template

**Branch settings**:
The branch template, the branch types with their fallback, and the title exclusion pattern, which a project uses together: its own, or the global ones. A project uses the global branch settings unless it has its own, and its own change nothing in any other project.
_Avoid_: Naming convention, branch config

**Branch template**:
A text with task variables, part of the branch settings, that gives the git branch of the task worktree a Start creates. It names only the branch, never the worktree. Branch settings without one leave the branch to Orca.
_Avoid_: Naming convention, branch pattern, template (alone)

**Branch type**:
The word a branch template puts for a task's kind, such as `bugfix` for a Jira bug. The branch settings choose it per Jira issue type, with one fallback for every other task and for every GitHub and Linear task, which have no issue type.
_Avoid_: Task type, issue type (that is the tracker's own value), prefix

**Title exclusion pattern**:
A regular expression, part of the branch settings, whose every match is removed from a task's title before the words of its worktree name and of `{{task_slug}}` are taken. It starts as one that removes bracketed tags such as `[FE]`.
_Avoid_: Title filter, title regex

**Start**:
The user action that creates a task worktree for a task and launches an agent in it with the prompt filled from the chosen prompt template. A task is started once; a task that already has a task worktree can't be started again.
_Avoid_: Launch, kick off, run, Run here (that launches an agent without a task worktree)

**Run here**:
The user action that launches a new agent in the worktree selected in Orca's sidebar, as it is, with the prompt filled from the chosen prompt template and a task. It creates no worktree, no branch and no link, so the task is not started and can be run here again. Only a task that has not been started offers it, and only when the agent chosen for that task names an agent.
_Avoid_: Start here, start without worktree, snippet

**Task worktree**:
A non-archived Orca worktree in the active project that is linked to a task, together with the agent running in it, if any.
_Avoid_: Session, workspace

**Link**:
The association between a task and a task worktree, recorded by Orca on the worktree itself.
_Avoid_: Mapping, binding

**Agent choice**:
The per-project setting that says which agent a Start or a Run here launches, unless the user chooses another one for that task on its card: Orca's default agent, a named agent, or none.
_Avoid_: Default agent (that is Orca's own setting)

**Available agent**:
An agent Orca can start on the host of the worktree an agent is launched in, the active worktree's for the agent choice: Orca detects it there and it is not turned off in Orca's settings. The agent choice offers the available agents; a named agent that is no longer available stays chosen but can't be launched.
_Avoid_: Installed agent (that includes the turned-off ones), configured agent

**Project settings**:
What Kickoff keeps for one project: its tracker and how the provider reads it (such as the Jira site, or the Linear workspace when Orca is connected to more than one), its Jira project key, its Linear team key, its own filters, its agent choice, its own prompt templates with the default template, and whether it uses its own branch settings or the global ones, with its own when it has them. Global filters, prompt templates and branch settings are not part of any one project's settings.
_Avoid_: Settings, Kickoff settings, plugin settings, config

**Active project**:
The project of the worktree currently selected in Orca's sidebar.
_Avoid_: Current repo, selected workspace

**Login**:
Credentials held outside the plugin that a provider relies on: a CLI login (`gh auth login`, `twg login`), or the Jira or Linear connection in Orca's settings. The plugin never holds credentials itself.
_Avoid_: Session, auth, token

**Development plugin**:
Kickoff loaded into Orca straight from a folder being worked on, rather than installed. Its version is the one that folder's manifest says, so it can differ from the release with the same number. Kickoff installed from a folder is a fixed copy, not a development plugin.
_Avoid_: Local plugin (`local` is also the publisher of a plugin installed from a folder), dev build
