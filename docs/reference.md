# Reference: Orca, gh, twg

Facts about the environment Kickoff runs in. Each fact carries its source:

- **[Verified]**: checked by running the command or reading Orca's generated types or installed code, on Windows with Orca 1.4.255 unless the fact names another version, or by reading Orca's public source ([stablyai/orca](https://github.com/stablyai/orca)) at the tag of the release it names.
- **[Original]**: read in [rr235/orca-task-launcher](https://github.com/rr235/orca-task-launcher) (MIT, v0.1.2 and later commits) but not run here.
- **[Assumed]**: an inference that has not been checked. Check it before depending on it.

Update this file when a fact is confirmed or disproved. All example data is invented.

## Orca plugins

### Sources of truth

- `orca plugin types <dir>` writes the plugin API types to `<dir>/.orca/types/` (and a `.orca/.gitignore`) without contacting the app. `orca plugin create` and `orca plugin dev load|watch` also write them **[Verified]**.
- `orca skills get orca-plugin-authoring` prints the official authoring guide for the installed Orca version, with references for manifest, host API, events, components, testing, recipes and CLI **[Verified]**.
- `tsconfig.json` is `{ "extends": "./.orca/types/tsconfig.json", "include": ["src"] }`. `.orca/` is git-ignored **[Verified]**.
- Orca loads `.ts`, `.tsx`, `.mts` and `.jsx` as they are, without type checking. There is no build step and no `package.json`. A panel may only import `orca`, `orca/*` and relative paths **[Verified]**.
- Type check with `npx -y -p typescript@5.6.3 tsc -p .`, after `orca plugin types .`: a fresh clone has no `.orca/`, so `tsconfig.json` has nothing to extend **[Verified]** with TypeScript 5.6.3.

### Manifest

Kickoff's manifest is `orca-plugin.json`. Its shape, with the version and the texts left out, since each release changes the version (see [Releases](#releases)):

```json
{
  "manifestVersion": 2,
  "id": "kickoff",
  "name": "Kickoff",
  "version": "...",
  "description": "...",
  "license": "MIT",
  "icon": "assets/icon.png",
  "cover": { "path": "assets/cover.png", "alt": "..." },
  "engines": { "orca": ">=1.4.277" },
  "execution": "trusted-worker",
  "pluginApi": 1,
  "main": "src/worker.ts",
  "capabilities": [{ "kind": "storage:own" }, { "kind": "workspace:read" }],
  "contributes": {
    "panels": [{ "id": "tasks", "title": "Kickoff", "icon": "zap", "entry": "src/panel.tsx", "ui": "components" }]
  }
}
```

**[Verified]** against the manifest schema:

- `manifestVersion: 2` requires `engines.orca >= 1.4.245`. `engines.orca` is required, in the form `">=x.y.z"`, and must cover the highest "Since" of anything used. `pluginApi` defaults to 1.
- `execution`: `data`, `declarative`, `sandboxed-ui` or `trusted-worker`. `trusted-worker` runs the worker in a separate Node.js process with the user's account access, and the user must approve it on install.
- `id` is kebab-case; ids starting with `orca-` are reserved. The installed identity is `<publisher>.<id>`, where the publisher is the repository owner (or `local` for a folder). Omit `publisher` (requires `>=1.4.246`).
- Orca rejects unknown keys.
- The manifest has a `repository` field (source repository URL, since 1.4.160) and a `homepage` field (https only, since 1.4.245) **[Verified]** (`orca skills get orca-plugin-authoring --reference references/manifest.md`, Orca 1.4.277). Kickoff sets neither. The panel can't read the manifest, so the link under Project settings to Kickoff's repository (issue #153) takes its URL from a constant, `KICKOFF_REPOSITORY_URL` in `src/about.ts`, and shows before the worker answers `about.load`.
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
| `appearance:write` | 1.4.251 |
| `workspace:create` | 1.4.259 |
| `automation:read` | 1.4.259 |
| `automation:write` | 1.4.259 |
| `history:read` (past agent sessions) | 1.4.259 |

The last five come from `orca skills get orca-plugin-authoring --reference host-api`, Orca 1.4.277 (issue #155). Which host method needs which capability is under [Worker API](#worker-api). Kickoff asks for `storage:own` and `workspace:read` only.

### Plugin icon

- `icon` (since 1.4.160) is the image Orca shows beside the plugin's name: a square, static PNG or WEBP, at least 128×128, at most 256 KB **[Verified]** (`orca skills get orca-plugin-authoring --reference manifest`, Orca 1.4.261). It is separate from a panel's `icon`, which names one of Orca's built-in icons (`zap`, `play`, `branch`, ...).
- Orca draws it on the plugin's page in Settings → Plugins (`PluginDetailPage`, from the entry's `images.icon`) **[Verified]** by reading the renderer of Orca 1.4.261. The maintainer saw Kickoff's icon inside Orca with the plugin loaded from a development folder (issue #71).
- Kickoff's icon is `assets/icon.png`, 512×512, exported from `assets/icon.svg`. It is a white task card with thin strokes and a mint (`#34D399`) play button, at 85% of the tile, on a rounded square with a slate gradient from `#3B4A63` at the top left to `#1A2233`. The play triangle and the ring around the button are filled with that same gradient, so they show the tile's colour at that spot. It is drawn by hand, with no image generator and no icon set. The gradient makes the PNG about 120 KB, under the 256 KB limit. It was chosen in issue #71; every variant is on the `prototype/icon` branch, the final round under `assets/icon-prototype/round2/`.
- The fallback, if the card's lines and play button blur together at 20–32 px beside the name, is I-B in the same style: a branch forking off a trunk and ending in a mint play triangle. Its source is `assets/icon-prototype/round2/out/b-thin-slate-mint-85.svg` on `prototype/icon`, with a 512×512 PNG next to it. To switch, copy that SVG over `assets/icon.svg` and export it again as below.
- Microsoft Edge in headless mode exports an SVG to a PNG of an exact size on Windows, with the corners outside the rounded square left transparent **[Verified]** with Edge on Windows 11 (issue #71). `--force-device-scale-factor=1` keeps Windows display scaling out of the size, `--default-background-color=00000000` makes the background transparent, and a separate `--user-data-dir` keeps an Edge window that is already open from taking the call. In PowerShell, from the repository root:

  ```powershell
  $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $svg = ([Uri](Resolve-Path assets/icon.svg).Path).AbsoluteUri
  Start-Process $edge -Wait -ArgumentList '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', "--user-data-dir=$env:TEMP\kickoff-icon-export",
    '--window-size=512,512', '--default-background-color=00000000',
    "--screenshot=$PWD\assets\icon.png", $svg
  ```

### Plugin cover

- `cover` (since 1.4.245) is the wide image at the top of the plugin page: `cover.path` is a static PNG, JPEG or WEBP, at least 800×500, at most 1024 KB, 16:10 recommended (1600×1000), and `cover.alt`, required, says what it shows for screen readers **[Verified]** (`orca skills get orca-plugin-authoring --reference manifest`, Orca 1.4.261). `cover.alt` takes at most 160 characters: `orca plugin validate` refuses a longer one with "cover.alt: must be at most 160 characters", a limit the reference doesn't state **[Verified]** with Orca 1.4.261 (issue #72).
- Orca draws the cover in two places, both cropped to 16:10 with `object-cover`: on the plugin's card in the plugin list, above its name and description, and in the hero at the top of the plugin's page, in a rounded, bordered frame **[Verified]** by reading the Settings bundle of Orca 1.4.261. How wide each one is inside Orca was not measured.
- Kickoff's cover is `assets/cover.png`, 1600×1000, about 560 KB, exported from `assets/cover.html`. On the icon's slate gradient, the name and the line "Your prompt templates, one click from any GitHub, Jira or Linear task." (Linear added in issue #161) sit on the left, and Kickoff's panel in Orca's dark theme on the right, drawn in HTML with the tasks of the `jira-started` check scenario (without WEB-14, so the open menu fits). The template menu of WEB-16 is open with `implement`, `prototype` and `review`, which are example names. A mint underline, tapered to a point, sits behind "prompt templates", and a curved arrow runs from under its last "e" to the menu; a script in the page places both from the layout. It is drawn by hand, with no image generator and no icon set. It was chosen in issue #72, as variant C-A.
- Edge in headless mode exports an HTML page to a PNG of exactly 1600×1000 on Windows **[Verified]** with Edge on Windows 11 (issue #72). `--virtual-time-budget` gives the page time to load its fonts and run its script before the capture. The page uses Segoe UI, so export it on Windows; elsewhere it falls back to another font **[Assumed]**. In PowerShell, from the repository root:

  ```powershell
  $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $src = ([Uri](Resolve-Path assets/cover.html).Path).AbsoluteUri
  Start-Process $edge -Wait -ArgumentList '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', "--user-data-dir=$env:TEMP\kickoff-cover-export",
    '--window-size=1600,1000', '--default-background-color=FFFFFFFF', '--virtual-time-budget=3000',
    "--screenshot=$PWD\assets\cover.png", $src
  ```

- A real shot of the panel is a poor source for a cover: `orca plugin shot --scenario` captures at 1× CSS pixels (320×680 for a 320 px panel), so it blurs when enlarged, and a scenario replay takes no `--act`, so it cannot open the template `Select` **[Verified]** (issue #72, `orca plugin shot --help`). With Orca's window minimized by a script (`ShowWindowAsync`), 2 of 6 scenario shots showed the panel and 4 showed Orca's own window, all reporting `ok`.

### Releases

- `orca plugin install owner/repo` with no version installs the newest version tag (`vX.Y.Z`), or the default branch when the repository has none, pinned to the exact commit. `owner/repo@<ref>` installs a given tag, branch or commit **[Verified]** (`orca plugin install --help`, Orca 1.4.261). With Kickoff's `v0.1.0` tag pushed, `orca plugin install samfaina/orca-kickoff --json` without `--approve` answered `approval_required` with `source.ref: "v0.1.0"`, the tag's commit and `version: "0.1.0"` from the manifest, and installed nothing **[Verified]** (Orca 1.4.261).
- `orca plugin update <plugin-key>` moves an install from a version tag to the newest version tag, and an install from a branch to the branch's newest commit; a commit pin stays put. An update that asks for no new access, from the same repository, keeps its approval; one that adds capabilities, a higher execution level, commands, shortcuts or panels fails with `approval_required` and leaves the running version in place **[Verified]** (`orca plugin update --help`, Orca 1.4.261).
- So once a tag exists, a merge to `main` reaches no one who installed without a version until the next tag.
- Whether Orca checks that a tag matches the manifest's `version` is not known **[Assumed]**; Kickoff keeps them equal.
- A published tag is never moved or deleted, and the history under it is not rewritten: an install is pinned to the tag's commit, and a rewrite would leave the tag on commits no branch holds. A fix goes out as a new version.

To release a version, with `X.Y.Z` following semantic versioning:

1. In a pull request, set `version` in `orca-plugin.json` to `X.Y.Z`, and merge it.
2. On the updated `main`, run the checks listed in `CLAUDE.md`.
3. Tag the merge commit and push the tag: `git tag -a vX.Y.Z -m "Kickoff X.Y.Z"`, then `git push origin vX.Y.Z`.
4. Publish the release notes: `gh release create vX.Y.Z --verify-tag --title "Kickoff X.Y.Z" --notes-file <notes>`.
5. Check that `orca plugin install samfaina/orca-kickoff --json`, without `--approve`, answers with `source.ref: "vX.Y.Z"`. It installs nothing without the approval.

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

#### Host methods

Orca 1.4.277 offers host API 1.10 (issue #155). The facts below are **[Verified]** from these sources, named in each row:

- **T**: the generated types of Orca 1.4.277 (`HostMethods` in `.orca/types/orca-host/index.d.ts`, from `orca plugin types .`): the params, the result, the surfaces and the "Since host API x.y" note of each method.
- **R**: `orca skills get orca-plugin-authoring --reference host-api`, Orca 1.4.277: the capability each method needs, and the same method lists per surface as T.
- **S**: Orca's method table in its public source, `src/shared/plugins/workers/plugin-host-api*.ts` of `stablyai/orca` at the tags `v1.4.271` and `v1.4.277`. Each method has a `capability`, which the host checks on every call (`capability_denied` when the manifest doesn't declare it), and `paramCapabilities` for a second capability that one param needs. Both tags give each method the same capability as R.

R and S are used because the routes the generated types leave give no answer per method: T names a capability only for `agent.resume`, and the manifest schema (`orca skills get orca-plugin-authoring --reference manifest`) lists the capability kinds but not which method needs which. No capability was checked by a host call answering `capability_denied`: that needs a plugin the user approves in Orca. `orca plugin validate` doesn't check capabilities against the calls a worker makes: a scratch plugin that calls `workspace.create` with only `workspace:read` validates with no warning **[Verified]** (Orca 1.4.277).

Worker methods, with the host API minor each appeared in (T) and its capability (R and S):

| Method | Since | Capability | Params → result |
| --- | --- | --- | --- |
| `workspace.readContext` | 1.0 | `workspace:read` | none → `{ workspaceId?, branch, displayName, terminals: { id, title? }[] } \| null`. `workspaceId` (1.7) is the focused workspace's `workspace.list` id (S). |
| `terminal.sendText` | 1.0 | `terminal:send` | `{ terminalId, text, enter? }` → `{ accepted }` |
| `notifications.show` | 1.0 | `notifications:show` | `{ title, body? }` → `{ delivered }` |
| `storage.get`, `.set`, `.delete`, `.keys` | 1.0 | `storage:own` | `{ key }` → `{ value }`; `{ key, value }` → `{ ok }`; `{ key }` → `{ ok }`; none → `{ keys }` |
| `secrets.get`, `.set`, `.delete` | 1.0 | `secrets:own` | as `storage`, with string values |
| `secrets.protection` | 1.1 | `secrets:own` | none → `{ status: 'os-keyring' \| 'unavailable' }` |
| `settings.get`, `.set` | 1.0 | `settings:own` | the plugin's own settings only: none → `{ settings }`; `{ key, value }` → `{ ok }` |
| `agents.list` | 1.2 | `agent:read` | `{ workspaceId? }` (1.10) → `{ agents: { terminalId, title, agent, state, stateStartedAt, sessionId?, task? }[] }`, the running agents of the focused workspace or of the one named |
| `statusBar.update` | 1.2 | none | `{ id, text?, icon?, tone?, tooltip?, visible? }` → `{ ok }`, for the plugin's `contributes.statusBarItems` |
| `workspace.list` | 1.3 | `workspace:read` | `{ includeStatus? }` (1.7) → `{ workspaces, truncated, statusTruncated? }`, rows below |
| `workspace.open` | 1.3 | `workspace:write` | `{ workspaceId }` → `{ opened }` |
| `terminal.create` | 1.3 | `terminal:send` | `{ workspaceId, title?, command? }` → `{ terminalId }` |
| `terminal.read` | 1.3 | `terminal:read` | `{ terminalId, maxLines? }` → `{ lines, truncated }` |
| `agent.launch` | 1.3 | `agent:launch` | `{ workspaceId, agent, prompt? }` → `{ terminalId }`, in an existing workspace |
| `editor.open` | 1.3 | `workspace:write` | `{ workspaceId, path }` → `{ opened }` |
| `commands.run` | 1.3 | `workspace:write` | `{ action }` (one of Orca's built-in actions) → `{ ran }` |
| `appearance.read` | 1.4 | `appearance:write` | none → `{ revision }` |
| `appearance.apply` | 1.4 | `appearance:write` | `{ expectedRevision, app, terminal }` → `{ revision, themeId, mode, delivery }` |
| `workspace.rename` | 1.5 | `workspace:write` | `{ workspaceId, name }` → `{ name }` |
| `editor.readTypography` | 1.6 | none | none → the editor's font, size, line height, ligatures, word wrap and minimap |
| `project.list` | 1.7 | `workspace:read` | none → `{ projects: { id, name, kind: 'git' \| 'folder', hostId, path, hidden? }[], truncated }`, at most 500 (S) |
| `terminal.list` | 1.7 | `workspace:read` | `{ workspaceId }` → `{ terminals: { id, title? }[], truncated }` |
| `terminal.focus` | 1.7 | `workspace:write` | `{ terminalId }` → `{ focused }` |
| `terminal.close` | 1.7 | `terminal:send` | `{ terminalId }` → `{ closed }`, for a terminal of the focused workspace or one the plugin opened |
| `workspace.create` | 1.8 | `workspace:create`, and `agent:launch` when `agent` is given (`paramCapabilities`, S) | `{ projectId, hostId?, name?, baseBranch?, agent?, prompt?, setup?: 'skip', open? }` → `{ workspaceId, terminalId? }`: a new branch and worktree in a Git project, then the agent once setup has run |
| `agent.resume` | 1.8 | `agent:launch` | `{ workspaceId, agent, sessionId }` → `{ terminalId, started }`; `agent` is one of the agents that resume by id |
| `automation.list` | 1.8 | `automation:read` | none → `{ automations, truncated }` |
| `automation.create` | 1.8 | `automation:write` | `{ name, prompt, agent, projectId?, hostId?, workspaceId?, schedule, timezone?, enabled?, creationKey? }` → `{ automationId }` |
| `automation.update` | 1.8 | `automation:write` | `{ automationId, name?, prompt?, schedule?, timezone?, enabled? }` → `{ updated, reason? }` |
| `automation.delete` | 1.8 | `automation:write` | `{ automationId }` → `{ deleted, reason? }` |
| `project.setHidden` | 1.9 | `workspace:write` | `{ projectId, hostId?, hidden }` → `{ hostId, hidden }` |
| `agent.listSessions` | 1.9 | `history:read` | `{ workspaceId?, limit? }` → `{ sessions: { sessionId, agent, title, workspaceId, hostId, branch, createdAt, updatedAt, messageCount, totalTokens, running }[], truncated }` |

Panel methods (T and R): `workspace.readContext`, `notifications.show`, `storage.get`, `storage.set`, `storage.delete`, `storage.keys`, `secrets.get`, `secrets.set`, `secrets.delete`, `secrets.protection`, `settings.get`, `settings.set`, `shell.openExternal` (1.1, no capability, needs a click or key press), `files.saveAs` (1.1, the same), `plugin.request` (1.2, no capability), `agents.list`, `events.subscribe` (1.2, no capability; the event's own capability) and `editor.readTypography`. A custom editor gets the same list. Panels got `storage`, `secrets` and `settings` in 1.2.

Rules for every call **[Verified]** (R): params are strict, so a field this Orca doesn't know is refused with `invalid_params`, and a method a surface isn't offered answers `not_permitted`. Text params (`prompt` of `agent.launch` and `workspace.create`, `command` of `terminal.create`) take at most 4096 characters, and `name` of `workspace.create` and `workspace.rename` is one line of at most 200 (S).

#### Host API by Orca release

The Orca release floor of each host API minor, the one `orca plugin validate` checks `engines.orca` against, from `PLUGIN_HOST_API_MINOR_SINCE` in `plugin-host-api-releases.ts` (S) **[Verified]**:

| Minor | 1.1, 1.2 | 1.3 | 1.4 | 1.5 | 1.6 | 1.7, 1.8, 1.9 | 1.10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Orca | 1.4.246 | 1.4.247 | 1.4.251 | 1.4.256 | 1.4.257 | 1.4.259 | 1.4.260 |

- So **Orca 1.4.271**, the oldest Kickoff accepted until issue #161 raised `engines.orca` to `>=1.4.277` (see [Orca's Linear support](#orcas-linear-support)), has **host API 1.10**: the method table at the `v1.4.271` tag holds every worker method above, with the same capabilities. Between that tag and `v1.4.277`, `src/shared/plugins/workers` changes in only two source files: how `automation.*` checks a time zone, and how `commands.register` disposes a replaced handler **[Verified]** (S, comparing the folder's files at both tags). Kickoff could call any of them without raising `engines.orca`. That a worker on 1.4.271 reads `orca.api.minor` as 10 is **[Assumed]**: it follows from the source, but nobody read it there.
- Orca's code calls the 1.7, 1.8 and 1.9 floors "provisional … not a stock-release claim" (`PLUGIN_HOST_API_1_7_SINCE`, `_1_8_SINCE` and `_1_9_SINCE`, S), so that 1.4.259 is the first release with these minors is **[Assumed]**. Minors 0 to 6 come from the release tags, as the table's own comment says. `orca plugin validate` uses these floors: a scratch plugin whose worker calls `project.list`, `workspace.create`, `agent.resume`, `agent.listSessions`, `terminal.list`, `project.setHidden` and `automation.list` warns for each one, with `engines.orca` `>=1.4.258`, that it "needs Orca 1.4.259; or guard the call with orca.host.has(…)", and validates with no warning with `>=1.4.271` **[Verified]** (Orca 1.4.277). It doesn't warn for a param newer than its method, such as `agents.list({ workspaceId })` or `includeStatus`: the table's `paramsSince` "cannot be seen statically" (S).
- The capabilities the new methods need, and the Orca that first knows them, are in the table under [Manifest](#manifest).

#### What the host methods give, next to the CLI

- `workspace.list` rows are `{ id, kind: 'worktree' | 'folder', name, project?, projectId?, path, branch, hostId, status? }` **[Verified]** (T). `project` (the project's name, since 1.5) and `projectId` (as `project.list` gives it, since 1.7) are null for a folder of a project group. `status` (with `includeStatus`, 1.7) is `{ state: 'working' | 'permission' | 'done' | 'active' | 'inactive', unread, terminalCount, lastActivityAt }`. There is no focus flag: `workspace.readContext` names the focused workspace.
- A row's `id` is `identity:<key>` when the workspace has an identity, else Orca's raw id (`pluginWorkspaceId`, S) **[Verified]**. So it is not always the `id` of `orca worktree list`, and the two lists don't join by id. Events carry both: `workspaceId`, and `workspaceListId` (1.7), the `workspace.list` id. Whether a `project.list` id is the `id` of `orca project list` (`github:acme/web`) was not checked **[Assumed]**.
- Against what Kickoff reads from the CLI (`ProjectRef` and `OrcaWorktree` in `src/orca.ts` and `src/protocol.ts`) **[Verified]** (T and S):
  - `project.list` has no `providerIdentity`, so it can't give a project's GitHub `owner/repo`, nor a git remote.
  - `workspace.list` has no `linkedIssue` or `linkedItems` (so no GitHub issue numbers or Jira keys), no `isArchived`, no `isMainWorktree` and no `baseRef`. Whether it lists archived worktrees is not known **[Assumed]**.
  - `workspace.create` has no `--branch`, `--issue`, `--reference`, `--reference-site` or `--no-parent`: with strict params, such a field is refused with `invalid_params`. Its `name` gives the branch too; whether Orca puts its branch prefix in front, as with `--name`, was not checked **[Assumed]**. No host method links a workspace to an issue or a Jira key afterwards, as `orca reference add` does.
  - The 4096-character `prompt` of `workspace.create` and `agent.launch` is below Kickoff's own limit, `MAX_PROMPT` (30 000) in `src/template.ts`.
  - `agent.launch` has no `--focus` or `--surface`; `terminal.focus` focuses its terminal afterwards, with `workspace:write`.

What the API still does **not** offer, as of Orca 1.4.277 **[Verified]** (T and R): reading Orca's settings (`settings.get` reads only the plugin's own), listing the available agents or saying which is Orca's default (`agents.list` lists the running ones; `orca agent installed` does, see below), a project's tracker identity, a workspace's linked issues and references, and linking a workspace to an issue or a Jira key. Listing projects, creating worktrees and naming the focused workspace by id, which earlier Orca lacked, it now offers.

That is why Kickoff still uses the Orca CLI for projects, worktrees, creation and agents; whether to move any of it to host methods is weighed in a comment on issue #155.

### Worker process

On Windows with Orca 1.4.255, read from inside a running trusted worker **[Verified]**:

- The worker is Orca's own `Orca.exe` with `ELECTRON_RUN_AS_NODE=1`, running `resources\app.asar.unpacked\out\main\plugin-host-entry.js`, with no `execArgv`.
- Its current folder is Orca's install folder (`%LOCALAPPDATA%\Programs\orca`), the one that holds `Orca.exe`.
- Its environment has only `COMSPEC`, `ELECTRON_RUN_AS_NODE`, `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `NUMBER_OF_PROCESSORS`, `PATH`, `PATHEXT`, `PROCESSOR_ARCHITECTURE`, `SYSTEMDRIVE`, `SystemRoot`, `TEMP`, `TMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE` and `WINDIR`. So `APPDATA`, `LOCALAPPDATA`, `ProgramFiles`, `HOME`, `NODE_OPTIONS` and every `GH_*` variable are missing. `PATH` is the user's, with Orca's CLI folder and `gh` on it.
- `execFile('orca', ...)` from that folder starts `Orca.exe`, not the CLI: Node looks in the current folder before `PATH`, and names are not case-sensitive on Windows. With `ELECTRON_RUN_AS_NODE=1` the app takes the first argument as a script and exits 1 with `Error: Cannot find module '<Orca's folder>\project'` on stderr, after a first line `node:internal/modules/cjs/loader:1575`.
- From the home folder, the Orca CLI without `APPDATA` exits 1 with `{ ok: false, error: { code: 'runtime_unavailable', message: 'APPDATA is not set, so the Orca runtime metadata path cannot be resolved.' } }` on stdout.
- `gh` without `APPDATA` answers "You are not logged into any GitHub hosts", because its login is in `%APPDATA%\GitHub CLI`.
- With the current folder set to the home folder and `APPDATA` set to `%USERPROFILE%\AppData\Roaming`, both work. `ELECTRON_RUN_AS_NODE=1`, inherited, does not bother the Orca CLI.

So Kickoff runs every tool from the home folder and puts back `APPDATA` and `LOCALAPPDATA` with their default values when they are missing (`childProcessSetup` in `src/cli.ts`). If a user's `APPDATA` is redirected elsewhere, that default is wrong and the tools fail as above; Kickoff does not handle it. On macOS and Linux the worker environment has not been read **[Assumed]**.

#### Where the worker runs from

Read in the installed code of Orca 1.4.271 on Windows (issue #149) **[Verified]**:

- The worker host imports `pathToFileURL(join(pluginRoot, main))`, and its module hooks transpile a `.ts` file in place without changing its URL (`plugin-host-entry.js`). So the worker's `import.meta.url` is `file:///<plugin root>/src/worker.ts`.
- For an install, the plugin root is the folder the `current` pointer names inside the plugin's folder: `<data>/plugins/<publisher>.<id>/<64 hex>`. For a development plugin (`orca plugin dev load`), it is the folder that was loaded, as it is. An install from a folder (`orca plugin install <folder>`) is a copy under `<data>/plugins/local.<id>/<64 hex>` like any other.
- So Kickoff tells a development plugin from an install by the manifest's folder: an install's is 64 hex inside a folder whose name ends with `.kickoff` (`aboutKickoff` in `src/about.ts`), and reads its version from the `orca-plugin.json` there (`about.load` in `src/worker.ts`).
- `about.load` logs `about.load: the worker runs from <url>`, which `orca plugin logs <plugin key>` shows. That it shows a development plugin's folder and an install's content folder inside Orca is **[Assumed]** until the maintainer reads it there.

A rejection nobody handles ends the worker: `plugin-host-entry.js` handles `uncaughtException` and `unhandledRejection` by reporting the error to Orca and exiting with code 1 **[Verified]** (installed code of Orca 1.4.263, issue #102), and every Start under way in it ends with it. What Orca does next, such as starting the worker again on the next request, was not checked **[Assumed]**.

### Errors from worker to panel

- Documented contract **[Verified]**: an error thrown in a handler whose `code` is a host error code (`invalid_params`, `conflict`, ...) reaches the panel with that code; any other becomes `action_failed`. The panel can also see `unknown_method`, `timeout` and `unavailable`.
- Whether the thrown `message` reaches the panel unchanged: **[Assumed]**. The worker side serialises `{ code, message }`, but the main-process routing could not be read.
- So Kickoff returns expected failures as data and never relies on thrown messages.
- `plugin.request` times out after 30 000 ms by default, and accepts at most 120 000 **[Verified]**. A `worktree create` can take longer, so `task.start` answers once its quick checks pass and the create goes on in the worker, which posts `start.ended` when it ends.

### Posts from worker to panel

- `orca.panels.post(event, payload, { panel? })` sends to every open panel of the plugin, or to one (`panel` from a request's context). It is fire and forget, returns `void`, and allows at most 256 KiB per post and 200 posts per 10 s **[Verified]** (generated types and Orca's authoring guide).
- `post` can throw: in the worker it checks the event name against `^[A-Za-z0-9_.:-]{1,128}$` and throws when the name doesn't match, then hands the message to Node's `process.send` at once **[Verified]** (installed code of Orca 1.4.263, `plugin-host-entry.js` and `plugin-panel-bridge-protocol.js`, issue #102). Neither the generated types nor the authoring guide says so. The worker checks neither limit, so a post past the size or rate limit doesn't throw there **[Verified]**, the same way. Whether Orca then drops it, and whether it tells the worker, was not checked **[Assumed]**. A payload `JSON.stringify` can't serialise would throw from `process.send` **[Assumed]**, from Node's documented IPC serialisation, not tried. So Kickoff's worker catches a throw from posting `start.ended` and logs it; the panel learns the end from its poll of `starts.load`.
- A panel hears posts with `plugin.on(event, handler)`, imported from `orca` with `plugin`, which returns a `Disposable` to push to `ctx.subscriptions` **[Verified]** (generated types).
- Event names and payloads are typed by declaring them in `PluginPanelEvents`, next to `PluginRequests` **[Verified]**.
- In tests, `TestWorker.posts` lists what the worker posted, in order, and `TestPanel.post(event, payload)` delivers a post to the panel's `plugin.on` handlers **[Verified]**.
- An open panel gets `start.ended` and shows the new worktree without a reload **[Verified]** inside Orca 1.4.259.
- Right after a `worktree create --agent` ends, `worktree ps` reports no agent in the new worktree for a few seconds **[Verified]**, seen by the maintainer inside Orca (issue #18, version not recorded). So `start.ended` carries the agent the create passed, the card says "Agent starting…" meanwhile, and the panel reads the worktrees once more 5 s later. The panel marks the agent as starting before it reads the worktrees after `start.ended`: marked only after that read, the card showed "No agent running" for less than a second, seen by the maintainer inside Orca (issue #31, version not recorded) **[Verified]**. That Orca draws the panel between the read's answer and the code that follows it **[Assumed]**: it explains the flash, but `orca/testing` draws only on `setImmediate` turns and can't show it. That 5 s is enough **[Verified]**: the maintainer confirmed inside Orca that the card reaches "Agent: claude" within the delayed load (issue #31).
- A plugin panel's tab has no close button: the person can only switch to another tab or hide the whole right sidebar **[Verified]** (seen by the maintainer). A panel hidden during a Start and shown again after the create ended shows the worktree, with no spinner **[Verified]**, seen by the maintainer inside Orca 1.4.259. Whether Orca keeps a hidden panel mounted, and so whether the post reached it or it read the list again, is not known.
- A post made while no panel is open reaches no one: Orca's guide says it goes to open panels, and nothing says it is queued **[Assumed]**; not observed inside Orca. So a panel that opens later asks the worker (`tasks.load` and `starts.load` report the Starts under way) instead of waiting for a post.
- Whether the worker reply to a request and a post sent right after it reach the panel in that order **[Assumed]**: not checked. The panel keeps a post that arrives before its `task.start` answer.
- Orca's guide says an idle worker stops, and starts again on its next command, event or panel request **[Verified]**. Whether a worker that has answered every request but still runs a child process (a `worktree create`) counts as idle is not known **[Assumed]**.
- A worker restarted during a Start (`orca plugin restart`) has lost its Starts under way: `starts.load` reports none, so the panel's poll clears their spinners. Orca still finishes the worktree, agent included **[Verified]** inside Orca 1.4.259, restarting the worker 1 s into the create.

### Events

- `workspace.changed` delivers `{ context: { workspaceId?: string; branch: string; displayName: string; terminals: { id; title? }[] } | null }`, with no project id. Each new subscriber first gets the current context **[Verified]**. The context has an optional `workspaceId` **[Verified]** (generated types of Orca 1.4.259); Kickoff doesn't read it.
- `mount()` from `orca/testing` does not emit it on its own; tests emit it **[Verified]**.
- Orca does not emit `workspace.changed` when switching between two workspaces with the same branch, name and terminals, for example two `main` worktrees of different projects. The original plugin polls the active worktree every 2 s while the panel is visible **[Original]**. Polling the active worktree's project covers it **[Verified]**: inside Orca 1.4.259 the maintainer switched between two `main` worktrees of different projects, both ways, and Kickoff's panel (polling every 3 s) listed the active project's tasks each time. A panel hidden during the switch and shown again listed them too (issue #23). Whether Orca sends `workspace.changed` on that switch was not observed directly.
- Other events: `workspace.created` and `workspace.removed` (`{ workspaceId: string; workspaceListId?: string; kind: 'worktree' | 'folder'; path: string }`, and `branch: string` on `created`), `agent.status.changed` (`agent:read`), and `theme` in the panel. A panel subscribes with `on(...)` without `contributes.events`, but needs `workspace:read` **[Verified]** (generated types of Orca 1.4.259).
- Deleting a worktree other than the active one sends no `workspace.changed` **[Assumed]**, since the focused workspace doesn't change. Kickoff's own Start, which creates a worktree, makes Orca send `workspace.created` while the Start is still running **[Assumed]**.
- With the refresh below, deleting a started task's worktree that is not the active one brings its Start button back without a Reload **[Verified]**. So does archiving it, so archiving a worktree sends `workspace.removed` **[Verified]**. During a Start, the card keeps its spinner until the create ends and never shows the worktree as "No agent running" **[Verified]**. The maintainer saw all three inside Orca 1.4.259 (issue #15).
- Kickoff's panel reads the task worktrees again on `workspace.created` and `workspace.removed` (issue #15):
  - It runs `worktrees.load` and keeps the loaded pages. It runs once, 300 ms after the last event of a burst, and after any `tasks.load` under way. It also reads for folders, which are never task worktrees.
  - That read leaves the cards of the Starts still running as they were, spinner included: each Start reads the worktrees itself when it ends.
  - A `worktrees.load` answer that is older than the worktrees shown is dropped.

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

- The multi-line text field is `Textarea` (catalog 2, since Orca 1.4.247), with the same `label`, `labelHidden`, `value`, `defaultValue`, `placeholder`, `maxLength`, `invalid`, `disabled` and `onChange` as `Input`, plus `rows?: number`, the visible lines, from 2 to 20. Its `onSubmit?: (value: string) => void` runs on Cmd+Enter on macOS and Ctrl+Enter elsewhere, so Enter alone adds a line **[Verified]** (generated types of Orca 1.4.263). In `orca/testing`, `TestPanel.submit` on a `Textarea` calls its `onSubmit` **[Verified]** with the panel tests. That Orca submits on those keys and not on Enter was not seen inside Orca **[Assumed]**.
- `Field` (`label`, `description?`, `error?`, `required?`) wraps a control with help text or an error.
- Kickoff's JQL queries (in Project settings until issue #107, in the filter editor since) put each query's label on a `Field` around a `Box direction="row" align="center"` that holds the `Textarea` (`labelHidden`, still labelled for the tests and screen readers) and its Remove button, so the button centres on the query's box rather than on box and label together (issue #87). The `Field` label looks like a `Textarea`'s own label, and the button draws centred on the box **[Verified]** (seen by the maintainer inside Orca 1.4.263, in Project settings). The filter editor draws the same component the same way **[Assumed]**: not yet seen inside Orca.
- Limits per render: 5000 nodes, 16 KiB per text, 500 options per `Select`.

Layout and sizing, from the generated types and `references/components.md` of `orca skills get orca-plugin-authoring`, Orca 1.4.261 **[Verified]**:

- No `className`, `style` or DOM tags; an unknown prop or enum value is dropped with a warning. `ui.has(component, prop?)` and `ui.catalog` detect what the installed Orca supports.
- Inner scroll: `Box` takes `height`, `maxHeight` and `minHeight` (`number` of pixels from 0 to 4096, or a whole percent of the parent such as `'50%'`) and `scroll?: 'x' | 'y' | 'both'`; `y` needs `height` or `maxHeight`. `Table`, `Tree` and `CodeView` take `maxHeight?: 'sm' | 'md' | 'lg' | 'none'` and scroll inside. `Stack`, `Row`, `List`, `Grid`, `Card`, `Collapsible` and `Tabs` have no height or scroll prop. There is no `sticky` or `overflow`.
- With the whole panel in a `Box direction="column" height="100%"` and the list in a `Box grow minHeight={0} maxHeight="100%" scroll="y"`, the list fills the height left in the panel and only the list scrolls: the header and the "Search tasks" field above it stay in place, and the list's last row (Load more) can be reached **[Verified]** (seen by the maintainer in the #46 prototype, Orca 1.4.261, a project with more tasks than fit).
- A part after the scrolling `Box`, such as the template detail's Delete bar in a `Box shrink={false}` (the bar at the bottom of the Prompt templates view since #129), stays in place under it while the form scrolls **[Verified]**, seen by the maintainer inside Orca (#55, version not recorded).
- A plugin can't scroll to a component or focus a field: no component takes a `ref`, a focus prop or a scroll position, and the host API has no such call. `Input` takes `invalid` to mark a field **[Verified]** (generated types of Orca 1.4.265). So Project settings name the field to fix in the bar under the form rather than taking you to it.
- Field width: `Select`, `Input` and `Textarea` have no size or width prop (`Textarea` has `rows`, 2 to 20). A `Box` around them sizes them: `width`, `minWidth`, `maxWidth`, `grow` and `shrink={false}`. `Button` and `IconButton` take `size: 'xs' | 'sm' | 'md'`. In a `Stack` with no `align`, fields, tables and cards fill the width and buttons keep their own. With `align="stretch"`, buttons fill the width too, as Kickoff's "Load more" does **[Verified]** (generated types of Orca 1.4.261).
- `Box` also takes `direction`, `gap`, `padding`, `paddingX`, `paddingY`, `margin`, `align`, `justify`, `wrap`, `columns`, `border`, `radius` and `background`. `Row` takes only `gap`, `align`, `justify` and `wrap`.
- A `Box` is a column unless `direction="row"` or `columns` is set **[Verified]** (generated types of Orca 1.4.271), so `justify` alone places its children up and down. The line with Kickoff's version under Project settings is a `Box direction="row" justify="center"` around a `Text size="xs" muted` (issue #149); that it draws centred across the panel is **[Assumed]**, for the maintainer to see in Orca. Since issue #153 the `Text` ends with a `Link`, `★ Star on GitHub`, to `https://github.com/samfaina/orca-kickoff` (`KICKOFF_REPOSITORY_URL` in `src/about.ts`). Once the version is known, the link follows it after ` · `; until then, the link shows alone. GitHub has no URL that stars a repository, so the link opens the repository's root, where its Star button is. That it opens in the browser, through `shell.openExternal` as the task cards' links do, is **[Assumed]**, for the maintainer to see in Orca.
- `Text` takes `tone`, `muted`, `size`, `weight` and a boolean `truncate`; there is no line clamp.
- `Table`: columns (`width`, `minWidth`, `hideBelow: 'sm' | 'md'` for under 360 px or 480 px, `sortable`), rows of plain cells (`string`, `number`, `boolean`, `null` or a relative time), `selectionMode`, `onRowAction` (Enter or a double click), `sort` and `onSortChange` (the plugin sorts), and `hasMore` with `onLoadMore`, called when scrolling near the last row. Rows scroll inside the table and only those in view are drawn. Cells can't hold components, so a row can't have its own button or `Select`, and there is no built-in filter.
- `ListItem` takes `title`, `description`, `icon`, `current`, `disabled` and `onPress`; with `onPress` the whole row is the press target and can't hold other controls.
- `IconButton` with `variant="outline"` and `tone="accent"` draws its icon and border in the text color, with no accent **[Verified]** (seen by the maintainer, Orca 1.4.261).
- `IconButton` with `variant="ghost"` and `tone="danger"` draws its icon in red, as Kickoff's remove-query trash button does **[Verified]** (seen by the maintainer, Orca 1.4.263, issue #87).
- A card's Start and Run here are both `IconButton`s with `variant="outline"` and no tone, as Start was before issue #132. That the two look the same, and like that Start, in the light and dark themes is **[Assumed]** (issue #136, for the maintainer to see in Orca).
- There is no menu, popover, dialog or split button. Tooltips exist only as the `tooltip` prop of `Button` and `IconButton`.
- `orca plugin shot <key> --width <px>` draws the panel at a given width, to check narrow layouts.
- A plugin panel's tab shows only the panel's icon, with its title as a tooltip **[Verified]** (seen by the maintainer).
- A `Select` option whose `value` is `''` is invalid: Orca drops the options with the warnings "Select: ignored invalid options" and "Select: missing required options; showing a placeholder", and draws no `Select`. Kickoff uses `:none` and `:default` for "Choose a tracker" and "Default site" **[Verified]** with `orca/testing`.

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
  - `mockHost({ capabilities, results, requests, storage, settings, secrets })`. A `results` entry is a value or a function of the params. With Orca 1.4.261 an `async` function for `storage.set` made the panel's write fail with an error that has no `code` **[Verified]** (issue #55). With Orca 1.4.263 a test can hold a storage write: a `storage.set` function that returns a promise, `async` or not, holds the panel's write until the promise settles, and then the write lands with no error in `errors` or `warnings` **[Verified]** with a temporary test (issue #94). While the write is held, `settled()` waits for it: an awaited `fire` of `withTimeouts` in `src/panel.test.tsx`, which ends with `settled()`, left `orca plugin test` running until it was stopped **[Verified]** with Orca 1.4.263 (issue #94). The other acts wait for it the same way **[Assumed]**, so the tests that hold a write start their acts without awaiting them, and release the write before they assert anything.
  - A promise rejection that nothing handles, made while a test runs, fails that test with the rejection's reason, so a test needs no `unhandledRejection` watch of its own **[Verified]** with Orca 1.4.263 and a temporary `void Promise.reject(...)` in a panel test (issue #96). A promise from `serialQueue` (`src/queue.ts`) never counts as unhandled, even when the caller drops it, because the queue attaches its own `catch` to it **[Verified]** the same way: before #96, a failed timed save failed no test.
  - `unmount()` ends before a settings save that a dispose starts reaches `storage.set`, so a test waits for that call with `until` **[Verified]** with Orca 1.4.263 (issue #96).
  - `TestPanel` has `find`, `findAll`, `press`, `type`, `toggle`, `select`, `emit`, `post`, `errors`, `refusals`, `persisted` and more.
  - `TestPanel.tree()` gives the drawn tree as plain `TreeSnapshot` data (`type`, `key`, `props`, `children`), handlers as `[handler]`. The panel tests read a card's rows and the scroll layout from it, since `find` gives only the innermost match **[Verified]** with Orca 1.4.261.
  - `TestWorker` has `request`, `emit`, `hooks.fire`, `logs`, `posts` and `deactivate`.
- On Windows, `orca plugin test` and `orca plugin check` fail when the plugin folder is on a different drive from Orca's install (for example the plugin on `I:` and Orca under `C:\Users\...`). Every test file fails with `orca-testing.mjs: cannot import "./orca-runtime.mjs": no such file in the plugin`, and `check` reports the same error as a panel issue while still exiting 0. The scaffolded `worker-panel` template fails the same way on `I:` and passes on `C:`. A directory junction on `C:` does not help, because Orca resolves the real path. Workaround: copy `orca-plugin.json`, `tsconfig.json`, `src/`, `assets/` and `.orca/` to a folder on Orca's drive and run the commands there. In PowerShell, from the repository root, with `%TEMP%` on Orca's drive:

  ```powershell
  $d = "$env:TEMP\kickoff-check"
  robocopy . $d orca-plugin.json tsconfig.json /NJH /NJS /NFL /NDL
  robocopy src "$d\src" /MIR /NJH /NJS /NFL /NDL
  robocopy assets "$d\assets" /MIR /NJH /NJS /NFL /NDL
  robocopy .orca "$d\.orca" /MIR /NJH /NJS /NFL /NDL
  Push-Location $d; orca plugin test .; orca plugin check .; Pop-Location
  ```

  The copy needs every file `orca-plugin.json` names. Outside `src/` that is today only `assets/`, which holds the `icon` and `cover.path`; a new manifest path outside these folders needs its own line here. Without `assets/`, `orca plugin check .` in the copy exits 2 with `icon assets/icon.png: ENOENT: no such file or directory`; with it, `check` and `test` both exit 0 **[Verified]** with Orca 1.4.263 (issue #79).

  `orca plugin validate` is not affected **[Verified]** with Orca 1.4.255, and `orca plugin test` still fails the same way with Orca 1.4.259 (issue #31). `orca plugin shot --scenario` fails the same way, with "could not read src/panel.check.ts: … cannot import "./orca-runtime.mjs"", and works from the copy **[Verified]** with Orca 1.4.261 (issue #47). The cause is in `orca-test-hooks.mjs`: it treats a file as part of the plugin when `path.relative(root, file)` doesn't start with `..`, and across drives that call answers an absolute path, so Orca's own `orca-testing.mjs` goes through the plugin's import rules **[Verified]** by reading `orca-test-hooks.mjs` of Orca 1.4.259.
- A panel mounted with `mount` uses the test's own timer globals: a test that replaces `globalThis.setInterval` and `clearInterval` before `mount` receives the panel's intervals and can fire them by hand. `setVisible(false)` makes `read(ctx.visible)` false, and `unmount()` disposes `ctx.subscriptions` **[Verified]**. `orca/testing` has no fake clock **[Verified]** (its generated types).
- A panel test that fails before its own `unmount()` leaves the panel's poll, a real `setInterval`, running, and `orca plugin test` never exits. With a failure forced in the last test of `panel.test.tsx` that mounts a view, the run was still going after 30 s and had to be killed. A failure forced in an earlier test did not hang the run **[Verified]** with Orca 1.4.261 and Node 24 (issue #60).
  - The next `mount` ends the previous view: `installOrcaDeclarativeRuntime` in `orca-runtime.mjs` starts with `runtime?.dispose()`. So the hang shows only when the failing test is the last one to mount **[Verified]** by reading `orca-runtime.mjs` of Orca 1.4.261.
  - `unmount()` called twice on the same view throws nothing and adds no `errors` or `warnings` **[Verified]** with Orca 1.4.261, with a temporary test.
  - The panel tests avoid the hang with a `mount` of their own that tracks the views it returns, which `afterEach` and `withIntervals` unmount when a test ends, each view once. With failures forced in an ordinary `show(...)` test, a held-request test, a test with two views and the last test, the run printed the four failures and exited with code 1 in under 4 s **[Verified]** with Orca 1.4.261 (issue #60). `withTimeouts` unmounts them too when it ends, before it puts the real timers back, even when its body or an unmount fails, as its own tests check **[Verified]** with Orca 1.4.261 (issue #68).
- A full `orca plugin test` in a copy on Orca's drive finishes in about 4 s, with or without failing tests **[Verified]** with Orca 1.4.261 (issue #60). An earlier full run in such a copy ran for more than 5 minutes without output and was stopped, while the #46 shots were taken. A panel test failing before `unmount()`, as above, may have caused it **[Assumed]**: the cause was not found then.
- `mount` and every act (`press`, `emit`, `settled`, ...) wait for the panel's pending `plugin.request` calls. A request that never resolves leaves the test pending until Node cancels it ("Promise resolution is still pending but the event loop has already resolved"). To see a loading state, mount the component alone (`mount(panel.default)`, which skips `setup`) **[Verified]**.
- The test runtime draws only while an act or `settled()` runs: each round waits one `setImmediate` turn, draws what the panel changed, then waits for every pending request. So a state the panel sets before it calls `plugin.request` is drawn while that request is still unanswered, and a state set after an answer arrives is drawn only once no request is pending. To see a state drawn while a request runs, hold that request's handler on a promise the test controls, start the act without awaiting it, yield `setImmediate` turns until `find` sees the state, then release the handler and await the act. Looking from inside a handler after a `setTimeout` races that turn and fails now and then under load (#24) **[Verified]** with Orca 1.4.259, by reading `orca-testing.mjs` and with the panel tests.
- While one act waits for a held request, a state that another answer sets is not drawn, because each act draws only between its waits. `rerender()` is an act of its own: started without awaiting it, it draws the panel as it is now after one `setImmediate` turn, and then waits for the held request too. The panel tests use this to see what Orca would draw while a Start's `worktrees.load` is held (#31) **[Verified]** with Orca 1.4.259, by reading `orca-testing.mjs` and with the panel tests.
- `orca plugin check` runs the real worker on this machine, so the rendered panel uses the real `orca` and `gh` and shows real data. Its output is not safe to paste anywhere public **[Verified]**.
- A trusted worker can `import { execFile } from 'node:child_process'`. With no `@types/node`, `src/node.d.ts` declares the few Node APIs used, for `tsc` only **[Verified]**.
- `src/panel.check.ts` default-exports `defineCheck({ <name>: scenario })`, which `orca plugin check` and `orca plugin shot --scenario` render, once per scenario on a fresh host with the worker **[Verified]** (generated types and `references/workflow.md` of Orca 1.4.261). A scenario takes `mockHost()` options (`results`, `requests`, `storage`, `settings`, `secrets`, `capabilities`), plus `persisted`, `theme` and `events`, delivered in order after the first draw.
  - `requests` stubs a request by name; any other goes to the real worker, which runs the real `orca`, `gh` and `twg`. So each of Kickoff's scenarios answers every panel request, and `src/panel.check.test.ts` checks it **[Verified]**. With every request stubbed, `check` showed only the scenarios' invented data (Orca 1.4.261).
  - A test imports the file only as `./panel.check.ts`: `./panel.check` fails with `cannot import "./panel.check": no such file in the plugin`, although the extension is among those tried. `tsc` accepts the `.ts` import **[Verified]** with Orca 1.4.261 and TypeScript 5.6.3.

Dev commands **[Verified]**: `orca plugin validate .`, `test .`, `check .`, `dev watch .`, `inspect`, `dev request`, `dev emit`, `shot --scenario`.

- `orca plugin shot --act` does not keep the panel's state between captures. After the capture, Orca puts the panel's atoms back, persisted ones included. What the acts did outside the panel stays, such as a `storage.set` or a `plugin.request` that changed the worker's storage. So a JQL typed through `--act` stays in storage while the panel shows the earlier one: `shownSettings` is restored, and `showSettings` doesn't read storage again for the project it already shows, until the plugin is loaded again. `--json` reports `restored: false` when the panel reloaded during `--act` and kept the acted state. **[Verified]** by `orca plugin shot --help` of Orca 1.4.259. The maintainer checked inside Orca that a JQL typed by hand stays in the JQL field after a Reload, a switch to another project and back, and hiding and showing the panel (issue #19).
- Seen while taking the #46 prototype's shots, with Orca 1.4.261 **[Verified]**:
  - **`orca plugin shot --scenario` needs Orca's window hidden or minimized.** With the window visible it refuses with "needs the window hidden or minimized".
  - **`--height` is ignored with `--scenario`.** The image grows to the content's height. `--height` is valid only with `--editor`.
  - **Scenario replays are flaky.** With tall content (over about 1000 px) or with `--theme dark`, a replay often captures Orca's own window instead of the panel. In #47 it happened with short content in both themes too, on every shot of a run that reported `ok`, at a moment when the window had just been minimized. In a second run, with the window minimized by a script (`ShowWindowAsync(hwnd, 6)`) and checked minimized before each shot, 2 of 18 shots showed the panel, 15 showed Orca's window, and one `--theme dark` shot showed the panel in the light theme, all reporting `ok`. So `ok` says nothing about the image: look at each one. That window shows the user's real projects, so delete those images and never publish them. Once, a replay drew the previous scenario's state. Keep scenarios short (about 5 tasks), and look at every image before publishing it.
  - **`--act` with a `select` doesn't redraw before the capture.** It changes the `Select`'s value, but the panel isn't drawn again before the image is taken.
## Orca CLI

- The executable is `orca` on Windows and macOS. On Linux it is `orca-ide`, because `orca` is usually GNOME's screen reader **[Original]**; not checked on Linux.
- On Windows, both `orca.cmd` and `orca.exe` are on PATH and `where` lists the `.cmd` first. `execFile('orca')` without a shell resolves the `.exe`. Never point at the `.cmd` **[Verified]**. From Orca's install folder a bare `orca` finds the app instead: see [Worker process](#worker-process).
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
- `branch` is the worktree's current branch as a full ref, `refs/heads/<name>`, on every row seen **[Verified]** (Orca 1.4.265, issue #132). A Run here's `{{branch}}` drops the `refs/heads/`, so it reads like a Start's. A detached worktree, or one with no branch, was not seen: Kickoff reads a missing, `null` or empty `branch` as no branch **[Assumed]**.
- Rows have many more fields, such as `workspaceKind`, `path`, `displayName`, `linkedIssue` and `linkedItems` **[Verified]**; Kickoff reads only those above.
- `orca reference list --worktree active` fails with `selector_not_found` at the same moment that `worktree show --worktree active` resolves.

### `orca worktree create`

Flags **[Verified]**:

- `--project <id-or-name>`, `--name <name>`, `--issue <n>`, `--no-parent`, `--agent <id>`, `--prompt <text>` and `--json`.
- Also `--branch`, `--base-branch <ref>`, `--surface chat|terminal`, `--activate`, `--setup`, `--retry-launch <operationId>`, `--reference <url-or-jira-key>` (repeatable) and `--reference-site <id>`.

Behaviour:

- `--name` sets `displayName` as a fixed, user-chosen name **[Verified]**.
  - The folder is the sanitised name; if the path is taken, Orca tries alternatives or fails with "Pick a different worktree name".
  - The branch is `refs/heads/<prefix>/<sanitised name>`, where the prefix comes from Orca's `branchPrefix` setting (`git-username` by default, `custom` or `none`).
  - `--branch` skips the prefix.
- How `--name` is cleaned, read in Orca 1.4.265's app bundle, not observed **[Verified]**:
  - Each run of characters other than Unicode letters, digits, `.`, `_` and `-` becomes one `-`. Runs of `-` become one `-`, and runs of `.` become one `.`. `.` and `-` are trimmed at the ends. Case is kept, and so is `__`.
  - For the folder, `/` is one of those characters and becomes `-`. For the default branch, `/` separates segments, which are cleaned one by one.
  - So a convention such as `feature/WEB-12__x--AB` can't be written with `--name`: the `--` becomes `-`.
- `--branch <name>`, read in Orca 1.4.265's app bundle, not observed **[Verified]**:
  - The CLI passes the value as it is. Orca refuses one that starts with `-`, checks the rest with `git check-ref-format --branch`, and then uses it verbatim, with no prefix and no cleaning. A name git refuses fails the create.
  - With `--branch`, Orca doesn't look up the git username for the prefix.
  - The folder still comes from `--name`.
  - A taken name is retried as `<name>-2`, `-3` and so on, up to 100 tries. The folder and the branch share that counter, so a taken branch gives `-2` to the folder too. A branch counts as taken when it exists locally or on a remote, when a GitHub PR is open for it, or when the folder path is taken. Names that differ only in case count as the same.
  - An existing local branch is checked out instead of retried when it points at the base's commit and no other worktree has it.
  - When an existing branch is a path prefix of the new one (`feature` for `feature/x`), the create fails with `Branch "…" is blocked by existing branch "…". Pick a different branch name.`, without retrying.
- Orca renames branches it named itself when an agent starts (`autoRenameBranchFromWork`, on by default). It renames only a branch whose last segment, ignoring a trailing `-<n>`, is one of Orca's generated names, a list of sea creatures (`narwhal`, `seahorse`, ...), and that has no upstream yet. So a name from `--name` or `--branch` that isn't one of those words is never renamed **[Verified]** (read in Orca 1.4.265's app bundle, not observed).
- Orca's `branchPrefix` setting gives only a prefix: `git-username` (the default), `custom` (`branchPrefixCustom`) or `none`. `git-username` is the first valid value of `git config github.user`, `git config user.username`, the `gh` login when a remote is on GitHub, and `git config user.name` when it has no spaces. A `custom` prefix that git refuses fails the create **[Verified]** (read in Orca 1.4.265's app bundle).
- `--prompt`, `--model`, `--effort`, `--surface` and `--retry-launch` require `--agent`: `invalid_argument: --prompt requires --agent`. Without `--agent`, no agent starts **[Verified]**.
- `--agent` must be a known id, otherwise "Unknown TUI agent" **[Verified]**. About 46 ids exist, including `claude`, `codex`, `opencode`, `gemini`, `copilot`, `grok`, `aider`, `goose`, `amp`, `cursor`, `cline`, `kiro`, `qwen-code` and `rovo`. There is no "default" value.
- `--reference <key-or-url>` **[Verified]**:
  - It only links: it does not rename the worktree or fill the prompt, and it is stored before setup or agent start.
  - A bare Jira key makes Orca look the task up through its own Jira connection, and fails without one ("No Jira site selected for issue keys", `jira_issue_unavailable`). A full `/browse/KEY` URL needs no lookup.
  - It cannot be combined with `--issue`, `--pr`, `--linear-issue` or `--gitlab-*`.
  - It needs a host with `WORKTREE_LINKED_ITEMS_DELTA`, otherwise `incompatible_runtime`.
- Orca accepts Jira keys matching `/^[A-Za-z][A-Za-z0-9_]*-\d+$/` **[Verified]**.
- Base of the new branch (issue #40), read in `--help` and Orca's app bundle **[Verified]**:
  - Orca takes `--base-branch`, then the repository's `worktreeBaseRef` (set with `orca repo set-base-ref`) if usable, then a default ref it detects. Kickoff passes no `--base-branch`. How the default ref is detected is not known **[Assumed]**.
  - When the base has a remote-tracking ref, Orca fetches it before `git worktree add`.
  - No CLI command reports the base before a create. Afterwards, `worktree list --json` rows carry `baseRef` (`refs/remotes/origin/main`), which is `null` on main worktrees.
- Files that aren't committed, read in Orca's app bundle **[Verified]**:
  - Orca copies the literal files and folders listed in `.worktreeinclude` at the main checkout's root into the new worktree (no globs, at most 1000 entries, file under 256 KiB).
  - It also creates the repository's `symlinkPaths` and runs its setup hooks unless `--setup skip`.
  - Nothing else that isn't tracked is copied.
- The main checkout of a project is `result.setups[].path` in `orca project setups --project <id> --json`. The same path is in `repo list --json` (`repos[].path`) and in the `worktree list --json` row with `isMainWorktree: true` **[Verified]**.

Timing, measured by the maintainer on Windows with Orca 1.4.257 on a small repository (issue #14) **[Verified]**: `worktree create` takes about 25 s without an agent and about 30 s with `--agent` and `--prompt`; `--setup skip` does not make it faster. Through Kickoff's Start on Orca 1.4.259, `task.start` answered in about 3 s and the create ended 19 to 28 s later **[Verified]**. That a larger repository or setup hooks take over a minute **[Assumed]**; Kickoff gives the create 10 minutes.

### Skill commands in `--prompt`

A prompt that starts with a Claude Code slash command runs that skill in the new agent (issue #16). Tried on Windows with Orca 1.4.259 and Claude Code 2.1.325, with `orca worktree create --agent claude --prompt`, `orca agent launch --prompt` and Kickoff's Start from the panel **[Verified]**:

- **Delivery.** On the terminal surface Orca types the prompt into Claude Code's input and submits it (`prompt.delivery: "submit"`, `outcome: "handed-to-terminal"`). On the chat surface it sends it as the first message (`outcome: "journaled"`). Claude Code was ready for it in every try, including straight after `worktree create`. The session transcript (`~/.claude/projects/<slug of the worktree path>/<session>.jsonl`) then holds `<command-name>/<skill></command-name>` and `<command-args>`, followed by the skill's content.
- **Surface.** Terminal and chat behave the same for a skill that exists. They differ for a name that doesn't:
  - Terminal: Claude Code prints `Unknown command: /<name>` and `Args from unknown skill: <rest>`, and the prompt never reaches the model. The agent sits idle.
  - Chat: the text reaches the model as plain text, and the model answers that it can't find the skill.
- **Agent.** Only `claude` was tried. Kickoff's agent choice and Orca's default agent can pick another one. Other agents have their own command syntax, or none **[Assumed]**.
- **Position.** Whitespace or a blank line before the `/` is removed before Claude Code reads the input, and the command still runs. Any text before it (`Please run /acme-skills:tdd`) makes the whole prompt plain text. The model may still choose to load the skill with its Skill tool, but nothing guarantees it.
- **Several lines.** The prompt arrives as one message. Everything after the command name, newlines and blank lines included, becomes the skill's arguments (`ARGUMENTS:`). So `{{task_description}}` can follow the command.
- **Names.** A user skill (`~/.claude/skills/<name>`) and a project skill (`<worktree>/.claude/skills/<name>`) run by their bare name. A plugin skill runs with its namespace (`/acme-skills:tdd`) and also by its bare name (`/tdd`): Claude Code rewrites a bare name to the namespaced one, on both surfaces. When a built-in command has the same name, the built-in wins: `/code-review` runs Claude Code's own command, not `acme-skills:code-review`. A partial name (`/grill` for `grilling`) is unknown.
- **What a new worktree sees.** The agent runs in the new worktree's folder, so it loads what Claude Code loads for that path, which is not always what the main checkout has:
  - A plugin installed with `local` scope is enabled for one project path only (`projectPath` in `claude plugin list --json`). On Windows, a new worktree is another path, so its skills are unknown there. This was the cause of the failed Start in issue #16; installing the plugin with `user` scope fixed it **[Verified]**. Claude Code's docs say that inside a git repository the local settings are read from the main checkout's root, except on Windows, so on macOS and Linux a `local` plugin would load in a new worktree too **[Assumed]**; not tried.
  - A project skill in `<repo>/.claude/skills` that isn't committed is not in the new worktree's own folder, unless `.worktreeinclude` lists it (see `orca worktree create`). But Claude Code's docs say a linked worktree with no `.claude/skills` at its root loads the main checkout's skills, agents and commands (Claude Code 2.1.277 and later). So an uncommitted skill is missing only when the worktree has a `.claude/skills` folder of its own, for example because other skills are committed **[Assumed]**; not tried.
  - User skills and `user`-scope plugins are seen everywhere **[Verified]**. Docs: `project`-scope plugins (a committed `.claude/settings.json`) load in any checkout that has the file, and `synced` plugins (from the claude.ai account) wherever the user is signed in **[Assumed]**.
- **Plugin list.** `claude plugin list --json` (Claude Code 2.1.325) answers an array of `{ id, version, scope, enabled, installPath, installedAt, lastUpdated, projectPath, projectEnabled }` **[Verified]**:
  - `local` rows have `projectPath`. `user` rows have no `projectPath` key. `session` rows (plugin folders passed with `CLAUDE_CODE_PLUGIN_DIRS`, which Orca sets for the agents it launches) and `synced` rows have only `id, version, scope, enabled, installPath`.
  - The same `id` can appear once per scope and once per `local` project path, including paths that no longer exist.
  - It doesn't list a plugin's skills. Those are under `installPath`: `skills/<name>/SKILL.md` and `commands/*.md` by default, plus the paths in `.claude-plugin/plugin.json`. The namespace in `/<namespace>:<skill>` is that manifest's `name`, which can differ from the part of `id` before `@`.
  - With the worker's reduced environment (see [Worker process](#worker-process)), `execFile('claude', ['plugin', 'list', '--json'])` without a shell resolves `claude.exe` and answers in about 0.7 s without network. The `session` rows are missing, since the worker has no `CLAUDE_CODE_PLUGIN_DIRS`.

To try this from Git Bash, set `MSYS_NO_PATHCONV=1`: otherwise MSYS turns an argument such as `/acme-skills:tdd` into a Windows path (`C:/Program Files/Git/acme-skills:tdd`) before Orca gets it **[Verified]**. Kickoff calls `orca.exe` with `execFile` and no shell, so it isn't affected.

### `orca agent launch`

`orca agent launch --agent <id> [--worktree <selector>] [--prompt <text>] [--model <id>] [--effort <level>] [--surface chat|terminal] [--focus] [--retry-launch <operationId>] [--json]` starts an agent in an existing workspace, as a new agent tab does **[Verified]** (`--help`, Orca 1.4.265). Kickoff's Run here runs `orca agent launch --agent <id> --worktree id:<worktree id> --prompt <prompt> --focus --json` (issue #132). Tried on Windows with Orca 1.4.265, `claude` and a one-line prompt, from the home folder **[Verified]**:

- **Selector.** `--worktree id:<id>` takes the `id` of `worktree list`, which is the `worktreeId` of `worktree ps`, as `worktree activate` does. Without `--worktree`, Orca uses the worktree that holds the current folder; `active` and `current` are also selectors.
- **Success.** Exit 0, `{ ok: true, result: { outcome: { kind: 'terminal', handle, paneKey }, worktreeId, receipt: { mode, preferred, reason, detail }, prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }, placement: { groupId }, operationId } }`. `receipt.detail` says why the surface was chosen, such as "Started a terminal agent, the default for new agent tabs in your settings." On the chat surface `outcome.kind` is `chat` **[Assumed]**, from `--help`; not tried.
- **Failure.** Exit 1 with the usual `{ ok: false, error: { code, message } }`. An unknown worktree gives `selector_not_found`, with `message` the code itself and the details in `error.data` (`selector`, `validSelectorForms`, `nextSteps`). An unknown agent gives `invalid_argument`, "Unknown TUI agent \"<id>\"".
- **Time.** About 0.6 s, failures about 0.4 s, like any other call: Orca answers once the tab is opened and the prompt handed over, without waiting for the agent. So `task.runHere` waits for the launch and answers its end, with no post like `start.ended`: its Orca calls take at most two 20 s timeouts in a row, within the panel's 60 s for the request.
- **`--focus`.** Without it the tab opens without switching to it. With it, the launch made its worktree the active one in `worktree ps`, where another worktree had been active before. That the new tab is shown inside Orca was not seen **[Assumed]**; for a Run here the worktree is already the active one.
- **Prompt.** Delivered as `worktree create --prompt` delivers it (see [Skill commands in `--prompt`](#skill-commands-in---prompt)).
- **Lost reply.** If the reply is lost, Orca asks to run the same command again with `--retry-launch <operationId>` from the error, never as a fresh launch **[Verified]** (`--help`). Kickoff doesn't retry.
- **Oldest Orca.** Neither `--help` nor the plugin docs say which Orca version added `orca agent launch`, and 1.4.265 is the oldest it was tried with. So since Kickoff 0.5.0, the first release with Run here, `engines.orca` is `>=1.4.265`. Whether an older Orca has the command is not known **[Assumed]**.

### `orca worktree activate --worktree id:<id> --json`

Shows the worktree in Orca **[Verified]** (help only, not run).

### `orca reference`

**[Verified]**:

- `list --worktree <selector>`, `add <url-or-key>... --worktree <selector>`, `remove`.
- `find <url-or-key> [--worktree | --repo] [--include-archived] [--limit n]` searches stored metadata only. It returns `{ kind: 'reference_matches', matches: [{ reference, workspace: { id, name, repo, archived }, agents: [{ agent, liveness }] }] }`, and `matches: []` when nothing is linked.

### `orca agent installed`

`orca agent installed [--worktree <selector>] [--json]` lists the agents Orca detects on a host that can start, with the ids `--agent` takes **[Verified]** (`--help` and a run, Orca 1.4.271). Agents turned off in Orca's Settings → Agents are left out, and agents set up there with a custom command are included. Read in Orca 1.4.271's app bundle (`cli/agents/installed-agents.js` and the host's `preflight.installedAgents`) **[Verified]**:

- **Success.** Exit 0, `{ id, ok: true, result: { agents: [{ id, name, default: boolean }] }, _meta: { runtimeId } }`. The list follows Orca's catalog order, then the custom-command agents. An empty list is `agents: []`.
- **`name`.** Orca's short display name (`claude` → `Claude`, `codex` → `Codex`, `copilot` → `GitHub Copilot`), or the id when it has none.
- **`default`.** True only for the agent whose id equals the saved `defaultTuiAgent`, after the turned-off agents are removed. So at most one agent is marked, and none when the default is `blank`, unset, turned off or not installed. It doesn't apply Orca's fallback to the first installed agent (`pickTuiAgent`, see [Orca's default agent](#orcas-default-agent)). Turning an agent off in Orca's settings also clears the default when it was that agent.
- **Host.** Without `--worktree`, the local machine's `PATH` (on Windows, Windows and not WSL). With `--worktree`, the host of that workspace. For a paired runtime or a managed SSH host, the call is forwarded there: an Orca there too old to have the command gives `incompatible_runtime`, and an unmanaged SSH target gives `ssh_host_not_served`. For a WSL project, a shell probe runs in the distro, and a stopped distro is not started.
- **Failure.** Exit 1 with `{ ok: false, error: { code, message, data? } }` on stdout. A local error has `id: 'local'` and `code: 'runtime_error'` unless the runtime gave one.
- **Selectors.** `--worktree id:<worktree id>` answers the agents of that worktree's host, and a selector that names no worktree, such as `id:does-not-exist`, exits 1 with `code` and `message` both `selector_not_found` **[Verified]** (run on Windows, Orca 1.4.271, issue #140).
- **`active` resolves from the caller's folder**, not from the worktree focused in Orca **[Verified]** (run on Windows, Orca 1.4.271, issue #147). From a terminal inside an Orca worktree it lists that host's agents, which is how issue #140 checked it. From a folder no Orca workspace contains, such as the user's home folder, where Kickoff's worker runs, it answers `{ "ok": false, "error": { "code": "selector_not_found", "message": "No Orca workspace contains the current directory: C:\\Users\\example", "data": { "selector": "active", ... } } }`.
- **How Kickoff uses it** (issues #140 and #147, ADR-0004): Kickoff passes `id:` selectors only, never `active` (`agentInstalledArgs` in `src/agent.ts` takes a worktree id). Project settings and the task's card (`agents.load`) and a Run here ask with `id:<active worktree id>`, the `worktree ps` row with `isActive: true`; with no active worktree they read nothing and answer an error that says so. A Start asks with `id:<main worktree id>` of its project, the `worktree list` row with `isMainWorktree: true`, since its worktree is created on that host. `src/agent.ts` parses the answer and resolves the agent choice against it.
- **Older hosts.** When the host has no `preflight.installedAgents`, the CLI falls back to older calls. If those can't read the settings, nothing is filtered or marked `default`.
- **Oldest Orca.** Neither `--help` nor the bundle says which version added the command, and 1.4.271 is the oldest it was seen in. Whether an older Orca has it is not known **[Assumed]**. So from issue #140 `engines.orca` was `>=1.4.271`, until issue #161 raised it to `>=1.4.277` for `orca linear list-issues`.

### Orca's default agent

Until Orca 1.4.271's `orca agent installed` (above), no CLI command or plugin API exposed it; `orca settings` and `orca config` are unknown commands **[Verified]**. Since issue #140 Kickoff reads it from there (ADR-0004), as the agent marked `default`. Before, it read the private data below, which is kept here as a record; no code reads it now. It is stored in Orca's private data:

1. **Data folder** (`%APPDATA%\orca` on Windows **[Verified]**):
   - macOS: `~/Library/Application Support/orca` **[Original]**.
   - Linux: `$XDG_CONFIG_HOME/orca` or `~/.config/orca` **[Original]**.
   - Orca removes `APPDATA` from the worker environment on Windows **[Verified]** (see [Worker process](#worker-process)), and `XDG_CONFIG_HOME` on Linux **[Original]**.
   - So the original plugin derives the folder from its own install path, `<data>/plugins/<publisher>.<id>/<64 hex>/...` **[Verified]**. It checks that the plugin folder ends with `.<id>`.
   - Each installed plugin folder holds the `<64 hex>` content folder (the `contentHash` in `plugins/plugins.lock.json`), a `current` file (not a link) and `.install-provenance` **[Verified]**. The worker's `import.meta.url` points inside the content folder: see [Where the worker runs from](#where-the-worker-runs-from).
2. **Active profile:** `activeProfileId` in `orca-profile-index.json` (keys `schemaVersion`, `activeProfileId`, `profiles[]`), with `orca-profile-index.json.bak` as a fallback and `local-default` as the default **[Verified]**. The original only accepts the id if it matches a pattern and is listed in `profiles[]` **[Original]**.
3. **Settings:** `profiles/<profile>/profile-state.db`, table `profile_state_documents` (`domain`, `payload`, `domain_version`, `revision`, `updated_at`, `content_hash`). `SELECT payload FROM profile_state_documents WHERE domain = 'settings'` gives JSON with `defaultTuiAgent`, `disabledTuiAgents` and `agentDefaultSurface` **[Verified]**.
   - Read with Node's built-in `node:sqlite` (`DatabaseSync`, `readOnly: true`): the Node inside Orca 1.4.255 is v24.22.1 and has it **[Verified]**.
   - `disabledTuiAgents` is an array of agent ids, and can be long **[Verified]**.
   - A `profile_state_document_parts` table also exists, so large documents may be split **[Assumed]**. Kickoff treated a payload that isn't valid JSON as unreadable, and tried `orca-data.json` next.
   - The older `profiles/<profile>/orca-data.json` still holds `settings.defaultTuiAgent` **[Verified]**.
4. **Orca's own rule** (`pickTuiAgent`) **[Verified]**:
   - `blank` means no agent.
   - Otherwise it uses the preferred agent if it is installed and not in `disabledTuiAgents`.
   - Otherwise the first installed agent in a fixed order (`claude`, `claude-agent-teams`, `openclaude`, `codex`, ...).
   - From the private data alone Kickoff couldn't tell what is installed (ADR-0003); `orca agent installed` can, but marks no agent `default` when this fallback would pick one, and Kickoff doesn't reproduce it (ADR-0004).

### Orca's Jira support

`orca jira` uses the Jira connection saved in Orca's settings **[Verified]**.

- Read-only subcommands: `connection`, `issue <key>`, `list [--filter assigned|reported|all|done]`, `search <jql>`, `project list|types|fields`, `status list`, `assignee list`, `priority list`, `comment list`.
- All take `--site <id>` and `--json`. `list` and `search` take `--limit <n>`: 30 by default, clamped to 1–100.
- `orca jira connection --json` → `result: { connected, sites: [{ id, siteUrl, displayName, authType: 'cloud' | 'server', apiBaseUrl, ... }], activeSiteId, selectedSiteId, viewer: {...} }`.
  - It lists saved connections; it does not test them.
  - Without a connection it answers `ok: true` with `connected: false` and `sites: []`. `result` also has `credentialProtection` and `supportsScopedTokens` **[Verified]**.
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
  - Kickoff reads `issueType.name` as the task's issue type, for its branch type (issue #119).
- No pagination: no cursor or offset, and no hint that more results exist.
- Errors **[Verified]**:
  - Invalid JQL: exit 1, `{ ok: false, error: { code: 'runtime_error', message: 'Error 400: <message in the instance language>' } }` on stdout, empty stderr. Kickoff counts only `runtime_error` from `orca jira search` as a rejected query (issue #107). Whether Orca also answers `runtime_error` for failures that aren't about the query, such as Jira being down, was not checked **[Assumed]**.
  - Unknown site: `invalid_argument`, "No matching connected Jira site...".
  - Empty JQL: rejected with `invalid_argument`.
  - Without a Jira connection, Orca's code answers "Not connected to Jira." when creating or editing a task **[Verified]** (read in `app.asar`). `orca jira search` instead fails with the unknown-site message, "No matching connected Jira site. Check orca jira connection and Orca Jira settings." **[Verified]**, seen by the maintainer in Kickoff's panel inside Orca 1.4.259 after disconnecting Jira (issue #23). Its error code was not seen.
- `orca jira list --filter assigned` uses `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` **[Verified]**.
- Text search in JQL **[Verified]** (issue #48, same results with `orca jira search` and `twg jira workitem query`, Jira Cloud):
  - `(<jql>) AND text ~ "<words>"` fails with `runtime_error` (exit 1) when `<jql>` ends in `ORDER BY ...`: the `ORDER BY` has to stay outside the parentheses, as in `(<conditions>) AND text ~ "<words>" ORDER BY updated DESC`.
  - `text ~` matches whole words: a word prefix matches nothing unless it ends in `*` (`"pag*"`).
  - Stop words such as `a` and `the` match nothing.
  - `text ~ "<task key>"` does not find the task; `key = "<task key>"` does. A well-formed key that does not exist returns no results, not an error.
  - An unterminated `"` inside the quoted words (`text ~ "\"abc"`) returns no results, not an error.
  - Lucene special characters inside the quoted words (`: - ( ) ! ? [ ] ^ ~ / { } && ||`) give no error with `orca jira search`. Inside a JQL string, `"` and `\` still have to be escaped with `\`: an unescaped trailing `\` would escape the closing quote.
  - The JQL a Kickoff tracker search sends, `(<conditions>) AND (text ~ "dark* mode*" OR key = "<KEY>") ORDER BY updated DESC`, with several prefixed words in one string, is accepted by `orca jira search` with no error **[Verified]** (Orca 1.4.261, Jira Cloud). Whether a task must match every word or any one of them was not checked.

### Orca's Linear support

These facts back the viability study (issue #154) and the Linear provider, `linear-orca` (`src/providers/linear-orca.ts`, issue #161). Seen with Orca 1.4.277 on Windows, connected to a test Linear workspace with invented issues, unless tagged otherwise.

How Kickoff uses them (issue #161): a page is one `list-issues` call per Linear query with `--limit` (50, or what the page still needs), `--state open` and `--order-by updatedAt` unless the query names others, `--cursor` for a next page and `--json`; the panel's cursor is `<query index>:<Orca cursor>`, as with `twg`. `--workspace` goes only with a workspace stored in the provider's configuration, never `all`. A row gives a task only its `identifier`, `title`, `url`, `description`, `state.name`, `state.type`, `assignee.displayName` and `labels[].name`. `state.type` gives the status category (`backlog`, `triage`, `unstarted` to do; `started` in progress; `completed`, `canceled`, `duplicate` done), so an open list can show a `duplicate` task as done: accepted, rather than leaving such rows out. `linear_not_connected` becomes a message that says to connect Linear in Orca's settings. Start links with `--reference <issue URL>`, and a worktree counts as a Linear task's when a `provider: 'linear'` item names it. `engines.orca` is `>=1.4.277`, the oldest Orca seen with `list-issues`.

`orca linear` uses the Linear connection saved in Orca **[Verified]**.

- The connection is a personal API key (Settings › Integrations › Linear, or `orca linear connect` with the key on stdin) or an OAuth token from Orca's bot connectors. Keys are sealed with the OS keyring, one per Linear workspace. Several Linear workspaces can be connected at once **[Verified]** (read in Orca's app bundle).
- Which workspace a read uses without `--workspace` (issue #160). The test setup has only one workspace connected, so the choice between several couldn't be seen; these facts are **[Verified]** (read in Orca 1.4.279's app bundle):
  - Orca keeps a *selected* and an *active* workspace. Connecting a workspace with an API key (in Settings or with `orca linear connect`) makes it both. Choosing a workspace in Orca's own Linear UI makes it both too; choosing "all" there selects `all` and keeps the active one. No CLI command only selects a workspace. How an OAuth connection from the bot connectors sets them was not read **[Assumed]**.
  - Without `--workspace`, `list-issues`, `team list` and `project list` read one workspace: the selected one, unless it is `all` or no longer connected; else the active one; else the first connected one.
  - So without `--workspace` these commands never read several workspaces, and which one they read changes when the user connects another workspace or picks one in Orca's UI. They read every workspace only with `--workspace all`.
  - With one workspace connected, they read that one, and `list-issues` gives its id as `meta.workspaceId` **[Verified]** (Orca 1.4.279).
- An unknown `--workspace` (one that isn't connected) **[Verified]** (Orca 1.4.279): `list-issues` exits 1 with `{ ok: false, error: { code: 'linear_invalid_workspace', message: 'Unknown Linear workspace <id>.', data: { nextSteps: [...] } } }`. `team list` and `project list` answer `ok: true` with an empty list.
- Read-only subcommands: `list`, `list-issues`, `search <query>`, `issue [<id>|--current]`, `team list|members|states|labels`, `project list`. Most take `--workspace <id>` (some also `all`) and `--json`. The rest write: `create`, `save-issue`, `status set`, `assignee`, `priority`, `estimate`, `due-date`, `label`, `comment`, `attach`, `relation`.
- There is no read-only command that reports the connection, like `orca jira connection`. The runtime has a `linear.status` method, but no CLI command calls it **[Verified]** (read in the app bundle).
- Without a connection, `list-issues`, `search` and `issue` exit 1 with `{ ok: false, error: { code: 'linear_not_connected', message: 'Linear is not signed in on this computer.' } }`. `list` and `team list` instead answer `ok: true` with an empty list, so they can't tell "not connected" from "nothing to show". So does `project list` **[Verified]** (read in Orca 1.4.279's app bundle).
- Privacy: every issue row and every team carries `workspace.name`, the Linear organisation's name, and the `url` carries its URL key. The connect and status answers carry the user's email. Read only the fields needed and never log raw output.
- The Orca version that first had `list-issues` is not known **[Assumed]**: 1.4.277 is the oldest seen.

`orca linear list-issues --json` → `result: { issues: Issue[], truncated, meta: { limit, returned, hasMore, nextCursor?, orderBy, workspaceId, partial, workspaceErrors } }`:

```json
{ "id": "<uuid>", "identifier": "ENG-12", "title": "Add dark mode to settings",
  "url": "https://linear.app/acme/issue/ENG-12/add-dark-mode-to-settings", "description": "Markdown text",
  "state": { "id": "...", "name": "Todo", "type": "unstarted", "color": "#..." },
  "team": { "id": "...", "name": "Engineering", "key": "ENG", "color": "#..." },
  "project": null, "cycle": null, "assignee": { "id": "...", "displayName": "Ana Example", "avatarUrl": null },
  "labels": [{ "id": "...", "name": "Feature", "color": "#..." }], "priority": 2, "priorityLabel": "High",
  "estimate": null, "dueDate": null, "branchName": "eng-12-add-dark-mode-to-settings",
  "createdAt": "...", "updatedAt": "...", "workspace": { "id": "...", "name": "Acme" } }
```

- `description` is Linear Markdown, or `null` when the issue has none.
- An unassigned issue has `assignee: null`; on Jira the key is missing instead. `project` and `cycle` are `null` when unset.
- `state.type` is Linear's own value and does not change with the workspace's language or state names. Seen: `backlog`, `unstarted`, `started`, `completed`, `canceled` and `duplicate`. Linear also has `triage` **[Verified]** (read in the app bundle).
- Linear has no issue type.
- Filters, one value each: `--state`, `--assignee user|me|null`, `--team`, `--project`, `--cycle`, `--label`, `--priority 0-4`, `--query`, `--parent-id`, `--created-at`, `--updated-at`, `--include-archived`. There is no query language like JQL.
  - `--state open` is Orca's filter `state.type not in (completed, canceled)`, so it includes `triage` and `duplicate` as well as `backlog`, `unstarted` and `started` **[Verified]** (read in Orca 1.4.279's app bundle, issue #160; its `--help` says "open for any state not done or canceled"). Seen in a list: `backlog`, `unstarted` and `started` in, `completed` and `canceled` out. The test team has a `duplicate` state with no issue in it and no `triage` state, so neither was seen in a list.
  - `--state` also takes a state name (`Todo`) or a type (`started`).
  - `--project` takes the project's id, its name (ignoring case) or its slug id (ignoring case), or `null` for issues with no project **[Verified]** (read in Orca 1.4.279's app bundle; `null` seen). An unknown project is not an error: it gives `ok: true` with no issues **[Verified]** (Orca 1.4.279).
  - `--team` takes the team's key, name or id, ignoring case. `--label` takes the label's name, ignoring case.
  - An unknown team, state or label is not an error: it gives `ok: true` with no issues.
  - `--query` matches the whole text as one substring of the title or the description, not word by word: `pagin` finds "Fix pagination", but `dark settings` doesn't find "Add dark mode to settings". It does not match the identifier.
- Order: `--order-by updatedAt` (the default) or `createdAt`, newest first. There is no board or manual order.
- Pagination: `meta.nextCursor` is an opaque token, given while `meta.hasMore` is true, that `--cursor` takes to read the next page. With `--workspace all`, a cursor is refused with `linear_invalid_workspace`. Without `--limit`, Orca reads every match until a 20 s deadline **[Verified]** (read in the app bundle).
- With `--workspace all`, a workspace that fails does not fail the call: it shows up in `meta.workspaceErrors[]` with `partial: true` **[Verified]** (read in the app bundle).

Other reads:

- `orca linear search <query>` uses Linear's full-text search. It has no state filter, so done and canceled issues come back too. Its limit is 20 by default, 50 at most **[Verified]** (limit read in the app bundle).
- `orca linear list --filter assigned|created|all|completed|open` gives Orca's own presets. Its rows have no `description`, `labels` or `cycle`, and it has no cursor **[Verified]** (read in the app bundle).
- `orca linear team states --team <key>` → `result: { team, states: [{ id, name, type, ... }], meta }`. `team labels` → `result: { team, labels: [{ id, name, color }], meta }`. `team list` → `result: { teams: [{ id, name, key, url, workspace: { id, name } }], meta }`. Listing the connected workspaces from `team list` rows needs `--workspace all` (see which workspace a read uses, above), and a workspace with no teams doesn't show up.
- `orca linear project list [--query <text>] [--limit <n>] [--workspace <id>|all] --json` → `result: { projects: Project[], truncated, meta: { query?, workspaceId?, limit, returned, hasMore, partial, workspaceErrors } }`. The shape of the answer is **[Verified]** (Orca 1.4.279), but the test workspace has no project, so the fields of a project were read in the app bundle **[Verified]**:

  ```json
  { "id": "...", "name": "Dark mode", "url": "https://linear.app/acme/project/dark-mode-0a1b2c3d4e5f",
    "workspaceId": "...", "workspaceName": "Acme",
    "teams": [{ "id": "...", "name": "Engineering", "key": "ENG" }] }
  ```

  - Only `id` and `name` are always there: `url`, `workspaceId`, `workspaceName` and `teams` are left out when empty, and a team's `key` can be missing. `teams` holds at most the project's first 10 teams. The slug id that `--project` also takes is not in the row.
  - `meta.query` and `meta.workspaceId` are there only when `--query` and `--workspace` were passed.
  - Orca asks Linear for projects ordered by `updatedAt`; with `--query` it uses Linear's project search instead. There is no cursor: without `--limit`, Orca reads every project until the 20 s deadline (the same deadline as `list-issues`) and sets `truncated` and `meta.hasMore` when it stops early.
  - Privacy: `workspaceName` is the organisation's name, and `url` carries its URL key.
- Orca's own UI also lists the issues of a Linear custom view (a filter saved in Linear). The CLI doesn't offer custom views **[Verified]** (read in the app bundle).

Linking a worktree to a Linear issue:

- `orca worktree create --reference <issue URL>` links the worktree to the issue with no lookup and no title. `worktree list --json` then shows `linkedLinearIssue: "ENG-12"` and a `linkedItems` entry `{ provider: 'linear', type: 'issue', number: 0, identifier: 'ENG-12', linearIdentifier: 'ENG-12', linearOrganizationUrlKey: 'acme', url }`, and `linkedWorkItem` stays `null`.
- `--linear-issue <identifier|URL>` (on `worktree create` and `worktree set`) links the same way. It can't be combined with `--reference`. A bare `ENG-12` given to `--reference` is read as a Jira key.
- `orca linear issue --current` run inside a worktree linked either way finds its issue. It resolves the worktree from `ORCA_TERMINAL_HANDLE` first, then from the folder it runs in. So run from a terminal of another worktree, it reads that worktree's link and fails with `linear_no_linked_issue`.
- The plugin API has nothing for Linear **[Verified]** (read in Orca 1.4.277's plugin host).

## Executable paths

On Windows all three tools are `.exe` and on PATH **[Verified]**:

| Tool | Windows path |
| --- | --- |
| `orca` | `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` |
| `gh` | `%ProgramFiles%\GitHub CLI\gh.exe` |
| `twg` | `%LOCALAPPDATA%\Programs\twg\bin\twg.exe` |

- macOS: `orca` is at `/Applications/Orca.app/Contents/Resources/bin/orca`; `gh` at `/opt/homebrew/bin/gh` or `/usr/local/bin/gh` **[Original]**.
- `twg` on macOS and Linux: no data **[Assumed]**.
- The worker inherits the user's `PATH` on Windows **[Verified]**. Full paths are still tried, for a tool that isn't on it.

## GitHub CLI

`gh` 2.96.0 **[Verified]**.

`gh issue list --repo <owner/name> --state open --limit 100 --json number,title,url,body,labels,assignees` returns a JSON array:

```json
[{ "number": 42, "title": "Add dark mode", "url": "https://github.com/acme/web/issues/42", "body": "...",
   "labels": [{ "id": "...", "name": "ui", "description": "", "color": "..." }],
   "assignees": [{ "id": "...", "login": "octocat", "name": "Octo Cat", "databaseId": 1 }] }]
```

- `--limit` defaults to 30. `--search`, `--assignee` and `--label` also exist.
- `--limit` above 100 works: gh pages on its own and has no cursor to resume from **[Verified]** (issue #48: `--limit 250` gave 250 issues, `--limit 1000` gave 1000 in about 6 s, on a public repository).
- `--search <query>` uses GitHub's issue search syntax **[Verified]** (issue #48):
  - It matches whole words: `pag` and `pag*` find nothing where `pager` finds issues.
  - A bare issue number finds that issue.
  - Qualifiers in the query override the other flags: `--state open --search "is:closed"` returns closed issues. Quoted, `"\"is:closed\""` is searched as text, and the issues seen then were open; gh still drops its `state:open` for it, so closed issues can come back too (see below, issue #109).
  - `is:pr` fails: "cannot use pull request search qualifiers with `gh issue list`".
  - An unterminated `"` returns no results, not an error.
- How `--state` and `--search` make one query, **[Verified]** with `gh` 2.103.3 and `GH_DEBUG=api` on a public repository (issue #109):
  - With `--search`, gh asks GitHub's issue search (GraphQL `search`, type `ISSUE_ADVANCED`) for `( <search> ) repo:<owner/name> state:open type:issue`: the words go in parentheses, so a filter's query adds to `--state open`. Without `--search` it lists issues with `states: ["OPEN"]` instead, not through search.
  - gh leaves `state:open` out when the search text holds `is:closed` or `state:closed`, even inside double quotes: `--state open --search '"is:closed"'` sends `( "is:closed" ) repo:… type:issue`, which can list closed issues that contain those words. `--state closed --search is:open` keeps `state:closed` and lists nothing. So Kickoff adds `is:open` to every search itself: `(is:closed) is:open` lists nothing.
  - gh refuses `is:pr` before asking GitHub, also inside double quotes: `--search '"is:pr"'` fails with the same "cannot use pull request search qualifiers" message. So do `"IS:PR"`, `"type:pr"` and `"is:pull-request"`, while `"is:prx"`, `"xis:pr"` and `"is pr"` go through: gh matches whole tokens, in any case.
  - Inside double quotes GitHub reads `:` as a word break: `"type:issue"` and `"type issue"` gave the same issues, in the same order. So a tracker search sends each word with its `:` as spaces, which gh neither refuses nor reads as `is:closed`.
  - Parentheses and `OR` work inside the search, and nest inside gh's own: `--search '(label:bug OR label:docs) is:open "gh"'` lists open issues with either label that match `gh`. `sort:updated-asc` inside parentheses still sorts.
  - An unbalanced `(` or an unknown qualifier such as `foo:bar` gives an empty list, not an error.
  - With no keyword, such as `is:open` or `assignee:@me`, the results come newest first, in the order of the plain list; with keywords, by relevance.
  - `@me` in `assignee:@me` is the logged-in user.
  - Of the searches tried, gh's `is:pr` refusal was the only failure: GitHub answered every malformed search with an empty list.
- Going through GitHub's search for every list, rather than the plain list, may bring the search's own rate limit and a short delay before a new issue is found, and each query of a filter is one more search **[Assumed]**: not measured.
- Logged out (no stored login, no `GH_TOKEN`): exit 4, empty stdout, and stderr starting `To get started with GitHub CLI, please run:  gh auth login`, then a line about `GH_TOKEN` **[Verified]**.
- For GitHub Enterprise, `--repo` takes `<host>/<owner>/<repo>` **[Assumed]**; it is the documented `gh` form, but not run here.

### Recent work, for triage

Used by the triage rule in `docs/agents/triage-labels.md`. **[Verified]** with `gh` 2.103.3 on this repository (issue #101):

- `gh issue list --state closed --search "closed:>=YYYY-MM-DD"` returns only the issues closed on or after that date.
- `gh pr list --state merged --search "merged:>=YYYY-MM-DD" --json number,title,body,files` returns the merged PRs with `files[].path`, the files each PR changed.
- `closingIssuesReferences` can be empty for a PR whose body ends with `Closes #<n>`: PR #103 returns `[]` and closes #100. Reading `Closes #<n>` out of `body` finds the issue.
- Windows PowerShell 5.1 strips the double quotes inside a single-quoted argument to a native program, so a `--jq` filter with a string in it breaks: `gh` exits 1 with `unknown argument "#([0-9]+))[0]])}"`. The same command works in Git Bash.

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
- **Query** **[Verified]**: `twg jira workitem query --jql <jql> --fields summary,status,assignee,labels,description,issuetype --limit 50 --after <cursor> --output json --api-version v2`.
  - `--help` describes `-n, --limit <limit>` as the most work items to return (an alias for `--first`), and `--after` as the cursor to go on from **[Verified]** (twg 1.4.4).
  - A `--limit` below 50 returns at most that many work items, and a cursor from a call with one `--limit` works in a call with another **[Verified]** (twg 1.4.4, seen by the maintainer inside Orca 1.4.263). With two queries on a project whose keys run on without gaps, the first holding keys 1 to 10 and the second the rest, both ordered by key, the first load showed keys 1 to 50 (the second query asked with `--limit 40`) and **Load more** showed 51 to 100 (the second query asked with its cursor and `--limit 50`), with no key repeated or skipped.
  - Kickoff fills a page of 50 across the JQL queries of the filter listed, in order: when a query ends before the page is full, it runs the next one with `--limit` set to the tasks the page still needs. The panel's cursor is `<index>:<twg cursor>`, for the query (counting the non-blank ones from 0) where the next page starts, or `<index>:` when it starts at the beginning of that query (`pageAcrossQueries` in `src/providers/queries.ts`, which `src/providers/jira-twg.ts` uses). A cursor belongs to its filter: the panel's **Load more** names the filter listed with it. With three queries on a board of 10 tasks (3 in the active sprint, 2 in a future sprint, 5 in the backlog), the first load shows all 10 and no **Load more** **[Verified]** (seen by the maintainer inside Orca 1.4.263, issue #86).

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
- Each issue also has `self` and `expand`. `status` is the Jira REST v3 status object (`self`, `description`, `name`, `id`, `statusCategory`), and `statusCategory` has `self`, `id`, `key`, `colorName` and `name` **[Verified]**.
- Only `statusCategory.key: "new"` has been seen. `indeterminate` and `done` are Jira's documented values **[Assumed]**.
- A non-null `assignee` is the Jira REST v3 user object **[Verified]** with an assigned task:

  ```json
  { "self": "https://example.atlassian.net/rest/api/3/user?accountId=acc-1", "accountId": "acc-1",
    "emailAddress": "ana@example.com", "displayName": "Ana Example", "active": true,
    "timeZone": "UTC", "accountType": "atlassian" }
  ```

  - `emailAddress` is the assignee's email: Kickoff reads only `displayName`.
  - An unassigned task has `assignee: null` **[Verified]**.
- With `issuetype` in `--fields`, each issue has `issuetype`, the Jira REST issue type object: `self`, `id`, `description`, `name` (a string), `subtask`, `avatarId`, `entityId` and `hierarchyLevel` **[Verified]** (twg 1.4.4). Kickoff asks for it and reads only `name`, as the task's issue type for its branch type (issue #119).
- `description` is ADF (Jira's JSON document format), an object `{ type: 'doc', version: 1, content: [...] }` **[Verified]**. An empty description is expected to be `null` **[Assumed]**. Node types seen: `paragraph`, `orderedList` (with `attrs.order`), `listItem` and `text`. Also `heading` (with `attrs.level`), `bulletList` (nested inside a list item too), `codeBlock` (with `attrs.language`, its text holding blank lines), `hardBreak`, `blockquote` and `rule`, plus the marks `strong`, `em`, `code` and `link` **[Verified]**: the maintainer saw them reach a started agent's prompt as readable plain text inside Orca (issue #22, version not recorded). A link written as HTML `<a>` becomes a `link` mark, not an `inlineCard`. `mention` and `inlineCard` follow Atlassian's ADF documentation **[Assumed]**; `src/adf.ts` handles them.

Errors **[Verified]**:

| Case | Exit | stdout | stderr |
| --- | --- | --- | --- |
| Invalid JQL | 1 | `{ ok: false, error: { code: 'TWG_TOOL_EXECUTION_FAILED', message, statusCode, downstreamError, retry, feedback: { url } } }` | Readable block starting `Error: <message>` |
| Unknown site or profile | 1 | `{ ok: false, error: { code: 'TWG_COMMAND_FAILED' \| 'AUTH_PROFILE_MISSING', message } }` | empty |
| Bad arguments | 1 | empty | `error: ...` |
| Not logged in | 77 | `{ ok: false, error: { code: 'AUTH_REQUIRED', kind, mode, statusCode: 401, message: 'authentication required. No valid credentials found.', summary: "You're not signed in. Run `twg login --force` to authenticate with your Atlassian account.", remediation: { command, env } } }` | Readable block starting `Error: <message>`, then the summary |

- The message is in the Jira instance's language.
- Take the message from `error.message` on stdout, followed by `error.summary` when present (it says how to fix it, as with `twg login`), and fall back to stderr.
- Kickoff counts a failure as a rejected JQL query, which names its filter and opens the filter editor, only with `error.code` `TWG_TOOL_EXECUTION_FAILED`, as in the table; every other failure is about the tool, the login, the site or the profile (`src/providers/jira.ts`, issue #107).
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
