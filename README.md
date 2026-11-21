# Kickoff

An [Orca](https://github.com/stablyai/orca) plugin that lists the open tasks of the active project's tracker (GitHub Issues, or Jira) in a side panel, and starts each one in its own worktree, linked to the task, with an agent and a prompt built from a template you write per project, or once for every project.

Inspired by [rr235/orca-task-launcher](https://github.com/rr235/orca-task-launcher), which reads GitHub only.

## Requirements

- **Orca 1.4.265 or later.**
- For **GitHub** projects: the [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`.
- For **Jira**, one of:
  - Orca's own Jira connection, set up in Orca's settings; or
  - the [Teamwork Graph CLI](https://developer.atlassian.com/cloud/twg-cli/) (`twg`), logged in with `twg login`. `twg` reads Jira Cloud only.

Kickoff holds no credentials of its own: it runs these tools, which already hold your login ([ADR-0001](docs/adr/0001-credentials-stay-in-external-tools.md)). Windows is the main platform; macOS and Linux are supported but less tried.

## Installation

```sh
orca plugin install samfaina/orca-kickoff
```

Kickoff runs a worker with your account's access, so Orca asks you to approve it: the first command fails with `approval_required` and prints the same command with `--approve <fingerprint>` to run next. Orca installs the plugin as `samfaina.kickoff`.

With no version, Orca installs the newest [release](https://github.com/samfaina/orca-kickoff/releases); `samfaina/orca-kickoff@v0.1.0` installs a given one. `orca plugin update samfaina.kickoff` moves to the newest release.

Kickoff looks each tool up on your `PATH`, then at its usual install folder. If one lives elsewhere, set `ORCA_CLI_COMMAND`, `GH_CLI_COMMAND` or `TWG_CLI_COMMAND` to its full path.

## Usage

Open the **Kickoff** panel from its icon (a lightning bolt) in Orca's right sidebar, and select a worktree in Orca: the panel lists the open tasks of that worktree's project.

- **A project with a GitHub repository** lists its open issues with no setup, through its first [filter](#filters), **Open**.
- **Any other project** opens **Project settings** by itself. Choose a tracker:
  - **GitHub**, for a project whose repository Orca knows.
  - **Jira (Orca connection)**: the site, when Orca is connected to more than one (Orca's default site otherwise).
  - **Jira (twg)**: optionally `twg`'s site and profile.

  On Jira, the **Jira project key** is the key of the Jira project the tasks are in, such as `WEB`. It starts empty, is never guessed from your JQL, and is stored trimmed and upper-cased. [Filters](#filters) and [prompt templates](#prompt-templates) name it as `{{jira_project}}`.

  **Done** shows the project's tasks: those of its first [filter](#filters), **Tasks** on Jira and **Open** on GitHub. The gear in the panel's header opens Project settings again later, and **Done** goes back to the list, loading it again when a tracker setting changed.

Each task shows as a card with its key and title, then its labels, after its status on Jira, then its assignees, if any. **Start** (the play button):

1. creates a worktree named after the task's key and up to four words of its title, without bracketed tags such as `[FE]` (see [Branch](#branch)), such as `web-12-add-dark-mode` for Jira's `WEB-12` "[FE] Add dark mode", or `issue-42-add-dark-mode` for GitHub's `#42`; its git branch comes from the [branch template](#branch) of the branch settings the project uses, its own or the [global](#global-branch-settings) ones, or, without one, Orca names it;
2. links it to the task in Orca, so Orca shows the task on the worktree;
3. launches the project's agent in it, with the prompt filled from the chosen template.

Creating the worktree can take a minute. Once it exists, the card shows the worktree, as a link that opens it, the assignees, and the agent running in it, and the task can't be started again.

A card that can start has, in its last row, the template `Select` (with two templates or more) and two buttons:

- **Run here** (the terminal button) launches the agent in the worktree you selected in Orca, without a new worktree (see [Run here](#run-here)).
- **Start** (the play button), at the end of the row, as above.

Both buttons look the same, whichever template is chosen. With the agent choice **No agent**, the card has no Run here, only Start.

**Project settings** also hold, under **Start**:

- **Agent**: Orca's default agent, a named one (`claude`, `codex`, `gemini`, `opencode`, `copilot`), or none. If Orca's default can't be read, Start and Run here say so and ask you to pick one.
- **Default template**: the [prompt template](#prompt-templates) a Start or a Run here uses unless you choose another on a task's card. A change saves itself like the other settings. **Manage templates**, beside it, opens the [Prompt templates](#the-prompt-templates-view) view; **Cancel** and **Save** there come back to Project settings.

Under **Branch**, they hold how a Start names its git branch, or say that the project uses the global branch settings (see [Branch](#branch)).

**Filters**, above the list and open at first, holds the filter row and the **Search tasks** field; closed, it says the filter listed and the words typed. The field narrows the loaded tasks as you type, by key, title or label. **Enter** (or **Search in GitHub** / **Search in Jira**) asks the tracker instead, for the tasks of the same list that match your words, including those not loaded yet. **Clear search** goes back to the list.

GitHub lists up to 100 tasks per query, and Orca's Jira connection up to 100 per JQL query, and both say so when there are more. With `twg`, a page holds up to 50 tasks, filled from each query in turn, and **Load more** reads the next one.

### Run here

Some templates run a skill that creates its own linked worktree, such as one that ships tickets with Orca workers and runs `orca worktree create --issue <n>` itself. A Start would create a worktree first, so the task would get two, and the agent would run in the first for nothing. **Run here**, the terminal button before Start on the card, hands the filled prompt to a new agent in the worktree selected in Orca's sidebar, as it is:

1. it checks that a worktree is selected, that it belongs to the listed project, that the task has no worktree yet, and that the project's agent choice gives an agent;
2. it fills the prompt from the chosen template, with `{{branch}}` the selected worktree's current branch, only as text;
3. it launches the project's agent there, in a new tab that Orca shows.

While it runs, the card says *Running … here*. A failure shows on the card, as a failed Start does. It creates no worktree, no branch and no link, and Kickoff keeps no record of it, so the task can be run here again, or started. When the launched skill creates a worktree linked to the task, the card shows it as started.

### Filters

A filter is a named way to ask the tracker for the project's tasks, made of one or more queries in order: JQL queries on Jira, GitHub issue searches on GitHub. A project can have several, for example the board's tasks in board order and the tasks assigned to you, its own and the [global](#global-filters) ones, and each tracker keeps its own.

- A Jira project starts with one, **Tasks**, whose query is `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`.
- A GitHub project starts with one, **Open**, whose query is `is:open`: its open issues, as before filters.

The filter row, in **Filters** above **Search tasks**, shows the filter listed, with ✎ to edit it and **+** to add one. It lists the project's own filters first, then the global ones, marked **(Global)**. Choosing another filter loads its tasks from the tracker, keeping the words in **Search tasks**; the panel opens on the filter shown last. Both Jira providers list the same filters.

✎ and **+** open the filter editor in place of the list. On Jira, **+** first asks what the new filter starts from:

- **Custom**: one blank query.
- **Board order**: a Jira project's tasks in board order. It asks for the Jira project key (typed, such as `WEB`; required, starting as the project's own when it has one), whose tasks (**Mine**, **Mine or unassigned**, the default, or **Anyone**) and the statuses to leave out, and writes three queries: the open sprints in rank order, then the future sprints, then the rest. With `WEB`, *Mine or unassigned* and `Done, Closed, To validate`, the first is `project = WEB AND sprint in openSprints() AND (assignee IS EMPTY OR assignee = currentUser()) AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Rank ASC`. While the answer is the project's Jira project key, ignoring case, the queries say `project = {{jira_project}}` instead.
- **My open tasks**: asks for the statuses to leave out and writes one query; with the first answer, `Done`, it is `assignee = currentUser() AND status NOT IN ("Done") ORDER BY updated DESC`.

The statuses to leave out are names separated by commas, starting as `Done`; with none, the queries keep every status. Status names are used rather than status categories, because a workflow's statuses such as *To validate* don't map to one. A wrong Jira project key shows as the query's error when the filter lists its tasks. **Continue** opens the filter editor on the new filter, named after its recipe, with the queries written for you to change before saving; the answers are not kept.

A new filter is named **Filter 2**, **Filter 3**…, or after its recipe, the first name no filter has. In the editor:

- **Name**: not empty, and unique among the project's own filters on the tracker, or among the global ones, ignoring case.
- **Global**: whether the filter is global (see [Global filters](#global-filters)).
- **JQL**, **JQL 2**… on Jira, **Query**, **Query 2**… on GitHub: the list shows the tasks of the first query, then those of the next that the earlier ones didn't list, each in the tracker's order; a blank query is kept and skipped. **Add JQL** (**Add query**) adds a query and the trash can removes one. A query can span several lines.
- On GitHub, a new filter can start from a recipe: **Open** (`is:open`) or **Assigned to me** (`is:open assignee:@me`), which write the filter's name and query for you to change before saving.
- **Save** (or **Ctrl+Enter**, **Cmd+Enter** on macOS, in a query) stores the filter, goes back to the list and loads it. **Cancel** goes back without storing anything.
- **Delete filter**, clicked twice, removes the filter; a project keeps at least one on its tracker, own or global.

A JQL query can name the project's Jira project key as `{{jira_project}}`, spaces inside the braces allowed, so two projects with the same workflow can use the same queries: `project = {{jira_project}} ORDER BY Rank` lists each project's own tasks. It becomes the key each time the query runs, for the list, **Load more** and a tracker search; the filter keeps it as written. In a project without a Jira project key, a filter that names it runs none of its queries, and the list says *This filter uses {{jira_project}}. Set the Jira project key in Project settings.* Filters that don't name it list as usual. GitHub searches run as written: they are already limited to the project's repository.

A GitHub query is any issue search, such as `label:needs-triage`, `assignee:@me` or `label:bug OR label:ui`. Kickoff runs it as `gh issue list --state open --search "(<query>) is:open"`, so it lists open issues only, even with `is:closed`; `is:pr` fails, since gh lists issues only. A malformed query lists nothing rather than failing: GitHub answers it with no issues.

A query the tracker rejects names its filter and its place in it, such as `Board: JQL query 2 failed: …` on Jira or `Mine: Query 2 failed: …` on GitHub, and the panel opens the filter editor on that filter. A filter whose queries are all blank opens it too. Any other failure, such as a missing `twg` or `gh` login or Jira connection, shows the tool's own message and opens Project settings. Settings stored before filters, with JQL in Project settings, become one filter, **Tasks**, with those queries.

### Global filters

A filter is either the project's own or **global**: kept once, apart from every project's settings, and offered in every project on its tracker. A global Jira filter is offered in every Jira project, through either Jira provider, and in no GitHub project; a global GitHub filter in every GitHub project. A global filter can be the filter shown.

- **Names**: no two of a project's own filters on a tracker share a name, nor two global ones on that tracker, ignoring case. An own filter and a global one may share one; the mark tells them apart.
- **The Global switch**, in the filter editor, moves a filter between the two groups. Turned on, the filter leaves the project and becomes global at once, and stays the filter shown. Turned off, a bar first asks to confirm, since *Other projects will stop offering it*; **Confirm** moves it to the active project only, and other projects that showed it fall back to their first filter. A move whose name the other group already has is refused with a message, and changes nothing. On a new filter, the switch says where **Save** stores it.
- **Edits and Delete**: editing a global filter changes it in every project on its tracker. Deleting one deletes it in every project, as its Delete bar says. A filter can be deleted while the active project lists at least one other on that tracker, own or global.
- **The initial filter**: a project lists **Tasks** (or **Open**) only while it has no filter of its own on the tracker and there is no global one there. The first global filter, saved from a project that listed only the initial one, keeps it in that project as one of its own.
- **`{{jira_project}}`**: a global Jira filter is the same in every project, so it should name the Jira project as `{{jira_project}}`. When its queries name the active project's Jira project key literally, as `project = WEB`, the editor says *This filter names WEB. Use {{jira_project}} so each project lists its own tasks.*, and **Use {{jira_project}}** replaces those keys in the queries for you to save. The hint blocks nothing.

## Prompt templates

A template is the text the agent gets as its prompt. `{{name}}` is replaced by the variable's value; spaces inside the braces are fine, and an unknown name is left as it is. An empty template gives the task's URL. A new template starts as `Complete {{task_key}}: {{task_url}}`.

| Variable | Value |
| --- | --- |
| `{{task_key}}` | The task key, such as `WEB-12` or `#42`. |
| `{{task_title}}` | The task's title. |
| `{{task_url}}` | The task's link in the tracker. |
| `{{task_description}}` | The task's description as plain text, cut to 4000 characters. |
| `{{task_status}}` | The status as the tracker shows it, such as `In Progress`; `Open` on GitHub. |
| `{{tracker}}` | `github` or `jira`. |
| `{{repo}}` | The project's repository (`owner/name`) when Orca knows it, else the project's name. |
| `{{branch}}` | The new worktree's git branch from the [branch template](#branch) the project uses, such as `feature/WEB-12__add-dark-mode`; without one, the worktree's name, such as `web-12-add-dark-mode`. It doesn't include a `-2` Orca may add to a taken branch, since the prompt is filled before the worktree is created. In a [Run here](#run-here), the current branch of the worktree selected in Orca, or nothing when it has none. |
| `{{jira_project}}` | The project's Jira project key, such as `WEB`, set in Project settings; empty when it has none. |

A filled prompt over 30 000 characters makes Start and Run here fail, since the Windows command line holds about 32 000.

To run a Claude Code skill, start the template with its command, for example:

```text
/tdd {{task_key}}: {{task_title}}

{{task_description}}
```

Only blank lines may come before the command, and the worktree the agent runs in must see the skill: a plugin installed with `local` scope is not seen in a new worktree on Windows, while `user` scope is.

### The Prompt templates view

A project can have several prompt templates, each with a name, its own and the [global](#global-templates) ones. **Prompt templates** (the layers button in the panel's header, between Reload tasks and Project settings) and **Manage templates** in Project settings open the view in place of the panel, on the default template. **Cancel** and **Save** go back where it was opened from: the task list or Project settings.

- **Template**, under the title, chooses the template to edit, among every template of the project, its own first, then the global ones, marked **(Global)**; **+** beside it starts a new one. Choosing another, or **+**, while the form has changes not saved yet, asks first in the bar at the bottom: *Discard your changes to …?* **Keep editing** keeps them; **Discard** opens the other one. Without changes it opens at once.
- **The form**: **Name**, the **Global** switch, the **Default template** switch, **Text**, the **Variables** and how to run a skill.
- **Save** stores the name, the text, Global and Default template at once, in one write, and leaves the view; it waits while the bar at the bottom asks a question. **Cancel** drops all of it.
- **Default template**: on, **Save** makes the template the project's default. On the current default it is on and can't be turned off: the default changes by turning it on in another template.
- **Delete template**, in the bar at the bottom, which stays in place while the form scrolls, removes the template after a second click, and the view shows the default template. A project keeps at least one template, own or global. Deleting the default template makes the first one listed the default.

Closing the panel, or changing the active project, drops what wasn't saved.

### Global templates

A prompt template is either the project's own or **global**: kept once, apart from every project's settings, and offered in every project. The default template and the template on a task's card list the project's own first, then the global ones, each group in its order, the global ones marked **(Global)**. A global template can be a project's default template.

- **Names**: no two of a project's own templates share a name, nor two global ones, ignoring case. An own template and a global one may share one; the mark tells them apart.
- **The Global switch**, in the [Prompt templates](#the-prompt-templates-view) view, says where **Save** stores the template, and **Save** moves it between the two groups; **Cancel** leaves it where it was. Made global, the template leaves the project; the project's default template and the templates chosen on its cards keep pointing at it. Turning it off first asks in the bar at the bottom, since *Other projects will stop offering it*; **Keep global** keeps it on and **Confirm** turns it off, and **Save** then moves it to the active project only, and other projects whose default template it was fall back to their first. A move whose name the other group already has is refused on **Save** with a message, and changes nothing.
- **Edits and Delete**: editing a global template changes it in every project. Deleting one deletes it in every project, as its Delete bar says; a project whose default template it was falls back to its first. A template can be deleted while the active project lists at least one other, own or global.
- **"Default"**: a project lists the template "Default" only while it has no template of its own and there is no global one. A new project starts with the global templates. The first global template, saved from a project that listed only "Default", keeps "Default" in that project as one of its own.

## Branch

The **Branch** section of Project settings holds the project's **branch settings**: the branch template, the branch types with their fallback, and the title exclusion pattern. They name the git branch a Start creates, and the title exclusion pattern the worktree's words. They never change the start of the worktree's name, which is the task's key. A project uses its own branch settings or the [global](#global-branch-settings) ones, never a mix.

- **Branch template**: empty at first, and then Orca names the branch, with its own branch prefix setting. Set, a Start passes the filled-in template to Orca, which uses it as it is. Its variables use the prompt templates' `{{name}}` syntax:

  | Variable | Value |
  | --- | --- |
  | `{{task_key}}` | The task key: `WEB-12` on Jira, `42` on GitHub (no `#`). |
  | `{{task_slug}}` | Up to four words of the title, without what the title exclusion pattern removes: accents folded, lower-cased, joined by `-`, such as `add-dark-mode`. |
  | `{{branch_type}}` | The task's branch type, from the table below. |

  Anything else is written as it is, such as your initials: `{{branch_type}}/{{task_key}}__{{task_slug}}--AB` gives `bugfix/WEB-12__add-dark-mode--AB` for the Jira bug `WEB-12` "[FE] | [Mobile][Widgets] Add dark mode".
- **Branch types**: a table of Jira issue types, typed as the tracker shows them, such as `Bug` → `bugfix` and `Story` → `feature`, matched ignoring case, with **Add branch type** and the trash can to remove a row, then a **Fallback branch type**. A row with either side empty counts as none. A type not in the table, a task with no type, and every GitHub task get the fallback.
- **Title exclusion pattern**: a regular expression, `\[[^\]]*\]` at first, which removes bracketed tags such as `[FE]` anywhere in the title. Every match, ignoring case, is removed before `{{task_slug}}` and the worktree's name are made, keeping the words on either side apart. Empty, it removes nothing. When it would leave no words, the whole title is used.
- **Preview**: the branch and the worktree's name a Start of the first loaded task would get, or of an example task, `WEB-12` "[FE] | [Mobile] Add dark mode", a Story, when none is loaded. It sits in the bar under Project settings, so it stays in view while you edit any field of the section.

The section saves itself as you type, like the rest of Project settings, but not while it has one of these problems, keeping what it saved last. It marks the field to fix, says why under it, and names that field in a bar under Project settings that stays in view however far you scroll:

- fixed text in the template that git can't hold in a branch name: a space, one of `~^:?*[\`, `..`, `@{`, a part (between `/`) that starts with `.` or ends with `.lock`, or a leading `-`;
- a title exclusion pattern that isn't a valid regular expression;
- a template that uses `{{branch_type}}` while the fallback is empty, which the fallback fixes.

A Start checks the filled-in branch the same way, for a branch type git can't hold, such as one with a space, and refuses with a message. The preview shows that message under its branch, unless the section already has one of the problems above, which says the same. A branch that is already taken is left to Orca, which tries `<branch>-2`, `-3` and so on.

### Global branch settings

The branch settings can be **global**: kept once, apart from every project's settings, and used *instead of* a project's own by every project that has none of its own, on Jira and GitHub alike. A team whose projects all name their branches the same way sets that up once.
 A Start, `{{branch}}` and the preview use the branch settings the project uses.

- **Which ones a project uses**: once the Global switch below has been used in a project, the project says which: its own or the global ones. Until then, a project that stores any branch setting of its own, even an empty template, uses its own; one with none uses the global ones, if there are any. While there are no global branch settings, a project with none of its own names branches as before: Orca names the branch, and the title exclusion pattern is the initial one.
- **The Global switch**, at the top of the Branch section, is on while the project uses the global branch settings. While there are none, it is off, even in a project with none of its own, so typing in the section never makes global ones.
  - **On, with none global yet**: a bar under Project settings first asks, since *Projects without their own branch settings will name branches this way*; **Make global** makes the section, as shown, the global branch settings, and the project uses them. It waits for a section git can hold, and the bar says so.
  - **On, with global ones**: when the project's own are the same, it just switches. Otherwise the bar asks, since *This project's own branch settings are discarded*; **Use global** drops them, and **Keep own** keeps them.
  - **Off**: the project gets a copy of the global branch settings as its own at once, since none of its branches change, and a note says so. Later edits change only that project.
- **Editing them**: while the switch is on, the section shows and edits the global branch settings, and a warning stays in view under Project settings: **Editing the global branch settings.** *Changes how every project that uses them names the branches and worktrees of its next Starts. Task worktrees already started keep their branches.* Orca never renames a branch it didn't name itself (`docs/reference.md`, `orca worktree create`). The warning gives no count of projects, since projects Kickoff has never opened use them too.
- **No deleting**: once stored, the global branch settings are only edited.

Each of Make global, Use global and turning the switch off writes the project's settings and the global branch settings together, in one write, so a project is never left with neither. A write that fails changes nothing and says why.

## Providers

A **provider** is the code that reads one tracker through one tool. Each lives in its own file under `src/providers/`:

| Provider | Tracker | Tool | Pages |
| --- | --- | --- | --- |
| `github` (`github.ts`) | GitHub Issues | `gh issue list --search` | No: the first 100 per query |
| `jira-orca` (`jira-orca.ts`) | Jira | `orca jira search` | No: the first 100 |
| `jira-twg` (`jira-twg.ts`) | Jira | `twg jira workitem query` | Yes, 50 at a time |

Every provider turns its tool's output into the same `Task` shape, so the panel and the templates never know which one a task came from.

### Adding a provider

For a tracker Kickoff already knows (another way to read Jira, say), adding a provider takes four things:

1. **A provider file** in `src/providers/`, exporting a `Provider` (`src/providers/types.ts`): an `id`, a `tracker`, a `label`, and `list(run, project, config, request)`, which answers one page of open tasks. `run` runs a CLI and is passed in, so the provider's tests run nothing. Keep parsing and argument building in pure functions, tested against real-shaped output with invented data.
2. **A line in the registry**, `src/providers/index.ts`.
3. **A configuration entry**: the id in `ProviderId` and `PROVIDER_IDS`, and its settings in `ProviderConfigs`, `readProviderConfigs` and the defaults of `providerConfig`, all in `src/protocol.ts`.
4. **Its panel settings**: an entry in `PROVIDER_OPTIONS` and the fields its configuration needs in `TrackerFields`, in `src/panel.tsx`.

The type check points at most of these once the id is added to `ProviderId`. A provider for a new tracker, such as Linear or GitLab, also adds the tracker to `TrackerId` and `trackerOf`, with the filter a project starts with in `INITIAL_FILTERS` (`src/protocol.ts`), the recipes its filter editor offers a new filter in `RECIPES` (`src/filter.ts`), says how its worktrees are named and read back (`src/naming.ts`), how a Start links the worktree to the task and how a linked worktree is found (`src/orca.ts`), and how the panel names the tracker and its queries, in `QUERY_WORDING` (`src/panel.tsx`).

## Known limitations

- **The same task can be started in two projects.** Kickoff looks for a task's worktree in the active project only, so two Orca projects that read the same tracker can each start it.
- **A renamed worktree without an Orca link isn't found.** A worktree counts as started for a task when Orca links it to the task, or, as a fallback, when its name starts with the task's key (`web-12-…`, `issue-42-…`). A worktree that has no link and was renamed is seen by neither.
- GitHub lists at most 100 tasks per query, and Orca's Jira connection at most 100 per JQL query; a tracker search with them gives at most as many results: narrow the filter's queries, or refine the search. Only `twg` pages, 50 tasks at a time, filled from each query in turn.
- On Windows, Kickoff gives the tools the default `APPDATA` folder, which Orca leaves out of the worker's environment. If yours is redirected elsewhere, the tools can't find their login or Orca.

## Development

There is no build step and no dependency: Orca loads the TypeScript as it is. `docs/reference.md` holds the facts about Orca, `gh` and `twg` that the code relies on, and `GLOSSARY.md` the words it uses.

```sh
orca plugin types .                      # writes the API types to .orca/ (git-ignored)
npx -y -p typescript@5.6.3 tsc -p .      # type check
orca plugin validate .
orca plugin test .
orca plugin check .                      # renders the panel once per scenario in src/panel.check.ts
orca plugin dev watch .                  # loads the folder into Orca and reloads on save
```

`orca plugin test` and `orca plugin check` fail when the folder is on a different drive from Orca on Windows; `docs/reference.md` (Tests) shows how to run them from a copy.

## License

[MIT](LICENSE).
