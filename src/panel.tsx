// PROTOTYPE (issue #46), throwaway, on the prototype/panel-ui branch, never merged. Two switches at
// the top of the panel pick a Project settings layout (S-A sections, S-B tabs, S-C separate view)
// and a task list layout (L-A compact cards, L-B grouped by state, L-C table with an action bar,
// L-D roomy cards with one row per part, L-E the same with an icon-only Start).
// The data, the loads and Start are the real ones; only the drawing changes per variant.
//
// Kickoff's side panel: the active project's tracker, its open tasks, its Start options, and Start. No build
// step: Orca strips the types and compiles the JSX when the panel loads. The worker does the work;
// the panel asks it and draws the answers.
import {
  Badge,
  Box,
  Button,
  Callout,
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
  Tab,
  Table,
  Tabs,
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
import {
  defaultTemplate,
  INITIAL_TEMPLATE_TEXT,
  projectTemplates,
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
/** Start options save themselves after this pause. */
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
/** The tracker settings and Start options of the listed project, as the person sees them. */
const shownSettings = atom<ShownSettings | null>(null)
/** PROTOTYPE: the two variant switches. */
type SettingsVariant = 'S-A' | 'S-B' | 'S-C'
type ListVariant = 'L-A' | 'L-B' | 'L-C' | 'L-D' | 'L-E'
const SETTINGS_VARIANTS = [
  { value: 'S-A', label: 'S-A · sections' },
  { value: 'S-B', label: 'S-B · tabs' },
  { value: 'S-C', label: 'S-C · separate view' }
]
const LIST_VARIANTS = [
  { value: 'L-A', label: 'L-A · compact cards' },
  { value: 'L-B', label: 'L-B · grouped by state' },
  { value: 'L-C', label: 'L-C · table' },
  { value: 'L-D', label: 'L-D · roomy cards' },
  { value: 'L-E', label: 'L-E · roomy, icon Start' }
]
const settingsVariant = atom<SettingsVariant>('protoSettingsVariant', 'S-A', { persist: 'plugin' })
const listVariant = atom<ListVariant>('protoListVariant', 'L-A', { persist: 'plugin' })

/** Whether the person left Project settings open (S-A, S-B); it is always open while the project
 *  has no tracker or the load failed. */
const settingsOpen = atom('projectSettingsOpen', false, { persist: 'plugin' })
/** The tab shown in S-B. */
const settingsTab = atom('projectSettingsTab', 'tracker', { persist: 'plugin' })
/** S-C: the settings view replaces the panel view. null follows the list: shown while the project
 *  has no tracker or the load failed. Persisted only so a scenario can shoot it. */
const settingsView = atom<boolean | null>('protoSettingsView', null, { persist: 'plugin' })
/** The search over the loaded tasks. Kept in memory, cleared when the active project changes. */
const search = atom('')
/** L-C: the selected row's task key. */
const selectedTask = atom<string | null>(null)
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

/** Opens the template detail for one of the shown project's templates, or for a new one. */
function openTemplate(id: string | null): void {
  const shown = read(shownSettings)
  if (!shown) return
  const template = id === null ? null : shown.templates.find((candidate) => candidate.id === id)
  if (id !== null && !template) return
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
 *  keeps the detail open with its error and the draft. Pending Start options are saved first, so
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
  set(settingsOpen, true)
  const chosen = chooseProvider({ providers: current.providers }, provider)
  changeSettings({ provider, providers: { [provider]: chosen.providers[provider] } })
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

/** Lists the active project's tasks. `poll` says the poll asked for it, so the poll's last answer
 *  stays the measure for the next one. */
async function load(reason: 'poll' | 'other' = 'other'): Promise<void> {
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
  // A change of active project clears the search and the selected row.
  const before = listedProjectId()
  if (answeredProjectId !== undefined && before !== undefined && answeredProjectId !== before) {
    set(search, '')
    set(selectedTask, null)
    set(settingsView, null)
  }
  set(list, answer)
  set(loading, false)
}

/** Asks for the next page and appends its tasks, skipping keys already listed. A page that
 *  arrives after a reload is dropped; one for another project means the project changed, so the
 *  list is loaded again. Pending settings are not saved first: the cursor belongs to the query
 *  that listed the first page. */
async function loadMore(): Promise<void> {
  const current = read(list)
  if (current?.kind !== 'ready' || current.nextCursor === null || read(loadingMore)) return
  const mine = generation
  set(loadingMore, true)
  set(moreError, null)
  let answer: TaskList
  try {
    answer = await plugin.request('tasks.load', { cursor: current.nextCursor }, { timeoutMs: LOAD_TIMEOUT_MS })
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
    void load()
    return
  }
  set(list, { ...answer, tasks: appendTasks(shown.tasks, answer.tasks) })
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
    return (
      <Stack gap="sm">
        <PrototypeBar />
        <TemplateDetail draft={draft} templates={shown.templates} projectName={project?.name ?? ''} />
      </Stack>
    )
  }
  const variant = read(settingsVariant)
  const attention = needsAttention(current)
  if (variant === 'S-C' && project && shown && (read(settingsView) ?? attention)) {
    return (
      <Stack gap="sm">
        <PrototypeBar />
        <SettingsView projectName={project.name} />
      </Stack>
    )
  }
  return (
    <ScrollFrame>
      <PrototypeBar />
      <Header projectName={project?.name ?? null} gear={variant === 'S-C' && project !== null && shown !== null} />
      {project && variant !== 'S-C' ? <SettingsCollapsible tabs={variant === 'S-B'} attention={attention} /> : null}
      {current ? <Body list={current} /> : <Spinner label="Loading tasks" />}
    </ScrollFrame>
  )
}

/** PROTOTYPE: the frame that should let only the list scroll. Whether `height: '100%'` reaches the
 *  panel's height is what issue #46 asks to find out. */
function ScrollFrame({ children }: { children?: OrcaNode }) {
  return read(scrollMode) === 'list-max-only' ? (
    <Stack gap="sm">{children}</Stack>
  ) : (
    <Box direction="column" gap="sm" height="100%">
      {children}
    </Box>
  )
}

/** PROTOTYPE: how the list's scroll area is sized, to find out what fills the panel. The third
 *  switch, only for this experiment. `frame`: the panel's frame has `height: '100%'` and the list
 *  `grow` with `maxHeight: '100%'`. `list-max-only`: no frame height, the list `maxHeight: '100%'`.
 *  `list-height`: frame `height: '100%'`, the list `height: '100%'`. */
type ScrollMode = 'frame' | 'list-max-only' | 'list-height'
const SCROLL_MODES = [
  { value: 'frame', label: 'frame 100% + list max 100%' },
  { value: 'list-max-only', label: 'list max 100% only' },
  { value: 'list-height', label: 'frame 100% + list height 100%' }
]
const scrollMode = atom<ScrollMode>('protoScrollMode', 'frame', { persist: 'plugin' })

/** The list's scroll area in the current `scrollMode`. */
function ScrollArea({ children }: { children?: OrcaNode }) {
  const mode = read(scrollMode)
  if (mode === 'list-height') {
    return (
      <Box direction="column" gap="xs" height="100%" scroll="y">
        {children}
      </Box>
    )
  }
  return (
    <Box direction="column" gap="xs" grow={mode === 'frame'} minHeight={0} maxHeight="100%" scroll="y">
      {children}
    </Box>
  )
}

/** Whether Project settings opens by itself: the project has no tracker, or the load failed. */
const needsAttention = (current: TaskList | null) => current?.kind === 'needs-config' || current?.kind === 'error'

/** PROTOTYPE: the two variant switches. */
function PrototypeBar() {
  return (
    <Box border="warning" radius="sm" padding="xs" columns={2} gap="xs">
      <Select
        label="PROTOTYPE · settings"
        value={read(settingsVariant)}
        options={SETTINGS_VARIANTS}
        onChange={(value) => set(settingsVariant, value as SettingsVariant)}
      />
      <Select label="PROTOTYPE · list" value={read(listVariant)} options={LIST_VARIANTS} onChange={(value) => set(listVariant, value as ListVariant)} />
      <Select label="PROTOTYPE · scroll" value={read(scrollMode)} options={SCROLL_MODES} onChange={(value) => set(scrollMode, value as ScrollMode)} />
    </Box>
  )
}

function Header({ projectName, gear }: { projectName: string | null; gear: boolean }) {
  const busy = read(loading)
  return (
    <Box direction="row" justify="between" align="center" gap="xs">
      <Box direction="row" align="center" gap="xs" grow minWidth={0}>
        {projectName ? (
          <>
            <Text muted>Kickoff ·</Text>
            <Heading level={2}>{projectName}</Heading>
          </>
        ) : (
          <Heading level={2}>Kickoff</Heading>
        )}
      </Box>
      <Row gap="xs" align="center">
        {busy && read(list) ? <Spinner label="Reloading tasks" labelHidden /> : null}
        <IconButton icon="refresh" label="Reload tasks" tooltip="Reload tasks" size="sm" variant="ghost" onPress={() => void load()} />
        {gear ? (
          <IconButton icon="settings" label="Project settings" tooltip="Project settings" size="sm" variant="ghost" onPress={() => set(settingsView, true)} />
        ) : null}
      </Row>
    </Box>
  )
}

/** One line that says what the closed Project settings hold. */
function settingsSummary(shown: ShownSettings): string {
  const tracker = PROVIDER_OPTIONS.find((option) => option.value === shown.provider)?.label ?? 'No tracker'
  const agent = AGENT_OPTIONS.find((option) => option.value === shown.agent)?.label ?? shown.agent
  const template = shown.templates.find((candidate) => candidate.id === shown.defaultTemplateId)?.name ?? ''
  return `${tracker} · ${agent} · ${template}`
}

/** S-A (sections) and S-B (tabs). */
function SettingsCollapsible({ tabs, attention }: { tabs: boolean; attention: boolean }) {
  const shown = read(shownSettings)
  if (!shown) return null
  return (
    <Collapsible
      title="Project settings"
      description={settingsSummary(shown)}
      open={attention || read(settingsOpen)}
      onChange={(open) => set(settingsOpen, open)}
    >
      {tabs ? (
        <Tabs label="Project settings" value={read(settingsTab)} onChange={(value) => set(settingsTab, value)}>
          <Tab value="tracker" label="Tracker">
            <TrackerFields paired={false} titled={false} />
          </Tab>
          <Tab value="start" label="Start">
            <StartFields paired={false} />
          </Tab>
        </Tabs>
      ) : (
        <Stack gap="sm">
          <Text size="sm" weight="semibold">
            Tracker
          </Text>
          <TrackerFields paired />
          <Separator />
          <Text size="sm" weight="semibold">
            Start
          </Text>
          <StartFields paired />
        </Stack>
      )}
    </Collapsible>
  )
}

/** S-C: the settings replace the panel view. */
function SettingsView({ projectName }: { projectName: string }) {
  return (
    <Stack gap="sm">
      <Box direction="row" justify="between" align="center" gap="xs">
        <Box direction="row" align="center" gap="xs" grow minWidth={0}>
          <Text muted>{`${projectName} ·`}</Text>
          <Heading level={3}>Project settings</Heading>
        </Box>
        <Button key="settings-done" size="sm" variant="ghost" icon="close" onPress={() => set(settingsView, false)}>
          Done
        </Button>
      </Box>
      <Text size="sm" weight="semibold">
        Tracker
      </Text>
      <TrackerFields paired={false} />
      <Separator />
      <Text size="sm" weight="semibold">
        Start
      </Text>
      <StartFields paired={false} />
    </Stack>
  )
}

/** Two fields side by side, or one under the other. */
function Pair({ paired, children }: { paired: boolean; children?: OrcaNode }) {
  return paired ? (
    <Box columns={2} gap="xs">
      {children}
    </Box>
  ) : (
    <Stack gap="sm">{children}</Stack>
  )
}

function TrackerFields({ paired, titled = true }: { paired: boolean; titled?: boolean }) {
  const shown = read(shownSettings)
  if (!shown) return null
  const providerOptions = shown.provider === null ? [{ value: NO_TRACKER, label: 'Choose a tracker' }, ...PROVIDER_OPTIONS] : PROVIDER_OPTIONS
  return (
    <Stack gap="sm">
      <Select label="Tracker" labelHidden={titled} value={shown.provider ?? NO_TRACKER} options={providerOptions} onChange={chooseProviderFor} />
      {shown.provider === 'jira-orca' ? <JiraOrcaSettings providers={shown.providers} /> : null}
      {shown.provider === 'jira-twg' ? <JiraTwgSettings providers={shown.providers} paired={paired} /> : null}
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
          void load()
        }}
      />
      {answered?.kind === 'error' ? (
        <Text size="sm" tone="danger">
          {`Couldn't list Jira sites: ${answered.message}`}
        </Text>
      ) : null}
      <Text size="sm" muted>
        Reads Jira through the connection saved in Orca's settings.
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
      onSubmit={() => void load()}
    />
  )
}

function JiraTwgSettings({ providers, paired }: { providers: ProviderConfigs; paired: boolean }) {
  const config = providerConfig({ providers }, 'jira-twg')
  return (
    <Stack gap="sm">
      <JqlInput provider="jira-twg" jql={config.jql} />
      <Pair paired={paired}>
        <Input
          label="Site"
          value={config.site}
          placeholder="twg's default"
          onChange={(site) => changeJiraConfig('jira-twg', { site })}
          onSubmit={() => void load()}
        />
        <Input
          label="Profile"
          value={config.profile}
          placeholder="twg's default"
          onChange={(profile) => changeJiraConfig('jira-twg', { profile })}
          onSubmit={() => void load()}
        />
      </Pair>
      <Text size="sm" muted>
        Reads Jira through the twg CLI. Run `twg login` first if you haven't.
      </Text>
    </Stack>
  )
}

function StartFields({ paired }: { paired: boolean }) {
  const shown = read(shownSettings)
  if (!shown) return null
  const agentOptions = AGENT_OPTIONS.some((option) => option.value === shown.agent)
    ? AGENT_OPTIONS
    : [...AGENT_OPTIONS, { value: shown.agent, label: shown.agent }]
  const text = shown.templates.find((template) => template.id === shown.defaultTemplateId)?.text ?? ''
  return (
    <Stack gap="sm">
      <Pair paired={paired}>
        <Select label="Agent" value={shown.agent} options={agentOptions} onChange={(agent) => changeSettings({ agent })} />
        <Select
          label="Default template"
          value={shown.defaultTemplateId}
          options={templateOptions(shown.templates)}
          onChange={(defaultTemplateId) => changeSettings({ defaultTemplateId })}
        />
      </Pair>
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

/** Whether the task's key, title or a label holds the query, ignoring case. */
function matchesSearch(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [task.key, task.title, ...task.labels].some((text) => text.toLowerCase().includes(q))
}

function ReadyList({ list }: { list: ReadyTaskList }) {
  const query = read(search)
  const tasks = list.tasks.filter((task) => matchesSearch(task, query))
  const variant = read(listVariant)
  return (
    <>
      <Stack gap="xs">
        <Input type="search" label="Search tasks" labelHidden value={query} placeholder="Search key, title or label" onChange={(value) => set(search, value)} />
        {list.nextCursor !== null ? (
          <Text size="sm" muted>
            {`Filtering ${list.tasks.length} loaded tasks`}
          </Text>
        ) : null}
      </Stack>
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
      {variant === 'L-C' ? <TaskTable list={list} tasks={tasks} /> : <ScrollList list={list} tasks={tasks} variant={variant} />}
    </>
  )
}

/** L-A, L-B, L-D and L-E: the list scrolls inside a `Box`. */
function ScrollList({ list, tasks, variant }: { list: ReadyTaskList; tasks: Task[]; variant: ListVariant }) {
  const query = read(search)
  return (
    <ScrollArea>
      {list.tasks.length === 0 ? (
        <EmptyState title="No open tasks" icon="check" />
      ) : variant === 'L-B' ? (
        <Grouped list={list} tasks={tasks} />
      ) : tasks.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        tasks.map((task) =>
          variant === 'L-D' || variant === 'L-E' ? (
            <RoomyCard key={task.key} task={task} projectId={list.project.id} worktrees={list.worktrees} iconStart={variant === 'L-E'} />
          ) : (
            <CompactCard key={task.key} task={task} projectId={list.project.id} worktrees={list.worktrees} />
          )
        )
      )}
      {list.nextCursor !== null ? <LoadMore count={list.tasks.length} /> : null}
      {list.truncated ? <Truncated list={list} /> : null}
    </ScrollArea>
  )
}

function NoMatch({ query }: { query: string }) {
  return (
    <Text size="sm" muted>
      {`No loaded task matches "${query.trim()}".`}
    </Text>
  )
}

function Truncated({ list }: { list: ReadyTaskList }) {
  return (
    <Text size="sm" muted>
      {list.provider === 'github' ? "Showing the first 100 of your repository's issues." : 'Showing the first 100 tasks — narrow your JQL.'}
    </Text>
  )
}

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

/** What the card says about its worktree's agent. */
function agentLine(worktree: TaskWorktree, agentStarting: boolean): string {
  if (worktree.agent) return `Agent: ${worktree.agent}`
  return agentStarting ? 'Agent starting…' : 'No agent running'
}

/** Status and labels on one line. Every GitHub task is open, so its status says nothing. */
function taskMeta(task: Task): string {
  const status = task.tracker !== 'github' ? task.status : null
  return [status, ...task.labels].filter((part): part is string => !!part).join(' · ')
}

/** What a card or the action bar needs to know about a task. */
function taskState(task: Task, projectId: string, worktrees: Record<string, TaskWorktree> | null) {
  const worktree = worktrees?.[task.key] ?? null
  const shown = read(shownSettings)
  return {
    worktree,
    isStarting: worktree === null && read(starting)[task.key] === true,
    error: read(taskErrors)[task.key] as string | undefined,
    agentStarting: read(agentStarting)[task.key] === projectId,
    settings: shown?.projectId === projectId ? shown : null
  }
}

/** The template `Select` of a card, with a width of its own; only with two or more templates. */
function CardTemplate({ task, projectId, width = 128 }: { task: Task; projectId: string; width?: number | 'grow' }) {
  const shown = read(shownSettings)
  if (shown?.projectId !== projectId || shown.templates.length < 2) return null
  const size = width === 'grow' ? { grow: true, minWidth: 0 } : { width, shrink: false }
  return (
    <Box {...size}>
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

function StartButton({ task, worktrees, size = 'sm' }: { task: Task; worktrees: Record<string, TaskWorktree> | null; size?: 'xs' | 'sm' }) {
  return (
    <Button key={`start:${task.key}`} size={size} icon="play" disabled={worktrees === null} onPress={() => void startTask(task)}>
      Start
    </Button>
  )
}

function TaskNotes({ isStarting, error }: { isStarting: boolean; error: string | undefined }) {
  return (
    <>
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
    </>
  )
}

/** L-A: the truncated title on the first row; meta, template and Start on the second. */
function CompactCard({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  const { worktree, isStarting, error, agentStarting: agentIsStarting } = taskState(task, projectId, worktrees)
  return (
    <Box border radius="md" paddingX="sm" paddingY="xs" direction="column" gap="xs" shrink={false}>
      <Text truncate>
        <Link href={task.url}>{task.key}</Link> {task.title}
      </Text>
      <Box direction="row" align="center" gap="xs">
        <Box grow minWidth={0}>
          {worktree ? (
            <Text size="sm" truncate>
              <Link onPress={() => void openWorktree(task.key, worktree.worktreeId)}>{worktree.name}</Link>
              {` · ${agentLine(worktree, agentIsStarting)}`}
            </Text>
          ) : (
            <Text size="sm" muted truncate>
              {taskMeta(task)}
            </Text>
          )}
        </Box>
        {worktree ? null : isStarting ? (
          <Spinner label={`Starting ${task.key}`} labelHidden />
        ) : (
          <>
            <CardTemplate task={task} projectId={projectId} />
            <Box shrink={false}>
              <StartButton task={task} worktrees={worktrees} />
            </Box>
          </>
        )}
      </Box>
      <TaskNotes isStarting={isStarting} error={error} />
    </Box>
  )
}

/** L-D: one row per part. The key and the whole title; the worktree, or the status and labels as
 *  badges; the agent, when the worktree has one; the template and Start, while there is no worktree.
 *  L-E: Start is an icon-only button. */
function RoomyCard({
  task,
  projectId,
  worktrees,
  iconStart
}: {
  task: Task
  projectId: string
  worktrees: Record<string, TaskWorktree> | null
  iconStart: boolean
}) {
  const { worktree, isStarting, error, agentStarting: agentIsStarting } = taskState(task, projectId, worktrees)
  const status = task.tracker !== 'github' ? task.status : null
  const agent = worktree?.agent ? `Agent: ${worktree.agent}` : worktree && agentIsStarting ? 'Agent starting…' : null
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
      {agent ? (
        <Text size="sm" muted>
          {agent}
        </Text>
      ) : null}
      {worktree ? null : isStarting ? (
        <Spinner label={`Starting ${task.key}`} />
      ) : (
        <Box direction="row" align="center" justify="end" gap="xs">
          <CardTemplate task={task} projectId={projectId} width="grow" />
          <Box shrink={false}>
            {iconStart ? (
              <IconButton
                key={`start:${task.key}`}
                icon="play"
                variant="outline"
                label={`Start ${task.key}`}
                tooltip="Start"
                disabled={worktrees === null}
                onPress={() => void startTask(task)}
              />
            ) : (
              <StartButton task={task} worktrees={worktrees} />
            )}
          </Box>
        </Box>
      )}
      <TaskNotes isStarting={isStarting} error={error} />
    </Box>
  )
}

/** L-B: "In progress" (task worktrees and Starts under way) above "To start". */
function Grouped({ list, tasks }: { list: ReadyTaskList; tasks: Task[] }) {
  const query = read(search)
  const projectId = list.project.id
  const isUnderWay = (task: Task) => !!list.worktrees?.[task.key] || read(starting)[task.key] === true
  const inProgress = tasks.filter(isUnderWay)
  const toStart = tasks.filter((task) => !isUnderWay(task))
  // Task worktrees whose task isn't loaded yet still show, by key.
  const loaded = new Set(list.tasks.map((task) => task.key))
  const unloaded = Object.entries(list.worktrees ?? {}).filter(
    ([key, worktree]) => !loaded.has(key) && matchesSearch({ key, title: worktree.name, labels: [] } as unknown as Task, query)
  )
  return (
    <>
      <GroupTitle title="In progress" count={inProgress.length + unloaded.length} />
      {inProgress.length + unloaded.length === 0 ? (
        <Text size="sm" muted>
          {query.trim() === '' ? 'No task worktrees yet.' : 'None matches.'}
        </Text>
      ) : null}
      {inProgress.map((task) => (
        <InProgressRow key={task.key} task={task} projectId={projectId} worktrees={list.worktrees} />
      ))}
      {unloaded.map(([key, worktree]) => (
        <Box key={key} border radius="md" paddingX="sm" paddingY="xs" direction="column" gap="xs" shrink={false}>
          <Text truncate>{key}</Text>
          <Text size="sm" truncate>
            <Link onPress={() => void openWorktree(key, worktree.worktreeId)}>{worktree.name}</Link>
            {` · ${agentLine(worktree, read(agentStarting)[key] === projectId)}`}
          </Text>
        </Box>
      ))}
      <Separator />
      <GroupTitle title="To start" count={toStart.length} />
      {toStart.length === 0 && query.trim() !== '' ? <NoMatch query={query} /> : null}
      {toStart.map((task) => (
        <ToStartRow key={task.key} task={task} projectId={projectId} worktrees={list.worktrees} />
      ))}
    </>
  )
}

function GroupTitle({ title, count }: { title: string; count: number }) {
  return (
    <Text size="sm" weight="semibold">
      {`${title} · ${count}`}
    </Text>
  )
}

function InProgressRow({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  const { worktree, isStarting, error, agentStarting: agentIsStarting } = taskState(task, projectId, worktrees)
  return (
    <Box border="accent" radius="md" paddingX="sm" paddingY="xs" direction="column" gap="xs" shrink={false}>
      <Box direction="row" align="center" gap="xs">
        <Box grow minWidth={0}>
          <Text truncate>
            <Link href={task.url}>{task.key}</Link> {task.title}
          </Text>
        </Box>
        {isStarting ? <Spinner label={`Starting ${task.key}`} labelHidden /> : null}
        {worktree ? (
          <Box shrink={false}>
            <Button key={`open:${task.key}`} size="xs" variant="outline" onPress={() => void openWorktree(task.key, worktree.worktreeId)}>
              Open
            </Button>
          </Box>
        ) : null}
      </Box>
      {worktree ? (
        <Text size="sm" muted truncate>
          {`${worktree.name} · ${agentLine(worktree, agentIsStarting)}`}
        </Text>
      ) : null}
      <TaskNotes isStarting={isStarting} error={error} />
    </Box>
  )
}

function ToStartRow({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  const { error } = taskState(task, projectId, worktrees)
  return (
    <Box border radius="md" paddingX="sm" paddingY="xs" direction="column" gap="xs" shrink={false}>
      <Box direction="row" align="center" gap="xs">
        <Box grow minWidth={0} direction="column">
          <Text truncate>
            <Link href={task.url}>{task.key}</Link> {task.title}
          </Text>
          <Text size="xs" muted truncate>
            {taskMeta(task)}
          </Text>
        </Box>
        <Box shrink={false}>
          <IconButton icon="play" label={`Start ${task.key}`} tooltip="Start" size="sm" variant="outline" disabled={worktrees === null} onPress={() => void startTask(task)} />
        </Box>
      </Box>
      <CardTemplate task={task} projectId={projectId} width={160} />
      <TaskNotes isStarting={false} error={error} />
    </Box>
  )
}

/** L-C: a table, and an action bar above it for the selected row. */
function TaskTable({ list, tasks }: { list: ReadyTaskList; tasks: Task[] }) {
  const selectedKey = read(selectedTask)
  const selected = list.tasks.find((task) => task.key === selectedKey) ?? null
  const startingKeys = read(starting)
  const rows = tasks.map((task) => {
    const worktree = list.worktrees?.[task.key]
    return {
      key: task.key,
      cells: {
        key: task.key,
        title: task.title,
        status: task.tracker !== 'github' ? task.status : null,
        worktree: worktree ? worktree.name : startingKeys[task.key] ? 'Starting…' : null
      }
    }
  })
  return (
    <>
      <ActionBar task={selected} list={list} />
      <Table
        label="Tasks"
        columns={[
          { key: 'key', label: 'Key', width: 'sm' },
          { key: 'title', label: 'Title', minWidth: 'sm' },
          { key: 'status', label: 'Status', width: 'sm', hideBelow: 'sm' },
          { key: 'worktree', label: 'Worktree', width: 'md', hideBelow: 'md' }
        ]}
        rows={rows}
        selectionMode="single"
        selected={selected ? [selected.key] : []}
        onSelectionChange={({ keys }) => set(selectedTask, keys[0] ?? null)}
        onRowAction={({ key }) => {
          const task = list.tasks.find((candidate) => candidate.key === key)
          if (!task) return
          const worktree = list.worktrees?.[key]
          if (worktree) void openWorktree(key, worktree.worktreeId)
          else void startTask(task)
        }}
        hasMore={list.nextCursor !== null}
        loading={read(loadingMore)}
        onLoadMore={() => void loadMore()}
        emptyText={list.tasks.length === 0 ? 'No open tasks' : `No loaded task matches "${read(search).trim()}".`}
        maxHeight="lg"
      />
      {read(moreError) ? (
        <Text size="sm" tone="danger">
          {`Couldn't load more tasks: ${read(moreError)}`}
        </Text>
      ) : null}
      {list.truncated ? <Truncated list={list} /> : null}
    </>
  )
}

function ActionBar({ task, list }: { task: Task | null; list: ReadyTaskList }) {
  if (!task) {
    return (
      <Box border radius="md" paddingX="sm" paddingY="xs" background="muted">
        <Text size="sm" muted>
          Select a task to start it. Enter or a double click starts it too.
        </Text>
      </Box>
    )
  }
  const projectId = list.project.id
  const { worktree, isStarting, error, agentStarting: agentIsStarting } = taskState(task, projectId, list.worktrees)
  return (
    <Box border radius="md" paddingX="sm" paddingY="xs" background="muted" direction="column" gap="xs">
      <Text truncate>
        <Link href={task.url}>{task.key}</Link> {task.title}
      </Text>
      <Box direction="row" align="center" gap="xs">
        <Box grow minWidth={0}>
          <Text size="sm" muted truncate>
            {worktree ? `${worktree.name} · ${agentLine(worktree, agentIsStarting)}` : taskMeta(task)}
          </Text>
        </Box>
        {worktree ? (
          <Box shrink={false}>
            <Button key={`open:${task.key}`} size="sm" variant="outline" onPress={() => void openWorktree(task.key, worktree.worktreeId)}>
              Open
            </Button>
          </Box>
        ) : isStarting ? (
          <Spinner label={`Starting ${task.key}`} labelHidden />
        ) : (
          <>
            <CardTemplate task={task} projectId={projectId} />
            <Box shrink={false}>
              <StartButton task={task} worktrees={list.worktrees} />
            </Box>
          </>
        )}
      </Box>
      <TaskNotes isStarting={isStarting} error={error} />
    </Box>
  )
}

function TemplateDetail({ draft, templates, projectName }: { draft: TemplateDraft; templates: PromptTemplate[]; projectName: string }) {
  const nameProblem = templateNameProblem(templates, draft.name, draft.id)
  return (
    <Stack gap="sm">
      <Heading level={2}>{projectName}</Heading>
      <Stack gap="xs">
        <Input label="Name" value={draft.name} invalid={nameProblem !== null} onChange={(name) => changeDraft(draft, { name })} />
        {nameProblem !== null ? (
          <Text size="sm" tone="danger">
            {nameProblem}
          </Text>
        ) : null}
      </Stack>
      <Textarea
        label="Text"
        value={draft.text}
        rows={6}
        placeholder="Empty: the prompt is the task URL"
        onChange={(text) => changeDraft(draft, { text })}
      />
      <Text size="sm" muted>
        {`Variables: ${TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(', ')}. An empty template gives the task URL.`}
      </Text>
      <Text size="sm" muted>
        {'To run a Claude Code skill, start the template with its command, for example `/tdd {{task_key}}`: the rest of the template becomes its arguments. The new worktree must see the skill, so install plugins with user scope, not local, and commit project skills. Other agents have their own syntax.'}
      </Text>
      {draft.error !== null ? (
        <Callout tone="danger" icon="error">
          <Text>{draft.error}</Text>
        </Callout>
      ) : null}
      <Row gap="xs" align="center" wrap>
        <Button key="template-save" size="sm" variant="solid" disabled={nameProblem !== null || draft.saving} onPress={() => void saveTemplate()}>
          Save
        </Button>
        <Button key="template-cancel" size="sm" variant="ghost" disabled={draft.saving} onPress={closeTemplate}>
          Cancel
        </Button>
        {draft.isNew ? null : (
          <Button
            key="template-delete"
            size="sm"
            variant="ghost"
            tone="danger"
            icon="delete"
            disabled={templates.length < 2 || draft.saving}
            onPress={() => void deleteTemplate()}
          >
            {draft.confirmingDelete ? 'Confirm delete' : 'Delete'}
          </Button>
        )}
        {draft.saving ? <Spinner label="Saving the template" labelHidden /> : null}
      </Row>
    </Stack>
  )
}
