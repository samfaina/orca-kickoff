// Kickoff's side panel: the active project's open tasks with Start and Run here, and its Project
// settings. No build step: Orca strips the types and compiles the JSX when the panel loads. The
// worker does the work; the panel asks it and draws the answers.
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
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
  Switch,
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
import { KICKOFF_REPOSITORY_URL, type About } from './about'
import {
  filterNameProblem,
  filterRecipes,
  filterWriteChanges,
  namesJiraProject,
  newFilterName,
  recipeFilterName,
  withFilterDeleted,
  withFilterMoved,
  withFilterSaved,
  withJiraProjectVariable,
  type FilterMove,
  type FilterRecipe,
  type FilterWrite
} from './filter'
import { projectBranchSettings, sameBranchSettings, usesGlobalBranchSettings, withBranchSwitched } from './branch-settings'
import { isRecord } from './json'
import { jqlRecipe, type JqlRecipeAnswers, type RecipeAssignees } from './jql-recipe'
import { NEW_LINEAR_QUERY, readLinearQuery, withLinearQueryChanges, type LinearQuery } from './linear-query'
import {
  BRANCH_VARIABLE_DESCRIPTIONS,
  BRANCH_VARIABLES,
  branchSettingsProblem,
  startBranch,
  type BranchSettingsProblem,
  titleExclusion,
  worktreeName
} from './naming'
import {
  appendTasks,
  chooseProvider,
  DEFAULT_GITHUB_QUERY,
  DEFAULT_JQL,
  globalSettings,
  globalTemplates,
  jiraProjectKey,
  listedFilter,
  orcaDefaultAgent,
  projectFilters,
  projectProvider,
  projectSettings,
  providerConfig,
  readSettings,
  SETTINGS_KEY,
  trackerOf,
  type BranchSettings,
  type BranchTypeRow,
  type ByTracker,
  type Filter,
  type FilterSettings,
  type ListedFilter,
  type JiraProviderId,
  type JiraSitesResult,
  type LinearChoicesResult,
  type ActionResult,
  type AgentChoice,
  type AgentsResult,
  type AvailableAgent,
  type LaunchRequest,
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
  JIRA_PROJECT_VARIABLE,
  projectTemplates,
  TEMPLATE_VARIABLE_DESCRIPTIONS,
  TEMPLATE_VARIABLES,
  templateNameProblem,
  withTemplateDeleted,
  withTemplateSaved,
  type ListedTemplate,
  type TemplateSave,
  type TemplateWrite
} from './template'

/** Orca queries and the tracker can take up to about 65 s together. */
const LOAD_TIMEOUT_MS = 90_000
/** `task.start` answers after its quick checks: two Orca queries run together, then `orca agent
 *  installed`, at most 20 s each in a row. The create goes on in the worker, which posts
 *  `start.ended` when it ends. */
const START_TIMEOUT_MS = 60_000
/** `task.runHere` waits for four Orca queries, run together, then the launch, which Orca answers
 *  in under a second: two calls of at most 20 s each in a row. */
const RUN_HERE_TIMEOUT_MS = 60_000
/** How long Delete waits for its second click, as "Confirm delete". */
const CONFIRM_DELETE_MS = 4_000
/** How often the panel asks for the active project while it is visible. */
const POLL_MS = 3_000
/** Orca detects the agent of a new worktree a few seconds after its create ends, so the panel
 *  reads the worktrees once more after this pause. */
const AGENT_CHECK_MS = 5_000
/** A burst of workspaces created or removed reads the worktrees once, this long after the last. */
const WORKSPACE_REFRESH_MS = 300

const PROVIDER_OPTIONS: { value: ProviderId; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira-orca', label: 'Jira (Orca connection)' },
  { value: 'jira-twg', label: 'Jira (twg)' },
  { value: 'linear-orca', label: 'Linear (Orca connection)' }
]

/** Select values can't be empty, so these stand for "no tracker yet" and "Orca's default site".
 *  Neither can be a provider id or an Orca site id. */
const NO_TRACKER = ':none'
const DEFAULT_SITE = ':default'

/** The listed project's settings, as the person sees them. `provider` is null while none is set.
 *  `filterSettings` holds every tracker's own filters and the one each showed last, as stored, and
 *  `globalFilters` the global ones of each tracker, as stored; the filter row shows those of the
 *  provider's tracker (`trackerFilters`). */
type ShownSettings = {
  projectId: string
  provider: ProviderId | null
  providers: ProviderConfigs
  /** '' while the project has none. */
  jiraProjectKey: string
  filterSettings: FilterSettings
  globalFilters: ByTracker<Filter[]>
  agent: string
  /** The project's own templates, then the global ones. */
  templates: ListedTemplate[]
  defaultTemplateId: string
  /** The Branch section as the person sees it: the branch settings the project uses, the global
   *  ones while `branchGlobal`, else its own. Saved only while `branchSettingsProblem` finds nothing
   *  wrong with it. */
  branch: ShownBranch
  /** Whether the project uses the global branch settings, so the Branch section shows and edits
   *  them: its Global switch. */
  branchGlobal: boolean
  /** The global branch settings as last read or saved, undefined while none are stored. */
  globalBranch: BranchSettings | undefined
  branchSwitch: BranchSwitch
}

/** The Branch section's fields, as typed. `titleExclusionSet`: the branch settings shown store
 *  their own title exclusion pattern, or the person changed it; until then the initial one is shown
 *  and never stored. */
type ShownBranch = Required<BranchSettings> & { titleExclusionSet: boolean }

/** The Branch section's Global switch. `asking`: turning it on waits for the bar's confirmation,
 *  to make the project's own branch settings the global ones (`publish`), or to drop them for the
 *  global ones (`adopt`). `copied`: turning it off gave the project a copy of the global ones, and a
 *  note says so. `error`: why the last switch write failed. */
type BranchSwitch = { asking: 'publish' | 'adopt' | null; saving: boolean; error: string | null; copied: boolean }

const BRANCH_SWITCH_IDLE: BranchSwitch = { asking: null, saving: false, error: null, copied: false }

/** The Branch section's fields for `settings`. */
function shownBranch(settings: BranchSettings): ShownBranch {
  return {
    branchTemplate: settings.branchTemplate ?? '',
    branchTypes: settings.branchTypes ?? [],
    branchTypeFallback: settings.branchTypeFallback ?? '',
    titleExclusion: titleExclusion(settings),
    titleExclusionSet: settings.titleExclusion !== undefined
  }
}

/** The branch settings the Branch section saves: every field, but the title exclusion pattern only
 *  once it was changed from the initial one. */
function savedBranch(branch: ShownBranch): BranchSettings {
  const { branchTemplate, branchTypes, branchTypeFallback } = branch
  return { branchTemplate, branchTypes, branchTypeFallback, ...(branch.titleExclusionSet ? { titleExclusion: branch.titleExclusion } : {}) }
}

/** The Branch section of `project`, with `global`, the global branch settings, as stored. */
function branchShownFor(project: ProjectSettings, global: BranchSettings | undefined): Pick<ShownSettings, 'branch' | 'branchGlobal' | 'globalBranch'> {
  return { branch: shownBranch(projectBranchSettings(project, global)), branchGlobal: usesGlobalBranchSettings(project, global), globalBranch: global }

}

/** The task the Branch section's preview shows when no task is loaded. */
const PREVIEW_TASK: Task = {
  tracker: 'jira',
  key: 'WEB-12',
  title: '[FE] | [Mobile] Add dark mode',
  url: 'https://example.atlassian.net/browse/WEB-12',
  description: '',
  status: null,
  statusCategory: null,
  assignees: [],
  labels: [],
  issueType: 'Story'
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

/** The filter editor's draft: a filter of `projectId` on `tracker`, or a global one of `tracker`,
 *  being edited, or a new one. */
type FilterDraft = {
  projectId: string
  tracker: TrackerId
  id: string
  isNew: boolean
  /** Where the filter is: among the global ones of `tracker`, or the project's own. For a new one,
   *  where Save stores it. */
  global: boolean
  /** Global was turned off, and the bar asks to confirm the move to the project. */
  confirmingOwn: boolean
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

/** Where the Prompt templates view goes back to on Cancel and Save: the task list or Project
 *  settings, the view it was opened from. */
type TemplatesOrigin = 'list' | 'settings'

/** The Prompt templates view's draft: a template of `projectId`, or a global one, being edited, or a
 *  new one. Save writes all of it at once; Cancel drops it. */
type TemplateDraft = {
  projectId: string
  origin: TemplatesOrigin
  id: string
  isNew: boolean
  /** Where Save stores the template: among the global ones, or the project's own. A stored template
   *  whose group differs from this moves on Save. */
  global: boolean
  /** Whether Save makes the template the project's default template. */
  isDefault: boolean
  /** Global was turned off on a global template, and the bar asks to confirm it. */
  confirmingOwn: boolean
  /** Another template, or a new one (`id: null`), was chosen while the draft had changes, and the
   *  bar asks to discard them. */
  discarding: { id: string | null } | null
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
/** What the Linear query form offers for the workspace `workspaceId`, by team key: under '' the
 *  teams, asked for when the filter editor opens on a Linear filter, and under a team's key also its
 *  states and labels, asked for then for each team its queries name, and when a form's team changes. */
const linearChoices = atom<{ workspaceId: string; answers: Record<string, ShownLinearChoices> } | null>(null)
/** The agents Orca can start on the active worktree's host, as last answered: asked on each load
 *  of the list and each time Project settings opens. null until the first answer. */
const availableAgents = atom<AgentsResult | null>(null)
/** Rises with each `agents.load`, so an answer older than the last one asked is dropped. */
let agentsAsked = 0
/** Kickoff's version, for the line under Project settings: `unasked` until Project settings first
 *  opens, `asking` until the worker answers, then its answer, null when it has none. */
const shownAbout = atom<'unasked' | 'asking' | About | null>('about', 'unasked', { persist: 'memory' })
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
/** The error of each task's last Start or Run here, or of opening its worktree. */
const taskErrors = atom<Record<string, string>>({})

/** The template chosen on each card, by project and task key, while the panel is open. Never
 *  stored; a card whose template no longer exists shows the default template again. */
const cardTemplates = atom<Record<string, string>>({})

/** The agent chosen on each card, by project and task key, while the panel is open. Never stored;
 *  a card that no longer offers it shows the project's agent choice again. */
const cardAgents = atom<Record<string, AgentChoice>>({})

/** Cards whose Run here hasn't answered yet, by project and task key. */
const runningHere = atom<Record<string, true>>({})
/** The Run here of each card in `runningHere`, so a second press joins it. */
const hereRuns = new Map<string, Promise<void>>()

/** Whether the Prompt templates view's Variables list is open, while the panel is open. */
const variablesOpen = atom(false)

/** Whether "Filters", the filter row and Search tasks above the list, is open, while the panel is
 *  open. */
const filtersOpen = atom(true)

/** The key of a task's card in `cardTemplates` and `cardAgents`. */
const cardKey = (projectId: string, taskKey: string) => `${projectId}\n${taskKey}`

/** The template a Start or a Run here of the task uses: the one chosen on its card while the
 *  project still has it, else the project's default template. */
function chosenTemplateId(shown: ShownSettings, taskKey: string): string {
  const chosen = read(cardTemplates)[cardKey(shown.projectId, taskKey)]
  return shown.templates.some((template) => template.id === chosen) ? chosen : shown.defaultTemplateId
}

/** The options of a card's agent `Select`, those of Project settings' Agent with labels short
 *  enough for 96 px: "Default", each available agent by name, then "None", and `projectAgent`, the
 *  project's agent choice, by its id when it isn't available. Null, and no `Select`, with fewer than
 *  two available agents or none read. */
function cardAgentOptions(agents: AgentsResult | null, projectAgent: AgentChoice): AgentOption[] | null {
  if (agents?.kind !== 'ready' || agents.agents.length < 2) return null
  return agentChoiceOptions(agents.agents, projectAgent, { orcaDefault: 'Default', none: 'None', unavailable: (id) => id })
}

type AgentOption = { value: AgentChoice; label: string }

/** The options of an agent `Select`, Project settings' Agent or a card's, labelled by `labels`:
 *  Orca default, each of `listed` by name, No agent, then `chosen` when it is none of them. */
function agentChoiceOptions(
  listed: readonly AvailableAgent[],
  chosen: AgentChoice,
  labels: { orcaDefault: string; none: string; unavailable: (id: string) => string }
): AgentOption[] {
  const options = [
    { value: 'orca-default', label: labels.orcaDefault },
    ...listed.map((agent) => ({ value: agent.id, label: agent.name })),
    { value: 'none', label: labels.none }
  ]
  if (!options.some((option) => option.value === chosen)) options.push({ value: chosen, label: labels.unavailable(chosen) })
  return options
}

/** The agent a Start or a Run here of the task launches, given `available`, the agents Orca can
 *  start: the one chosen on its card while the card offers it, else the project's agent choice. */
function chosenAgent(shown: ShownSettings, taskKey: string, available: AgentsResult | null): AgentChoice {
  const chosen = read(cardAgents)[cardKey(shown.projectId, taskKey)]
  const offered = cardAgentOptions(available, shown.agent)?.some((option) => option.value === chosen) ?? false
  return offered ? chosen : shown.agent
}

/** The project's templates as `Select` options, the global ones marked. */
const templateOptions = (templates: ListedTemplate[]) =>
  templates.map((template) => ({ value: template.id, label: template.global ? `${template.name} (Global)` : template.name }))

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

/** The Prompt templates view's draft while it replaces the panel view, else null. */
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
 *  editor, and the branch settings through `changeBranch` and the Branch section's Global switch. */
type SettingsChange = Omit<ProjectChanges, keyof FilterSettings | keyof BranchSettings | 'branchSettingsUsed'>

function changeSettings(changes: SettingsChange): void {
  const current = read(shownSettings)
  if (!current) return
  if (changes.provider !== undefined || changes.providers !== undefined || changes.jiraProjectKey !== undefined) {
    trackerSettingsVersion++
    // A tracker search narrows the list the tracker settings give, which this changes.
    leaveTrackerSearch()
  }
  const providers = { ...current.providers, ...changes.providers }
  set(shownSettings, { ...current, ...changes, provider: changes.provider ?? current.provider, providers })
  settingsSave.change(current.projectId, changes)
}

/** Shows the stored settings of `project`, with the changes not saved yet, unless they are already
 *  shown: an edit of the global branch settings made in another project shows here before it is
 *  saved, so an edit here doesn't put back what it replaced. */
async function showSettings(project: ProjectRef): Promise<void> {
  if (read(shownSettings)?.projectId === project.id) return
  const stored = settingsSave.withPending(readSettings(await storage.get(SETTINGS_KEY)))
  const settings = projectSettings(stored, project.id)
  const global = globalTemplates(stored)
  const provider = projectProvider(settings, project)
  set(shownSettings, {
    projectId: project.id,
    provider,
    providers: settings.providers,
    jiraProjectKey: settings.jiraProjectKey ?? '',
    filterSettings: { filters: settings.filters, shownFilterId: settings.shownFilterId },
    globalFilters: globalSettings(stored).filters ?? {},
    agent: settings.agent ?? 'orca-default',
    templates: projectTemplates(settings, global),
    defaultTemplateId: defaultTemplate(settings, global).id,
    ...branchShownFor(settings, globalSettings(stored).branch),
    branchSwitch: BRANCH_SWITCH_IDLE
  })
}

/** Changes the Branch section as shown, and saves the whole section, through the settings saver,
 *  only while `branchSettingsProblem` finds nothing wrong with it: what it refuses is shown, with
 *  why, and the last section it accepted stays saved. It saves the global branch settings while
 *  the Global switch is on, else the project's own. The title exclusion pattern is saved only once
 *  it was changed from the initial one. Nothing changes while the switch writes. */
function changeBranch(changes: Partial<Omit<ShownBranch, 'titleExclusionSet'>>): void {
  const current = read(shownSettings)
  if (!current || current.branchSwitch.saving) return
  const titleExclusionSet = current.branch.titleExclusionSet || changes.titleExclusion !== undefined
  const branch: ShownBranch = { ...current.branch, ...changes, titleExclusionSet }
  if (branchSettingsProblem(branch) !== null) {
    set(shownSettings, { ...current, branch })
    return
  }
  const saved = savedBranch(branch)
  set(shownSettings, { ...current, branch, globalBranch: current.branchGlobal ? saved : current.globalBranch })
  if (current.branchGlobal) settingsSave.changeGlobalBranch(saved)
  else settingsSave.change(current.projectId, saved)
}

/** Changes the Branch section's Global switch, while `projectId` is still the project shown. */
function changeBranchSwitch(projectId: string, changes: Partial<BranchSwitch>): void {
  update(shownSettings, (shown) => (shown?.projectId === projectId ? { ...shown, branchSwitch: { ...shown.branchSwitch, ...changes } } : shown))
}

/** The Branch section's Global switch. Off: the project gets a copy of the global branch settings
 *  as its own, at once, since none of its branches change. On: with no global ones stored, the bar
 *  under the view asks before the project's own become them; with some, it asks before the
 *  project's own are dropped for them, unless they are the same. Turning it back while the bar asks
 *  closes the bar. */
function switchBranchGlobal(on: boolean): void {
  const shown = read(shownSettings)
  if (!shown || shown.branchSwitch.saving) return
  if (on === shown.branchGlobal) {
    changeBranchSwitch(shown.projectId, { asking: null })
    return
  }
  if (!on) {
    void writeBranchSwitch(shown.projectId, false)
    return
  }
  const { globalBranch } = shown
  if (globalBranch !== undefined && sameBranchSettings(savedBranch(shown.branch), globalBranch)) {
    void writeBranchSwitch(shown.projectId, true)
    return
  }
  changeBranchSwitch(shown.projectId, { asking: globalBranch === undefined ? 'publish' : 'adopt', error: null, copied: false })
}

/** Make global, or Use global, in the bar that asks before the Global switch turns on. Make global
 *  waits for a Branch section git can hold, since it makes the section the global one. */
function confirmBranchGlobal(): void {
  const shown = read(shownSettings)
  if (!shown || shown.branchSwitch.asking === null || shown.branchSwitch.saving) return
  if (shown.branchSwitch.asking === 'publish' && branchSettingsProblem(shown.branch) !== null) return
  void writeBranchSwitch(shown.projectId, true)
}

/** Turns the project's Global switch to `on` through the settings saver: the project's settings
 *  and the global branch settings in one write, computed from them as stored, after the pending
 *  changes. Then shows the Branch section as written, or, when the write fails, why, with nothing
 *  changed. */
async function writeBranchSwitch(projectId: string, on: boolean): Promise<void> {
  const what = !on
    ? 'give this project its own branch settings'
    : read(shownSettings)?.globalBranch === undefined
      ? 'make these branch settings global'
      : 'use the global branch settings'
  changeBranchSwitch(projectId, { asking: null, saving: true, error: null, copied: false })
  let written: { project: ProjectSettings; global: BranchSettings | undefined }
  try {
    written = await settingsSave.writeProjectAndGlobal(projectId, (project, global) => {
      const write = withBranchSwitched(project, global.branch, on)
      if (!write) return { answer: { project, global: global.branch } }
      return { answer: { project: { ...project, ...write.project }, global: write.global?.branch ?? global.branch }, ...write }
    })
  } catch (error) {
    changeBranchSwitch(projectId, { saving: false, error: `Couldn't ${what} (${errorCode(error)}). Try again.` })
    return
  }
  const shown = read(shownSettings)
  if (shown?.projectId !== projectId) return
  set(shownSettings, { ...shown, ...branchShownFor(written.project, written.global), branchSwitch: { ...BRANCH_SWITCH_IDLE, copied: !on } })
}

/** The filters the shown project lists on its tracker, its own then the global ones, and the one the
 *  filter row shows, or null while the project has no tracker. */
type TrackerFilters = { tracker: TrackerId; filters: ListedFilter[]; shownFilterId: string }

function trackerFilters(shown: ShownSettings): TrackerFilters | null {
  if (shown.provider === null) return null
  const tracker = trackerOf(shown.provider)
  return { tracker, filters: listedFilters(shown, tracker), shownFilterId: listedFilter(shown.filterSettings, tracker, shownGlobalFilters(shown, tracker)).id }
}

/** The global filters of `tracker`, as the shown project last read or wrote them. */
const shownGlobalFilters = (shown: ShownSettings, tracker: TrackerId): Filter[] => shown.globalFilters[tracker] ?? []

/** The filters the shown project lists on `tracker`: its own, then the global ones. */
const listedFilters = (shown: ShownSettings, tracker: TrackerId): ListedFilter[] =>
  projectFilters(shown.filterSettings, tracker, shownGlobalFilters(shown, tracker))

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
 *  on a new one: named "Filter 2", "Filter 3"… with one new query, or with the name and queries of
 *  `recipe`, the name made free. `loadError` is the failed load that opened it. On Linear it asks
 *  for what the Linear query form offers: the teams, and the lists of each team its queries name. */
function openFilter(id: string | null, loadError: string | null = null, recipe: FilterRecipe | null = null): void {
  const shown = read(shownSettings)
  const current = shown ? trackerFilters(shown) : null
  if (!shown || !current) return
  const filter = id === null ? null : current.filters.find((candidate) => candidate.id === id)
  if (id !== null && !filter) return
  const queries = draftQueries(current.tracker, filter ? filter.queries : recipe ? recipe.queries : [])
  closeTemplate()
  set(newFilterChoice, null)
  set(filterDraft, {
    projectId: shown.projectId,
    tracker: current.tracker,
    id: filter?.id ?? newId('f', current.filters),
    isNew: !filter,
    global: filter?.global ?? false,
    confirmingOwn: false,
    name: filter?.name ?? (recipe ? recipeFilterName(current.filters, recipe.name) : newFilterName(current.filters)),
    queries,
    loadError,
    error: null,
    saving: false,
    confirmingDelete: false
  })
  if (current.tracker !== 'linear') return
  const workspaceId = linearWorkspace(shown)
  void loadLinearChoices(workspaceId)
  for (const team of new Set(queries.map((query) => readLinearQuery(query).team))) if (team !== undefined) void loadLinearChoices(workspaceId, team)
}

/** `queries` as the filter editor's draft holds them on `tracker`: one new query when there are
 *  none, and, where each query is a form, a new query in place of each blank one, since the form
 *  shows a blank one as every default, which runs, while a blank query never does. */
function draftQueries(tracker: TrackerId, queries: readonly string[]): string[] {
  const wording = QUERY_WORDING[tracker]
  if (queries.length === 0) return [wording.fresh]
  return queries.map((query) => (wording.form && query.trim() === '' ? wording.fresh : query))
}

/** + in the filter row: on Jira, the choice of a blank filter or a JQL recipe, in place of the panel
 *  view, with fresh answers, Board order's Jira project key starting as the project's own;
 *  on GitHub and Linear, the filter editor on a new filter, whose recipes are in it. */
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
  set(newFilterChoice, { projectId: shown.projectId, kind: 'custom', projectKey: shown.jiraProjectKey, assignees: 'mine-or-unassigned', leaveOut: 'Done' })
}

/** Changes the choice of +, while it is still open on the project `expected` was made for. */
function changeNewFilterChoice(expected: NewFilterChoice, changes: Partial<NewFilterChoice>): void {
  update(newFilterChoice, (choice) => (choice && choice.projectId === expected.projectId ? { ...choice, ...changes } : choice))
}

/** The name and queries the choice of + writes: null for a blank filter, or undefined while its
 *  recipe lacks an answer it needs. Board order names the project's Jira project key as
 *  `{{jira_project}}` while its answer is that key. */
function chosenRecipe(choice: NewFilterChoice): FilterRecipe | null | undefined {
  switch (choice.kind) {
    case 'custom':
      return null
    case 'board-order': {
      const answers: JqlRecipeAnswers = { recipe: 'board-order', projectKey: choice.projectKey, assignees: choice.assignees, leaveOut: choice.leaveOut }
      return jqlRecipe(answers, read(shownSettings)?.jiraProjectKey ?? '') ?? undefined
    }
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

/** Stores the draft's filter, among the global ones when Global is on, else among the project's
 *  own, unless its name can't be saved, then goes back to the view the editor replaced and loads
 *  the filter's tasks. */
async function saveFilter(): Promise<void> {
  const draft = read(filterDraft)
  const shown = read(shownSettings)
  if (!draft || draft.saving || shown?.projectId !== draft.projectId) return
  if (filterNameProblem(listedFilters(shown, draft.tracker), draft.name, draft.id, draft.global) !== null) return
  const filter = { id: draft.id, name: draft.name, queries: draft.queries }
  await writeFilters(draft, (project, global) => withFilterSaved(project, draft.tracker, global, filter, draft.global))
}

/** The first click asks for a second within a few seconds; the second deletes the filter, then
 *  goes back to the view the editor replaced and loads the tasks of the filter it shows. */
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
  await writeFilters(draft, (project, global) => withFilterDeleted(project, draft.tracker, global, draft.id))
}

/** What a write of filters on a tracker stored: the project's own filters with the one each
 *  tracker shows, and every tracker's global filters. */
type FiltersWritten = { project: FilterSettings; global: ByTracker<Filter[]> }

/** Writes the write `compute` gives from the draft project's settings and the global filters of its
 *  tracker as stored, through the settings saver, in one write of both. Answers its `answer` with
 *  what it stored, or with null when it gives no write, which writes nothing. */
function writeFilterChange<T>(
  draft: FilterDraft,
  compute: (project: ProjectSettings, global: Filter[]) => { answer: T; write: FilterWrite | null }
): Promise<{ answer: T; written: FiltersWritten | null }> {
  return settingsSave.writeProjectAndGlobal<{ answer: T; written: FiltersWritten | null }>(draft.projectId, (project, global) => {
    const { answer, write } = compute(project, global.filters?.[draft.tracker] ?? [])
    if (!write) return { answer: { answer, written: null } }
    const changes = filterWriteChanges(global, draft.tracker, write)
    return { answer: { answer, written: { project: write.project, global: changes.global.filters ?? {} } }, ...changes }
  })
}

/** Shows the filters a write stored, while the project is still the one shown. */
function showWrittenFilters(projectId: string, written: FiltersWritten): void {
  const shown = read(shownSettings)
  if (shown?.projectId === projectId) set(shownSettings, { ...shown, filterSettings: written.project, globalFilters: written.global })
}

/** Writes a change to the draft project's filters and the global ones of its tracker, then shows
 *  them, goes back to the view the editor replaced and loads the list. That view is the list, or
 *  Project settings when they were open, and Project settings still open by themselves when a load
 *  needs them. A failed write keeps the editor open with its error and the draft. Pending Project
 *  settings are saved first, so the change applies to what the person sees. */
async function writeFilters(draft: FilterDraft, change: (project: ProjectSettings, global: Filter[]) => FilterWrite | null): Promise<void> {
  changeFilterDraft(draft, { saving: true, error: null, confirmingDelete: false, confirmingOwn: false })
  let written: FiltersWritten | null
  try {
    const done = await writeFilterChange(draft, (project, global) => ({ answer: null, write: change(project, global) }))
    written = done.written
  } catch (error) {
    changeFilterDraft(draft, { saving: false, error: `Couldn't save the filter (${errorCode(error)}). Try again.` })
    return
  }
  if (written) showWrittenFilters(draft.projectId, written)
  const current = read(filterDraft)
  if (!current || !isSameDraft(current, draft)) return
  set(filterDraft, null)
  if (!written) return
  leaveTrackerSearch()
  await load()
}

/** The filter editor's Global switch: on a new filter, where Save stores it. On a stored one,
 *  turning it on moves the filter to the global ones of its tracker at once; turning it off asks
 *  first, in the bar under the form, and turning it on again while it asks keeps it global. */
function switchFilterGlobal(expected: FilterDraft, on: boolean): void {
  const draft = read(filterDraft)
  if (!draft || !isSameDraft(draft, expected) || draft.saving) return
  if (draft.isNew) {
    changeFilterDraft(draft, { global: on, error: null })
    return
  }
  cancelConfirmDelete()
  if (draft.global) {
    changeFilterDraft(draft, { confirmingOwn: !on, confirmingDelete: false, error: null })
    return
  }
  if (on) void moveFilter(draft, true)
}

/** Confirm, in the bar that asks before Global is turned off: moves the filter to the project. */
function confirmFilterOwn(): void {
  const draft = read(filterDraft)
  if (draft?.confirmingOwn && !draft.saving) void moveFilter(draft, false)
}

/** Moves the draft's filter, as stored, to the global ones of its tracker or to the project, in one
 *  write, and keeps the editor open on it. The name and queries typed stay in the draft for Save. A
 *  move refused, because the destination has the name, or a failed write, changes nothing and shows
 *  why. The filter keeps its id, unless it is the initial filter made global: then the filter shown
 *  follows the new id. */
async function moveFilter(draft: FilterDraft, toGlobal: boolean): Promise<void> {
  changeFilterDraft(draft, { saving: true, error: null, confirmingDelete: false, confirmingOwn: false })
  const shown = read(shownSettings)
  const freshId = newId('f', shown ? listedFilters(shown, draft.tracker) : [])
  let moved: { answer: FilterMove; written: FiltersWritten | null }
  try {
    moved = await writeFilterChange<FilterMove>(draft, (project, global) => {
      const move = withFilterMoved(project, draft.tracker, global, draft.id, toGlobal, freshId)
      return { answer: move, write: move.ok ? move.write : null }
    })
  } catch (error) {
    changeFilterDraft(draft, { saving: false, error: `Couldn't move the filter (${errorCode(error)}). Try again.` })
    return
  }
  const { answer, written } = moved
  if (!answer.ok) {
    changeFilterDraft(draft, { saving: false, error: answer.message })
    return
  }
  if (written) showWrittenFilters(draft.projectId, written)
  const { id } = answer
  update(filterDraft, (current) => (current && isSameDraft(current, draft) ? { ...current, id, global: toGlobal, saving: false } : current))
}

/** Opens the Prompt templates view, in place of the panel view, on the shown project's default
 *  template. Cancel and Save go back to `origin`. */
function openTemplates(origin: TemplatesOrigin): void {
  const shown = read(shownSettings)
  if (shown) openTemplate(shown.defaultTemplateId, origin)
}

/** Opens the Prompt templates view on one of the shown project's templates, or on a new one, with
 *  a fresh draft. Cancel and Save go back to `origin`. Answers false, opening nothing, when the
 *  project no longer lists that template. */
function openTemplate(id: string | null, origin: TemplatesOrigin): boolean {
  const shown = read(shownSettings)
  if (!shown) return false
  const template = id === null ? null : shown.templates.find((candidate) => candidate.id === id)
  if (id !== null && !template) return false
  closeFilter()
  cancelConfirmDelete()
  set(templateDraft, {
    projectId: shown.projectId,
    origin,
    id: template?.id ?? newId('t', shown.templates),
    isNew: !template,
    ...(template ? templateFields(template, shown) : NEW_TEMPLATE_FIELDS),
    confirmingOwn: false,
    discarding: null,
    error: null,
    saving: false,
    confirmingDelete: false
  })
  return true
}

/** What Save stores of a template, as the view's draft holds it. */
type TemplateFields = Pick<TemplateDraft, 'name' | 'text' | 'global' | 'isDefault'>

/** A new template as it opens. */
const NEW_TEMPLATE_FIELDS: TemplateFields = { name: '', text: INITIAL_TEMPLATE_TEXT, global: false, isDefault: false }

/** A listed template as Save would store it again. */
const templateFields = (template: ListedTemplate, shown: ShownSettings): TemplateFields => ({
  name: template.name,
  text: template.text,
  global: template.global,
  isDefault: template.id === shown.defaultTemplateId
})

/** The draft's template as the shown project lists it, or undefined for a new one or one gone. */
const storedTemplate = (draft: TemplateDraft, shown: ShownSettings): ListedTemplate | undefined =>
  draft.isNew ? undefined : shown.templates.find((template) => template.id === draft.id)

/** Whether the draft differs from its template as stored, the Global, Default template and New
 *  worktree switches included, or, for a new one, from a new template as it opens. */
function templateChanged(draft: TemplateDraft, shown: ShownSettings): boolean {
  const stored = storedTemplate(draft, shown)
  const before = stored ? templateFields(stored, shown) : NEW_TEMPLATE_FIELDS
  return (Object.keys(before) as (keyof TemplateFields)[]).some((field) => draft[field] !== before[field])
}

/** The view's Template `Select`, or + (`id: null`): opens that template at once, or, while the
 *  draft has changes, asks first, in the bar under the form. */
function chooseTemplate(id: string | null): void {
  const draft = read(templateDraft)
  const shown = read(shownSettings)
  if (!draft || draft.saving || draft.discarding || shown?.projectId !== draft.projectId) return
  if (id !== null && id === draft.id) return
  if (!templateChanged(draft, shown)) {
    openTemplate(id, draft.origin)
    return
  }
  cancelConfirmDelete()
  changeTemplateDraft(draft, { discarding: { id }, confirmingOwn: false, confirmingDelete: false })
}

/** Keep editing, in the bar that asks before the draft's changes are dropped. */
function keepEditing(): void {
  const draft = read(templateDraft)
  if (draft?.discarding) changeTemplateDraft(draft, { discarding: null })
}

/** Discard, in the bar that asks before the draft's changes are dropped: opens the template chosen,
 *  or the default template when it is gone meanwhile. */
function discardTemplateChanges(): void {
  const draft = read(templateDraft)
  if (!draft?.discarding) return
  if (!openTemplate(draft.discarding.id, draft.origin)) openTemplates(draft.origin)
}

/** Leaves the Prompt templates view for the view it was opened from: Project settings, kept open
 *  also when a load meanwhile listed the tasks, or the task list, where Project settings still open
 *  by themselves when a load needs them. */
function leaveTemplates(draft: TemplateDraft): void {
  closeTemplate()
  if (draft.origin === 'settings') openSettings()
}

/** Cancel: leaves the view without saving. */
function cancelTemplates(): void {
  const draft = read(templateDraft)
  if (draft && !draft.saving) leaveTemplates(draft)
}

/** An id, starting with `prefix`, that none of `items` has. */
function newId(prefix: string, items: { id: string }[]): string {
  for (;;) {
    const id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!items.some((item) => item.id === id)) return id
  }
}

/** Changes the Prompt templates view's draft, while it is still the draft of the `expected` template. */
function changeTemplateDraft(expected: TemplateDraft, changes: Partial<TemplateDraft>): void {
  update(templateDraft, (draft) => (draft && isSameDraft(draft, expected) ? { ...draft, ...changes } : draft))
}

/** Whether two drafts are of the same template, or the same filter, of the same project. */
const isSameDraft = (a: { projectId: string; id: string }, b: { projectId: string; id: string }) => a.projectId === b.projectId && a.id === b.id

/** Drops the Prompt templates view's draft, which closes the view. */
function closeTemplate(): void {
  cancelConfirmDelete()
  set(templateDraft, null)
}

/** Save: stores the draft's name, text, Global and Default template in one write,
 *  then goes back to the view it was opened from, unless its name can't be saved or the bar under
 *  the form is asking a question. A template whose Global changed moves; a move refused, because the destination has the name, or a failed write, changes nothing
 *  and keeps the draft with the reason. Pending Project settings are saved first, so the change
 *  applies to what the person sees. The template keeps its id, unless it is the initial template
 *  made global: then the default template and the cards that chose it follow the new id. */
async function saveTemplate(): Promise<void> {
  const draft = read(templateDraft)
  const shown = read(shownSettings)
  if (!draft || draft.saving || draft.confirmingOwn || draft.discarding || shown?.projectId !== draft.projectId) return
  if (templateNameProblem(shown.templates, draft.name, draft.id, draft.global) !== null) return
  cancelConfirmDelete()
  changeTemplateDraft(draft, { saving: true, error: null, confirmingDelete: false })
  const template: PromptTemplate = { id: draft.id, name: draft.name, text: draft.text }
  const options = { isGlobal: draft.global, isDefault: draft.isDefault, freshId: newId('t', shown.templates) }
  let saved: TemplateSave
  try {
    saved = await settingsSave.writeProjectAndGlobal<TemplateSave>(draft.projectId, (project, global) => {
      const save = withTemplateSaved(project, global.templates ?? [], template, options)
      return save.ok ? { answer: save, ...save.write } : { answer: save }
    })
  } catch (error) {
    changeTemplateDraft(draft, { saving: false, error: `Couldn't save the template (${errorCode(error)}). Try again.` })
    return
  }
  if (!saved.ok) {
    changeTemplateDraft(draft, { saving: false, error: saved.message })
    return
  }
  showTemplates(draft.projectId, saved.write)
  if (saved.id !== draft.id) followTemplate(draft.projectId, draft.id, saved.id)
  const current = read(templateDraft)
  if (current && isSameDraft(current, draft)) leaveTemplates(current)
}

/** Points the cards of `projectId` that chose the template `from` at `to`, its new id. */
function followTemplate(projectId: string, from: string, to: string): void {
  const prefix = cardKey(projectId, '')
  update(cardTemplates, (chosen) => Object.fromEntries(Object.entries(chosen).map(([key, value]) => [key, key.startsWith(prefix) && value === from ? to : value])))
}

/** The pending end of a Delete's wait for its second click. */
let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null

/** The first click asks for a second within a few seconds; the second deletes the template as
 *  stored, and the view stays open on the project's default template, which is the first listed
 *  when the default was the one deleted. A failed write keeps the draft with the error. Pending
 *  Project settings are saved first, so the change applies to what the person sees. */
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
  changeTemplateDraft(draft, { saving: true, error: null, confirmingDelete: false, confirmingOwn: false })
  let written: TemplateWrite | null
  try {
    written = await settingsSave.writeProjectAndGlobal(draft.projectId, (project, global) => {
      const write = withTemplateDeleted(project, global.templates ?? [], draft.id)
      return write ? { answer: write, ...write } : { answer: null }
    })
  } catch (error) {
    changeTemplateDraft(draft, { saving: false, error: `Couldn't delete the template (${errorCode(error)}). Try again.` })
    return
  }
  if (written) showTemplates(draft.projectId, written)
  const current = read(templateDraft)
  if (!current || !isSameDraft(current, draft)) return
  if (written) openTemplates(current.origin)
  else changeTemplateDraft(current, { saving: false })
}

/** Stops waiting for Delete's second click. */
function cancelConfirmDelete(): void {
  if (confirmDeleteTimer !== null) clearTimeout(confirmDeleteTimer)
  confirmDeleteTimer = null
}

/** Shows the templates a write stored, while the project is still the one shown. */
function showTemplates(projectId: string, written: TemplateWrite): void {
  const shown = read(shownSettings)
  if (shown?.projectId !== projectId) return
  const global = written.global.templates
  set(shownSettings, { ...shown, templates: projectTemplates(written.project, global), defaultTemplateId: defaultTemplate(written.project, global).id })
}

/** The Global switch, kept in the draft for Save. Turning it off on a template stored among the
 *  global ones asks first, in the bar under the form, and turning it on again while it asks keeps it
 *  global. */
function switchGlobal(expected: TemplateDraft, on: boolean): void {
  const draft = read(templateDraft)
  const shown = read(shownSettings)
  if (!draft || !isSameDraft(draft, expected) || draft.saving) return
  cancelConfirmDelete()
  const storedGlobal = shown?.projectId === draft.projectId && storedTemplate(draft, shown)?.global === true
  if (!on && draft.global && storedGlobal) {
    changeTemplateDraft(draft, { confirmingOwn: true, confirmingDelete: false, error: null })
    return
  }
  changeTemplateDraft(draft, { global: on, confirmingOwn: false, confirmingDelete: false, error: null })
}

/** Confirm, in the bar that asks before Global is turned off: turns it off in the draft, so Save
 *  moves the template to the project. */
function confirmOwn(): void {
  const draft = read(templateDraft)
  if (draft?.confirmingOwn && !draft.saving) changeTemplateDraft(draft, { global: false, confirmingOwn: false })
}

/** The Default template switch, kept in the draft for Save. */
function switchDefault(expected: TemplateDraft, on: boolean): void {
  const draft = read(templateDraft)
  if (!draft || !isSameDraft(draft, expected) || draft.saving) return
  cancelConfirmDelete()
  changeTemplateDraft(draft, { isDefault: on, confirmingDelete: false, error: null })
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

/** Asks for what the Linear query form offers in the workspace `workspaceId`, with the states and
 *  labels of the team `team` unless it is '', unless that is being asked for. The teams aren't asked
 *  for again once some are listed: after a failure or with none listed, the person may have
 *  connected Linear since. A team's lists are asked for again each time, so a team chosen again
 *  shows its lists as they are now. The answers for another workspace are dropped when one for this
 *  one is asked for, and an answer for another workspace than the last one asked for is dropped. */
async function loadLinearChoices(workspaceId: string, team = ''): Promise<void> {
  const current = read(linearChoices)
  const asked = current?.workspaceId === workspaceId ? current.answers[team] : undefined
  if (asked === 'loading' || (team === '' && asked?.kind === 'ready' && asked.teams.length > 0)) return
  set(linearChoices, { workspaceId, answers: { ...(current?.workspaceId === workspaceId ? current.answers : {}), [team]: 'loading' } })
  let answer: LinearChoicesResult
  try {
    answer = await plugin.request('linear.choices', team === '' ? { workspaceId } : { workspaceId, team })
  } catch (error) {
    answer = { kind: 'error', message: `Kickoff's worker didn't answer (${errorCode(error)}).` }
  }
  const latest = read(linearChoices)
  if (latest?.workspaceId === workspaceId) set(linearChoices, { workspaceId, answers: { ...latest.answers, [team]: answer } })
}

/** The workspace the shown project's Linear filters read: '' for the one Orca picks. */
const linearWorkspace = (shown: ShownSettings): string => providerConfig({ providers: shown.providers }, 'linear-orca').workspaceId

/** Asks for the agents Orca can start, and keeps the last answer shown until the new one arrives.
 *  A worker that doesn't answer counts as agents that can't be read. */
async function loadAgents(): Promise<void> {
  const mine = ++agentsAsked
  let answer: AgentsResult
  try {
    answer = await plugin.request('agents.load', {})
  } catch (error) {
    answer = { kind: 'error', message: `Kickoff's worker didn't answer (${errorCode(error)}).` }
  }
  if (mine === agentsAsked) set(availableAgents, answer)
}

/** Asks for Kickoff's version the first time Project settings opens, and keeps the answer while
 *  the panel is open. A worker that doesn't answer counts as no version. */
async function askAbout(): Promise<void> {
  if (read(shownAbout) !== 'unasked') return
  set(shownAbout, 'asking')
  let answer: About | null
  try {
    answer = await plugin.request('about.load', {})
  } catch {
    answer = null
  }
  set(shownAbout, answer)
}

/** Opens Project settings, reading Orca's agents again: one may have been turned off in Orca. */
function openSettings(): void {
  set(settingsChoice, 'open')
  void loadAgents()
  void askAbout()
}

/** Lists the active project's tasks, or runs the tracker search shown again. `poll` says the poll
 *  asked for it, so the poll's last answer stays the measure for the next one. */
async function load(reason: 'poll' | 'other' = 'other'): Promise<void> {
  const shownSearch = read(trackerSearch)
  if (shownSearch !== null) return searchTracker(shownSearch.query, reason)
  const mine = startLoading()
  const { answer, askedAt, worktreesAskedAt, savedTrackerSettings } = await askTasks({})
  if (mine !== generation) return
  // A change of active project drops the Prompt templates view's draft and the filter editor's. An answer
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
    // A load may open Project settings by itself, and a load after the poll saw the active project
    // change may find the active worktree on another host.
    void loadAgents()
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
  // Project settings may open by itself with this answer: only one that names a project.
  if ('project' in answer && answer.project && read(settingsChoice) === 'auto' && needsSettings(answer)) void askAbout()
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

/** What a Start or a Run here of the task asks the worker: what its card shows, the template and
 *  the agent chosen for it. */
function launchOf(shown: ShownSettings, task: Task): LaunchRequest {
  return { projectId: shown.projectId, task, templateId: chosenTemplateId(shown, task.key), agent: chosenAgent(shown, task.key, read(availableAgents)) }
}

/** Saves pending settings, then asks the worker to start the task with the template and agent
 *  chosen for it. A failed save asks the worker nothing, so the task didn't start. */
async function askStart(projectId: string, task: Task): Promise<StartResult> {
  try {
    await settingsSave.saveNow()
  } catch (error) {
    return { ok: false, message: `Couldn't save Project settings (${errorCode(error)}), so ${task.key} didn't start. Try again.` }
  }
  try {
    const shown = await settingsShownFor(projectId)
    if (!shown.ok) return shown
    return await plugin.request('task.start', launchOf(shown.settings, task), { timeoutMs: START_TIMEOUT_MS })
  } catch (error) {
    return { ok: false, message: `Kickoff's worker didn't answer (${errorCode(error)}). Reload the tasks to see whether ${task.key} started.` }
  }
}

/** Runs the task here with its card's template, or joins the Run here of the card still running,
 *  so two presses launch one agent. The card shows a spinner until the worker answers, then a
 *  failure's message. Kickoff keeps no record of it: a worktree the agent links to the task shows
 *  through the worktree refresh. */
function runTaskHere(task: Task): Promise<void> {
  const projectId = readyProjectId()
  if (!projectId) return Promise.resolve()
  const key = cardKey(projectId, task.key)
  const running = hereRuns.get(key)
  if (running) return running
  update(runningHere, (keys): Record<string, true> => ({ ...keys, [key]: true as const }))
  setTaskError(task.key, null)
  const run = askRunHere(projectId, task).then((answer) => {
    // A panel opened again since then has its own Run heres, which this one must not end.
    if (hereRuns.get(key) !== run) return
    hereRuns.delete(key)
    update(runningHere, ({ [key]: _, ...rest }) => rest)
    if (!answer.ok && readyProjectId() === projectId) setTaskError(task.key, answer.message)
  })
  hereRuns.set(key, run)
  return run
}

/** Saves pending settings, then asks the worker to run the task here with the template and agent
 *  chosen for it. A failed save asks the worker nothing. Never rejects. */
async function askRunHere(projectId: string, task: Task): Promise<ActionResult> {
  try {
    await settingsSave.saveNow()
  } catch (error) {
    return { ok: false, message: `Couldn't save Project settings (${errorCode(error)}), so ${task.key} didn't run here. Try again.` }
  }
  try {
    const shown = await settingsShownFor(projectId)
    if (!shown.ok) return shown
    return await plugin.request('task.runHere', launchOf(shown.settings, task), { timeoutMs: RUN_HERE_TIMEOUT_MS })
  } catch (error) {
    return { ok: false, message: `Kickoff's worker didn't answer (${errorCode(error)}). Look in Orca whether an agent started for ${task.key}.` }
  }
}

/** The listed project's settings as shown, read again when a load couldn't read them, or why they
 *  can't be read: a Start or a Run here needs its template's id, and never falls back to another. */
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
  set(cardAgents, {})
  set(runningHere, {})
  hereRuns.clear()
  set(templateDraft, null)
  set(filterDraft, null)
  set(newFilterChoice, null)
  set(variablesOpen, false)
  set(filtersOpen, true)
  set(settingsChoice, 'auto')
  // An answer still on its way to the panel closed before is dropped.
  agentsAsked++
  set(availableAgents, null)
  viewStateFor = undefined
  set(fieldText, '')
  set(trackerSearch, null)
  set(settingsSaveError, null)
  // Closing the panel drops the Prompt templates view's draft and the filter editor's.
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
    return <TemplatesView draft={draft} shown={shown} projectName={project?.name ?? ''} />
  }
  const filterEdit = read(filterDraft)
  if (filterEdit && shown?.projectId === filterEdit.projectId) {
    return (
      <FilterEditor
        draft={filterEdit}
        filters={listedFilters(shown, filterEdit.tracker)}
        jiraProjectKey={shown.jiraProjectKey}
        linearWorkspaceId={linearWorkspace(shown)}
        projectName={project?.name ?? ''}
      />
    )
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
 *  reason other than a filter's query, which opens the filter editor instead, or than a missing
 *  Jira project key, which the list asks for. */
const needsSettings = (current: TaskList | null) =>
  current?.kind === 'needs-config' || (current?.kind === 'error' && current.filterId === undefined && current.needsJiraProjectKey !== true)

/** The panel's title, since its tab shows only its icon, and its actions. `gear` shows the buttons
 *  that open the Prompt templates view and Project settings. */
function Header({ projectName, gear }: { projectName: string | null; gear: boolean }) {
  return (
    <TitleRow prefix={projectName !== null ? 'Kickoff ·' : null} title={projectName ?? 'Kickoff'} level={2}>
      <Row gap="xs" align="center">
        {read(loading) && read(list) ? <Spinner label="Reloading tasks" labelHidden /> : null}
        <IconButton icon="refresh" label="Reload tasks" tooltip="Reload tasks" size="sm" variant="ghost" onPress={() => void load()} />
        {gear ? (
          <IconButton icon="layers" label="Prompt templates" tooltip="Prompt templates" size="sm" variant="ghost" onPress={() => openTemplates('list')} />
        ) : null}
        {gear ? (
          <IconButton icon="settings" label="Project settings" tooltip="Project settings" size="sm" variant="ghost" onPress={openSettings} />
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

/** Project settings, in place of the panel view: the tracker, then what a Start uses. The title row
 *  and the bar under the sections stay in place while the sections between them scroll. That bar
 *  says which field keeps the Branch section from being saved, shows the section's preview, and asks
 *  before the section's Global switch turns on, or, while it is on, warns that the section edits the
 *  global branch settings. */
function SettingsView({ projectName, shown }: { projectName: string; shown: ShownSettings }) {
  return (
    <Box direction="column" gap="sm" height="100%">
      <TitleRow prefix={`${projectName} ·`} title="Project settings" level={3}>
        <Button key="settings-done" size="sm" variant="solid" onPress={closeSettings}>
          Done
        </Button>
      </TitleRow>
      <SettingsSaveError />
      <Box direction="column" gap="sm" grow minHeight={0} maxHeight="100%" scroll="y">
        <Text size="sm" weight="semibold">
          Tracker
        </Text>
        <TrackerFields shown={shown} />
        <Separator />
        <Text size="sm" weight="semibold">
          Start
        </Text>
        <StartFields shown={shown} />
        <Separator />
        <Text size="sm" weight="semibold">
          Branch
        </Text>
        <BranchFields shown={shown} />
      </Box>
      <SettingsBar shown={shown} />
    </Box>
  )
}

/** How the bar under Project settings names the field that keeps the Branch section from being saved. */
const BRANCH_PROBLEM_FIELDS: Record<BranchSettingsProblem['field'], string> = {
  branchTemplate: 'branch template',
  branchTypeFallback: 'fallback branch type',
  titleExclusion: 'title exclusion pattern'
}

/** Under Project settings, in view however far the sections scroll: which field keeps the Branch
 *  section from being saved, if one does, then the section's preview, then the row that asks before
 *  its Global switch turns on, or, while it is on, the warning that the section edits the global
 *  branch settings. */
function SettingsBar({ shown }: { shown: ShownSettings }) {
  const problem = branchSettingsProblem(shown.branch)
  return (
    <Box direction="column" gap="xs" shrink={false}>
      {problem !== null ? (
        <Callout tone="danger" icon="error">
          <Text size="sm">{`Branch settings not saved until the ${BRANCH_PROBLEM_FIELDS[problem.field]} is fixed.`}</Text>
        </Callout>
      ) : null}
      <BranchPreview shown={shown} problem={problem} />
      {branchGlobalBar(shown, problem)}
      <VersionLine />
    </Box>
  )
}

/** One centred, muted line: Kickoff's version, once the worker has answered with one, then a link
 *  to Kickoff's repository so a user can star it. The link shows from the start, also while the
 *  worker hasn't answered and when it answers with no version. A development plugin says so,
 *  since its version can match a release's. */
function VersionLine() {
  const about = read(shownAbout)
  const known = about !== 'unasked' && about !== 'asking' && about !== null
  const version = known ? (about.development ? `Kickoff ${about.version} · development` : `Kickoff ${about.version}`) : null
  return (
    <Box direction="row" justify="center">
      <Text size="xs" muted>
        {version !== null ? `${version} · ` : null}
        <Link href={KICKOFF_REPOSITORY_URL}>★ Star on GitHub</Link>
      </Text>
    </Box>
  )
}

/** The row that asks before the Branch section's Global switch turns on, saying why Make global
 *  waits while `problem` keeps the section from being saved, or, while the switch is on, the
 *  warning that the section edits the global branch settings; else nothing. */
function branchGlobalBar(shown: ShownSettings, problem: BranchSettingsProblem | null): OrcaNode | null {
  const { asking, saving } = shown.branchSwitch
  if (asking !== null) {
    const publish = asking === 'publish'
    const waits = publish && problem !== null
    return (
      <Box direction="row" justify="end" align="center" gap="xs">
        <Text size="sm" tone={waits ? 'danger' : 'warning'}>
          {waits
            ? 'Fix the branch settings to make them global.'
            : publish
              ? 'Projects without their own branch settings will name branches this way.'
              : "This project's own branch settings are discarded."}
        </Text>
        <Button key="branch-global-cancel" size="sm" variant="ghost" disabled={saving} onPress={() => switchBranchGlobal(false)}>
          {publish ? 'Cancel' : 'Keep own'}
        </Button>
        <Button
          key="branch-global-confirm"
          size="sm"
          variant="solid"
          disabled={saving || waits}
          onPress={confirmBranchGlobal}
        >
          {publish ? 'Make global' : 'Use global'}
        </Button>
      </Box>
    )
  }
  if (!shown.branchGlobal) return null
  // No count of projects: those Kickoff has never opened use the global branch settings too.
  return (
    <Callout tone="warning" icon="warning" title="Editing the global branch settings.">
      <Text size="sm">
        Changes how every project that uses them names the branches and worktrees of its next Starts. Task worktrees already started keep their branches.
      </Text>
    </Callout>
  )
}

/** The first loaded task of the filter shown, for the Branch section's preview, or null when the
 *  shown project has none loaded. */
function firstLoadedTask(projectId: string): Task | null {
  const current = read(list)
  return current?.kind === 'ready' && current.project.id === projectId ? (current.tasks[0] ?? null) : null
}

/** Why the Branch section isn't saved, under the field to fix for it, marked invalid. */
function BranchProblemText({ problem, field }: { problem: BranchSettingsProblem | null; field: BranchSettingsProblem['field'] }) {
  if (problem?.field !== field) return null
  return (
    <Text size="sm" tone="danger">
      {`${problem.message} Not saved until it is fixed.`}
    </Text>
  )
}

/** The Global switch, then the branch settings the project uses: the branch template, the branch
 *  type table with its fallback and the title exclusion pattern, with why they aren't saved, if
 *  they aren't, under the field to fix. Their preview is in the bar under Project settings. Nothing
 *  can be typed while the switch writes. */
function BranchFields({ shown }: { shown: ShownSettings }) {
  const { branch } = shown
  const { asking, saving, error, copied } = shown.branchSwitch
  const problem = branchSettingsProblem(branch)
  const changeRow = (index: number, changes: Partial<BranchTypeRow>) =>
    changeBranch({ branchTypes: branch.branchTypes.map((row, at) => (at === index ? { ...row, ...changes } : row)) })
  return (
    <Stack gap="sm">
      <Stack gap="xs">
        <Box direction="row" align="center" gap="xs">
          <Switch label="Global" checked={shown.branchGlobal || asking !== null} disabled={saving} onChange={switchBranchGlobal} />
          {saving ? <Spinner label="Saving the branch settings" labelHidden /> : null}
        </Box>
        <Text size="sm" muted>
          Global branch settings are used by every project without its own. Turn it off to give this project its own copy.
        </Text>
        {copied ? (
          <Text size="sm">This project now has its own copy of the global branch settings. Changes here change only this project.</Text>
        ) : null}
        {error !== null ? (
          <Callout tone="danger" icon="error">
            <Text>{error}</Text>
          </Callout>
        ) : null}
      </Stack>
      <Stack gap="xs">
        <Input
          label="Branch template"
          value={branch.branchTemplate}
          placeholder="{{branch_type}}/{{task_key}}__{{task_slug}}"
          invalid={problem?.field === 'branchTemplate'}
          disabled={saving}
          onChange={(branchTemplate) => changeBranch({ branchTemplate })}
        />
        <BranchProblemText problem={problem} field="branchTemplate" />
        <Text size="sm" muted>
          The git branch of each Start. Empty: Orca names it. Anything other than these variables, such as your initials, is written as it is.
        </Text>
        {BRANCH_VARIABLES.map((name) => (
          <Text key={name} size="sm">
            <Code>{`{{${name}}}`}</Code> {BRANCH_VARIABLE_DESCRIPTIONS[name]}
          </Text>
        ))}
      </Stack>
      <Text size="sm" muted>
        Branch types: a Jira issue type, as the tracker shows it, and the branch type it gives. A row with either left empty counts as none.
      </Text>
      {branch.branchTypes.map((row, index) => (
        <Box key={`branch-type-${index}`} direction="row" align="center" gap="xs">
          <Box grow minWidth={0}>
            <Input label={`Issue type ${index + 1}`} labelHidden value={row.issueType} placeholder="Bug" disabled={saving} onChange={(issueType) => changeRow(index, { issueType })} />
          </Box>
          <Box grow minWidth={0}>
            <Input label={`Branch type ${index + 1}`} labelHidden value={row.branchType} placeholder="bugfix" disabled={saving} onChange={(branchType) => changeRow(index, { branchType })} />
          </Box>
          <Box shrink={false}>
            <IconButton
              icon="delete"
              label={`Remove branch type ${index + 1}`}
              tooltip="Remove branch type"
              size="sm"
              variant="ghost"
              tone="danger"
              disabled={saving}
              onPress={() => changeBranch({ branchTypes: branch.branchTypes.filter((_, at) => at !== index) })}
            />
          </Box>
        </Box>
      ))}
      <Row gap="none" align="center">
        <Button
          key="branch-type-add"
          icon="add"
          size="sm"
          variant="solid"
          disabled={saving}
          onPress={() => changeBranch({ branchTypes: [...branch.branchTypes, { issueType: '', branchType: '' }] })}
        >
          Add branch type
        </Button>
      </Row>
      <Stack gap="xs">
        <Input
          label="Fallback branch type"
          value={branch.branchTypeFallback}
          placeholder="feature"
          invalid={problem?.field === 'branchTypeFallback'}
          disabled={saving}
          onChange={(branchTypeFallback) => changeBranch({ branchTypeFallback })}
        />
        <BranchProblemText problem={problem} field="branchTypeFallback" />
        <Text size="sm" muted>
          For an issue type not in the table, a task with no type, and every GitHub task.
        </Text>
      </Stack>
      <Stack gap="xs">
        <Input
          label="Title exclusion pattern"
          value={branch.titleExclusion}
          invalid={problem?.field === 'titleExclusion'}
          disabled={saving}
          onChange={(pattern) => changeBranch({ titleExclusion: pattern })}
        />
        <BranchProblemText problem={problem} field="titleExclusion" />
        <Text size="sm" muted>
          A regular expression. Every match, ignoring case, is removed from the title before {'{{task_slug}}'} and the worktree name are made. Empty: nothing is removed.
        </Text>
      </Stack>
    </Stack>
  )
}

/** In a box, the branch and the worktree name a Start of the first loaded task would get, or of an
 *  invented task when none is loaded, with the Branch section as shown; and, under a separator, why
 *  a Start would refuse the branch, if it would, unless `problem`, why the section isn't saved,
 *  already says so. */
function BranchPreview({ shown, problem }: { shown: ShownSettings; problem: BranchSettingsProblem | null }) {
  const loaded = firstLoadedTask(shown.projectId)
  const previewed = loaded ?? PREVIEW_TASK
  const { branch, problem: startRefusal } = startBranch(shown.branch, previewed)
  const refused = problem === null ? startRefusal : null
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Text size="sm" weight="semibold">
        {loaded ? `Preview for ${previewed.key}` : `Preview for ${previewed.key} (an example)`}
      </Text>
      <Text size="sm">{branch === null ? 'Branch: named by Orca' : `Branch: ${branch}`}</Text>
      <Text size="sm">{`Worktree: ${worktreeName(previewed, shown.branch)}`}</Text>
      {refused !== null ? <Separator /> : null}
      {refused !== null ? (
        <Text size="sm" tone="warning">
          {refused}
        </Text>
      ) : null}
    </Box>
  )
}

function TrackerFields({ shown }: { shown: ShownSettings }) {
  const providerOptions = shown.provider === null ? [{ value: NO_TRACKER, label: 'Choose a tracker' }, ...PROVIDER_OPTIONS] : PROVIDER_OPTIONS
  return (
    <Stack gap="sm">
      <Select label="Tracker" labelHidden value={shown.provider ?? NO_TRACKER} options={providerOptions} onChange={chooseProviderFor} />
      {shown.provider === 'jira-orca' ? <JiraOrcaSettings providers={shown.providers} /> : null}
      {shown.provider === 'jira-twg' ? <JiraTwgSettings providers={shown.providers} /> : null}
      {shown.provider !== null && trackerOf(shown.provider) === 'jira' ? <JiraProjectKeyField value={shown.jiraProjectKey} /> : null}
      {shown.provider === 'linear-orca' ? (
        <Text size="sm" muted>
          Kickoff reads Linear through the connection saved in Orca. Connect Linear in Orca's settings first if you haven't.
        </Text>
      ) : null}
    </Stack>
  )
}

/** The project's Jira project key, stored as `jiraProjectKey` gives it from what is typed. Like
 *  the other tracker settings, typing it loads nothing by itself, and Enter or Done lists the tasks. */
function JiraProjectKeyField({ value }: { value: string }) {
  return (
    <Stack gap="xs">
      <Input
        label="Jira project key"
        value={value}
        placeholder="WEB"
        onChange={(typed) => changeSettings({ jiraProjectKey: jiraProjectKey(typed) })}
        onSubmit={loadKeepingSettingsOpen}
      />
      <Text size="sm" muted>
        {'The key of the Jira project, such as WEB. Filters and prompt templates name it as {{jira_project}}, so the same filter lists each project\'s own tasks.'}
      </Text>
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

/** Where Ctrl+Enter saves a filter whose queries are text: in any of them. */
const SUBMIT_FROM_QUERY = 'Ctrl+Enter (Cmd+Enter on macOS) saves the filter and lists its tasks.'

/** How the filter editor names a tracker's queries: "JQL" on Jira, "Query" on GitHub, "Linear
 *  query" on Linear, with the button that adds one, what it adds (`fresh`), the placeholder of the
 *  first, what the queries are, when it needs saying, and where Ctrl+Enter saves. `form`: each
 *  query is a form of choices rather than text, as on Linear, so there is no text to save from with
 *  Ctrl+Enter, and the name saves instead, where Enter does too. */
const QUERY_WORDING: Record<TrackerId, { label: string; add: string; fresh: string; placeholder: string; hint: string | null; submit: string; form: boolean }> = {
  jira: { label: 'JQL', add: 'Add JQL', fresh: '', placeholder: DEFAULT_JQL, hint: null, submit: SUBMIT_FROM_QUERY, form: false },
  github: {
    label: 'Query',
    add: 'Add query',
    fresh: '',
    placeholder: DEFAULT_GITHUB_QUERY,
    hint: 'Each query is a GitHub issue search, such as is:open label:bug or assignee:@me. Kickoff lists open issues only.',
    submit: SUBMIT_FROM_QUERY,
    form: false
  },
  linear: {
    label: 'Linear query',
    add: 'Add query',
    fresh: NEW_LINEAR_QUERY,
    placeholder: '',
    hint: 'Each Linear query lists open issues unless a state is chosen.',
    submit: 'Ctrl+Enter (Cmd+Enter on macOS), or Enter, in the name saves the filter and lists its tasks.',
    form: true
  }
}

/** What the Linear query form shows of its choices: the answer for its workspace, or 'loading'
 *  until it arrives. */
type ShownLinearChoices = LinearChoicesResult | 'loading'

/** Select values can't be empty, so this stands for "any team", "anyone" and "any label" in the
 *  Linear query form. It can't be a team key, and Kickoff takes it that no label is named so. */
const LINEAR_ANY = ':any'

/** The State option of Orca's own `open`, a Linear query's default state. `--state` ignores case,
 *  so a team's state named "Open" in any case runs as this one, and isn't offered beside it. */
const LINEAR_OPEN = { value: 'open', label: 'Open' }

const LINEAR_ASSIGNEE_OPTIONS: { value: NonNullable<LinearQuery['assignee']> | typeof LINEAR_ANY; label: string }[] = [
  { value: 'me', label: 'Me' },
  { value: 'null', label: 'Unassigned' },
  { value: LINEAR_ANY, label: 'Anyone' }
]

const LINEAR_ORDER_OPTIONS: { value: NonNullable<LinearQuery['orderBy']>; label: string }[] = [
  { value: 'updatedAt', label: 'Recently updated first' },
  { value: 'createdAt', label: 'Recently created first' }
]

type ChoiceOption = { value: string; label: string }

/** `options`, then the stored value `stored` when it isn't among them, marked not found once the
 *  list it is looked for in is `listed`. */
function withStored(options: ChoiceOption[], stored: string | undefined, listed: boolean): ChoiceOption[] {
  if (stored === undefined || options.some((option) => option.value === stored)) return options
  return [...options, { value: stored, label: listed ? `${stored} (not found)` : stored }]
}

/** The answer `answer` when it is read, else null. */
const readChoices = (answer: ShownLinearChoices | undefined) => (answer !== undefined && answer !== 'loading' && answer.kind === 'ready' ? answer : null)

/** One Linear query as a form, whose values are chosen: Team, from the teams in `answers['']`, then
 *  State and Label, from the team's lists in `answers[team]`, then Assignee and Order. Without a team,
 *  State and Label can't be changed, except to put a stored one back to its default. `index` names
 *  its fields' keys. A change stores the query again with the field changed, keeping the others;
 *  choosing Any team puts State and Label back to their defaults, and choosing a team runs
 *  `onTeamChosen` to read its lists again. */
function LinearQueryForm({
  query,
  index,
  answers,
  onTeamChosen,
  onChange
}: {
  query: string
  index: number
  answers: Record<string, ShownLinearChoices>
  onTeamChosen: (team: string) => void
  onChange: (query: string) => void
}) {
  const fields = readLinearQuery(query)
  const change = (changes: Partial<LinearQuery>) => onChange(withLinearQueryChanges(query, changes))
  const teams = readChoices(answers[''])?.teams ?? null
  const lists = fields.team === undefined ? null : readChoices(answers[fields.team])
  const listed = lists !== null
  const states = (lists?.states ?? []).filter((state) => state.toLowerCase() !== LINEAR_OPEN.value)
  const chooseTeam = (team: string) => {
    if (team === LINEAR_ANY) {
      change({ team: undefined, state: undefined, label: undefined })
      return
    }
    change({ team })
    onTeamChosen(team)
  }
  return (
    <Stack gap="xs">
      <Select
        key={`linear-team-${index}`}
        label="Team"
        value={fields.team ?? LINEAR_ANY}
        options={withStored([{ value: LINEAR_ANY, label: 'Any team' }, ...(teams ?? []).map((team) => ({ value: team.key, label: `${team.name} (${team.key})` }))], fields.team, teams !== null)}
        onChange={chooseTeam}
      />
      {fields.team !== undefined ? <LinearTeamListsNote team={fields.team} answer={answers[fields.team] ?? 'loading'} /> : null}
      <Select
        key={`linear-state-${index}`}
        label="State"
        value={fields.state ?? LINEAR_OPEN.value}
        options={withStored([LINEAR_OPEN, ...states.map((state) => ({ value: state, label: state }))], fields.state, listed)}
        disabled={fields.team === undefined && fields.state === undefined}
        onChange={(state) => change({ state: state === LINEAR_OPEN.value ? undefined : state })}
      />
      <Select
        key={`linear-assignee-${index}`}
        label="Assignee"
        value={fields.assignee ?? LINEAR_ANY}
        options={LINEAR_ASSIGNEE_OPTIONS}
        onChange={(assignee) => change({ assignee: assignee === 'me' || assignee === 'null' ? assignee : undefined })}
      />
      <Select
        key={`linear-label-${index}`}
        label="Label"
        value={fields.label ?? LINEAR_ANY}
        options={withStored([{ value: LINEAR_ANY, label: 'Any label' }, ...(lists?.labels ?? []).map((label) => ({ value: label, label }))], fields.label, listed)}
        disabled={fields.team === undefined && fields.label === undefined}
        onChange={(label) => change({ label: label === LINEAR_ANY ? undefined : label })}
      />
      <Select
        key={`linear-order-${index}`}
        label="Order"
        value={fields.orderBy ?? 'updatedAt'}
        options={LINEAR_ORDER_OPTIONS}
        onChange={(orderBy) => change({ orderBy: orderBy === 'createdAt' ? 'createdAt' : undefined })}
      />
    </Stack>
  )
}

/** What a Linear query form says about its team's states and labels, under its Team: that they are
 *  loading, or couldn't be read. */
function LinearTeamListsNote({ team, answer }: { team: string; answer: ShownLinearChoices }) {
  if (answer === 'loading') return <Spinner label={`Loading the states and labels of ${team}`} />
  if (answer.kind === 'ready') return null
  return (
    <Text size="sm" tone="danger">
      {`Couldn't list the states and labels of ${team}: ${answer.message}`}
    </Text>
  )
}

/** What the Linear query form says about its lists, above the forms: that the teams are loading,
 *  couldn't be read, or that there are none, which can mean Linear isn't connected. */
function LinearChoicesNote({ answer }: { answer: ShownLinearChoices }) {
  if (answer === 'loading') return <Spinner label="Loading the Linear teams" />
  if (answer.kind === 'error') {
    return (
      <Text size="sm" tone="danger">
        {`Couldn't list the Linear teams: ${answer.message}`}
      </Text>
    )
  }
  if (answer.teams.length > 0) return null
  return (
    <Text size="sm" tone="warning">
      Linear lists no teams. Linear may not be connected: connect it in Orca's settings (Settings › Integrations › Linear).
    </Text>
  )
}

/** The queries of a filter on `tracker`, each with its Remove button while more than one is left,
 *  then Add JQL (Add query on GitHub and Linear). Each is a text field, or on Linear a Linear query
 *  form whose lists come from the workspace `linearWorkspaceId`. Ctrl+Enter (Cmd+Enter on macOS) in
 *  any text field runs `onSubmit`. */
function FilterQueries({
  tracker,
  queries: stored,
  linearWorkspaceId,
  onChange: change,
  onSubmit
}: {
  tracker: TrackerId
  queries: string[]
  linearWorkspaceId: string
  onChange: (queries: string[]) => void
  onSubmit: () => void
}) {
  const wording = QUERY_WORDING[tracker]
  // A filter stored with no query at all still shows one to fill in.
  const queries = stored.length > 0 ? stored : [wording.fresh]
  const choices = read(linearChoices)
  const answers = choices?.workspaceId === linearWorkspaceId ? choices.answers : {}
  const loadTeamLists = (team: string) => void loadLinearChoices(linearWorkspaceId, team)
  return (
    <Stack gap="sm">
      {wording.hint !== null ? (
        <Text size="sm" muted>
          {wording.hint}
        </Text>
      ) : null}
      {tracker === 'linear' ? <LinearChoicesNote answer={answers[''] ?? 'loading'} /> : null}
      {queries.map((query, index) => {
        const label = index === 0 ? wording.label : `${wording.label} ${index + 1}`
        const changeQuery = (value: string) => change(queries.map((other, at) => (at === index ? value : other)))
        // The label is the Field's, above the row, so Remove centres on the query's box alone.
        return (
          <Field key={`query-${index}`} label={label}>
            <Box direction="row" align="center" gap="xs">
              <Box grow minWidth={0}>
                {tracker === 'linear' ? (
                  <LinearQueryForm query={query} index={index} answers={answers} onTeamChosen={loadTeamLists} onChange={changeQuery} />
                ) : (
                  <Textarea
                    label={label}
                    labelHidden
                    rows={3}
                    value={query}
                    placeholder={index === 0 ? wording.placeholder : undefined}
                    onChange={changeQuery}
                    onSubmit={onSubmit}
                  />
                )}
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
        <Button key="query-add" icon="add" size="sm" variant="solid" onPress={() => change([...queries, wording.fresh])}>
          {wording.add}
        </Button>
      </Row>
      <Text size="sm" muted>
        {wording.submit}
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

/** The agent choice's options: "Orca default", named after the agent Orca marks default, each
 *  available agent by name, then "No agent". A stored agent that isn't available stays, marked so.
 *  Until the agents are read, or when they can't be, only "Orca default", "No agent" and the stored
 *  choice. */
function agentOptions(agents: AgentsResult | null, stored: string): AgentOption[] {
  const listed = agents?.kind === 'ready' ? agents.agents : null
  return agentChoiceOptions(listed ?? [], stored, {
    orcaDefault: listed === null ? 'Orca default' : `Orca default (${orcaDefaultAgent(listed)?.name ?? 'not set'})`,
    none: 'No agent',
    unavailable: (id) => (listed === null ? id : `${id} (not available)`)
  })
}

/** The agent choice, and the default template with the button beside it that opens the Prompt
 *  templates view. */
function StartFields({ shown }: { shown: ShownSettings }) {
  const agents = read(availableAgents)
  return (
    <Stack gap="sm">
      <Select label="Agent" value={shown.agent} options={agentOptions(agents, shown.agent)} onChange={(agent) => changeSettings({ agent })} />
      {agents?.kind === 'error' ? (
        <Text size="sm" muted>
          Couldn't read Orca's agents.
        </Text>
      ) : null}
      <Box direction="row" align="end" gap="xs">
        <Box grow minWidth={0}>
          <Select
            label="Default template"
            value={shown.defaultTemplateId}
            options={templateOptions(shown.templates)}
            onChange={(defaultTemplateId) => changeSettings({ defaultTemplateId })}
          />
        </Box>
        <Box shrink={false}>
          <IconButton icon="layers" label="Manage templates" tooltip="Manage templates" size="sm" variant="ghost" onPress={() => openTemplates('settings')} />
        </Box>
      </Box>
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
          {list.project ? <FiltersSection projectId={list.project.id} /> : null}
          <LoadError message={list.message} />
        </>
      )
    case 'ready':
      return <ReadyList list={list} />
  }
}

/** "Filters", open at first: a header as wide as the panel, as a Collapsible's, that opens and
 *  closes it, then the filter row and `children`, Search tasks on a ready list. Not a Collapsible,
 *  which would indent them. Closed, a line under the header says the filter shown and the trimmed
 *  `words` of the text filter, so neither is hidden. A divider follows it. It shows nothing while it
 *  would hold nothing. */
function FiltersSection({ projectId, words = '', children }: { projectId: string; words?: string; children?: OrcaNode }) {
  const open = read(filtersOpen)
  const shown = read(shownSettings)
  const current = shown?.projectId === projectId ? trackerFilters(shown) : null
  if (!current && children === undefined) return null
  const filterName = current?.filters.find((filter) => filter.id === current.shownFilterId)?.name ?? null
  const summary = [filterName, words !== '' ? `"${words}"` : null].filter((part) => part !== null).join(' · ')
  // The divider parts the section from the list, or from the load error, below it.
  return (
    <>
      <Box direction="column" gap="xs">
        <Stack align="stretch">
          <Button
            key="filters-toggle"
            size="sm"
            variant="ghost"
            icon={open ? 'collapse' : 'expand'}
            tooltip={open ? 'Hide filters' : 'Show filters'}
            onPress={() => set(filtersOpen, !open)}
          >
            Filters
          </Button>
        </Stack>
        {!open && summary !== '' ? (
          <Text size="sm" muted truncate>
            {summary}
          </Text>
        ) : null}
        {open ? (
          <Stack gap="sm">
            <FilterRow projectId={projectId} />
            {children}
          </Stack>
        ) : null}
      </Box>
      <Separator />
    </>
  )
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
          options={current.filters.map((filter) => ({ value: filter.id, label: filter.global ? `${filter.name} (Global)` : filter.name }))}
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
const TRACKER_NAMES: Record<TrackerId, string> = { github: 'GitHub', jira: 'Jira', linear: 'Linear' }
const trackerName = (tracker: TrackerId) => TRACKER_NAMES[tracker]

/** How a tracker search on Linear matches: Kickoff passes the text whole as `--query`, and Linear
 *  matches it as one substring of the title or the description, never the identifier. */
const LINEAR_SEARCH_HINT = 'Linear matches the words as one phrase of the title or description, not the task key.'

/** The warnings, "Filters" with the filter row, the field and its hints (on Linear also how a
 *  tracker search matches), and the tracker search's title, which
 *  stay in place, then the list, which scrolls inside the rest of the panel's height: the loaded
 *  tasks that match the text filter, or the tracker search's results, then "Load more" and the
 *  truncation notice. */
function ReadyList({ list }: { list: ReadyTaskList }) {
  const text = read(fieldText)
  const query = text.trim()
  const found = read(trackerSearch)
  const trackerId = trackerOf(list.provider)
  const tracker = trackerName(trackerId)
  return (
    <>
      {list.warning ? (
        <Callout tone="warning" icon="warning">
          <Text>{list.warning}</Text>
        </Callout>
      ) : null}
      {list.worktrees === null ? (
        <Callout tone="warning" icon="warning">
          <Text>{`Couldn't read Orca's worktrees, so Start and Run here are off. ${list.worktreesError ?? ''}`.trim()}</Text>
        </Callout>
      ) : null}
      <FiltersSection projectId={list.project.id} words={query}>
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
          {query !== '' && trackerId === 'linear' ? (
            <Text size="sm" muted>
              {LINEAR_SEARCH_HINT}
            </Text>
          ) : null}
        </Stack>
      </FiltersSection>
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

/** What a truncated list says, in the words of each tracker: a list from several queries has the first 100 tasks of each.
 *  A tracker added to `TrackerId` fails the type check until it has its own text here. */
const TRUNCATION_NOTICE: Record<TrackerId, { one: string; several: string }> = {
  github: { one: "Showing the first 100 of your repository's issues.", several: 'Showing the first 100 issues of each query.' },
  jira: { one: 'Showing the first 100 tasks — narrow your JQL.', several: 'Showing the first 100 tasks of each query — narrow your JQL.' },
  linear: { one: 'Showing the first 100 tasks — narrow your filter.', several: 'Showing the first 100 tasks of each query — narrow your filter.' }
}

function truncationNotice(list: ReadyTaskList): string {
  const notice = TRUNCATION_NOTICE[trackerOf(list.provider)]
  return list.queryCount > 1 ? notice.several : notice.one
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
 *  assignees; the agent; the template, the agent chosen for the task, Run here and Start, while
 *  there is no worktree. While that agent is "No agent" the row has no Run here. */
function TaskCard({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  // Every GitHub task is open, so its status says nothing.
  const status = task.tracker !== 'github' ? task.status : null
  const worktree = worktrees?.[task.key] ?? null
  const isStarting = worktree === null && read(starting)[task.key] === true
  const isRunningHere = worktree === null && !isStarting && read(runningHere)[cardKey(projectId, task.key)] === true
  const shown = read(shownSettings)
  const settings = shown?.projectId === projectId ? shown : null
  // Until the project's settings show, the agent choice is unknown, so the card offers only Start.
  const offersRunHere = settings !== null && chosenAgent(settings, task.key, read(availableAgents)) !== 'none'
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
      ) : isRunningHere ? (
        <Spinner label={`Running ${task.key} here`} />
      ) : (
        <Box direction="row" align="center" justify="end" gap="xs">
          <CardTemplate task={task} projectId={projectId} />
          <CardAgent task={task} projectId={projectId} />
          {offersRunHere ? (
            <Box shrink={false}>
              <IconButton
                key={`run-here:${task.key}`}
                icon="terminal"
                variant="outline"
                label={`Run ${task.key} here`}
                tooltip="Run here, in the selected worktree"
                disabled={worktrees === null}
                onPress={() => void runTaskHere(task)}
              />
            </Box>
          ) : null}
          <Box shrink={false}>
            <IconButton
              key={`start:${task.key}`}
              icon="play"
              variant="outline"
              label={`Start ${task.key}`}
              tooltip="Start in a new worktree"
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

/** The card's template `Select`, filling the Start row before the agent `Select`, Run here and
 *  Start; only when the project has two or more templates. */
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

/** The card's agent `Select`, 96 px wide after the template `Select`, so that one keeps the space
 *  the buttons leave; only when the project has two or more available agents. A choice here is
 *  never written to Project settings. */
function CardAgent({ task, projectId }: { task: Task; projectId: string }) {
  const shown = read(shownSettings)
  const agents = read(availableAgents)
  const options = shown?.projectId === projectId ? cardAgentOptions(agents, shown.agent) : null
  if (shown === null || options === null) return null
  return (
    <Box width={96} shrink={false}>
      <Select
        label={`Agent for ${task.key}`}
        labelHidden
        value={chosenAgent(shown, task.key, agents)}
        options={options}
        onChange={(agent) => update(cardAgents, (chosen) => ({ ...chosen, [cardKey(projectId, task.key)]: agent }))}
      />
    </Box>
  )
}

/** The Prompt templates view, in place of the panel view: the title row with Cancel and Save, the
 *  Template `Select` with +, then the form of the template it shows, which scrolls, and the bar
 *  under the form, which stays in place. That bar is the Delete bar, or the bar that asks while
 *  choosing another template waits to discard the draft's changes, or while turning Global off
 *  waits for its confirmation. */
function TemplatesView({ draft, shown, projectName }: { draft: TemplateDraft; shown: ShownSettings; projectName: string }) {
  const { templates } = shown
  const nameProblem = templateNameProblem(templates, draft.name, draft.id, draft.global)
  const isCurrentDefault = !draft.isNew && draft.id === shown.defaultTemplateId
  const choosing = draft.saving || draft.discarding !== null
  // Save waits while the bar under the form asks a question.
  const asking = draft.confirmingOwn || draft.discarding !== null
  const options = draft.isNew ? [{ value: draft.id, label: 'New template' }, ...templateOptions(templates)] : templateOptions(templates)
  const stored = storedTemplate(draft, shown)
  return (
    <Box direction="column" gap="sm" height="100%">
      <TitleRow prefix={projectName !== '' ? `${projectName} ·` : null} title="Prompt templates" level={3}>
        <Row gap="xs" align="center">
          {draft.saving ? <Spinner label="Saving the template" labelHidden /> : null}
          <Button key="template-cancel" size="sm" variant="ghost" disabled={draft.saving} onPress={cancelTemplates}>
            Cancel
          </Button>
          <Button key="template-save" size="sm" variant="solid" disabled={nameProblem !== null || draft.saving || asking} onPress={() => void saveTemplate()}>
            Save
          </Button>
        </Row>
      </TitleRow>
      <Box direction="row" align="center" gap="xs">
        <Box grow minWidth={0}>
          <Select label="Template" labelHidden value={draft.id} options={options} disabled={choosing} onChange={chooseTemplate} />
        </Box>
        <Box shrink={false}>
          <IconButton icon="add" label="New template" tooltip="New template" size="sm" variant="ghost" disabled={choosing} onPress={() => chooseTemplate(null)} />
        </Box>
      </Box>
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
          <Switch
            label="Global"
            checked={draft.global && !draft.confirmingOwn}
            disabled={draft.saving}
            onChange={(on) => switchGlobal(draft, on)}
          />
          <Text size="sm" muted>
            A global template is offered in every project, and editing or deleting it changes it in every project.
          </Text>
        </Stack>
        <Stack gap="xs">
          <Switch
            label="Default template"
            checked={draft.isDefault}
            disabled={isCurrentDefault || draft.saving}
            onChange={(on) => switchDefault(draft, on)}
          />
          <Text size="sm" muted>
            {isCurrentDefault
              ? "Tasks start with it unless you choose another template on their card. To change the default, turn this on in another template."
              : 'Tasks start with the default template unless you choose another one on their card.'}
          </Text>
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
            {'To run a Claude Code skill, start the template with its command, for example `/tdd {{task_key}}`: the rest of the template becomes its arguments. The worktree the agent runs in must see the skill, so install plugins with user scope, not local, and commit project skills. Other agents have their own syntax.'}
          </Text>
        </Callout>
      </Box>
      {draft.discarding ? (
        <Box direction="row" justify="end" align="center" gap="xs" shrink={false}>
          <Text size="sm" tone="warning">
            {`Discard your changes to ${stored ? stored.name : 'the new template'}?`}
          </Text>
          <Button key="template-keep-editing" size="sm" variant="ghost" onPress={keepEditing}>
            Keep editing
          </Button>
          <Button key="template-discard" size="sm" variant="solid" onPress={discardTemplateChanges}>
            Discard
          </Button>
        </Box>
      ) : draft.isNew ? null : draft.confirmingOwn ? (
        <Box direction="row" justify="end" align="center" gap="xs" shrink={false}>
          <Text size="sm" tone="warning">
            Other projects will stop offering it.
          </Text>
          <Button key="template-keep-global" size="sm" variant="ghost" disabled={draft.saving} onPress={() => switchGlobal(draft, true)}>
            Keep global
          </Button>
          <Button key="template-confirm-own" size="sm" variant="solid" disabled={draft.saving} onPress={confirmOwn}>
            Confirm
          </Button>
        </Box>
      ) : (
        <Box direction="row" justify="end" align="center" gap="xs" shrink={false}>
          {stored?.global ? (
            <Text size="sm" muted>
              Deletes it in every project.
            </Text>
          ) : null}
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

/** The filter editor, in place of the panel view, laid out as the Prompt templates view without
 *  its Template row: the title row with Cancel and Save, and the bar under the form, stay in place
 *  while the form between them scrolls. Unlike that view's, its Global switch moves a stored filter
 *  at once.
 *  That bar is the Delete bar, or, while turning Global off waits for its confirmation, the bar
 *  that asks for it. The form starts with the failed load that opened it, if one did. `filters`
 *  are those the project lists on the draft's tracker, its own and the global ones, and
 *  `linearWorkspaceId` the workspace its Linear query forms list teams from. */
function FilterEditor({
  draft,
  filters,
  jiraProjectKey,
  linearWorkspaceId,
  projectName
}: {
  draft: FilterDraft
  filters: ListedFilter[]
  jiraProjectKey: string
  linearWorkspaceId: string
  projectName: string
}) {
  const nameProblem = filterNameProblem(filters, draft.name, draft.id, draft.global)
  const save = () => void saveFilter()
  const recipes = filterRecipes(draft.tracker)
  const isGlobal = draft.global && !draft.confirmingOwn
  // A global Jira filter that names the project's key lists that project's tasks in every project.
  const namesJiraProjectKey = isGlobal && draft.tracker === 'jira' && draft.queries.some((query) => namesJiraProject(query, jiraProjectKey))
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
          <Input
            label="Name"
            value={draft.name}
            invalid={nameProblem !== null}
            onChange={(name) => changeFilterDraft(draft, { name })}
            // Queries that are forms have no text to save from with Ctrl+Enter, so the name saves.
            onSubmit={QUERY_WORDING[draft.tracker].form ? save : undefined}
          />
          {nameProblem !== null ? (
            <Text size="sm" tone="danger">
              {nameProblem}
            </Text>
          ) : null}
        </Stack>
        <Stack gap="xs">
          <Switch label="Global" checked={isGlobal} disabled={draft.saving} onChange={(on) => switchFilterGlobal(draft, on)} />
          <Text size="sm" muted>
            {`A global filter is offered in every ${trackerName(draft.tracker)} project, and editing or deleting it changes it in every project.`}
          </Text>
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
        <FilterQueries
          tracker={draft.tracker}
          queries={draft.queries}
          linearWorkspaceId={linearWorkspaceId}
          onChange={(queries) => changeFilterDraft(draft, { queries })}
          onSubmit={save}
        />
        {namesJiraProjectKey ? (
          <Stack gap="xs">
            <Text size="sm" tone="warning">
              {`This filter names ${jiraProjectKey}. Use {{${JIRA_PROJECT_VARIABLE}}} so each project lists its own tasks.`}
            </Text>
            <Row gap="xs" align="center">
              <Button
                key="filter-use-jira-project"
                size="sm"
                variant="outline"
                disabled={draft.saving}
                onPress={() => changeFilterDraft(draft, { queries: draft.queries.map((query) => withJiraProjectVariable(query, jiraProjectKey)) })}
              >
                {`Use {{${JIRA_PROJECT_VARIABLE}}}`}
              </Button>
            </Row>
          </Stack>
        ) : null}
        {draft.error !== null ? (
          <Callout tone="danger" icon="error">
            <Text>{draft.error}</Text>
          </Callout>
        ) : null}
      </Box>
      {draft.isNew ? null : draft.confirmingOwn ? (
        <Box direction="row" justify="end" align="center" gap="xs" shrink={false}>
          <Text size="sm" tone="warning">
            Other projects will stop offering it.
          </Text>
          <Button key="filter-keep-global" size="sm" variant="ghost" disabled={draft.saving} onPress={() => switchFilterGlobal(draft, true)}>
            Keep global
          </Button>
          <Button key="filter-confirm-own" size="sm" variant="solid" disabled={draft.saving} onPress={confirmFilterOwn}>
            Confirm
          </Button>
        </Box>
      ) : (
        <Box direction="row" justify="end" align="center" gap="xs" shrink={false}>
          {draft.global ? (
            <Text size="sm" muted>
              Deletes it in every project.
            </Text>
          ) : null}
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
