# Kickoff

An [Orca](https://github.com/stablyai/orca) plugin that lists the open tasks of the active project's tracker (GitHub Issues, or Jira) in a side panel, and starts each one in its own worktree, linked to the task, with an agent and a prompt built from a template you write per project.

Inspired by [rr235/orca-task-launcher](https://github.com/rr235/orca-task-launcher), which reads GitHub only.

## Requirements

- **Orca 1.4.255 or later.**
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

- **A project with a GitHub repository** lists its open issues with no setup.
- **Any other project** opens **Project settings** by itself. Choose a tracker:
  - **GitHub**, for a project whose repository Orca knows.
  - **Jira (Orca connection)**: a JQL query, and the site when Orca is connected to more than one (Orca's default site otherwise).
  - **Jira (twg)**: a JQL query, and optionally `twg`'s site and profile.

  The JQL starts as `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`. The gear in the panel's header opens Project settings again later, and **Done** goes back to the list.

Each task shows as a card with its key and title, then its labels, after its status on Jira, then its assignees, if any. **Start** (the play button):

1. creates a worktree named after the task's key and up to four words of its title, such as `web-12-add-dark-mode` for Jira's `WEB-12` "Add dark mode", or `issue-42-add-dark-mode` for GitHub's `#42`;
2. links it to the task in Orca, so Orca shows the task on the worktree;
3. launches the project's agent in it, with the prompt filled from the chosen template.

Creating the worktree can take a minute. Once it exists, the card shows the worktree, as a link that opens it, the assignees, and the agent running in it, and the task can't be started again.

**Project settings** also hold, under **Start**:

- **Agent**: Orca's default agent, a named one (`claude`, `codex`, `gemini`, `opencode`, `copilot`), or none. If Orca's default can't be read, Start says so and asks you to pick one.
- **Prompt templates**: a project can have several, each with a name. The default template is used unless you choose another on a task's card. The pencil edits the template chosen as default, and **+** adds one.

The **Search tasks** field above the list filters the loaded tasks as you type, by key, title or label. **Enter** (or **Search in GitHub** / **Search in Jira**) asks the tracker instead, for the tasks of the same list that match your words, including those not loaded yet. **Clear search** goes back to the list.

GitHub and Orca's Jira connection list up to 100 tasks, and say so when there are more. With `twg`, **Load more** reads the next page.

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
| `{{branch}}` | The new worktree's name, such as `web-12-add-dark-mode`. |

A filled prompt over 30 000 characters makes Start fail, since the Windows command line holds about 32 000.

To run a Claude Code skill, start the template with its command, for example:

```text
/tdd {{task_key}}: {{task_title}}

{{task_description}}
```

Only blank lines may come before the command, and the new worktree must see the skill: a plugin installed with `local` scope is not seen in a new worktree on Windows, while `user` scope is.

## Providers

A **provider** is the code that reads one tracker through one tool. Each lives in its own file under `src/providers/`:

| Provider | Tracker | Tool | Pages |
| --- | --- | --- | --- |
| `github` (`github.ts`) | GitHub Issues | `gh issue list` | No: the first 100 |
| `jira-orca` (`jira-orca.ts`) | Jira | `orca jira search` | No: the first 100 |
| `jira-twg` (`jira-twg.ts`) | Jira | `twg jira workitem query` | Yes, 50 at a time |

Every provider turns its tool's output into the same `Task` shape, so the panel and the templates never know which one a task came from.

### Adding a provider

For a tracker Kickoff already knows (another way to read Jira, say), adding a provider takes four things:

1. **A provider file** in `src/providers/`, exporting a `Provider` (`src/providers/types.ts`): an `id`, a `tracker`, a `label`, and `list(run, project, config, request)`, which answers one page of open tasks. `run` runs a CLI and is passed in, so the provider's tests run nothing. Keep parsing and argument building in pure functions, tested against real-shaped output with invented data.
2. **A line in the registry**, `src/providers/index.ts`.
3. **A configuration entry**: the id in `ProviderId` and `PROVIDER_IDS`, and its settings in `ProviderConfigs`, `readProviderConfigs` and the defaults of `providerConfig`, all in `src/protocol.ts`.
4. **Its panel settings**: an entry in `PROVIDER_OPTIONS` and the fields its configuration needs in `TrackerFields`, in `src/panel.tsx`.

The type check points at most of these once the id is added to `ProviderId`. A provider for a new tracker, such as Linear or GitLab, also adds the tracker to `TrackerId` and `trackerOf` (`src/protocol.ts`), says how its worktrees are named and read back (`src/naming.ts`), how a Start links the worktree to the task and how a linked worktree is found (`src/orca.ts`), and how the panel names the tracker (`src/panel.tsx`).

## Known limitations

- **The same task can be started in two projects.** Kickoff looks for a task's worktree in the active project only, so two Orca projects that read the same tracker can each start it.
- **A renamed worktree without an Orca link isn't found.** A worktree counts as started for a task when Orca links it to the task, or, as a fallback, when its name starts with the task's key (`web-12-…`, `issue-42-…`). A worktree that has no link and was renamed is seen by neither.
- GitHub and Orca's Jira connection list at most 100 tasks, and a tracker search with them at most 100 results: narrow the JQL on Jira, or refine the search. Only `twg` pages.
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
