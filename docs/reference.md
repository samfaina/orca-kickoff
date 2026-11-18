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
- Orca loads `.ts`, `.tsx`, `.mts` and `.jsx` as they are, without type checking. There is no build step and no `package.json`. A panel may only import `orca`, `orca/*` and relative paths **[Verified]**.
- Type check with `npx -y -p typescript@5.6.3 tsc -p .`, after `orca plugin types .`: a fresh clone has no `.orca/`, so `tsconfig.json` has nothing to extend **[Verified]** with TypeScript 5.6.3.

### Manifest

```json
{
  "manifestVersion": 2,
  "id": "kickoff",
  "name": "Kickoff",
  "version": "0.1.0",
  "description": "...",
  "license": "MIT",
  "icon": "assets/icon.png",
  "engines": { "orca": ">=1.4.255" },
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
- Kickoff's cover is `assets/cover.png`, 1600×1000, about 560 KB, exported from `assets/cover.html`. On the icon's slate gradient, the name and the line "Your prompt templates, one click from any GitHub or Jira task." sit on the left, and Kickoff's panel in Orca's dark theme on the right, drawn in HTML with the tasks of the `jira-started` check scenario (without WEB-14, so the open menu fits). The template menu of WEB-16 is open with `implement`, `prototype` and `review`, which are example names. A mint underline, tapered to a point, sits behind "prompt templates", and a curved arrow runs from under its last "e" to the menu; a script in the page places both from the layout. It is drawn by hand, with no image generator and no icon set. It was chosen in issue #72, as variant C-A.
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

Host methods **[Verified]**:

- Worker: `workspace.readContext`, `workspace.list`, `workspace.open`, `terminal.sendText`, `terminal.create`, `terminal.read`, `agent.launch`, `agents.list`, `notifications.show`, `storage.*`, `secrets.*`, `settings.*`, `statusBar.update`, `editor.open`, `commands.run`.
- Panel: `workspace.readContext`, `notifications.show`, `storage`, `secrets`, `settings`, `shell.openExternal`, `files.saveAs`, `plugin.request`, `agents.list`, `events.subscribe`.

What the API does **not** offer **[Verified]**: listing projects, creating worktrees, reading Orca's settings, or knowing which workspace is focused by id.

- `workspace.list` returns `{ workspaces: { id, kind: 'worktree' | 'folder', name, path, branch | null, hostId | null }[], truncated }`, with no project id and no focus flag.
- `agent.launch({ workspaceId, agent, prompt? })` returns `{ terminalId }`. `agent` is required, and the workspace must already exist.
- `agents.list` returns `{ agents: { terminalId, title, agent, state: 'working' | 'blocked' | 'waiting' | 'done', stateStartedAt }[] }` for the focused workspace only, and does not say which agent is the default.

That is why Kickoff uses the Orca CLI for projects, worktrees and creation.

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

### Errors from worker to panel

- Documented contract **[Verified]**: an error thrown in a handler whose `code` is a host error code (`invalid_params`, `conflict`, ...) reaches the panel with that code; any other becomes `action_failed`. The panel can also see `unknown_method`, `timeout` and `unavailable`.
- Whether the thrown `message` reaches the panel unchanged: **[Assumed]**. The worker side serialises `{ code, message }`, but the main-process routing could not be read.
- So Kickoff returns expected failures as data and never relies on thrown messages.
- `plugin.request` times out after 30 000 ms by default, and accepts at most 120 000 **[Verified]**. A `worktree create` can take longer, so `task.start` answers once its quick checks pass and the create goes on in the worker, which posts `start.ended` when it ends.

### Posts from worker to panel

- `orca.panels.post(event, payload, { panel? })` sends to every open panel of the plugin, or to one (`panel` from a request's context). It is fire and forget, returns `void`, and allows at most 256 KiB per post and 200 posts per 10 s **[Verified]** (generated types and Orca's authoring guide).
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

- `Field` (`label`, `description?`, `error?`, `required?`) wraps a control with help text or an error.
- Limits per render: 5000 nodes, 16 KiB per text, 500 options per `Select`.

Layout and sizing, from the generated types and `references/components.md` of `orca skills get orca-plugin-authoring`, Orca 1.4.261 **[Verified]**:

- No `className`, `style` or DOM tags; an unknown prop or enum value is dropped with a warning. `ui.has(component, prop?)` and `ui.catalog` detect what the installed Orca supports.
- Inner scroll: `Box` takes `height`, `maxHeight` and `minHeight` (`number` of pixels from 0 to 4096, or a whole percent of the parent such as `'50%'`) and `scroll?: 'x' | 'y' | 'both'`; `y` needs `height` or `maxHeight`. `Table`, `Tree` and `CodeView` take `maxHeight?: 'sm' | 'md' | 'lg' | 'none'` and scroll inside. `Stack`, `Row`, `List`, `Grid`, `Card`, `Collapsible` and `Tabs` have no height or scroll prop. There is no `sticky` or `overflow`.
- With the whole panel in a `Box direction="column" height="100%"` and the list in a `Box grow minHeight={0} maxHeight="100%" scroll="y"`, the list fills the height left in the panel and only the list scrolls: the header and the "Search tasks" field above it stay in place, and the list's last row (Load more) can be reached **[Verified]** (seen by the maintainer in the #46 prototype, Orca 1.4.261, a project with more tasks than fit).
- A part after the scrolling `Box`, such as the template detail's Delete bar in a `Box shrink={false}`, stays in place under it while the form scrolls **[Verified]**, seen by the maintainer inside Orca (#55, version not recorded).
- Field width: `Select`, `Input` and `Textarea` have no size or width prop (`Textarea` has `rows`, 2 to 20). A `Box` around them sizes them: `width`, `minWidth`, `maxWidth`, `grow` and `shrink={false}`. `Button` and `IconButton` take `size: 'xs' | 'sm' | 'md'`. In a `Stack` with no `align`, fields, tables and cards fill the width and buttons keep their own. With `align="stretch"`, buttons fill the width too, as Kickoff's "Load more" does **[Verified]** (generated types of Orca 1.4.261).
- `Box` also takes `direction`, `gap`, `padding`, `paddingX`, `paddingY`, `margin`, `align`, `justify`, `wrap`, `columns`, `border`, `radius` and `background`. `Row` takes only `gap`, `align`, `justify` and `wrap`.
- `Text` takes `tone`, `muted`, `size`, `weight` and a boolean `truncate`; there is no line clamp.
- `Table`: columns (`width`, `minWidth`, `hideBelow: 'sm' | 'md'` for under 360 px or 480 px, `sortable`), rows of plain cells (`string`, `number`, `boolean`, `null` or a relative time), `selectionMode`, `onRowAction` (Enter or a double click), `sort` and `onSortChange` (the plugin sorts), and `hasMore` with `onLoadMore`, called when scrolling near the last row. Rows scroll inside the table and only those in view are drawn. Cells can't hold components, so a row can't have its own button or `Select`, and there is no built-in filter.
- `ListItem` takes `title`, `description`, `icon`, `current`, `disabled` and `onPress`; with `onPress` the whole row is the press target and can't hold other controls.
- `IconButton` with `variant="outline"` and `tone="accent"` draws its icon and border in the text color, with no accent **[Verified]** (seen by the maintainer, Orca 1.4.261).
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
  - `mockHost({ capabilities, results, requests, storage, settings, secrets })`. A `results` entry is a value or a function that answers or throws at once: an `async` function for `storage.set` made the panel's write fail with an error that has no `code`, so a test can't hold a storage write the way it holds a `requests` handler **[Verified]** with Orca 1.4.261 (issue #55).
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
- Orca renames branches it named itself when an agent starts (`autoRenameBranchFromWork`). A name given with `--name` is not generated, so it is expected not to be renamed **[Assumed]**; not tested by creating a worktree.
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
   - Orca removes `APPDATA` from the worker environment on Windows **[Verified]** (see [Worker process](#worker-process)), and `XDG_CONFIG_HOME` on Linux **[Original]**.
   - So the original plugin derives the folder from its own install path, `<data>/plugins/<publisher>.<id>/<64 hex>/...` **[Verified]**. It checks that the plugin folder ends with `.<id>`.
   - Each installed plugin folder holds the `<64 hex>` content folder (the `contentHash` in `plugins/plugins.lock.json`), a `current` file (not a link) and `.install-provenance` **[Verified]**. That the worker's `import.meta.url` points inside the content folder is **[Original]**; Kickoff falls back to the platform's default folder otherwise (`src/agent.ts`).
2. **Active profile:** `activeProfileId` in `orca-profile-index.json` (keys `schemaVersion`, `activeProfileId`, `profiles[]`), with `orca-profile-index.json.bak` as a fallback and `local-default` as the default **[Verified]**. The original only accepts the id if it matches a pattern and is listed in `profiles[]` **[Original]**.
3. **Settings:** `profiles/<profile>/profile-state.db`, table `profile_state_documents` (`domain`, `payload`, `domain_version`, `revision`, `updated_at`, `content_hash`). `SELECT payload FROM profile_state_documents WHERE domain = 'settings'` gives JSON with `defaultTuiAgent`, `disabledTuiAgents` and `agentDefaultSurface` **[Verified]**.
   - Read with Node's built-in `node:sqlite` (`DatabaseSync`, `readOnly: true`): the Node inside Orca 1.4.255 is v24.22.1 and has it **[Verified]**.
   - `disabledTuiAgents` is an array of agent ids, and can be long **[Verified]**.
   - A `profile_state_document_parts` table also exists, so large documents may be split **[Assumed]**. A payload that isn't valid JSON is treated as unreadable, and Kickoff tries `orca-data.json` next.
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
- No pagination: no cursor or offset, and no hint that more results exist.
- Errors **[Verified]**:
  - Invalid JQL: exit 1, `{ ok: false, error: { code: 'runtime_error', message: 'Error 400: <message in the instance language>' } }` on stdout, empty stderr.
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
  - Qualifiers in the query override the other flags: `--state open --search "is:closed"` returns closed issues. Quoted, `"\"is:closed\""` is searched as text and only open issues come back.
  - `is:pr` fails: "cannot use pull request search qualifiers with `gh issue list`".
  - An unterminated `"` returns no results, not an error.
- Logged out (no stored login, no `GH_TOKEN`): exit 4, empty stdout, and stderr starting `To get started with GitHub CLI, please run:  gh auth login`, then a line about `GH_TOKEN` **[Verified]**.
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
