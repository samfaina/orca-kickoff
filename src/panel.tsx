// Kickoff's side panel: the active project's open tasks and Start, and its Project settings. No build
// step: Orca strips the types and compiles the JSX when the panel loads. The worker does the work;
// the panel asks it and draws the answers.
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  Row,
  Select,
  Separator,
  Spinner,
  Stack,
  Text,
  Textarea,
  atom,
  on,
  plugin,
  read,
  set,
  storage,
  update,
  type JsonValue,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { isRecord } from './json'
import {
  appendTasks,
  chooseProvider,
  DEFAULT_JQL,
  projectProvider,
  projectSettings,
  providerConfig,
  readSettings,
  SETTINGS_KEY,
  trackerOf,
  withProjectChanges,
  type JiraProviderId,
  type JiraSitesResult,
  type ProjectChanges,
  type ProjectSettings,
  type ProjectRef,
  type ProviderConfigs,
  type PromptTemplate,
  type ProviderId,
  type StartEnded,
  type StartResult,
  type Task,
  type TaskList,
  type TaskWorktree
} from './protocol'
import { matchesSearch } from './search'
import {
  defaultTemplate,
  INITIAL_TEMPLATE_TEXT,
  projectTemplates,
  TEMPLATE_VARIABLE_DESCRIPTIONS,
  TEMPLATE_VARIABLES,
  templateNameProblem,
  withTemplateDeleted,
  withTemplateSaved,
  type TemplateChanges
} from './template'

/** Orca queries and the tracker can take up to about 65 s together. */
const LOAD_TIMEOUT_MS = 90_000
/** `task.start` answers after its quick checks, two Orca queries of at most 20 s each; the create
 *  goes on in the worker, which posts `start.ended` when it ends. */
const START_TIMEOUT_MS = 60_000
/** Project settings save themselves after this pause. */
const SAVE_DELAY_MS = 600
/** How long Delete waits for its second click, as "Confirm delete". */
const CONFIRM_DELETE_MS = 4_000
/** How often the panel asks for the active project while it is visible. */
const POLL_MS = 3_000
/** Orca detects the agent of a new worktree a few seconds after its create ends, so the panel
 *  reads the worktrees once more after this pause. */
const AGENT_CHECK_MS = 5_000
/** A burst of workspaces created or removed reads the worktrees once, this long after the last. */
const WORKSPACE_REFRESH_MS = 300

const AGENT_OPTIONS = [
  { value: 'orca-default', label: 'Orca default' },
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'gemini', label: 'gemini' },
  { value: 'opencode', label: 'opencode' },
  { value: 'copilot', label: 'copilot' },
  { value: 'none', label: 'No agent' }
]

const PROVIDER_OPTIONS: { value: ProviderId; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira-orca', label: 'Jira (Orca connection)' },
  { value: 'jira-twg', label: 'Jira (twg)' }
]

/** Select values can't be empty, so these stand for "no tracker yet" and "Orca's default site".
 *  Neither can be a provider id or an Orca site id. */
const NO_TRACKER = ':none'
const DEFAULT_SITE = ':default'

/** The listed project's settings, as the person sees them. `provider` is null while none is set. */
type ShownSettings = {
  projectId: string
  provider: ProviderId | null
  providers: ProviderConfigs
  agent: string
  templates: PromptTemplate[]
  defaultTemplateId: string
}

/** The template detail's draft: a template of `projectId` being edited, or a new one. */
type TemplateDraft = {
  projectId: string
  id: string
  isNew: boolean
  name: string
  text: string
  /** The error of the last write, shown until the next one. */
  error: string | null
  saving: boolean
  /** Delete was clicked once and waits for its second click. */
  confirmingDelete: boolean
}

const list = atom<TaskList | null>(null)
const loading = atom(false)
/** The Project settings of the listed project, as the person sees them. */
const shownSettings = atom<ShownSettings | null>(null)
/** The sites of Orca's Jira connection, asked for the first time they are needed. */
const jiraSites = atom<JiraSitesResult | 'loading' | null>(null)
/** Task keys with a Start under way: asked by this panel, or reported by the worker. */
const starting = atom<Record<string, true>>({})
/** Task keys whose `task.start` hasn't answered yet. */
const requested = new Set<string>()
/** The end of each Start that arrived before its `task.start` answer. */
const endedEarly = new Map<string, StartEnded>()
/** Rises with each report asked for and each Start under way, so a report the worker made before
 *  a Start went under way can't end it. */
let startClock = 0
/** When each task's `task.start` answered that it is under way, on `startClock`. */
const underWaySince = new Map<string, number>()
/** Task keys whose Start passed an agent that Orca doesn't report running yet, mapped to the
 *  project of that Start. */
const agentStarting = atom<Record<string, string>>({})
/** The pending read of the worktrees for each task in `agentStarting`. */
const agentChecks = new Map<string, ReturnType<typeof setTimeout>>()
/** Task keys whose Start ended and is reading the worktrees for that end. */
const ending = new Set<string>()
/** Rises with each read of the worktrees, by `tasks.load` or `worktrees.load`, so a
 *  `worktrees.load` answer older than the worktrees shown is dropped. */
let worktreesClock = 0
/** When the worktrees shown were asked for, on `worktreesClock`. */
let worktreesShownAt = 0
/** The pending read of the worktrees after a workspace was created or removed. */
let workspacesTimer: ReturnType<typeof setTimeout> | null = null
/** The error of each task's last Start, or of opening its worktree. */
const taskErrors = atom<Record<string, string>>({})

/** The template chosen on each card, by project and task key, while the panel is open. Never
 *  stored; a card whose template no longer exists shows the default template again. */
const cardTemplates = atom<Record<string, string>>({})

/** Whether the template detail's Variables list is open, while the panel is open. */
const variablesOpen = atom(false)

/** The key of a task's card in `cardTemplates`. */
const cardKey = (projectId: string, taskKey: string) => `${projectId}\n${taskKey}`

/** The template a Start of the task uses: the one chosen on its card while the project still has
 *  it, else the project's default template. */
function chosenTemplateId(shown: ShownSettings, taskKey: string): string {
  const chosen = read(cardTemplates)[cardKey(shown.projectId, taskKey)]
  return shown.templates.some((template) => template.id === chosen) ? chosen : shown.defaultTemplateId
}

/** The project's templates as `Select` options. */
const templateOptions = (templates: PromptTemplate[]) => templates.map((template) => ({ value: template.id, label: template.name }))

/** Whether Project settings replaces the list: `open` or `closed` as the person left it, or `auto`
 *  to open it by itself when `needsSettings`. */
type SettingsChoice = 'open' | 'closed' | 'auto'

/** Kept in memory, and back to `auto` when the active project changes. */
const settingsChoice = atom<SettingsChoice>('auto')
/** The text of the "Search tasks" field: the filter over the loaded tasks, and the words of a
 *  tracker search. Kept in memory, and cleared when the active project changes. */
const fieldText = atom('')
/** The active project `settingsChoice` and `fieldText` belong to, null without one, or undefined
 *  before the first answer that says which. */
let viewStateFor: string | null | undefined

/** A tracker search shown in place of the loaded list, with the trimmed words it asked for. The
 *  loaded list stays in `list` meanwhile, so leaving the tracker search shows it again without a
 *  reload. */
type TrackerSearch =
  | { query: string; kind: 'loading' }
  | { query: string; kind: 'error'; message: string }
  | { query: string; kind: 'ready'; tasks: Task[]; nextCursor: string | null; truncated: boolean }

/** The tracker search shown, or null while the loaded list is. */
const trackerSearch = atom<TrackerSearch | null>(null)

/** The template detail's draft while it replaces the panel view, else null. */
const templateDraft = atom<TemplateDraft | null>(null)

/** Whether a "Load more" is under way, and the error of the last one. */
const loadingMore = atom(false)
const moreError = atom<string | null>(null)

/** Rises with each load, so an answer that arrives after a newer request is dropped. */
let generation = 0

/** The active project id of the last poll, or undefined when the next poll measures against the
 *  list instead: before the first poll, and after every load the poll didn't ask for. */
let lastPolledProjectId: string | null | undefined

/** Settings changes not saved yet, for one project. */
let pending: { projectId: string; changes: ProjectChanges } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Saves pending settings changes now. The worker reads settings from storage, so this runs
 *  before every request that depends on them. */
async function flushSettings(): Promise<void> {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  const toSave = pending
  pending = null
  if (!toSave) return
  try {
    const settings = readSettings(await storage.get(SETTINGS_KEY))
    await storage.set(SETTINGS_KEY, withProjectChanges(settings, toSave.projectId, toSave.changes) as unknown as JsonValue)
  } catch (error) {
    // Kept for the next save, under the changes made meanwhile.
    const meanwhile = pending as typeof toSave | null
    if (meanwhile === null || meanwhile.projectId === toSave.projectId) {
      pending = { projectId: toSave.projectId, changes: mergeChanges(toSave.changes, meanwhile?.changes ?? {}) }
    }
    throw error
  }
}

/** `earlier` changes with `later` ones on top, keeping the providers either changed. */
function mergeChanges(earlier: ProjectChanges, later: ProjectChanges): ProjectChanges {
  return { ...earlier, ...later, providers: { ...earlier.providers, ...later.providers } }
}

function changeSettings(changes: ProjectChanges): void {
  const current = read(shownSettings)
  if (!current) return
  // A tracker search narrows the list the tracker settings give, which this changes.
  if (changes.provider !== undefined || changes.providers !== undefined) leaveTrackerSearch()
  const providers = { ...current.providers, ...changes.providers }
  set(shownSettings, { ...current, ...changes, provider: changes.provider ?? current.provider, providers })
  const earlier = pending?.projectId === current.projectId ? pending.changes : {}
  pending = { projectId: current.projectId, changes: mergeChanges(earlier, changes) }
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushSettings(), SAVE_DELAY_MS)
}

/** Shows the stored settings of `project`, unless they are already shown. */
async function showSettings(project: ProjectRef): Promise<void> {
  if (read(shownSettings)?.projectId === project.id) return
  const settings = projectSettings(readSettings(await storage.get(SETTINGS_KEY)), project.id)
  const provider = projectProvider(settings, project)
  set(shownSettings, {
    projectId: project.id,
    provider,
    providers: settings.providers,
    agent: settings.agent ?? 'orca-default',
    templates: projectTemplates(settings),
    defaultTemplateId: defaultTemplate(settings).id
  })
}

/** Opens the template detail for one of the shown project's templates, or for a new one. It opens
 *  from Project settings, which stays open to come back to. */
function openTemplate(id: string | null): void {
  const shown = read(shownSettings)
  if (!shown) return
  const template = id === null ? null : shown.templates.find((candidate) => candidate.id === id)
  if (id !== null && !template) return
  set(settingsChoice, 'open')
  set(templateDraft, {
    projectId: shown.projectId,
    id: template?.id ?? newTemplateId(shown.templates),
    isNew: !template,
    name: template?.name ?? '',
    text: template?.text ?? INITIAL_TEMPLATE_TEXT,
    error: null,
    saving: false,
    confirmingDelete: false
  })
}

/** An id that none of `templates` has. */
function newTemplateId(templates: PromptTemplate[]): string {
  for (;;) {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!templates.some((template) => template.id === id)) return id
  }
}

/** Changes the detail's draft, while it is still the draft of the `expected` template. */
function changeDraft(expected: TemplateDraft, changes: Partial<TemplateDraft>): void {
  update(templateDraft, (draft) => (draft && isSameDraft(draft, expected) ? { ...draft, ...changes } : draft))
}

/** Whether two drafts are of the same template of the same project. */
const isSameDraft = (a: TemplateDraft, b: TemplateDraft) => a.projectId === b.projectId && a.id === b.id

/** Leaves the template detail without saving. */
function closeTemplate(): void {
  cancelConfirmDelete()
  set(templateDraft, null)
}

/** Stores the draft's template and goes back, unless its name can't be saved. */
async function saveTemplate(): Promise<void> {
  const draft = read(templateDraft)
  const shown = read(shownSettings)
  if (!draft || draft.saving || shown?.projectId !== draft.projectId) return
  if (templateNameProblem(shown.templates, draft.name, draft.id) !== null) return
  await writeTemplates(draft, (project) => withTemplateSaved(project, { id: draft.id, name: draft.name, text: draft.text }))
}

/** The pending end of a Delete's wait for its second click. */
let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null

/** The first click asks for a second within a few seconds; the second deletes the template. */
async function deleteTemplate(): Promise<void> {
  const draft = read(templateDraft)
  if (!draft || draft.saving || draft.isNew) return
  cancelConfirmDelete()
  if (!draft.confirmingDelete) {
    changeDraft(draft, { confirmingDelete: true })
    confirmDeleteTimer = setTimeout(() => {
      confirmDeleteTimer = null
      changeDraft(draft, { confirmingDelete: false })
    }, CONFIRM_DELETE_MS)
    return
  }
  await writeTemplates(draft, (project) => withTemplateDeleted(project, draft.id))
}

/** Stops waiting for Delete's second click. */
function cancelConfirmDelete(): void {
  if (confirmDeleteTimer !== null) clearTimeout(confirmDeleteTimer)
  confirmDeleteTimer = null
}

/** Writes a change to the draft project's templates, then shows them and goes back. A failed write
 *  keeps the detail open with its error and the draft. Pending Project settings are saved first, so
 *  the change applies to what the person sees. */
async function writeTemplates(draft: TemplateDraft, change: (project: ProjectSettings) => TemplateChanges | null): Promise<void> {
  changeDraft(draft, { saving: true, error: null, confirmingDelete: false })
  let changes: TemplateChanges | null
  try {
    await flushSettings()
    const settings = readSettings(await storage.get(SETTINGS_KEY))
    changes = change(projectSettings(settings, draft.projectId))
    if (changes) await storage.set(SETTINGS_KEY, withProjectChanges(settings, draft.projectId, changes) as unknown as JsonValue)
  } catch (error) {
    changeDraft(draft, { saving: false, error: `Couldn't save the template (${errorCode(error)}). Try again.` })
    return
  }
  const shown = read(shownSettings)
  if (changes && shown?.projectId === draft.projectId) set(shownSettings, { ...shown, ...changes })
  const current = read(templateDraft)
  if (current && isSameDraft(current, draft)) set(templateDraft, null)
}

/** Chooses the project's provider, saves it with its configuration and lists its tasks. */
function chooseProviderFor(value: string): void {
  const current = read(shownSettings)
  const provider = PROVIDER_OPTIONS.find((option) => option.value === value)?.value
  if (!current || !provider) return
  const chosen = chooseProvider({ providers: current.providers }, provider)
  changeSettings({ provider, providers: { [provider]: chosen.providers[provider] } })
  loadKeepingSettingsOpen()
}

/** Lists the tasks with the tracker shown in Project settings, which stays open: also when it
 *  opened by itself and the tasks now load. */
function loadKeepingSettingsOpen(): void {
  set(settingsChoice, 'open')
  leaveTrackerSearch()
  void load()
}

/** Changes some of a Jira provider's settings, keeping the rest. */
function changeJiraConfig<K extends JiraProviderId>(id: K, changes: Partial<Required<ProviderConfigs>[K]>): void {
  const current = read(shownSettings)
  if (!current) return
  changeSettings({ providers: { [id]: { ...providerConfig({ providers: current.providers }, id), ...changes } } })
}

/** Asks for the sites of Orca's Jira connection, unless they are being asked for or some are
 *  already listed: after a failure or with none connected, the person may have fixed it since. */
async function loadJiraSites(): Promise<void> {
  const sites = read(jiraSites)
  if (sites === 'loading' || (sites?.kind === 'ready' && sites.sites.length > 0)) return
  set(jiraSites, 'loading')
  try {
    set(jiraSites, await plugin.request('jira.sites', {}))
  } catch (error) {
    set(jiraSites, { kind: 'error', message: `Kickoff's worker didn't answer (${errorCode(error)}).` })
  }
}

/** Lists the active project's tasks, or runs the tracker search shown again. `poll` says the poll
 *  asked for it, so the poll's last answer stays the measure for the next one. */
async function load(reason: 'poll' | 'other' = 'other'): Promise<void> {
  const shownSearch = read(trackerSearch)
  if (shownSearch !== null) return searchTracker(shownSearch.query, reason)
  const mine = ++generation
  set(loading, true)
  set(loadingMore, false)
  set(moreError, null)
  let answer: TaskList
  let askedAt = 0
  let worktreesAskedAt = 0
  try {
    await flushSettings()
    askedAt = ++startClock
    worktreesAskedAt = ++worktreesClock
    answer = await plugin.request('tasks.load', {}, { timeoutMs: LOAD_TIMEOUT_MS })
  } catch (error) {
    answer = { kind: 'error', project: null, message: `Kickoff's worker didn't answer (${errorCode(error)}). Reload to try again.` }
  }
  if (mine !== generation) return
  // A change of active project drops the template detail's draft. An answer that names no project
  // because the worker didn't answer says nothing about it.
  const answeredProjectId = answer.kind === 'no-project' ? null : answer.project?.id
  const draft = read(templateDraft)
  if (draft && answeredProjectId !== undefined && answeredProjectId !== draft.projectId) closeTemplate()
  // A change of active project also sends Project settings back to opening by itself and clears
  // the field. Only once a project was listed: before that, both are as they start.
  if (answeredProjectId !== undefined) {
    if (typeof viewStateFor === 'string' && answeredProjectId !== viewStateFor) {
      set(settingsChoice, 'auto')
      set(fieldText, '')
    }
    viewStateFor = answeredProjectId
  }
  if ('project' in answer && answer.project) {
    try {
      await showSettings(answer.project)
    } catch {
      // Storage unreadable: the settings stay hidden, and a Start reads them again for its template.
    }
    if (mine !== generation) return
  }
  if (read(shownSettings)?.provider === 'jira-orca') void loadJiraSites()
  if (reason !== 'poll') lastPolledProjectId = undefined
  // Only a ready list reports the Starts under way.
  if (answer.kind === 'ready') showStarting(answer.starting, askedAt)
  else showStarting([], 0)
  if (answer.kind === 'ready' && answer.worktrees) agentsReported(answer.project.id, answer.worktrees)
  worktreesShownAt = worktreesAskedAt
  set(list, answer)
  set(loading, false)
}

/** Asks the tracker for the listed project's tasks that match the trimmed `query`, and shows them
 *  in place of the loaded list, which stays as it is. The same tracker search run again keeps its
 *  results while it loads, as a reload keeps the list. A blank query asks nothing. An answer for
 *  another project or tracker means the list the tracker search narrowed is gone: the tracker
 *  search ends and the list is loaded again. */
async function searchTracker(query: string, reason: 'poll' | 'other' = 'other'): Promise<void> {
  if (query === '' || read(list)?.kind !== 'ready') return
  const mine = ++generation
  const before = read(trackerSearch)
  set(loading, true)
  set(loadingMore, false)
  set(moreError, null)
  if (before?.query !== query || before.kind !== 'ready') set(trackerSearch, { query, kind: 'loading' })
  let answer: TaskList
  let askedAt = 0
  let worktreesAskedAt = 0
  try {
    await flushSettings()
    askedAt = ++startClock
    worktreesAskedAt = ++worktreesClock
    answer = await plugin.request('tasks.load', { query }, { timeoutMs: LOAD_TIMEOUT_MS })
  } catch (error) {
    answer = { kind: 'error', project: null, message: `Kickoff's worker didn't answer (${errorCode(error)}). Reload to try again.` }
  }
  if (mine !== generation) return
  if (reason !== 'poll') lastPolledProjectId = undefined
  const current = read(list)
  if (current?.kind !== 'ready') return
  if (answer.kind === 'error' && (answer.project === null || answer.project.id === current.project.id)) {
    set(trackerSearch, { query, kind: 'error', message: answer.message })
    set(loading, false)
    return
  }
  if (answer.kind !== 'ready' || answer.project.id !== current.project.id || answer.provider !== current.provider) {
    set(trackerSearch, null)
    return load()
  }
  showStarting(answer.starting, askedAt)
  if (answer.worktrees) agentsReported(answer.project.id, answer.worktrees)
  worktreesShownAt = worktreesAskedAt
  set(list, { ...current, worktrees: answer.worktrees, worktreesError: answer.worktreesError, warning: answer.warning })
  set(trackerSearch, { query, kind: 'ready', tasks: answer.tasks, nextCursor: answer.nextCursor, truncated: answer.truncated })
  set(loading, false)
}

/** Goes back from the tracker search to the loaded list as it was, with the filter, dropping any
 *  answer still on its way. When a tracker search was loading, its answer may have said that the active
 *  project changed, so the list is loaded again. */
function leaveTrackerSearch(): void {
  if (read(trackerSearch) === null) return
  const wasLoading = read(loading)
  generation++
  set(trackerSearch, null)
  set(loading, false)
  set(loadingMore, false)
  set(moreError, null)
  if (wasLoading) void load()
}

/** "Clear search": back to the loaded list, with an empty field. */
function clearTrackerSearch(): void {
  leaveTrackerSearch()
  set(fieldText, '')
}

/** Typing in the field filters the loaded list, leaving a tracker search shown. */
function changeField(value: string): void {
  set(fieldText, value)
  leaveTrackerSearch()
}

/** Asks for the next page of the list, or of the tracker search shown, and appends its tasks,
 *  skipping keys already listed. A page that arrives after a reload or after the tracker search changed
 *  is dropped; one for another project means the project changed, so the list is loaded again.
 *  Pending settings are not saved first: the cursor belongs to the query that listed the first
 *  page, and a tracker search sends its words again with it. */
async function loadMore(): Promise<void> {
  const current = read(list)
  const found = read(trackerSearch)
  if (current?.kind !== 'ready' || read(loadingMore) || (found !== null && found.kind !== 'ready')) return
  const cursor = found ? found.nextCursor : current.nextCursor
  if (cursor === null) return
  const mine = generation
  set(loadingMore, true)
  set(moreError, null)
  let answer: TaskList
  try {
    answer = await plugin.request('tasks.load', found ? { cursor, query: found.query } : { cursor }, { timeoutMs: LOAD_TIMEOUT_MS })
  } catch (error) {
    answer = { kind: 'error', project: null, message: `Kickoff's worker didn't answer (${errorCode(error)}).` }
  }
  const shown = read(list)
  if (mine !== generation || shown?.kind !== 'ready') return
  set(loadingMore, false)
  if (answer.kind === 'error') {
    set(moreError, answer.message)
    return
  }
  if (answer.kind !== 'ready' || answer.project.id !== shown.project.id || answer.provider !== shown.provider) {
    set(trackerSearch, null)
    void load()
    return
  }
  const shownSearch = read(trackerSearch)
  if (shownSearch?.kind === 'ready') {
    set(trackerSearch, { ...shownSearch, tasks: appendTasks(shownSearch.tasks, answer.tasks), nextCursor: answer.nextCursor, truncated: answer.truncated })
  } else {
    set(list, { ...answer, tasks: appendTasks(shown.tasks, answer.tasks) })
  }
}

/** The listed project's id, when the list is ready. */
function readyProjectId(): string | null {
  const current = read(list)
  return current?.kind === 'ready' ? current.project.id : null
}

/** Reads the task worktrees again and puts them in the list, keeping its loaded pages. Answers
 *  the worktrees shown then, or null when they couldn't be read or the project changed meanwhile.
 *  An answer older than the worktrees shown changes nothing.
 *
 *  `runningStartsStay` keeps the cards of the Starts still running as they are, with their
 *  spinner: such a Start reads the worktrees itself when it ends. */
async function refreshWorktrees(
  projectId: string,
  { runningStartsStay = false } = {}
): Promise<Record<string, TaskWorktree> | null> {
  const askedAt = ++worktreesClock
  try {
    const answer = await plugin.request('worktrees.load', { projectId })
    const current = read(list)
    if (answer.kind !== 'ready' || current?.kind !== 'ready' || current.project.id !== projectId) return null
    if (askedAt < worktreesShownAt) return current.worktrees
    const worktrees = runningStartsStay ? withRunningStartsAsShown(answer.worktrees, current.worktrees) : answer.worktrees
    agentsReported(projectId, worktrees)
    worktreesShownAt = askedAt
    set(list, { ...current, worktrees, worktreesError: null })
    return worktrees
  } catch {
    return null
  }
}

/** The `fresh` worktrees, with those of the Starts still running as `shown` has them. A Start
 *  reading the worktrees for its end isn't running any more. */
function withRunningStartsAsShown(
  fresh: Record<string, TaskWorktree>,
  shown: Record<string, TaskWorktree> | null
): Record<string, TaskWorktree> {
  const worktrees = { ...fresh }
  for (const key of Object.keys(read(starting))) {
    if (ending.has(key)) continue
    const before = shown?.[key]
    if (before) worktrees[key] = before
    else delete worktrees[key]
  }
  return worktrees
}

/** Reads the worktrees again once workspaces stop being created or removed for a moment, and
 *  after any load under way, whose answer may predate them. */
function refreshWorktreesLater(): void {
  cancelWorktreesRefresh()
  workspacesTimer = setTimeout(() => {
    workspacesTimer = null
    if (read(loading)) return refreshWorktreesLater()
    const projectId = readyProjectId()
    if (projectId) void refreshWorktrees(projectId, { runningStartsStay: true })
  }, WORKSPACE_REFRESH_MS)
}

/** Cancels the pending read of `refreshWorktreesLater`, when the panel closes. */
function cancelWorktreesRefresh(): void {
  if (workspacesTimer !== null) clearTimeout(workspacesTimer)
  workspacesTimer = null
}

function setTaskError(key: string, message: string | null): void {
  update(taskErrors, (errors) => {
    const { [key]: _, ...rest } = errors
    return message === null ? rest : { ...rest, [key]: message }
  })
}

/** Shows the spinner on the tasks the worker reports under way in a report asked for at
 *  `askedAt`, on those whose `task.start` hasn't answered yet, and on those that went under way
 *  after the report was asked for. */
function showStarting(reported: string[], askedAt: number): void {
  for (const [key, since] of underWaySince) if (since < askedAt) underWaySince.delete(key)
  const keys = [...reported, ...requested, ...underWaySince.keys()]
  set(starting, Object.fromEntries(keys.map((key): [string, true] => [key, true])))
}

async function startTask(task: Task): Promise<void> {
  const projectId = readyProjectId()
  if (!projectId || read(starting)[task.key]) return
  requested.add(task.key)
  update(starting, (keys): Record<string, true> => ({ ...keys, [task.key]: true as const }))
  setTaskError(task.key, null)
  let answer: StartResult
  try {
    await flushSettings()
    const shown = await settingsShownFor(projectId)
    answer = shown.ok
      ? await plugin.request('task.start', { projectId, task, templateId: chosenTemplateId(shown.settings, task.key) }, { timeoutMs: START_TIMEOUT_MS })
      : shown
  } catch (thrown) {
    answer = { ok: false, message: `Kickoff's worker didn't answer (${errorCode(thrown)}). Reload the tasks to see whether ${task.key} started.` }
  }
  requested.delete(task.key)
  const early = endedEarly.get(task.key)
  endedEarly.delete(task.key)
  if (answer.ok && answer.underWay) {
    // The worker posts `start.ended` when the create ends.
    if (early) await endStart(early)
    else underWaySince.set(task.key, ++startClock)
    return
  }
  // The task already had its worktree: this Start launched no agent.
  await finishStart(projectId, task.key, answer.ok ? null : answer.message, null)
}

/** The listed project's settings as shown, read again when a load couldn't read them, or why they
 *  can't be read: a Start needs its template's id, and never falls back to another. */
async function settingsShownFor(projectId: string): Promise<{ ok: true; settings: ShownSettings } | { ok: false; message: string }> {
  const current = read(list)
  if (read(shownSettings)?.projectId !== projectId && current?.kind === 'ready' && current.project.id === projectId) {
    try {
      await showSettings(current.project)
    } catch (error) {
      return { ok: false, message: `Couldn't read the prompt templates of ${current.project.name} (${errorCode(error)}). Reload the tasks and try again.` }
    }
  }
  const settings = read(shownSettings)
  if (settings?.projectId !== projectId) return { ok: false, message: "Couldn't read the prompt templates of this project. Reload the tasks and try again." }
  return { ok: true, settings }
}

/** Asks the worker which Starts are under way, while a spinner shows for one this panel isn't
 *  asking about: a worker that restarted knows none, and posts no end. */
async function checkStarts(): Promise<void> {
  const projectId = readyProjectId()
  if (!projectId || !Object.keys(read(starting)).some((key) => !requested.has(key))) return
  const askedAt = ++startClock
  const answer = await plugin.request('starts.load', { projectId })
  if (readyProjectId() === projectId) showStarting(answer.starting, askedAt)
}

/** A Start's create ended in the worker. */
function onStartEnded(end: StartEnded): void {
  if (requested.has(end.taskKey)) endedEarly.set(end.taskKey, end)
  else void endStart(end)
}

async function endStart(end: StartEnded): Promise<void> {
  if (readyProjectId() !== end.projectId) return
  await finishStart(end.projectId, end.taskKey, end.ok ? null : end.message, end.agent)
}

/** Clears a Start's spinner once Orca's worktrees are read again, and shows its error unless the
 *  task now has a worktree: a Start that timed out may have finished.
 *
 *  A Start that passed an agent marks it as starting before that read, so no card draws the new
 *  worktree as having no agent. The read ends the mark when Orca already reports the agent
 *  (`agentsReported`), and so does a read that finds no worktree or a project that changed. A mark
 *  that is left gets one more read later. */
async function finishStart(projectId: string, key: string, error: string | null, agent: string | null): Promise<void> {
  if (agent !== null) update(agentStarting, (keys) => ({ ...keys, [key]: projectId }))
  ending.add(key)
  const worktrees = await refreshWorktrees(projectId)
  ending.delete(key)
  underWaySince.delete(key)
  update(starting, ({ [key]: _, ...rest }) => rest)
  const worktree = worktrees?.[key]
  const shown = readyProjectId() === projectId
  if (!shown || !worktree) stopAgentStarting(projectId, key)
  if (!shown) return
  setTaskError(key, worktree ? null : error)
  if (agent !== null && read(agentStarting)[key] === projectId) checkAgentLater(projectId, key)
}

/** Stops showing the task's agent as starting in the project. */
function stopAgentStarting(projectId: string, key: string): void {
  update(agentStarting, (keys) => {
    if (keys[key] !== projectId) return keys
    const { [key]: _, ...rest } = keys
    return rest
  })
}

/** Reads the worktrees again after a pause for a task whose agent shows as starting; from then on
 *  the card shows what Orca reports. */
function checkAgentLater(projectId: string, key: string): void {
  const earlier = agentChecks.get(key)
  if (earlier !== undefined) clearTimeout(earlier)
  agentChecks.set(
    key,
    setTimeout(() => {
      agentChecks.delete(key)
      void refreshWorktrees(projectId).finally(() => stopAgentStarting(projectId, key))
    }, AGENT_CHECK_MS)
  )
}

/** Stops showing as starting the agents of the project's tasks whose worktree Orca now reports
 *  running one. */
function agentsReported(projectId: string, worktrees: Record<string, TaskWorktree>): void {
  for (const key of Object.keys(read(agentStarting))) if (worktrees[key]?.agent) stopAgentStarting(projectId, key)
}

/** Cancels the pending reads of `checkAgentLater`, when the panel closes. */
function cancelAgentChecks(): void {
  for (const timer of agentChecks.values()) clearTimeout(timer)
  agentChecks.clear()
}

async function openWorktree(key: string, worktreeId: string): Promise<void> {
  setTaskError(key, null)
  try {
    const answer = await plugin.request('worktree.open', { worktreeId })
    if (!answer.ok) setTaskError(key, answer.message)
  } catch (error) {
    setTaskError(key, `Kickoff's worker didn't answer (${errorCode(error)}).`)
  }
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error'
}

/** The listed project's id, null when no project is selected, or undefined when the list says
 *  neither. */
function listedProjectId(): string | null | undefined {
  const current = read(list)
  if (current?.kind === 'no-project') return null
  return current && 'project' in current && current.project ? current.project.id : undefined
}

export function setup(ctx: PanelContext): void {
  let started = false
  const reload = () => {
    started = true
    void load()
  }
  // Orca sends the current context to each new subscriber; load now only if it hasn't yet.
  ctx.subscriptions.push(on('workspace.changed', reload))
  // Deleting a worktree other than the active one changes no focused workspace, so the panel
  // reads the task worktrees again when a workspace is created or removed.
  ctx.subscriptions.push(on('workspace.created', refreshWorktreesLater))
  ctx.subscriptions.push(on('workspace.removed', refreshWorktreesLater))
  ctx.subscriptions.push({ dispose: cancelWorktreesRefresh })
  ctx.subscriptions.push(plugin.on('start.ended', onStartEnded))
  ctx.subscriptions.push({ dispose: () => void flushSettings() })
  ctx.subscriptions.push({ dispose: cancelAgentChecks })

  // Orca sends no workspace.changed between two worktrees with the same branch and name, such
  // as two `main` worktrees of different projects, so the panel also asks while it is visible,
  // and not while a load is under way. An answer is measured against the last one, so a project
  // the list can't show reloads it once, not on every poll; after any other load it is measured
  // against the list.
  lastPolledProjectId = undefined
  set(agentStarting, {})
  set(cardTemplates, {})
  set(templateDraft, null)
  set(variablesOpen, false)
  set(settingsChoice, 'auto')
  viewStateFor = undefined
  set(fieldText, '')
  set(trackerSearch, null)
  // Closing the panel drops the template detail's draft.
  ctx.subscriptions.push({ dispose: closeTemplate })
  let polling = false
  const poll = async () => {
    if (polling || read(loading) || !read(ctx.visible)) return
    polling = true
    try {
      const answer = await plugin.request('project.active', {})
      if (!('projectId' in answer)) return
      const before = lastPolledProjectId === undefined ? listedProjectId() : lastPolledProjectId
      lastPolledProjectId = answer.projectId
      if (before !== undefined && answer.projectId !== before) void load('poll')
      else await checkStarts()
    } catch {
      // The worker didn't answer: the next poll asks again.
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => void poll(), POLL_MS)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  if (!started) reload()
}

export default function Panel() {
  const current = read(list)
  const project = current && 'project' in current ? current.project : null
  const draft = read(templateDraft)
  const shown = read(shownSettings)
  if (draft && shown?.projectId === draft.projectId) {
    return <TemplateDetail draft={draft} templates={shown.templates} projectName={project?.name ?? ''} />
  }
  const settings = project !== null && shown?.projectId === project.id ? shown : null
  const choice = read(settingsChoice)
  if (project && settings && (choice === 'auto' ? needsSettings(current) : choice === 'open')) {
    return <SettingsView projectName={project.name} shown={settings} />
  }
  // The panel fills its height, so a ready list's last part, the list, scrolls alone.
  return (
    <Box direction="column" gap="sm" height="100%">
      <Header projectName={project?.name ?? null} gear={settings !== null} />
      {current ? <Body list={current} /> : <Spinner label="Loading tasks" />}
    </Box>
  )
}

/** Whether Project settings opens by itself: the project has no tracker, or its load failed. */
const needsSettings = (current: TaskList | null) => current?.kind === 'needs-config' || current?.kind === 'error'

/** The panel's title, since its tab shows only its icon, and its actions. `gear` shows the button
 *  that opens Project settings. */
function Header({ projectName, gear }: { projectName: string | null; gear: boolean }) {
  return (
    <TitleRow prefix={projectName !== null ? 'Kickoff ·' : null} title={projectName ?? 'Kickoff'} level={2}>
      <Row gap="xs" align="center">
        {read(loading) && read(list) ? <Spinner label="Reloading tasks" labelHidden /> : null}
        <IconButton icon="refresh" label="Reload tasks" tooltip="Reload tasks" size="sm" variant="ghost" onPress={() => void load()} />
        {gear ? (
          <IconButton icon="settings" label="Project settings" tooltip="Project settings" size="sm" variant="ghost" onPress={() => set(settingsChoice, 'open')} />
        ) : null}
      </Row>
    </TitleRow>
  )
}

/** A view's title, after a muted `prefix` when there is one, with its actions on the right. */
function TitleRow({ prefix, title, level, children }: { prefix: string | null; title: string; level: 2 | 3; children?: OrcaNode }) {
  return (
    <Box direction="row" justify="between" align="center" gap="xs">
      <Box direction="row" align="center" gap="xs" grow minWidth={0}>
        {prefix !== null ? <Text muted>{prefix}</Text> : null}
        <Heading level={level}>{title}</Heading>
      </Box>
      {children}
    </Box>
  )
}

/** Project settings, in place of the panel view: the tracker, then what a Start uses. */
function SettingsView({ projectName, shown }: { projectName: string; shown: ShownSettings }) {
  return (
    <Stack gap="sm">
      <TitleRow prefix={`${projectName} ·`} title="Project settings" level={3}>
        <Button key="settings-done" size="sm" variant="solid" onPress={() => set(settingsChoice, 'closed')}>
          Done
        </Button>
      </TitleRow>
      <Text size="sm" weight="semibold">
        Tracker
      </Text>
      <TrackerFields shown={shown} />
      <Separator />
      <Text size="sm" weight="semibold">
        Start
      </Text>
      <StartFields shown={shown} />
    </Stack>
  )
}

function TrackerFields({ shown }: { shown: ShownSettings }) {
  const providerOptions = shown.provider === null ? [{ value: NO_TRACKER, label: 'Choose a tracker' }, ...PROVIDER_OPTIONS] : PROVIDER_OPTIONS
  return (
    <Stack gap="sm">
      <Select label="Tracker" labelHidden value={shown.provider ?? NO_TRACKER} options={providerOptions} onChange={chooseProviderFor} />
      {shown.provider === 'jira-orca' ? <JiraOrcaSettings providers={shown.providers} /> : null}
      {shown.provider === 'jira-twg' ? <JiraTwgSettings providers={shown.providers} /> : null}
    </Stack>
  )
}

function JiraOrcaSettings({ providers }: { providers: ProviderConfigs }) {
  const config = providerConfig({ providers }, 'jira-orca')
  const sites = read(jiraSites)
  const answered = sites !== null && sites !== 'loading' ? sites : null
  const connected = answered?.kind === 'ready' ? answered.sites : []
  const siteOptions = [{ value: DEFAULT_SITE, label: 'Default site' }, ...connected.map((site) => ({ value: site.id, label: site.name }))]
  if (config.siteId !== '' && !connected.some((site) => site.id === config.siteId)) {
    siteOptions.push({ value: config.siteId, label: config.siteId })
  }
  return (
    <Stack gap="sm">
      <JqlInput provider="jira-orca" jql={config.jql} />
      <Select
        label="Site"
        value={config.siteId || DEFAULT_SITE}
        options={siteOptions}
        onChange={(value) => {
          changeJiraConfig('jira-orca', { siteId: value === DEFAULT_SITE ? '' : value })
          loadKeepingSettingsOpen()
        }}
      />
      {answered?.kind === 'error' ? (
        <Text size="sm" tone="danger">
          {`Couldn't list Jira sites: ${answered.message}`}
        </Text>
      ) : null}
      <Text size="sm" muted>
        Kickoff reads Jira through the connection saved in Orca. Connect Jira in Orca's settings first if you haven't.
      </Text>
    </Stack>
  )
}

/** The JQL of a Jira provider. Enter lists the tasks with it. */
function JqlInput({ provider, jql }: { provider: JiraProviderId; jql: string }) {
  return (
    <Input
      label="JQL"
      value={jql}
      placeholder={DEFAULT_JQL}
      onChange={(value) => changeJiraConfig(provider, { jql: value })}
      onSubmit={loadKeepingSettingsOpen}
    />
  )
}

function JiraTwgSettings({ providers }: { providers: ProviderConfigs }) {
  const config = providerConfig({ providers }, 'jira-twg')
  return (
    <Stack gap="sm">
      <JqlInput provider="jira-twg" jql={config.jql} />
      <Input
        label="Site"
        value={config.site}
        placeholder="twg's default site"
        onChange={(site) => changeJiraConfig('jira-twg', { site })}
        onSubmit={loadKeepingSettingsOpen}
      />
      <Input
        label="Profile"
        value={config.profile}
        placeholder="twg's default profile"
        onChange={(profile) => changeJiraConfig('jira-twg', { profile })}
        onSubmit={loadKeepingSettingsOpen}
      />
      <Text size="sm" muted>
        Kickoff reads Jira through the Teamwork Graph CLI. Run `twg login` in a terminal first if you haven't. Leave Site and Profile empty to use twg's defaults.
      </Text>
    </Stack>
  )
}

/** The agent choice and the default template, with the buttons that edit it or add one, and its text. */
function StartFields({ shown }: { shown: ShownSettings }) {
  const agentOptions = AGENT_OPTIONS.some((option) => option.value === shown.agent)
    ? AGENT_OPTIONS
    : [...AGENT_OPTIONS, { value: shown.agent, label: shown.agent }]
  const text = shown.templates.find((template) => template.id === shown.defaultTemplateId)?.text ?? ''
  return (
    <Stack gap="sm">
      <Select label="Agent" value={shown.agent} options={agentOptions} onChange={(agent) => changeSettings({ agent })} />
      <Select
        label="Default template"
        value={shown.defaultTemplateId}
        options={templateOptions(shown.templates)}
        onChange={(defaultTemplateId) => changeSettings({ defaultTemplateId })}
      />
      <Box direction="row" justify="between" align="center" gap="xs">
        <Text size="sm" muted>
          Template text
        </Text>
        <Row gap="none" align="center">
          <IconButton icon="edit" label="Edit template" tooltip="Edit template" size="sm" variant="ghost" onPress={() => openTemplate(shown.defaultTemplateId)} />
          <IconButton icon="add" label="New template" tooltip="New template" size="sm" variant="ghost" onPress={() => openTemplate(null)} />
        </Row>
      </Box>
      {text === '' ? (
        <Text size="sm" muted>
          Empty: the prompt is the task URL.
        </Text>
      ) : (
        <CodeView code={text} wrap maxHeight="sm" />
      )}
    </Stack>
  )
}

function Body({ list }: { list: TaskList }) {
  switch (list.kind) {
    case 'no-project':
      return <EmptyState title="No project selected" description="Select a worktree in Orca to see its project's tasks." icon="folder" />
    case 'needs-config':
      return (
        <EmptyState
          title="No tracker for this project"
          description={`Choose a tracker in Project settings to list the tasks of ${list.project.name}.`}
          icon="settings"
        />
      )
    case 'error':
      return (
        <Callout tone="danger" title="Couldn't load tasks" icon="error">
          <Text>{list.message}</Text>
        </Callout>
      )
    case 'ready':
      return <ReadyList list={list} />
  }
}

type ReadyTaskList = Extract<TaskList, { kind: 'ready' }>

/** The tracker's name, as the panel says it. */
const trackerName = (provider: ProviderId) => (trackerOf(provider) === 'github' ? 'GitHub' : 'Jira')

/** The warnings, the field and the tracker search's title, which stay in place, then the list,
 *  which scrolls inside the rest of the panel's height: the loaded tasks that match the filter, or
 *  the tracker search's results, then "Load more" and the truncation notice. */
function ReadyList({ list }: { list: ReadyTaskList }) {
  const text = read(fieldText)
  const query = text.trim()
  const found = read(trackerSearch)
  const tracker = trackerName(list.provider)
  return (
    <>
      {list.warning ? (
        <Callout tone="warning" icon="warning">
          <Text>{list.warning}</Text>
        </Callout>
      ) : null}
      {list.worktrees === null ? (
        <Callout tone="warning" icon="warning">
          <Text>{`Couldn't read Orca's worktrees, so Start is off. ${list.worktreesError ?? ''}`.trim()}</Text>
        </Callout>
      ) : null}
      <Stack gap="xs">
        <Input
          type="search"
          label="Search tasks"
          labelHidden
          value={text}
          placeholder="Search key, title or label"
          onChange={changeField}
          onSubmit={(value) => void searchTracker(value.trim())}
        />
        {query !== '' ? (
          <Box direction="row" justify="between" align="center" gap="xs">
            <Box grow minWidth={0}>
              {found === null ? (
                <Text size="sm" muted>
                  {`Filtering ${list.tasks.length} loaded tasks · Enter searches ${tracker}`}
                </Text>
              ) : null}
            </Box>
            <Box shrink={false}>
              <Button key="tracker-search" size="sm" variant="outline" onPress={() => void searchTracker(query)}>
                {`Search in ${tracker}`}
              </Button>
            </Box>
          </Box>
        ) : null}
      </Stack>
      {found !== null ? (
        <Box direction="row" justify="between" align="center" gap="xs">
          <Box grow minWidth={0}>
            <Text size="sm" weight="semibold">{`Results in ${tracker} for "${found.query}"`}</Text>
          </Box>
          <Box shrink={false}>
            <Button key="clear-search" size="sm" variant="ghost" onPress={clearTrackerSearch}>
              Clear search
            </Button>
          </Box>
        </Box>
      ) : null}
      <Box direction="column" gap="xs" grow minHeight={0} maxHeight="100%" scroll="y">
        {found === null ? <LoadedTasks list={list} query={query} /> : <SearchResults found={found} list={list} tracker={tracker} />}
      </Box>
    </>
  )
}

/** The loaded tasks that match the filter, "Load more" and the truncation notice. */
function LoadedTasks({ list, query }: { list: ReadyTaskList; query: string }) {
  const tasks = list.tasks.filter((task) => matchesSearch(task, query))
  return (
    <>
      {list.tasks.length === 0 ? (
        <EmptyState title="No open tasks" icon="check" />
      ) : tasks.length === 0 ? (
        <Text size="sm" muted>
          {`No loaded task matches "${query}".`}
        </Text>
      ) : (
        tasks.map((task) => <TaskCard key={task.key} task={task} projectId={list.project.id} worktrees={list.worktrees} />)
      )}
      {list.nextCursor !== null ? <LoadMore count={list.tasks.length} /> : null}
      {list.truncated ? (
        <Text size="sm" muted>
          {list.provider === 'github' ? "Showing the first 100 of your repository's issues." : 'Showing the first 100 tasks — narrow your JQL.'}
        </Text>
      ) : null}
    </>
  )
}

/** A tracker search's results, unfiltered: a result may match on its description, which the
 *  filter doesn't read. Then "Load more" and the truncation notice. The cards show the worktrees
 *  of the loaded list, which every read of them keeps up to date. */
function SearchResults({ found, list, tracker }: { found: TrackerSearch; list: ReadyTaskList; tracker: string }) {
  switch (found.kind) {
    case 'loading':
      return <Spinner label={`Searching ${tracker}`} />
    case 'error':
      return (
        <Callout tone="danger" title="Couldn't load tasks" icon="error">
          <Text>{found.message}</Text>
        </Callout>
      )
    case 'ready':
      return (
        <>
          {found.tasks.length === 0 ? (
            <Text size="sm" muted>
              {`No task in ${tracker} matches "${found.query}".`}
            </Text>
          ) : (
            found.tasks.map((task) => <TaskCard key={task.key} task={task} projectId={list.project.id} worktrees={list.worktrees} />)
          )}
          {found.nextCursor !== null ? <LoadMore count={found.tasks.length} /> : null}
          {found.truncated ? (
            <Text size="sm" muted>
              Showing the first 100 results — refine your search
            </Text>
          ) : null}
        </>
      )
  }
}

/** A full-width button that says how many tasks are loaded, with the last failure above it. */
function LoadMore({ count }: { count: number }) {
  const error = read(moreError)
  const busy = read(loadingMore)
  return (
    <Stack gap="xs" align="stretch">
      {error ? (
        <Text size="sm" tone="danger">
          {`Couldn't load more tasks: ${error}`}
        </Text>
      ) : null}
      <Button key="load-more" size="sm" variant="outline" disabled={busy} onPress={() => void loadMore()}>
        {busy ? `Showing ${count} · Loading…` : `Showing ${count} · Load more`}
      </Button>
    </Stack>
  )
}

/** What the card says about its worktree's agent, or null while it has none and none is starting. */
function agentLine(worktree: TaskWorktree, agentStarting: boolean): string | null {
  if (worktree.agent) return `Agent: ${worktree.agent}`
  return agentStarting ? 'Agent starting…' : null
}

/** One row per part: the key and the whole title; the worktree, or the status and labels; the
 *  agent; the template and Start, while there is no worktree. */
function TaskCard({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  // Every GitHub task is open, so its status says nothing.
  const status = task.tracker !== 'github' ? task.status : null
  const worktree = worktrees?.[task.key] ?? null
  const isStarting = worktree === null && read(starting)[task.key] === true
  const error = read(taskErrors)[task.key]
  const agent = worktree ? agentLine(worktree, read(agentStarting)[task.key] === projectId) : null
  return (
    <Box border radius="md" padding="sm" direction="column" gap="sm" shrink={false}>
      <Text>
        <Link href={task.url}>{task.key}</Link> {task.title}
      </Text>
      {worktree ? (
        <Text size="sm" truncate>
          <Link onPress={() => void openWorktree(task.key, worktree.worktreeId)}>{worktree.name}</Link>
        </Text>
      ) : status || task.labels.length > 0 ? (
        <Box direction="row" wrap gap="xs" align="center">
          {status ? <Badge tone="accent">{status}</Badge> : null}
          {task.labels.map((label) => (
            <Badge key={label}>{label}</Badge>
          ))}
        </Box>
      ) : null}
      {agent !== null ? (
        <Text size="sm" muted>
          {agent}
        </Text>
      ) : null}
      {worktree ? null : isStarting ? (
        <Spinner label={`Starting ${task.key}`} />
      ) : (
        <Box direction="row" align="center" justify="end" gap="xs">
          <CardTemplate task={task} projectId={projectId} />
          <Box shrink={false}>
            <IconButton
              key={`start:${task.key}`}
              icon="play"
              variant="outline"
              label={`Start ${task.key}`}
              tooltip="Start"
              disabled={worktrees === null}
              onPress={() => void startTask(task)}
            />
          </Box>
        </Box>
      )}
      {isStarting ? (
        <Text size="sm" muted>
          Creating the worktree can take a minute.
        </Text>
      ) : null}
      {error ? (
        <Text size="sm" tone="danger">
          {error}
        </Text>
      ) : null}
    </Box>
  )
}

/** The card's template `Select`, filling the Start row; only when the project has two or more
 *  templates. */
function CardTemplate({ task, projectId }: { task: Task; projectId: string }) {
  const shown = read(shownSettings)
  if (shown?.projectId !== projectId || shown.templates.length < 2) return null
  return (
    <Box grow minWidth={0}>
      <Select
        label={`Template for ${task.key}`}
        labelHidden
        value={chosenTemplateId(shown, task.key)}
        options={templateOptions(shown.templates)}
        onChange={(id) => update(cardTemplates, (chosen) => ({ ...chosen, [cardKey(projectId, task.key)]: id }))}
      />
    </Box>
  )
}

/** The template detail, in place of the panel view. The title row with Cancel and Save, and the
 *  Delete bar, stay in place while the form between them scrolls. */
function TemplateDetail({ draft, templates, projectName }: { draft: TemplateDraft; templates: PromptTemplate[]; projectName: string }) {
  const nameProblem = templateNameProblem(templates, draft.name, draft.id)
  return (
    <Box direction="column" gap="sm" height="100%">
      <TitleRow prefix={projectName !== '' ? `${projectName} ·` : null} title={draft.isNew ? 'New template' : 'Edit template'} level={3}>
        <Row gap="xs" align="center">
          {draft.saving ? <Spinner label="Saving the template" labelHidden /> : null}
          <Button key="template-cancel" size="sm" variant="ghost" disabled={draft.saving} onPress={closeTemplate}>
            Cancel
          </Button>
          <Button key="template-save" size="sm" variant="solid" disabled={nameProblem !== null || draft.saving} onPress={() => void saveTemplate()}>
            Save
          </Button>
        </Row>
      </TitleRow>
      <Box direction="column" gap="sm" grow minHeight={0} maxHeight="100%" scroll="y">
        <Stack gap="xs">
          <Input label="Name" value={draft.name} invalid={nameProblem !== null} onChange={(name) => changeDraft(draft, { name })} />
          {nameProblem !== null ? (
            <Text size="sm" tone="danger">
              {nameProblem}
            </Text>
          ) : null}
        </Stack>
        <Stack gap="xs">
          <Textarea
            label="Text"
            value={draft.text}
            rows={12}
            placeholder="Empty: the prompt is the task URL"
            onChange={(text) => changeDraft(draft, { text })}
          />
          <Text size="sm" muted>
            An empty text gives the task URL.
          </Text>
        </Stack>
        <Collapsible title="Variables" open={read(variablesOpen)} onChange={(open) => set(variablesOpen, open)}>
          <Stack gap="xs">
            {TEMPLATE_VARIABLES.map((name) => (
              <Text key={name} size="sm">
                <Code>{`{{${name}}}`}</Code> {TEMPLATE_VARIABLE_DESCRIPTIONS[name]}
              </Text>
            ))}
          </Stack>
        </Collapsible>
        {draft.error !== null ? (
          <Callout tone="danger" icon="error">
            <Text>{draft.error}</Text>
          </Callout>
        ) : null}
        <Callout icon="info" title="Run a skill">
          <Text size="sm">
            {'To run a Claude Code skill, start the template with its command, for example `/tdd {{task_key}}`: the rest of the template becomes its arguments. The new worktree must see the skill, so install plugins with user scope, not local, and commit project skills. Other agents have their own syntax.'}
          </Text>
        </Callout>
      </Box>
      {draft.isNew ? null : (
        <Box direction="row" justify="end" align="center" shrink={false}>
          <Button
            key="template-delete"
            size="sm"
            variant="ghost"
            tone="danger"
            icon="delete"
            disabled={templates.length < 2 || draft.saving}
            onPress={() => void deleteTemplate()}
          >
            {draft.confirmingDelete ? 'Confirm delete' : 'Delete template'}
          </Button>
        </Box>
      )}
    </Box>
  )
}
