# Reference: Orca, gh, twg

Facts about the environment Kickoff runs in. Each fact carries its source:

- **[Verified]**: checked by running the command or reading Orca's generated types or installed code, on Windows with Orca 1.4.255.
- **[Original]**: read in [rr235/orca-task-launcher](https://github.com/rr235/orca-task-launcher) (MIT, v0.1.2 and later commits) but not run here.
- **[Assumed]**: an inference that has not been checked. Check it before depending on it.

Update this file when a fact is confirmed or disproved. All example data is invented.

## Orca plugins

### Sources of truth

- `orca plugin types <dir>` writes the plugin API types to `<dir>/.orca/types/` (and a `.orca/.gitignore`) without contacting the app. `orca plugin create` and `orca plugin dev load|watch` also write them **[Verified]**.
- `orca skills get orca-plugin-authoring` prints the official authoring guide for the installed Orca version, with references for manifest, host API, events, components, testing, recipes and CLI **[Verified]**.
- `tsconfig.json` is `{ "extends": "./.orca/types/tsconfig.json", "include": ["src"] }`. `.orca/` is git-ignored **[Verified]**.
- Orca loads `.ts`, `.tsx`, `.mts` and `.jsx` as they are, without type checking (`npx tsc -p .` for that). There is no build step and no `package.json`. A panel may only import `orca`, `orca/*` and relative paths **[Verified]**.

### Manifest

```json
{
  "manifestVersion": 2,
  "id": "kickoff",
  "name": "Kickoff",
  "version": "0.1.0",
  "description": "...",
  "license": "MIT",
  "engines": { "orca": ">=1.4.255" },
  "execution": "trusted-worker",
  "pluginApi": 1,
  "main": "src/worker.ts",
  "capabilities": [{ "kind": "storage:own" }, { "kind": "workspace:read" }],
  "contributes": {
    "panels": [{ "id": "tasks", "title": "Kickoff", "icon": "rocket", "entry": "src/panel.tsx", "ui": "components" }]
  }
}
```

**[Verified]** against the manifest schema:

- `manifestVersion: 2` requires `engines.orca >= 1.4.245`. `engines.orca` is required, in the form `">=x.y.z"`, and must cover the highest "Since" of anything used. `pluginApi` defaults to 1.
- `execution`: `data`, `declarative`, `sandboxed-ui` or `trusted-worker`. `trusted-worker` runs the worker in a separate Node.js process with the user's account access, and the user must approve it on install.
- `id` is kebab-case; ids starting with `orca-` are reserved. The installed identity is `<publisher>.<id>`, where the publisher is the repository owner (or `local` for a folder). Omit `publisher` (requires `>=1.4.246`).
- Orca rejects unknown keys.
- `kickoff` is not used in either configured catalog (`stablyai/orca-plugins`, `stablyai/orca-community-plugins`) as of 2026-11-11. Similar plugins: `rr235.task-launcher`, `nhangen.git-issues`, `plozmun.redmine-tasks`.

Capabilities and the Orca version they need **[Verified]**:

| Capability | Since |
| --- | --- |
| `workspace:read` | 1.4.160 |
| `workspace:write` | 1.4.248 |
| `agent:read` | 1.4.245 |
| `agent:launch` | 1.4.248 |
| `terminal:send` | 1.4.160 |
| `terminal:read` | 1.4.248 |
| `notifications:show` | 1.4.160 |
| `storage:own` | 1.4.245 |
| `secrets:own` (system keychain) | 1.4.245 |
| `settings:own` | 1.4.160 |

### Worker API

```ts
type OrcaWorkerApi = {
  api: HostApiVersion
  commands: { register(id, handler: (args, { signal }) => unknown): Disposable }
  events: { on(event, handler): Disposable }       // only events listed in contributes.events (max 4)
  hooks: { on(hook, handler): Disposable }
  host: HostApi<'worker'>                           // host.call(method, params, { signal }), host.has()
  panels: {
    handle(name, (input, { panel: { id, surface, contributionId }, signal }) => output): Disposable
    post(event, payload, { panel? }): void
  }
  storage: { get(key): Promise<JsonValue | null>; set; delete; keys; onDidChange(({ key }) => void) }
  settings: { get(); get(key); set; onDidChange }  // settings:own
  secrets: { get; set; delete }                    // secrets:own
  grantedCapabilities: readonly string[]
  log(message: string): void
}

export default function activate(orca: OrcaWorkerApi): void   // deactivate() is optional
```

**[Verified]**. Requests and panel events are typed by augmenting the `orca` module, in a file that also has `export {}`:

```ts
declare module 'orca' {
  interface PluginRequests {
    'tasks.load': { input: { cursor?: string }; output: TaskList }
  }
  interface PluginPanelEvents {}
}
```

Host methods **[Verified]**:

- Worker: `workspace.readContext`, `workspace.list`, `workspace.open`, `terminal.sendText`, `terminal.create`, `terminal.read`, `agent.launch`, `agents.list`, `notifications.show`, `storage.*`, `secrets.*`, `settings.*`, `statusBar.update`, `editor.open`, `commands.run`.
- Panel: `workspace.readContext`, `notifications.show`, `storage`, `secrets`, `settings`, `shell.openExternal`, `files.saveAs`, `plugin.request`, `agents.list`, `events.subscribe`.

What the API does **not** offer **[Verified]**: listing projects, creating worktrees, reading Orca's settings, or knowing which workspace is focused by id.

- `workspace.list` returns `{ workspaces: { id, kind: 'worktree' | 'folder', name, path, branch | null, hostId | null }[], truncated }`, with no project id and no focus flag.
- `agent.launch({ workspaceId, agent, prompt? })` returns `{ terminalId }`. `agent` is required, and the workspace must already exist.
- `agents.list` returns `{ agents: { terminalId, title, agent, state: 'working' | 'blocked' | 'waiting' | 'done', stateStartedAt }[] }` for the focused workspace only, and does not say which agent is the default.

That is why Kickoff uses the Orca CLI for projects, worktrees and creation.

### Errors from worker to panel

- Documented contract **[Verified]**: an error thrown in a handler whose `code` is a host error code (`invalid_params`, `conflict`, ...) reaches the panel with that code; any other becomes `action_failed`. The panel can also see `unknown_method`, `timeout` and `unavailable`.
- Whether the thrown `message` reaches the panel unchanged: **[Assumed]**. The worker side serialises `{ code, message }`, but the main-process routing could not be read.
- So Kickoff returns expected failures as data and never relies on thrown messages.
- `plugin.request` times out after 30 000 ms by default, and accepts at most 120 000 **[Verified]**.

### Events

- `workspace.changed` delivers `{ context: { branch: string; displayName: string; terminals: { id; title? }[] } | null }`, with no workspace or project id. Each new subscriber first gets the current context **[Verified]**.
- `mount()` from `orca/testing` does not emit it on its own; tests emit it **[Verified]**.
- Orca does not emit `workspace.changed` when switching between two workspaces with the same branch, name and terminals, for example two `main` worktrees of different projects. The original plugin polls the active worktree every 2 s while the panel is visible **[Original]**.
- Other events: `workspace.created` and `workspace.removed` (`{ workspaceId, kind, path, branch? }`), `agent.status.changed` (`agent:read`), and `theme` in the panel. A panel subscribes with `on(...)` without `contributes.events`, but needs `workspace:read` **[Verified]**.

### Panel

- A panel exports a default component, plus an optional `setup(ctx: PanelContext): void | (() => void)`, where `PanelContext = { subscriptions, signal, visible: ReadonlyAtom<boolean>, panel: { id } }` **[Verified]**.
- State: `atom`, `derived`, `read`, `set`, `update`. `persist` takes `'memory' | 'plugin' | 'workspace' | 'storage'`, plus `version` and `migrate` **[Verified]**.

Components **[Verified]**:

- `Stack`, `Row`, `Text`, `Heading`, `Button`, `IconButton`, `Badge`, `Card`, `List`, `ListItem`, `Input`, `Switch`, `Select`, `Separator`, `Progress`, `Spinner`, `EmptyState`, `Link`, `Code`, `Textarea`, `Checkbox`, `RadioGroup`, `Slider`, `Field`, `Tabs`, `Tab`, `Collapsible`, `Toolbar`, `Grid`, `Callout`, `Skeleton`, `Box` (since 1.4.248), `Table` (with `hasMore` and `onLoadMore`), `Tree`, `Markdown`, `CodeView`, `Image`, `KeyValue`, `RelativeTime`.
- The single-line text field is `Input`:

  ```ts
  type InputProps = { label: string; labelHidden?: boolean; value?: string; defaultValue?: string; placeholder?: string;
    type?: 'text' | 'search' | 'password'; maxLength?: number; invalid?: boolean; disabled?: boolean;
    onChange?: (value: string) => void; onSubmit?: (value: string) => void }
  ```

- `Field` (`label`, `description?`, `error?`, `required?`) wraps a control with help text or an error.
- Limits per render: 5000 nodes, 16 KiB per text, 500 options per `Select`.

Usage seen in the original **[Original]**:

```tsx
const list = atom<T | null>(null)
const open = atom<T>('name', initial, { persist: 'plugin' })
ctx.subscriptions.push(on('workspace.changed', () => reload()))
await plugin.request('request.name', input, { timeoutMs: 60000 })

<Row justify="between" align="center" gap="xs" wrap>
<Box border radius="md" padding="sm">
<Text size="sm" muted> <Badge tone="success">
<IconButton size="xs" variant="solid" tone="accent" icon="play" label="..." tooltip="..." onPress={fn} />
<Select label="..." value={v} onChange={fn} options={[{ value, label }]} />
<Collapsible title="..." open={b} onChange={fn}>
<EmptyState title="..." description="..." icon="branch" />
```

Icons seen: `rocket`, `play`, `refresh`, `branch`, `close`, `check`.

### Tests

- `orca plugin test .` runs `*.test.ts(x)`, `.mts`, `.js`, `.jsx` and `.mjs` files next to the code, with no sandbox **[Verified]**.
- `orca/testing` exports `test`, `describe`, `beforeEach`, `afterEach`, `assert`, `mockHost`, `hostError`, `mockEditorHost`, `stored`, `mount`, `mountWorker` and `defineCheck`, and the types `MockRequests`, `TestPanel`, `TestWorker`, `MockHost` and `CheckScenario` **[Verified]**.
  - `assert` has `ok`, `equal`, `notEqual`, `deepEqual`, `notDeepEqual`, `match`, `throws`, `rejects` and `fail`.
  - `mockHost({ capabilities, results, requests, storage, settings, secrets })`.
  - `TestPanel` has `find`, `findAll`, `press`, `type`, `toggle`, `select`, `emit`, `post`, `errors`, `refusals`, `persisted` and more.
  - `TestWorker` has `request`, `emit`, `hooks.fire`, `logs`, `posts` and `deactivate`.
- `src/panel.check.ts` exports `defineCheck({ scenario: { storage, events, requests } })`, which `orca plugin check` and `orca plugin shot --scenario` render **[Original]**.

Dev commands **[Verified]**: `orca plugin validate .`, `test .`, `check .`, `dev watch .`, `inspect`, `dev request`, `dev emit`, `shot --scenario`.

## Orca CLI

- The executable is `orca` on Windows and macOS. On Linux it is `orca-ide`, because `orca` is usually GNOME's screen reader **[Original]**; not checked on Linux.
- On Windows, both `orca.cmd` and `orca.exe` are on PATH and `where` lists the `.cmd` first. `execFile('orca')` without a shell resolves the `.exe`. Never point at the `.cmd` **[Verified]**.
- Every call takes about 0.5 s on Windows, mostly process start-up **[Verified]**.
- Every `--json` response is wrapped as `{ id, ok: true, result: {...}, _meta: { runtimeId } }`. Errors are `{ ok: false, error: { code, message } }` on stdout, with exit 1 **[Verified]**.

### `orca project list --json`

`result.projects[]` **[Verified]**:

```json
{ "id": "github:acme/web", "displayName": "web", "kind": "git",
  "providerIdentity": { "provider": "github", "owner": "acme", "repo": "web" },
  "gitRemoteIdentity": { "canonicalKey": "...", "remoteName": "origin", "remoteUrl": "..." },
  "sourceRepoIds": ["..."], "badgeColor": "...", "repoIcon": { "type": "lucide" }, "createdAt": "...", "updatedAt": "..." }
```

From Orca's code **[Verified]**, not seen in real output:

- `kind` is `'git' | 'folder'` and optional.
- `providerIdentity` only exists for GitHub: `{ provider: 'github', owner, repo, host? }`, where `host` is set for GitHub Enterprise.
- Project id forms:
  - `github:<owner>/<repo>`, lower-case; `github:<host>/<owner>/<repo>` for GitHub Enterprise.
  - `git:<canonicalKey>` for other remotes, with `gitRemoteIdentity` and no `providerIdentity`.
  - `repo:<repoId>` for a folder or a repository without a remote, with neither identity.

Check `providerIdentity.provider === 'github'`, not just `owner` and `repo`.

### `orca worktree list --json`

`result.worktrees[]`, plus `totalCount`, `truncated` and `hostScope` **[Verified]**. Fields Kickoff uses:

```json
{ "id": "<repoId>::<path>", "projectId": "github:acme/web", "displayName": "web-12-add-dark-mode",
  "displayNameMode": "fixed", "branch": "refs/heads/someone/web-12-add-dark-mode", "isArchived": false,
  "isMainWorktree": false, "linkedIssue": 42,
  "linkedWorkItem": { "provider": "github", "type": "issue", "number": 42, "title": "...", "url": "..." },
  "linkedItems": [
    { "provider": "jira", "type": "issue", "number": 0, "identifier": "WEB-12", "jiraIdentifier": "WEB-12",
      "url": "https://example.atlassian.net/browse/WEB-12", "title": "..." }
  ] }
```

- `linkedIssue` is `number | null`.
- `linkedWorkItem` is the primary link or `null`:
  - `provider` is `github`, `gitlab`, `linear` or `jira`; `type` is `issue`, `pr` or `mr`.
  - `title` and `url` are required.
- `linkedItems[]` holds all links.
  - `title` and `url` may be missing.
  - Each item may carry `taskSourceContext` and `origins`, for example a PR observed in an agent session.
- The Jira item shape comes from Orca's code (`parseWorkspaceReferenceUrl`). No Jira-linked worktree has been seen in real output yet.
- `displayNameMode`:
  - `automatic`: the name follows the branch.
  - `fixed`: the user named it, which is what `--name` gives.

### `orca worktree ps --json`

`result.worktrees[]`: `{ worktreeId, isActive: boolean, displayName, branch, repo, status, linkedIssue, agents: [{ agentType, state, paneKey, prompt, mainAgent }] }` **[Verified]**.

- `worktreeId` matches `id` in `worktree list`.
- Exactly one row has `isActive: true`, and it matches `orca worktree show --worktree active`.
- `agents` may be `[]`.
- `orca reference list --worktree active` fails with `selector_not_found` at the same moment that `worktree show --worktree active` resolves.

### `orca worktree create`

Flags **[Verified]**:

- `--project <id-or-name>`, `--name <name>`, `--issue <n>`, `--no-parent`, `--agent <id>`, `--prompt <text>` and `--json`.
- Also `--branch`, `--surface chat|terminal`, `--activate`, `--setup`, `--retry-launch <operationId>`, `--reference <url-or-jira-key>` (repeatable) and `--reference-site <id>`.

Behaviour:

- `--name` sets `displayName` as a fixed, user-chosen name **[Verified]**.
  - The folder is the sanitised name; if the path is taken, Orca tries alternatives or fails with "Pick a different worktree name".
  - The branch is `refs/heads/<prefix>/<sanitised name>`, where the prefix comes from Orca's `branchPrefix` setting (`git-username` by default, `custom` or `none`).
  - `--branch` skips the prefix.
- Orca renames branches it named itself when an agent starts (`autoRenameBranchFromWork`). A name given with `--name` is not generated, so it is expected not to be renamed **[Assumed]**; not tested by creating a worktree.
- `--prompt`, `--model`, `--effort`, `--surface` and `--retry-launch` require `--agent`: `invalid_argument: --prompt requires --agent`. Without `--agent`, no agent starts **[Verified]**.
- `--agent` must be a known id, otherwise "Unknown TUI agent" **[Verified]**. About 46 ids exist, including `claude`, `codex`, `opencode`, `gemini`, `copilot`, `grok`, `aider`, `goose`, `amp`, `cursor`, `cline`, `kiro`, `qwen-code` and `rovo`. There is no "default" value.
- `--reference <key-or-url>` **[Verified]**:
  - It only links: it does not rename the worktree or fill the prompt, and it is stored before setup or agent start.
  - A bare Jira key makes Orca look the task up through its own Jira connection, and fails without one ("No Jira site selected for issue keys", `jira_issue_unavailable`). A full `/browse/KEY` URL needs no lookup.
  - It cannot be combined with `--issue`, `--pr`, `--linear-issue` or `--gitlab-*`.
  - It needs a host with `WORKTREE_LINKED_ITEMS_DELTA`, otherwise `incompatible_runtime`.
- Orca accepts Jira keys matching `/^[A-Za-z][A-Za-z0-9_]*-\d+$/` **[Verified]**.

### `orca worktree activate --worktree id:<id> --json`

Shows the worktree in Orca **[Verified]** (help only, not run).

### `orca reference`

**[Verified]**:

- `list --worktree <selector>`, `add <url-or-key>... --worktree <selector>`, `remove`.
- `find <url-or-key> [--worktree | --repo] [--include-archived] [--limit n]` searches stored metadata only. It returns `{ kind: 'reference_matches', matches: [{ reference, workspace: { id, name, repo, archived }, agents: [{ agent, liveness }] }] }`, and `matches: []` when nothing is linked.

### Orca's default agent

No CLI command or plugin API exposes it; `orca settings` and `orca config` are unknown commands **[Verified]**. It is stored in Orca's private data:

1. **Data folder** (`%APPDATA%\orca` on Windows **[Verified]**):
   - macOS: `~/Library/Application Support/orca` **[Original]**.
   - Linux: `$XDG_CONFIG_HOME/orca` or `~/.config/orca` **[Original]**.
   - Orca removes `APPDATA` and `XDG_CONFIG_HOME` from the worker environment **[Original]**; not checked, because that needs a running worker.
   - So the original plugin derives the folder from its own install path, `<data>/plugins/<publisher>.<id>/<64 hex>/...` **[Verified]**. It checks that the plugin folder ends with `.<id>`.
2. **Active profile:** `activeProfileId` in `orca-profile-index.json` (keys `schemaVersion`, `activeProfileId`, `profiles[]`), with `orca-profile-index.json.bak` as a fallback and `local-default` as the default **[Verified]**. The original only accepts the id if it matches a pattern and is listed in `profiles[]` **[Original]**.
3. **Settings:** `profiles/<profile>/profile-state.db`, table `profile_state_documents` (`domain`, `payload`, `domain_version`, `revision`, `updated_at`, `content_hash`). `SELECT payload FROM profile_state_documents WHERE domain = 'settings'` gives JSON with `defaultTuiAgent`, `disabledTuiAgents` and `agentDefaultSurface` **[Verified]**.
   - A `profile_state_document_parts` table also exists, so large documents may be split **[Assumed]**.
   - The older `profiles/<profile>/orca-data.json` still holds `settings.defaultTuiAgent` **[Verified]**.
4. **Orca's own rule** (`pickTuiAgent`) **[Verified]**:
   - `blank` means no agent.
   - Otherwise it uses the preferred agent if it is installed and not in `disabledTuiAgents`.
   - Otherwise the first installed agent in a fixed order (`claude`, `claude-agent-teams`, `openclaude`, `codex`, ...).
   - Kickoff cannot tell what is installed (see ADR-0003).

### Orca's Jira support

`orca jira` uses the Jira connection saved in Orca's settings **[Verified]**.

- Read-only subcommands: `connection`, `issue <key>`, `list [--filter assigned|reported|all|done]`, `search <jql>`, `project list|types|fields`, `status list`, `assignee list`, `priority list`, `comment list`.
- All take `--site <id>` and `--json`. `list` and `search` take `--limit <n>`: 30 by default, clamped to 1–100.
- `orca jira connection --json` → `result: { connected, sites: [{ id, siteUrl, displayName, authType: 'cloud' | 'server', apiBaseUrl, ... }], activeSiteId, selectedSiteId, viewer: {...} }`.
  - It lists saved connections; it does not test them.
  - `viewer` and `sites[]` contain the user's email: never show or log them.
- `orca jira search "<jql>" --json` → `result: Issue[]`:

  ```json
  { "id": "10012", "key": "WEB-12", "siteId": "abc123", "title": "Add dark mode to settings",
    "description": "plain text", "url": "https://example.atlassian.net/browse/WEB-12",
    "status": { "id": "10000", "name": "To Do", "categoryKey": "new", "categoryName": "To Do", "colorName": "blue-gray" },
    "labels": ["ui"], "assignee": { "accountId": "...", "displayName": "Ana Example" },
    "project": { "key": "WEB", "name": "Web" }, "issueType": { "name": "Task" }, "createdAt": "...", "updatedAt": "..." }
  ```

  - `status.categoryKey` is `new`, `indeterminate` or `done`, and is `"undefined"` when missing.
  - An unassigned task has **no** `assignee` key: it is not `null`. The assignee shape comes from Orca's code.
  - `description` is already plain text, not ADF.
- No pagination: no cursor or offset, and no hint that more results exist.
- Errors **[Verified]**:
  - Invalid JQL: exit 1, `{ ok: false, error: { code: 'runtime_error', message: 'Error 400: <message in the instance language>' } }` on stdout, empty stderr.
  - Unknown site: `invalid_argument`, "No matching connected Jira site...".
  - Empty JQL: rejected with `invalid_argument`.
- `orca jira list --filter assigned` uses `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` **[Verified]**.

## Executable paths

On Windows all three tools are `.exe` and on PATH **[Verified]**:

| Tool | Windows path |
| --- | --- |
| `orca` | `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` |
| `gh` | `%ProgramFiles%\GitHub CLI\gh.exe` |
| `twg` | `%LOCALAPPDATA%\Programs\twg\bin\twg.exe` |

- macOS: `orca` is at `/Applications/Orca.app/Contents/Resources/bin/orca`; `gh` at `/opt/homebrew/bin/gh` or `/usr/local/bin/gh` **[Original]**.
- `twg` on macOS and Linux: no data **[Assumed]**.
- Whether the worker inherits the user's PATH on Windows: **[Assumed]**. That is why full paths are tried too.

## GitHub CLI

`gh` 2.96.0 **[Verified]**.

`gh issue list --repo <owner/name> --state open --limit 100 --json number,title,url,body,labels,assignees` returns a JSON array:

```json
[{ "number": 42, "title": "Add dark mode", "url": "https://github.com/acme/web/issues/42", "body": "...",
   "labels": [{ "id": "...", "name": "ui", "description": "", "color": "..." }],
   "assignees": [{ "id": "...", "login": "octocat", "name": "Octo Cat", "databaseId": 1 }] }]
```

- `--limit` defaults to 30. `--search`, `--assignee` and `--label` also exist.
- For GitHub Enterprise, `--repo` takes `<host>/<owner>/<repo>` **[Assumed]**; it is the documented `gh` form, but not run here.

## Teamwork Graph CLI (twg)

Atlassian's official CLI, `twg` 1.4.4. Docs: <https://developer.atlassian.com/cloud/twg-cli/>. Code: <https://github.com/atlassian/twg-cli> (Apache 2.0).

- **Login** **[Verified]**:
  - `twg login` uses OAuth 2.1 in the browser and refreshes on its own.
  - `twg whoami`, `twg doctor` and `twg access` show the user, diagnose problems and list sites.
- **Global options** **[Verified]**:
  - `-o, --output text|json|jsonl`.
  - `--api-version v2`.
  - `-s, --site <prefix|host|cloud id>` (`TWG_SITE`).
  - `-p, --profile <name>` (`TWG_PROFILE`).
  - `--timeout-ms`.
  - `--select <paths>`, which needs `-o json`.
  - All of them work after the subcommand.
- **Query** **[Verified]**: `twg jira workitem query --jql <jql> --fields summary,status,assignee,labels,description --limit 50 --after <cursor> --output json --api-version v2`.

Successful output **[Verified]** (no `ok` key):

```json
{
  "apiVersion": "v2",
  "command": "jira.workitem.query",
  "request": { "jql": "...", "site": "example.atlassian.net", "maxResults": 50, "fields": ["summary", "status", "assignee", "labels"] },
  "data": {
    "issues": [
      { "id": "10012", "key": "WEB-12", "summary": "Add dark mode to settings", "assignee": null,
        "status": { "name": "To Do", "statusCategory": { "id": 2, "key": "new", "name": "To Do" } },
        "labels": [], "url": "https://example.atlassian.net/browse/WEB-12" }
    ]
  },
  "pageInfo": { "hasNextPage": true, "nextCursor": "<opaque>" },
  "meta": { "resourceClass": "entity", "resourceType": "jira.workitem" }
}
```

- An empty result is `data.issues: []` with exit 0 **[Verified]**.
- `pageInfo` is **missing** in some responses, for example with 0 or 1 results and limit 50 **[Verified]**. Treat a missing `pageInfo` as "no next page".
- Without `-o json`, success starts with `✓ Completed jira.workitem.query.` and failure with `x Failed jira.workitem.query.` on stderr **[Verified]**.
- Only `statusCategory.key: "new"` has been seen. `indeterminate` and `done` are Jira's documented values **[Assumed]**.
- Shape of a non-null `assignee`: **[Assumed]** to be the Jira REST v3 user object, with `displayName`. The response meta says `sourceMode: 'rest'` and `apiVersion: 'rest-v3'`.
- `description` is ADF (Jira's JSON document format) **[Assumed]**.

Errors **[Verified]**:

| Case | Exit | stdout | stderr |
| --- | --- | --- | --- |
| Invalid JQL | 1 | `{ ok: false, error: { code: 'TWG_TOOL_EXECUTION_FAILED', message, statusCode, downstreamError, retry, feedback: { url } } }` | Readable block starting `Error: <message>` |
| Unknown site or profile | 1 | `{ ok: false, error: { code: 'TWG_COMMAND_FAILED' \| 'AUTH_PROFILE_MISSING', message } }` | empty |
| Bad arguments | 1 | empty | `error: ...` |

- The message is in the Jira instance's language.
- Take the message from `error.message` on stdout, and fall back to stderr.
- `error.feedback.url` and the stderr block contain the user's email address: never show or log them.
- Coverage: the docs describe Jira Cloud only.

## What the original plugin gets wrong

Reasons Kickoff is written from scratch rather than forked **[Original]**:

- All logic is tied to GitHub: GraphQL queries, the issue number as identifier, and `linkedIssue` as the link.
- It drops Orca projects with no GitHub repository.
- It tries only `orca-ide` on Linux, and only `orca` by name on Windows.
- It shows "Could not reach the Orca CLI" for every Orca CLI failure.
- It lists at most 100 issues.
- When the default agent cannot be read, it assumes `claude`.

Worth copying:

- Pure functions tested against real CLI output.
- Dropping late responses.
- Blocking a second Start while the first may still be running.
- Saving the template after a pause.
- Polling the active worktree.
