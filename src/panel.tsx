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
  Field,
  Heading,
  IconButton,
  Input,
  Link,
  RadioGroup,
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
import {
  filterNameProblem,
  filterRecipes,
  newFilterName,
  recipeFilterName,
  withFilterDeleted,
  withFilterSaved,
  type FilterChanges,
  type FilterRecipe
} from './filter'
import { isRecord } from './json'
import { jqlRecipe, type JqlRecipeAnswers, type RecipeAssignees } from './jql-recipe'
import {
  appendTasks,
  chooseProvider,
  DEFAULT_GITHUB_QUERY,
  DEFAULT_JQL,
  listedFilter,
  projectFilters,
  projectProvider,
  projectSettings,
  providerConfig,
  readSettings,
  SETTINGS_KEY,
  trackerOf,
  type Filter,
  type FilterSettings,
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
  type TaskWorktree,
  type TrackerId
} from './protocol'
import type { TaskPage } from './providers/types'
import { matchesSearch } from './search'
import { settingsSaver } from './settings-save'
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

/** The listed project's settings, as the person sees them. `provider` is null while none is set.
 *  `filterSettings` holds every tracker's filters and the one each showed last, as stored; the
 *  filter row shows those of the provider's tracker (`trackerFilters`). */
type ShownSettings = {
  projectId: string
  provider: ProviderId | null
  providers: ProviderConfigs
  filterSettings: FilterSettings
  agent: string
  templates: PromptTemplate[]
  defaultTemplateId: string
}

/** What + offers on Jira, in place of the panel view, before the filter editor opens on the new
 *  filter: the kind of filter to start from, and the answers of each JQL recipe, as typed. */
type NewFilterChoice = {
  projectId: string
  kind: NewFilterKind
  projectKey: string
  assignees: RecipeAssignees
  leaveOut: string
}

/** A blank filter, or one of the JQL recipes. */
type NewFilterKind = 'custom' | JqlRecipeAnswers['recipe']

const NEW_FILTER_KINDS: { value: NewFilterKind; label: string; description: string }[] = [
  { value: 'custom', label: 'Custom', description: 'One blank JQL query to write yourself.' },
  { value: 'board-order', label: 'Board order', description: "A Jira project's tasks in board order: the open sprints, the future sprints, then the rest." },
  { value: 'my-open-tasks', label: 'My open tasks', description: 'The tasks assigned to you, last updated first.' }
]

const ASSIGNEE_OPTIONS: { value: RecipeAssignees; label: string }[] = [
  { value: 'mine', label: 'Mine' },
  { value: 'mine-or-unassigned', label: 'Mine or unassigned' },
  { value: 'anyone', label: 'Anyone' }
]

/** The filter editor's draft: a filter of `projectId` on `tracker` being edited, or a new one. */
type FilterDraft = {
  projectId: string
  tracker: TrackerId
  id: string
  isNew: boolean
  name: string
  queries: string[]
  /** The failed load of the list that opened the editor on this filter, shown until Save. */
  loadError: string | null
  /** The error of the last write, shown until the next one. */
  error: string | null
  saving: boolean
  /** Delete was clicked once and waits for its second click. */
  confirmingDelete: boolean
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
/** The text of the "Search tasks" field: the text filter over the loaded tasks, and the words of a
 *  tracker search. Kept in memory, kept when another filter is chosen, and cleared when the active
 *  project changes. */
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
  | ({ query: string; kind: 'ready'; queryCount: number } & TaskPage)

/** The tracker search shown, or null while the loaded list is. */
const trackerSearch = atom<TrackerSearch | null>(null)

/** The template detail's draft while it replaces the panel view, else null. */
const templateDraft = atom<TemplateDraft | null>(null)

/** The filter editor's draft while it replaces the panel view, else null. */
const filterDraft = atom<FilterDraft | null>(null)

/** What + offers on Jira while it replaces the panel view, else null. */
const newFilterChoice = atom<NewFilterChoice | null>(null)

/** Whether a "Load more" is under way, and the error of the last one. */
const loadingMore = atom(false)
const moreError = atom<string | null>(null)

/** Rises with each load, so an answer that arrives after a newer request is dropped. */
let generation = 0

/** The active project id of the last poll, or undefined when the next poll measures against the
 *  list instead: before the first poll, and after every load the poll didn't ask for. */
let lastPolledProjectId: string | null | undefined

/** Rises with each change of the tracker settings, the ones that change what the list loads. */
let trackerSettingsVersion = 0
/** The `trackerSettingsVersion` the list shown was loaded with. Done in Project settings loads the
 *  list again while it is behind, so the list shows the tracker settings as they are. */
let listedTrackerSettingsVersion = 0

/** What the panel says after a timed save of Project settings failed, until a later save of the
 *  pending changes succeeds, or null. */
const settingsSaveError = atom<string | null>(null)

/** Every save of Project settings goes through it, and every read-modify-write of them in storage.
 *  The worker reads settings from storage, so a request that depends on them saves first. */
const settingsSave = settingsSaver({
  storage: {
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, value as unknown as JsonValue)
  },
  // The globals are read on each call, so the tests' timers stand in for them.
  timers: {
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  onSaved: () => set(settingsSaveError, null),
  onTimedSaveFailed: (error) => {
    set(settingsSaveError, `Couldn't save Project settings (${errorCode(error)}). Kickoff tries again with your next change.`)
  }
})

/** A change Project settings makes; the filters change through `chooseFilter` and the filter
 *  editor. */
type SettingsChange = Omit<ProjectChanges, keyof FilterSettings>

function changeSettings(changes: SettingsChange): void {
  const current = read(shownSettings)
  if (!current) return
  if (changes.provider !== undefined || changes.providers !== undefined) {
    trackerSettingsVersion++
    // A tracker search narrows the list the tracker settings give, which this changes.
    leaveTrackerSearch()
  }
  const providers = { ...current.providers, ...changes.providers }
  set(shownSettings, { ...current, ...changes, provider: changes.provider ?? current.provider, providers })
  settingsSave.change(current.projectId, changes)
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
    filterSettings: { filters: settings.filters, shownFilterId: settings.shownFilterId },
    agent: settings.agent ?? 'orca-default',
    templates: projectTemplates(settings),
    defaultTemplateId: defaultTemplate(settings).id
  })
}

/** The filters of the shown project's tracker and the one the filter row shows, or null while the
 *  project has no tracker. */
type TrackerFilters = { tracker: TrackerId; filters: Filter[]; shownFilterId: string }

function trackerFilters(shown: ShownSettings): TrackerFilters | null {
  if (shown.provider === null) return null
  const tracker = trackerOf(shown.provider)
  return { tracker, filters: projectFilters(shown.filterSettings, tracker), shownFilterId: listedFilter(shown.filterSettings, tracker).id }
}

/** Chooses the filter the panel shows, saves that choice, and loads its tasks from the tracker,
 *  as Reload does. It leaves any tracker search, but the field keeps its words. */
function chooseFilter(id: string): void {
  const shown = read(shownSettings)
  const current = shown ? trackerFilters(shown) : null
  if (!shown || !current || id === current.shownFilterId || !current.filters.some((filter) => filter.id === id)) return
  leaveTrackerSearch()
  // A change replaces `shownFilterId` whole, so it keeps the filter each other tracker shows.
  const shownFilterId = { ...shown.filterSettings.shownFilterId, [current.tracker]: id }
  set(shownSettings, { ...shown, filterSettings: { ...shown.filterSettings, shownFilterId } })
  settingsSave.change(shown.projectId, { shownFilterId })
  void load()
}

/** Opens the filter editor, in place of the panel view, on one of the shown project's filters, or
 *  on a new one: named "Filter 2", "Filter 3"… with one blank query, or with the name and queries of
 *  `recipe`, the name made free. `loadError` is the failed load that opened it. */
function openFilter(id: string | null, loadError: string | null = null, recipe: FilterRecipe | null = null): void {
  const shown = read(shownSettings)
  const current = shown ? trackerFilters(shown) : null
  if (!shown || !current) return
  const filter = id === null ? null : current.filters.find((candidate) => candidate.id === id)
  if (id !== null && !filter) return
  closeTemplate()
  set(newFilterChoice, null)
  set(filterDraft, {
    projectId: shown.projectId,
    tracker: current.tracker,
    id: filter?.id ?? newId('f', current.filters),
    isNew: !filter,
    name: filter?.name ?? (recipe ? recipeFilterName(current.filters, recipe.name) : newFilterName(current.filters)),
    queries: filter ? [...filter.queries] : recipe ? [...recipe.queries] : [''],
    loadError,
    error: null,
    saving: false,
    confirmingDelete: false
  })
}

/** + in the filter row: on Jira, the choice of a blank filter or a JQL recipe, in place of the panel
 *  view, with fresh answers; on GitHub, the filter editor on a new filter, whose recipes are in it. */
function newFilter(): void {
  const shown = read(shownSettings)
  const current = shown ? trackerFilters(shown) : null
  if (!shown || !current) return
  if (current.tracker !== 'jira') {
    openFilter(null)
    return
  }
  closeTemplate()
  set(filterDraft, null)
  set(newFilterChoice, { projectId: shown.projectId, kind: 'custom', projectKey: '', assignees: 'mine-or-unassigned', leaveOut: 'Done' })
}

/** Changes the choice of +, while it is still open on the project `expected` was made for. */
function changeNewFilterChoice(expected: NewFilterChoice, changes: Partial<NewFilterChoice>): void {
  update(newFilterChoice, (choice) => (choice && choice.projectId === expected.projectId ? { ...choice, ...changes } : choice))
}

/** The name and queries the choice of + writes: null for a blank filter, or undefined while its
 *  recipe lacks an answer it needs. */
function chosenRecipe(choice: NewFilterChoice): FilterRecipe | null | undefined {
  switch (choice.kind) {
    case 'custom':
      return null
    case 'board-order':
      return jqlRecipe({ recipe: 'board-order', projectKey: choice.projectKey, assignees: choice.assignees, leaveOut: choice.leaveOut }) ?? undefined
    case 'my-open-tasks':
      return jqlRecipe({ recipe: 'my-open-tasks', leaveOut: choice.leaveOut }) ?? undefined
  }
}

/** Continue: opens the filter editor on a new filter, blank or with the queries its recipe writes,
 *  unless the recipe lacks an answer. The answers are not kept. */
function continueNewFilter(): void {
  const choice = read(newFilterChoice)
  if (!choice || read(shownSettings)?.projectId !== choice.projectId) return
  const recipe = chosenRecipe(choice)
  if (recipe === undefined) return
  openFilter(null, null, recipe)
}

/** Changes the editor's draft, while it is still the draft of the `expected` filter. */
function changeFilterDraft(expected: FilterDraft, changes: Partial<FilterDraft>): void {
  update(filterDraft, (draft) => (draft && isSameDraft(draft, expected) ? { ...draft, ...changes } : draft))
}

/** Writes a recipe's name and queries into the draft of a new filter, the name made free. */
function useRecipe(draft: FilterDraft, filters: Filter[], recipe: FilterRecipe): void {
  changeFilterDraft(draft, { name: recipeFilterName(filters, recipe.name), queries: [...recipe.queries] })
}

/** Leaves the filter editor, or the choice of + before it, without saving. */
function closeFilter(): void {
  cancelConfirmDelete()
  set(filterDraft, null)
  set(newFilterChoice, null)
}

/** Stores the draft's filter, unless its name can't be saved, then goes back to the list and loads
 *  the filter's tasks. */
async function saveFilter(): Promise<void> {
  const draft = read(filterDraft)
  const shown = read(shownSettings)
  if (!draft || draft.saving || shown?.projectId !== draft.projectId) return
  if (filterNameProblem(projectFilters(shown.filterSettings, draft.tracker), draft.name, draft.id) !== null) return
  await writeFilters(draft, (project) => withFilterSaved(project, draft.tracker, { id: draft.id, name: draft.name, queries: draft.queries }))
}

/** The first click asks for a second within a few seconds; the second deletes the filter, then
 *  goes back to the list and loads the tasks of the filter it shows. */
async function deleteFilter(): Promise<void> {
  const draft = read(filterDraft)
  if (!draft || draft.saving || draft.isNew) return
  cancelConfirmDelete()
  if (!draft.confirmingDelete) {
    changeFilterDraft(draft, { confirmingDelete: true })
    confirmDeleteTimer = setTimeout(() => {
      confirmDeleteTimer = null
      changeFilterDraft(draft, { confirmingDelete: false })
    }, CONFIRM_DELETE_MS)
    return
  }
  await writeFilters(draft, (project) => withFilterDeleted(project, draft.tracker, draft.id))
}

/** Writes a change to the draft project's filters, then shows them, goes back to the list and
 *  loads it. A failed write keeps the editor open with its error and the draft. Pending Project
 *  settings are saved first, so the change applies to what the person sees. */
async function writeFilters(draft: FilterDraft, change: (project: ProjectSettings) => FilterChanges | null): Promise<void> {
  changeFilterDraft(draft, { saving: true, error: null, confirmingDelete: false })
  let changes: FilterChanges | null
  try {
    changes = await settingsSave.writeProject(draft.projectId, change)
  } catch (error) {
    changeFilterDraft(draft, { saving: false, error: `Couldn't save the filter (${errorCode(error)}). Try again.` })
    return
  }
  const shown = read(shownSettings)
  if (changes && shown?.projectId === draft.projectId) set(shownSettings, { ...shown, filterSettings: changes })
  const current = read(filterDraft)
  if (!current || !isSameDraft(current, draft)) return
  set(filterDraft, null)
  if (!changes) return
  set(settingsChoice, 'closed')
  leaveTrackerSearch()
  await load()
}

/** Opens the template detail for one of the shown project's templates, or for a new one. It opens
 *  from Project settings, which stays open to come back to. */
function openTemplate(id: string | null): void {
  const shown = read(shownSettings)
  if (!shown) return
  const template = id === null ? null : shown.templates.find((candidate) => candidate.id === id)
  if (id !== null && !template) return
  closeFilter()
  set(settingsChoice, 'open')
  set(templateDraft, {
    projectId: shown.projectId,
    id: template?.id ?? newId('t', shown.templates),
    isNew: !template,
    name: template?.name ?? '',
    text: template?.text ?? INITIAL_TEMPLATE_TEXT,
    error: null,
    saving: false,
    confirmingDelete: false
  })
}

/** An id, starting with `prefix`, that none of `items` has. */
function newId(prefix: string, items: { id: string }[]): string {
  for (;;) {
    const id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!items.some((item) => item.id === id)) return id
  }
}

/** Changes the detail's draft, while it is still the draft of the `expected` template. */
function changeTemplateDraft(expected: TemplateDraft, changes: Partial<TemplateDraft>): void {
  update(templateDraft, (draft) => (draft && isSameDraft(draft, expected) ? { ...draft, ...changes } : draft))
}

/** Whether two drafts are of the same template, or the same filter, of the same project. */
const isSameDraft = (a: { projectId: string; id: string }, b: { projectId: string; id: string }) => a.projectId === b.projectId && a.id === b.id

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
    changeTemplateDraft(draft, { confirmingDelete: true })
    confirmDeleteTimer = setTimeout(() => {
      confirmDeleteTimer = null
      changeTemplateDraft(draft, { confirmingDelete: false })
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
  changeTemplateDraft(draft, { saving: true, error: null, confirmingDelete: false })
  let changes: TemplateChanges | null
  try {
    changes = await settingsSave.writeProject(draft.projectId, change)
  } catch (error) {
    changeTemplateDraft(draft, { saving: false, error: `Couldn't save the template (${errorCode(error)}). Try again.` })
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

/** Done: goes back to the list, and loads it again when the tracker settings changed since the list
 *  shown was loaded. Typing in them loads nothing by itself, so typing twg's site or profile asks
 *  the tracker nothing. A change of tracker settings already left any tracker search, so this loads
 *  the list. */
function closeSettings(): void {
  set(settingsChoice, 'closed')
  if (listedTrackerSettingsVersion !== trackerSettingsVersion) void load()
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
  const mine = startLoading()
  const { answer, askedAt, worktreesAskedAt, savedTrackerSettings } = await askTasks({})
  if (mine !== generation) return
  // A change of active project drops the template detail's draft and the filter editor's. An answer
  // that names no project because the worker didn't answer says nothing about it.
  const answeredProjectId = answer.kind === 'no-project' ? null : answer.project?.id
  const draft = read(templateDraft)
  if (draft && answeredProjectId !== undefined && answeredProjectId !== draft.projectId) closeTemplate()
  const filterOpen = read(filterDraft) ?? read(newFilterChoice)
  if (filterOpen && answeredProjectId !== undefined && answeredProjectId !== filterOpen.projectId) closeFilter()
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
  if (savedTrackerSettings !== null) listedTrackerSettingsVersion = savedTrackerSettings
  set(list, answer)
  set(loading, false)
  // A failed query opens the filter editor on its filter, unless a draft, or the choice of +, is
  // open already.
  if (answer.kind === 'error' && answer.filterId !== undefined && !read(templateDraft) && !read(filterDraft) && !read(newFilterChoice)) {
    if (read(shownSettings)?.projectId === answer.project?.id) openFilter(answer.filterId, answer.message)
  }
}

/** Asks the tracker for the listed project's tasks that match the trimmed `query`, and shows them
 *  in place of the loaded list, which stays as it is. The same tracker search run again keeps its
 *  results while it loads, as a reload keeps the list. A blank query asks nothing. An answer for
 *  another project, tracker or filter means the list the tracker search narrowed is gone: the
 *  tracker search ends and the list is loaded again. */
async function searchTracker(query: string, reason: 'poll' | 'other' = 'other'): Promise<void> {
  if (query === '' || read(list)?.kind !== 'ready') return
  const mine = startLoading()
  const before = read(trackerSearch)
  if (before?.query !== query || before.kind !== 'ready') set(trackerSearch, { query, kind: 'loading' })
  const { answer, askedAt, worktreesAskedAt } = await askTasks({ query })
  if (mine !== generation) return
  if (reason !== 'poll') lastPolledProjectId = undefined
  const current = read(list)
  if (current?.kind !== 'ready') return
  if (answer.kind === 'error' && (answer.project === null || answer.project.id === current.project.id)) {
    set(trackerSearch, { query, kind: 'error', message: answer.message })
    set(loading, false)
    return
  }
  if (!isSameList(answer, current)) {
    set(trackerSearch, null)
    return load()
  }
  showStarting(answer.starting, askedAt)
  if (answer.worktrees) agentsReported(answer.project.id, answer.worktrees)
  worktreesShownAt = worktreesAskedAt
  set(list, { ...current, worktrees: answer.worktrees, worktreesError: answer.worktreesError, warning: answer.warning })
  set(trackerSearch, { query, kind: 'ready', tasks: answer.tasks, nextCursor: answer.nextCursor, truncated: answer.truncated, queryCount: answer.queryCount })
  set(loading, false)
}

/** Starts a load of the list or of a tracker search: an answer to any earlier one, and any "Load
 *  more" under way, will be dropped. Answers the load's generation. */
function startLoading(): number {
  const mine = ++generation
  set(loading, true)
  set(loadingMore, false)
  set(moreError, null)
  return mine
}

/** Saves pending settings, then asks the worker for a first page, with when the Starts under way
 *  and the worktrees were asked for. A failed save, which asks the worker nothing, and a worker
 *  that doesn't answer give an error that names no project. `savedTrackerSettings` is the
 *  `trackerSettingsVersion` the request asked with, or null when the save failed. */
async function askTasks(
  input: { query?: string }
): Promise<{ answer: TaskList; askedAt: number; worktreesAskedAt: number; savedTrackerSettings: number | null }> {
  // A change made while the save is under way isn't in it.
  const version = trackerSettingsVersion
  try {
    await settingsSave.saveNow()
  } catch (error) {
    const message = `Couldn't save Project settings (${errorCode(error)}). Reload to try again.`
    return { answer: { kind: 'error', project: null, message }, askedAt: 0, worktreesAskedAt: 0, savedTrackerSettings: null }
  }
  const askedAt = ++startClock
  const worktreesAskedAt = ++worktreesClock
  try {
    return { answer: await plugin.request('tasks.load', input, { timeoutMs: LOAD_TIMEOUT_MS }), askedAt, worktreesAskedAt, savedTrackerSettings: version }
  } catch (error) {
    const message = `Kickoff's worker didn't answer (${errorCode(error)}). Reload to try again.`
    return { answer: { kind: 'error', project: null, message }, askedAt, worktreesAskedAt, savedTrackerSettings: version }
  }
}

/** Whether `answer` is a page of the same list as `shown`: of the same project, tracker and filter. */
function isSameList(answer: TaskList, shown: ReadyTaskList): answer is ReadyTaskList {
  return answer.kind === 'ready' && answer.project.id === shown.project.id && answer.provider === shown.provider && answer.filterId === shown.filterId
}

/** Goes back from the tracker search to the loaded list as it was, with the text filter, dropping
 *  any answer still on its way, without loading the list again. Such an answer might have said that
 *  the active project changed, so the next poll measures against the list. */
function leaveTrackerSearch(): void {
  if (read(trackerSearch) === null) return
  if (read(loading)) lastPolledProjectId = undefined
  generation++
  set(trackerSearch, null)
  set(loading, false)
  set(loadingMore, false)
  set(moreError, null)
}

/** "Clear search": back to the loaded list, with an empty field. */
function clearTrackerSearch(): void {
  leaveTrackerSearch()
  set(fieldText, '')
}

/** Typing in the field narrows the loaded list with the text filter, leaving a tracker search
 *  shown. */
function changeField(value: string): void {
  set(fieldText, value)
  leaveTrackerSearch()
}

/** Asks for the next page of the list, or of the tracker search shown, and appends its tasks,
 *  skipping keys already listed. A page that arrives after a reload or after the tracker search changed
 *  is dropped; one for another project or filter means the list changed, so it is loaded again.
 *  Pending settings are not saved first: the cursor belongs to the list of the filter, or the
 *  tracker search, that listed the first page, with the queries saved then, so the request names
 *  that filter, and a tracker search sends its words again with it. */
async function loadMore(): Promise<void> {
  const current = read(list)
  const found = read(trackerSearch)
  if (current?.kind !== 'ready' || read(loadingMore) || (found !== null && found.kind !== 'ready')) return
  const cursor = found ? found.nextCursor : current.nextCursor
  if (cursor === null) return
  const mine = generation
  set(loadingMore, true)
  set(moreError, null)
  const page = { filterId: current.filterId, cursor }
  let answer: TaskList
  try {
    answer = await plugin.request('tasks.load', found ? { ...page, query: found.query } : page, { timeoutMs: LOAD_TIMEOUT_MS })
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
  if (!isSameList(answer, shown)) {
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
  const answer = await askStart(projectId, task)
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

/** Saves pending settings, then asks the worker to start the task with its chosen template. A
 *  failed save asks the worker nothing, so the task didn't start. */
async function askStart(projectId: string, task: Task): Promise<StartResult> {
  try {
    await settingsSave.saveNow()
  } catch (error) {
    return { ok: false, message: `Couldn't save Project settings (${errorCode(error)}), so ${task.key} didn't start. Try again.` }
  }
  try {
    const shown = await settingsShownFor(projectId)
    if (!shown.ok) return shown
    return await plugin.request('task.start', { projectId, task, templateId: chosenTemplateId(shown.settings, task.key) }, { timeoutMs: START_TIMEOUT_MS })
  } catch (error) {
    return { ok: false, message: `Kickoff's worker didn't answer (${errorCode(error)}). Reload the tasks to see whether ${task.key} started.` }
  }
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
  ctx.subscriptions.push({ dispose: settingsSave.unload })
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
  set(filterDraft, null)
  set(newFilterChoice, null)
  set(variablesOpen, false)
  set(settingsChoice, 'auto')
  viewStateFor = undefined
  set(fieldText, '')
  set(trackerSearch, null)
  set(settingsSaveError, null)
  // Closing the panel drops the template detail's draft and the filter editor's.
  ctx.subscriptions.push({ dispose: closeTemplate })
  ctx.subscriptions.push({ dispose: closeFilter })
  let polling = false
  const poll = async () => {
    if (polling || read(loading) || !read(ctx.visible)) return
    polling = true
    try {
      const answer = await plugin.request('project.active', {})
      if (!('projectId' in answer)) return
      const before = lastPolledProjectId === undefined ? listedProjectId() : lastPolledProjectId
      lastPolledProjectId = answer.projectId
      if (before !== undefined && answer.projectId !== before) {
        // The tracker search narrowed the other project's list.
        leaveTrackerSearch()
        void load('poll')
      } else await checkStarts()
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
  const filterEdit = read(filterDraft)
  if (filterEdit && shown?.projectId === filterEdit.projectId) {
    return <FilterEditor draft={filterEdit} filters={projectFilters(shown.filterSettings, filterEdit.tracker)} projectName={project?.name ?? ''} />
  }
  const newChoice = read(newFilterChoice)
  if (newChoice && shown?.projectId === newChoice.projectId) return <NewFilterChooser choice={newChoice} projectName={project?.name ?? ''} />
  const settings = project !== null && shown?.projectId === project.id ? shown : null
  const choice = read(settingsChoice)
  if (project && settings && (choice === 'auto' ? needsSettings(current) : choice === 'open')) {
    return <SettingsView projectName={project.name} shown={settings} />
  }
  // The panel fills its height, so a ready list's last part, the list, scrolls alone.
  return (
    <Box direction="column" gap="sm" height="100%">
      <Header projectName={project?.name ?? null} gear={settings !== null} />
      <SettingsSaveError />
      {current ? <Body list={current} /> : <Spinner label="Loading tasks" />}
    </Box>
  )
}

/** Whether Project settings opens by itself: the project has no tracker, or its load failed for a
 *  reason other than a filter's query, which opens the filter editor instead. */
const needsSettings = (current: TaskList | null) =>
  current?.kind === 'needs-config' || (current?.kind === 'error' && current.filterId === undefined)

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
        <Button key="settings-done" size="sm" variant="solid" onPress={closeSettings}>
          Done
        </Button>
      </TitleRow>
      <SettingsSaveError />
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

/** How the filter editor names a tracker's queries: "JQL" on Jira, "Query" on GitHub, with the
 *  button that adds one, the placeholder of the first and what the queries are, when it needs
 *  saying. */
const QUERY_WORDING: Record<TrackerId, { label: string; add: string; placeholder: string; hint: string | null }> = {
  jira: { label: 'JQL', add: 'Add JQL', placeholder: DEFAULT_JQL, hint: null },
  github: {
    label: 'Query',
    add: 'Add query',
    placeholder: DEFAULT_GITHUB_QUERY,
    hint: 'Each query is a GitHub issue search, such as is:open label:bug or assignee:@me. Kickoff lists open issues only.'
  }
}

/** The queries of a filter on `tracker`, each with its Remove button while more than one is left,
 *  then Add JQL (Add query on GitHub). Ctrl+Enter (Cmd+Enter on macOS) in any of them runs
 *  `onSubmit`. */
function FilterQueries({
  tracker,
  queries: stored,
  onChange: change,
  onSubmit
}: {
  tracker: TrackerId
  queries: string[]
  onChange: (queries: string[]) => void
  onSubmit: () => void
}) {
  const wording = QUERY_WORDING[tracker]
  // A filter stored with no query at all still shows one field to type into.
  const queries = stored.length > 0 ? stored : ['']
  return (
    <Stack gap="sm">
      {wording.hint !== null ? (
        <Text size="sm" muted>
          {wording.hint}
        </Text>
      ) : null}
      {queries.map((query, index) => {
        const label = index === 0 ? wording.label : `${wording.label} ${index + 1}`
        // The label is the Field's, above the row, so Remove centres on the query's box alone.
        return (
          <Field key={`query-${index}`} label={label}>
            <Box direction="row" align="center" gap="xs">
              <Box grow minWidth={0}>
                <Textarea
                  label={label}
                  labelHidden
                  rows={3}
                  value={query}
                  placeholder={index === 0 ? wording.placeholder : undefined}
                  onChange={(value) => change(queries.map((other, at) => (at === index ? value : other)))}
                  onSubmit={onSubmit}
                />
              </Box>
              {queries.length > 1 ? (
                <Box shrink={false}>
                  <IconButton
                    icon="delete"
                    label={`Remove ${label}`}
                    tooltip="Remove query"
                    size="sm"
                    variant="ghost"
                    tone="danger"
                    onPress={() => change(queries.filter((_, at) => at !== index))}
                  />
                </Box>
              ) : null}
            </Box>
          </Field>
        )
      })}
      <Row gap="none" align="center">
        <Button key="query-add" icon="add" size="sm" variant="solid" onPress={() => change([...queries, ''])}>
          {wording.add}
        </Button>
      </Row>
      <Text size="sm" muted>
        Ctrl+Enter (Cmd+Enter on macOS) saves the filter and lists its tasks.
      </Text>
    </Stack>
  )
}

function JiraTwgSettings({ providers }: { providers: ProviderConfigs }) {
  const config = providerConfig({ providers }, 'jira-twg')
  return (
    <Stack gap="sm">
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
        <>
          {list.project ? <FilterRow projectId={list.project.id} /> : null}
          <LoadError message={list.message} />
        </>
      )
    case 'ready':
      return <ReadyList list={list} />
  }
}

/** On a project with a tracker, the filter shown, ✎ to edit it and + to add one. */
function FilterRow({ projectId }: { projectId: string }) {
  const shown = read(shownSettings)
  const current = shown?.projectId === projectId ? trackerFilters(shown) : null
  if (!current) return null
  return (
    <Box direction="row" align="center" gap="xs">
      <Box grow minWidth={0}>
        <Select
          label="Filter"
          labelHidden
          value={current.shownFilterId}
          options={current.filters.map((filter) => ({ value: filter.id, label: filter.name }))}
          onChange={chooseFilter}
        />
      </Box>
      <Box shrink={false}>
        <Row gap="none" align="center">
          <IconButton icon="edit" label="Edit filter" tooltip="Edit filter" size="sm" variant="ghost" onPress={() => openFilter(current.shownFilterId)} />
          <IconButton icon="add" label="New filter" tooltip="New filter" size="sm" variant="ghost" onPress={newFilter} />
        </Row>
      </Box>
    </Box>
  )
}

/** The failure of the last timed save of Project settings, until a save of them succeeds. */
function SettingsSaveError() {
  const message = read(settingsSaveError)
  if (message === null) return null
  return (
    <Callout tone="danger" icon="error">
      <Text>{message}</Text>
    </Callout>
  )
}

/** A failed load of the list or of a tracker search. */
function LoadError({ message }: { message: string }) {
  return (
    <Callout tone="danger" title="Couldn't load tasks" icon="error">
      <Text>{message}</Text>
    </Callout>
  )
}

type ReadyTaskList = Extract<TaskList, { kind: 'ready' }>

/** The tracker's name, as the panel says it. */
const trackerName = (provider: ProviderId) => (trackerOf(provider) === 'github' ? 'GitHub' : 'Jira')

/** The warnings, the filter row, the field and the tracker search's title, which stay in place,
 *  then the list, which scrolls inside the rest of the panel's height: the loaded tasks that match
 *  the text filter, or the tracker search's results, then "Load more" and the truncation notice. */
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
      <FilterRow projectId={list.project.id} />
      <Stack gap="xs">
        <Input
          type="search"
          label="Search tasks"
          labelHidden
          value={text}
          placeholder="Filter loaded tasks · Enter searches the tracker"
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
        {found === null ? <LoadedTasks list={list} words={query} /> : <SearchResults found={found} list={list} tracker={tracker} />}
      </Box>
    </>
  )
}

/** The loaded tasks that the text filter's trimmed `words` match, "Load more" and the truncation
 *  notice. */
function LoadedTasks({ list, words }: { list: ReadyTaskList; words: string }) {
  const tasks = list.tasks.filter((task) => matchesSearch(task, words))
  return (
    <>
      {list.tasks.length === 0 ? (
        <EmptyState title="No open tasks" icon="check" />
      ) : tasks.length === 0 ? (
        <Text size="sm" muted>
          {`No loaded task matches "${words}".`}
        </Text>
      ) : (
        tasks.map((task) => <TaskCard key={task.key} task={task} projectId={list.project.id} worktrees={list.worktrees} />)
      )}
      {list.nextCursor !== null ? <LoadMore count={list.tasks.length} /> : null}
      {list.truncated ? (
        <Text size="sm" muted>
          {truncationNotice(list)}
        </Text>
      ) : null}
    </>
  )
}

/** What a truncated list says: a list from several queries has the first 100 tasks of each. */
function truncationNotice(list: ReadyTaskList): string {
  if (list.provider === 'github') return list.queryCount > 1 ? 'Showing the first 100 issues of each query.' : "Showing the first 100 of your repository's issues."
  return list.queryCount > 1 ? 'Showing the first 100 tasks of each query — narrow your JQL.' : 'Showing the first 100 tasks — narrow your JQL.'
}

/** A tracker search's results, without the text filter: a result may match on its description,
 *  which the text filter doesn't read. Then "Load more" and the truncation notice. The cards show the worktrees
 *  of the loaded list, which every read of them keeps up to date. */
function SearchResults({ found, list, tracker }: { found: TrackerSearch; list: ReadyTaskList; tracker: string }) {
  switch (found.kind) {
    case 'loading':
      return <Spinner label={`Searching ${tracker}`} />
    case 'error':
      return <LoadError message={found.message} />
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
              {found.queryCount > 1 ? 'Showing the first 100 results of each query — refine your search' : 'Showing the first 100 results — refine your search'}
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

/** What the card says about the task's assignees, in the tracker's order, or null when it has none. */
function assigneeLine(task: Task): string | null {
  if (task.assignees.length === 0) return null
  return `${task.assignees.length === 1 ? 'Assignee' : 'Assignees'}: ${task.assignees.join(', ')}`
}

/** One row per part: the key and the whole title; the worktree, or the status and labels; the
 *  assignees; the agent; the template and Start, while there is no worktree. */
function TaskCard({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  // Every GitHub task is open, so its status says nothing.
  const status = task.tracker !== 'github' ? task.status : null
  const worktree = worktrees?.[task.key] ?? null
  const isStarting = worktree === null && read(starting)[task.key] === true
  const error = read(taskErrors)[task.key]
  const assignees = assigneeLine(task)
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
      {assignees !== null ? (
        <Text size="sm" muted>
          {assignees}
        </Text>
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
          <Input label="Name" value={draft.name} invalid={nameProblem !== null} onChange={(name) => changeTemplateDraft(draft, { name })} />
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
            onChange={(text) => changeTemplateDraft(draft, { text })}
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

/** What + offers on Jira, in place of the panel view, as the filter editor is: the title row with
 *  Cancel and Continue, then the kind of filter to start from and the answers its recipe asks. */
function NewFilterChooser({ choice, projectName }: { choice: NewFilterChoice; projectName: string }) {
  const ready = chosenRecipe(choice) !== undefined
  const change = (changes: Partial<NewFilterChoice>) => changeNewFilterChoice(choice, changes)
  const leaveOut = (
    <Stack gap="xs">
      <Input label="Statuses to leave out" value={choice.leaveOut} onChange={(value) => change({ leaveOut: value })} onSubmit={continueNewFilter} />
      <Text size="sm" muted>
        Status names separated by commas, such as Done, Closed. Leave it empty to keep every status.
      </Text>
    </Stack>
  )
  return (
    <Box direction="column" gap="sm" height="100%">
      <TitleRow prefix={projectName !== '' ? `${projectName} ·` : null} title="New filter" level={3}>
        <Row gap="xs" align="center">
          <Button key="new-filter-cancel" size="sm" variant="ghost" onPress={closeFilter}>
            Cancel
          </Button>
          <Button key="new-filter-continue" size="sm" variant="solid" disabled={!ready} onPress={continueNewFilter}>
            Continue
          </Button>
        </Row>
      </TitleRow>
      <Box direction="column" gap="sm" grow minHeight={0} maxHeight="100%" scroll="y">
        <RadioGroup label="Start from" value={choice.kind} options={NEW_FILTER_KINDS} onChange={(kind) => change({ kind: kind as NewFilterKind })} />
        {choice.kind === 'board-order' ? (
          <Stack gap="sm">
            <Stack gap="xs">
              <Input
                label="Jira project key"
                value={choice.projectKey}
                placeholder="WEB"
                onChange={(projectKey) => change({ projectKey })}
                onSubmit={continueNewFilter}
              />
              {choice.projectKey.trim() === '' ? (
                <Text size="sm" muted>
                  Enter the key of the board's Jira project to go on.
                </Text>
              ) : null}
            </Stack>
            <RadioGroup
              label="Whose tasks"
              value={choice.assignees}
              options={ASSIGNEE_OPTIONS}
              orientation="horizontal"
              onChange={(assignees) => change({ assignees: assignees as RecipeAssignees })}
            />
            {leaveOut}
          </Stack>
        ) : null}
        {choice.kind === 'my-open-tasks' ? leaveOut : null}
        {choice.kind !== 'custom' ? (
          <Text size="sm" muted>
            Continue writes the filter's JQL queries for you to change before saving it.
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}

/** The filter editor, in place of the panel view, as the template detail: the title row with
 *  Cancel and Save, and the Delete bar, stay in place while the form between them scrolls. The
 *  form starts with the failed load that opened it, if one did. */
function FilterEditor({ draft, filters, projectName }: { draft: FilterDraft; filters: Filter[]; projectName: string }) {
  const nameProblem = filterNameProblem(filters, draft.name, draft.id)
  const save = () => void saveFilter()
  const recipes = filterRecipes(draft.tracker)
  return (
    <Box direction="column" gap="sm" height="100%">
      <TitleRow prefix={projectName !== '' ? `${projectName} ·` : null} title={draft.isNew ? 'New filter' : 'Edit filter'} level={3}>
        <Row gap="xs" align="center">
          {draft.saving ? <Spinner label="Saving the filter" labelHidden /> : null}
          <Button key="filter-cancel" size="sm" variant="ghost" disabled={draft.saving} onPress={closeFilter}>
            Cancel
          </Button>
          <Button key="filter-save" size="sm" variant="solid" disabled={nameProblem !== null || draft.saving} onPress={save}>
            Save
          </Button>
        </Row>
      </TitleRow>
      <Box direction="column" gap="sm" grow minHeight={0} maxHeight="100%" scroll="y">
        {draft.loadError !== null ? <LoadError message={draft.loadError} /> : null}
        <Stack gap="xs">
          <Input label="Name" value={draft.name} invalid={nameProblem !== null} onChange={(name) => changeFilterDraft(draft, { name })} />
          {nameProblem !== null ? (
            <Text size="sm" tone="danger">
              {nameProblem}
            </Text>
          ) : null}
        </Stack>
        {draft.isNew && recipes.length > 0 ? (
          <Field label="Start from a recipe">
            <Row gap="xs" align="center" wrap>
              {recipes.map((recipe) => (
                <Button key={`recipe-${recipe.name}`} size="sm" variant="outline" onPress={() => useRecipe(draft, filters, recipe)}>
                  {recipe.name}
                </Button>
              ))}
            </Row>
          </Field>
        ) : null}
        <FilterQueries tracker={draft.tracker} queries={draft.queries} onChange={(queries) => changeFilterDraft(draft, { queries })} onSubmit={save} />
        {draft.error !== null ? (
          <Callout tone="danger" icon="error">
            <Text>{draft.error}</Text>
          </Callout>
        ) : null}
      </Box>
      {draft.isNew ? null : (
        <Box direction="row" justify="end" align="center" shrink={false}>
          <Button
            key="filter-delete"
            size="sm"
            variant="ghost"
            tone="danger"
            icon="delete"
            disabled={filters.length < 2 || draft.saving}
            onPress={() => void deleteFilter()}
          >
            {draft.confirmingDelete ? 'Confirm delete' : 'Delete filter'}
          </Button>
        </Box>
      )}
    </Box>
  )
}
