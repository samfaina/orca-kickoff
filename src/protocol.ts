// The panel <-> worker contract, the data model from the spec and the settings reader.
// src/panel.tsx and src/worker.ts both read it, so it imports nothing from Node. Expected failures
// are data (`kind: 'error'`, `ok: false`): no request throws for them.
import { isRecord } from './json'
import { fillTemplate, INITIAL_TEMPLATE_ID, INITIAL_TEMPLATE_NAME, JIRA_PROJECT_VARIABLE, sameTemplateName, usesVariable } from './template'

export type TrackerId = 'github' | 'jira'
export type ProviderId = 'github' | 'jira-orca' | 'jira-twg'
/** The providers that read Jira, and share its JQL. */
export type JiraProviderId = Exclude<ProviderId, 'github'>

export type Task = {
  tracker: TrackerId
  /** "#42" on GitHub, "WEB-12" on Jira. */
  key: string
  title: string
  /** Browser URL. */
  url: string
  /** Plain text, '' when none. */
  description: string
  /** As the tracker shows it. */
  status: string | null
  statusCategory: 'todo' | 'in_progress' | 'done' | null
  /** Display names (GitHub: login). */
  assignees: string[]
  labels: string[]
}

export type ProjectRef = {
  /** Orca project id. */
  id: string
  name: string
  /** "owner/name", or "host/owner/name" on GitHub Enterprise; null without providerIdentity. */
  repo: string | null
}

/** Each provider's configuration, kept separately so switching provider and back loses nothing:
 *  how it reads the tracker. What it lists is a filter, which belongs to the tracker. */
export type ProviderConfigs = {
  github?: {}
  /** siteId '' = Orca's default site. */
  'jira-orca'?: { siteId: string }
  /** '' = twg's default. */
  'jira-twg'?: { site: string; profile: string }
}

/** A named way to ask the tracker for a project's tasks. */
export type Filter = {
  /** Stable, made by the panel; never shown. */
  id: string
  /** Trimmed, not empty, unique in the project ignoring case. */
  name: string
  /** Its tracker queries, in order, as the filter editor shows them (JQL on Jira): blank ones are
   *  kept, so the person can type into a new one, and never run. */
  queries: string[]
}

/** A value per tracker: each tracker has filters of its own. */
export type ByTracker<T> = { [K in TrackerId]?: T }

/** 'orca-default', 'none', or any other string as an Orca agent id. */
export type AgentChoice = string

/** A named text with task variables that becomes the prompt of a Start. */
export type PromptTemplate = {
  /** Stable, made by the panel; never shown. */
  id: string
  /** Trimmed, not empty, and unique ignoring case among the project's own templates, or among the
   *  global ones: an own template and a global one may share a name. */
  name: string
  /** '': the prompt is the task URL. */
  text: string
}

export type ProjectSettings = {
  /** undefined: GitHub when the project has a repo, else none. */
  provider?: ProviderId
  providers: ProviderConfigs
  /** The key of the project's Jira project, such as WEB: trimmed and upper-cased (see
   *  `jiraProjectKey`). A JQL query names it as `{{jira_project}}`. Undefined or '': none. */
  jiraProjectKey?: string
  /** The filters of each tracker, in order; both Jira providers list the same ones. Undefined or
   *  empty: one filter, "Tasks" with DEFAULT_JQL on Jira, "Open" with DEFAULT_GITHUB_QUERY on
   *  GitHub. */
  filters?: ByTracker<Filter[]>
  /** The filter each tracker showed last; undefined or unknown: the first. */
  shownFilterId?: ByTracker<string>
  /** The project's own templates. Undefined or empty, and no global ones: one template "Default"
   *  with INITIAL_TEMPLATE_TEXT. */
  templates?: PromptTemplate[]
  /** One of the project's own templates or a global one; undefined or unknown: the first template
   *  the project lists. */
  defaultTemplateId?: string
  /** undefined: 'orca-default'. */
  agent?: AgentChoice
}

/** What belongs to no project: the global prompt templates, offered in every project beside its
 *  own. Global filters will join them. */
export type GlobalSettings = {
  /** In order; undefined or empty: none. */
  templates?: PromptTemplate[]
}

/** `global` is undefined while nothing global is stored. */
export type Settings = { version: 1; projects: Record<string, ProjectSettings>; global?: GlobalSettings }

/** Where the settings live in the plugin's storage. */
export const SETTINGS_KEY = 'settings'

export const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

/** The id and name of the filter a Jira project has before it stores any (src/filter.ts). Settings
 *  stored before filters, with JQL queries on a Jira provider, read as this filter with those
 *  queries. */
export const INITIAL_FILTER_ID = 'tasks'
export const INITIAL_FILTER_NAME = 'Tasks'

/** The GitHub search of the filter a GitHub project has before it stores any: its open issues. */
export const DEFAULT_GITHUB_QUERY = 'is:open'

/** The filter each tracker has before a project stores any. */
const INITIAL_FILTERS: Record<TrackerId, Filter> = {
  jira: { id: INITIAL_FILTER_ID, name: INITIAL_FILTER_NAME, queries: [DEFAULT_JQL] },
  github: { id: 'open', name: 'Open', queries: [DEFAULT_GITHUB_QUERY] }
}

/** Every tracker, from the map above, so a new one can't be left out of reading settings. */
const TRACKER_IDS = Object.keys(INITIAL_FILTERS) as TrackerId[]

const PROVIDER_IDS: readonly ProviderId[] = ['github', 'jira-orca', 'jira-twg']

/** Settings as read from storage. Anything of an unexpected shape (empty, an old version,
 *  corrupt data) falls back to the defaults instead of failing. */
export function readSettings(raw: unknown): Settings {
  const settings: Settings = { version: 1, projects: {} }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.projects)) return settings
  for (const [id, project] of Object.entries(raw.projects)) {
    if (isRecord(project)) settings.projects[id] = readProjectSettings(project)
  }
  // Settings stored before global templates have no `global`, and read with none.
  const templates = readTemplates(isRecord(raw.global) ? raw.global.templates : undefined)
  if (templates.length > 0) settings.global = { templates }
  return settings
}

function readProjectSettings(raw: Record<string, unknown>): ProjectSettings {
  const project: ProjectSettings = { providers: readProviderConfigs(raw.providers) }
  if (PROVIDER_IDS.includes(raw.provider as ProviderId)) project.provider = raw.provider as ProviderId
  const key = typeof raw.jiraProjectKey === 'string' ? jiraProjectKey(raw.jiraProjectKey) : ''
  if (key !== '') project.jiraProjectKey = key
  const filters: ByTracker<Filter[]> = {}
  const shownFilterId: ByTracker<string> = {}
  for (const tracker of TRACKER_IDS) {
    const stored = readFilters(isRecord(raw.filters) ? raw.filters[tracker] : undefined)
    // A project stored before filters kept its JQL queries on each Jira provider.
    const jql = tracker === 'jira' && stored.length === 0 ? jqlStoredBeforeFilters(raw.providers, project.provider) : null
    if (jql !== null) stored.push({ id: INITIAL_FILTER_ID, name: INITIAL_FILTER_NAME, queries: jql })
    if (stored.length > 0) filters[tracker] = stored
    const shown = isRecord(raw.shownFilterId) ? raw.shownFilterId[tracker] : undefined
    if (typeof shown === 'string') shownFilterId[tracker] = shown
  }
  if (Object.keys(filters).length > 0) project.filters = filters
  if (Object.keys(shownFilterId).length > 0) project.shownFilterId = shownFilterId
  const templates = readTemplates(raw.templates)
  // A project stored before it could have several templates kept one text in `template`.
  if (templates.length === 0 && typeof raw.template === 'string') {
    templates.push({ id: INITIAL_TEMPLATE_ID, name: INITIAL_TEMPLATE_NAME, text: raw.template })
  }
  if (templates.length > 0) project.templates = templates
  if (typeof raw.defaultTemplateId === 'string') project.defaultTemplateId = raw.defaultTemplateId
  if (typeof raw.agent === 'string' && raw.agent !== '') project.agent = raw.agent
  return project
}

/** The stored templates of the expected shape, in order. A template whose id or name, ignoring
 *  case, an earlier one already has is dropped too. */
function readTemplates(raw: unknown): PromptTemplate[] {
  const templates: PromptTemplate[] = []
  if (!Array.isArray(raw)) return templates
  for (const item of raw) {
    if (!isRecord(item) || !strings(item, 'id', 'name', 'text')) continue
    const name = item.name.trim()
    if (item.id === '' || name === '') continue
    if (templates.some((template) => template.id === item.id || sameTemplateName(template.name, name))) continue
    templates.push({ id: item.id, name, text: item.text })
  }
  return templates
}

/** The stored filters of the expected shape, in order, names trimmed. A filter whose id or name,
 *  ignoring case, an earlier one already has is dropped too. */
function readFilters(raw: unknown): Filter[] {
  const filters: Filter[] = []
  if (!Array.isArray(raw)) return filters
  for (const item of raw) {
    if (!isRecord(item)) continue
    const { queries } = item
    if (!strings(item, 'id', 'name') || !isStringList(queries)) continue
    const name = item.name.trim()
    if (item.id === '' || name === '') continue
    if (filters.some((filter) => filter.id === item.id || filter.name.toLowerCase() === name.toLowerCase())) continue
    filters.push({ id: item.id, name, queries: [...queries] })
  }
  return filters
}

/** The JQL queries a project stored before filters, or null when it stored none: those of the
 *  Jira provider chosen, else of Jira (Orca connection), else of Jira (twg). Before a project could
 *  have several queries, a provider stored one string, which is read as a list of one. */
function jqlStoredBeforeFilters(raw: unknown, provider: ProviderId | undefined): string[] | null {
  if (!isRecord(raw)) return null
  const order: JiraProviderId[] = provider === 'jira-twg' ? ['jira-twg', 'jira-orca'] : ['jira-orca', 'jira-twg']
  for (const id of order) {
    const config = raw[id]
    if (!isRecord(config)) continue
    if (typeof config.jql === 'string') return [config.jql]
    if (isStringList(config.jql)) return [...config.jql]
  }
  return null
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function readProviderConfigs(raw: unknown): ProviderConfigs {
  const configs: ProviderConfigs = {}
  if (!isRecord(raw)) return configs
  if (isRecord(raw.github)) configs.github = {}
  const orca = raw['jira-orca']
  if (isRecord(orca) && strings(orca, 'siteId')) configs['jira-orca'] = { siteId: orca.siteId }
  const twg = raw['jira-twg']
  if (isRecord(twg) && strings(twg, 'site', 'profile')) configs['jira-twg'] = { site: twg.site, profile: twg.profile }
  return configs
}

function strings<K extends string>(record: Record<string, unknown>, ...keys: K[]): record is Record<K, string> {
  return keys.every((key) => typeof record[key] === 'string')
}

/** A Jira project key as it is stored, from what the person typed: trimmed and upper-cased. */
export function jiraProjectKey(typed: string): string {
  return typed.trim().toUpperCase()
}

/** A project's settings, or empty ones when it has none. */
export function projectSettings(settings: Settings, projectId: string): ProjectSettings {
  return settings.projects[projectId] ?? { providers: {} }
}

/** What belongs to no project, or nothing when none is stored. */
export function globalSettings(settings: Settings): GlobalSettings {
  return settings.global ?? {}
}

/** The global prompt templates, in order. */
export function globalTemplates(settings: Settings): PromptTemplate[] {
  return globalSettings(settings).templates ?? []
}

/** What the panel changes in what belongs to no project. */
export type GlobalChanges = Partial<GlobalSettings>

/** `settings` with global changes applied, and every project kept. */
export function withGlobalChanges(settings: Settings, changes: GlobalChanges): Settings {
  return { ...settings, global: { ...settings.global, ...changes } }
}

/** The part of a project's settings that holds its filters. */
export type FilterSettings = Pick<ProjectSettings, 'filters' | 'shownFilterId'>

/** A project's filters on `tracker`, in their order: the stored ones, or the initial one when none
 *  is stored, "Tasks" with DEFAULT_JQL on Jira and "Open" with DEFAULT_GITHUB_QUERY on GitHub. */
export function projectFilters(settings: FilterSettings, tracker: TrackerId): Filter[] {
  const filters = settings.filters?.[tracker]
  if (filters && filters.length > 0) return filters
  return [{ ...INITIAL_FILTERS[tracker], queries: [...INITIAL_FILTERS[tracker].queries] }]
}

/** The filter to list on `tracker`: the one `id` names, else the one shown last, else the first. */
export function listedFilter(settings: FilterSettings, tracker: TrackerId, id?: string): Filter {
  const filters = projectFilters(settings, tracker)
  const shown = settings.shownFilterId?.[tracker]
  return filters.find((filter) => filter.id === id) ?? filters.find((filter) => filter.id === shown) ?? filters[0]
}

/** The provider a project reads tasks with: the chosen one, else GitHub when it has a repo. */
export function projectProvider(settings: ProjectSettings, project: ProjectRef): ProviderId | null {
  return settings.provider ?? (project.repo !== null ? 'github' : null)
}

/** The tracker a provider reads. */
export function trackerOf(provider: ProviderId): TrackerId {
  return provider === 'github' ? 'github' : 'jira'
}

/** A provider's stored configuration, or its defaults when none is stored: the tool's own default
 *  site and profile. The filters don't depend on it: both Jira providers list the same ones. */
export function providerConfig<K extends ProviderId>(settings: Pick<ProjectSettings, 'providers'>, id: K): Required<ProviderConfigs>[K] {
  const defaults: Required<ProviderConfigs> = { github: {}, 'jira-orca': { siteId: '' }, 'jira-twg': { site: '', profile: '' } }
  const configs: Required<ProviderConfigs> = { ...defaults, ...settings.providers }
  return configs[id]
}

/** One query of a filter to run (JQL on Jira, a GitHub search on GitHub): trimmed, each line break
 *  a space, and its position from 1 among the filter's queries as the filter editor shows them,
 *  blank ones included. */
export type FilterQuery = { text: string; position: number }

/** The queries of a filter that run, in order: the non-blank ones. What is stored doesn't change. */
export function filterQueries(queries: readonly string[]): FilterQuery[] {
  return queries.flatMap((query, index) => {
    const normalized = query.replace(/\r\n|\r|\n/g, ' ').trim()
    return normalized === '' ? [] : [{ text: normalized, position: index + 1 }]
  })
}

/** What a list answers when the filter's JQL queries name the Jira project key and the project
 *  has none. */
export const NO_JIRA_PROJECT_KEY = `This filter uses {{${JIRA_PROJECT_VARIABLE}}}. Set the Jira project key in Project settings.`

/** `filter` with its queries as they run on `tracker`, in a project whose Jira project key is
 *  `jiraProjectKey` ('' for none): on Jira each `{{ jira_project }}` becomes the key; on GitHub,
 *  where it has no meaning, they run as written. Every run of the queries goes through it: the
 *  list, its next pages and a tracker search. A project without a key whose filter names it fails,
 *  and none of the filter's queries runs. What is stored doesn't change. */
export function filterAsRun(filter: Filter, tracker: TrackerId, jiraProjectKey: string): { ok: true; filter: Filter } | { ok: false; message: string } {
  if (tracker !== 'jira') return { ok: true, filter }
  if (jiraProjectKey === '' && filter.queries.some((query) => usesVariable(query, JIRA_PROJECT_VARIABLE))) {
    return { ok: false, message: NO_JIRA_PROJECT_KEY }
  }
  const variables = { [JIRA_PROJECT_VARIABLE]: jiraProjectKey }
  return { ok: true, filter: { ...filter, queries: filter.queries.map((query) => fillTemplate(query, variables)) } }
}

/** How many queries a provider runs to list the project's tasks: the non-blank queries of the
 *  filter `filterId` names, or of the one `listedFilter` lists without it. */
export function queryCount(settings: ProjectSettings, id: ProviderId, filterId?: string): number {
  return filterQueries(listedFilter(settings, trackerOf(id), filterId).queries).length
}

/** Chooses a provider, keeping every provider's configuration and the filters, and filling in the
 *  chosen one's defaults the first time. */
export function chooseProvider(settings: ProjectSettings, provider: ProviderId): ProjectSettings {
  return { ...settings, provider, providers: { ...settings.providers, [provider]: providerConfig(settings, provider) } }
}

/** What the panel changes in a project's settings. `providers` holds only the providers whose
 *  configuration changed. */
export type ProjectChanges = Partial<ProjectSettings>

/** `settings` with a project's changes applied, and everything else kept, including the
 *  configuration of every provider that didn't change. */
export function withProjectChanges(settings: Settings, projectId: string, changes: ProjectChanges): Settings {
  const current = projectSettings(settings, projectId)
  const project = { ...current, ...changes, providers: { ...current.providers, ...changes.providers } }
  return { ...settings, projects: { ...settings.projects, [projectId]: project } }
}

/** `tasks` followed by the tasks of a next page, skipping keys already listed. */
export function appendTasks(tasks: Task[], next: Task[]): Task[] {
  const keys = new Set(tasks.map((task) => task.key))
  return [
    ...tasks,
    ...next.filter((task) => {
      if (keys.has(task.key)) return false
      keys.add(task.key)
      return true
    })
  ]
}

export type TaskWorktree = { worktreeId: string; name: string; agent: string | null }

export type TaskList =
  /** No worktree selected in Orca. */
  | { kind: 'no-project' }
  /** No provider for this project. */
  | { kind: 'needs-config'; project: ProjectRef }
  /** `filterId`: the filter one of whose queries failed, or that has none to run; the panel opens
   *  the filter editor on it. `needsJiraProjectKey`: the filter's JQL queries name the Jira
   *  project key and the project has none; the list shows the message, and Project settings, where
   *  the key is set, doesn't open by itself. */
  | { kind: 'error'; project: ProjectRef | null; message: string; filterId?: string; needsJiraProjectKey?: true }
  | {
      kind: 'ready'
      project: ProjectRef
      provider: ProviderId
      tasks: Task[]
      nextCursor: string | null
      truncated: boolean
      /** The filter listed. */
      filterId: string
      /** How many queries listed the tasks: the filter's non-blank ones. A truncated list's
       *  notice says whether it has the first 100 of each. */
      queryCount: number
      /** null when Orca's worktrees couldn't be read. */
      worktrees: Record<string, TaskWorktree> | null
      worktreesError: string | null
      /** Keys of the tasks whose Start is under way in the worker. */
      starting: string[]
      /** For example "using the last known project". */
      warning: string | null
    }

/** Task keys mapped to their task worktrees. */
export type WorktreesResult =
  | { kind: 'ready'; worktrees: Record<string, TaskWorktree> }
  | { kind: 'error'; message: string }

/** Keys of a project's tasks whose Start is under way in the worker. A restarted worker knows
 *  none, so a panel that asks stops waiting for their end. */
export type StartsResult = { starting: string[] }

export type ActiveProjectResult = { projectId: string | null } | { kind: 'error'; message: string }

export type JiraSitesResult =
  | { kind: 'ready'; sites: { id: string; name: string }[] }
  | { kind: 'error'; message: string }

export type ActionResult = { ok: true } | { ok: false; message: string }

/** A Start's answer. `underWay`: Orca is creating the worktree and `start.ended` follows;
 *  otherwise the task already has its worktree. */
export type StartResult = { ok: true; underWay: boolean } | { ok: false; message: string }

/** Posted when the `worktree create` of a Start under way ends. A timeout is a failure. `agent`
 *  is the agent the create passed, null for none: Orca reports it running only a few seconds
 *  after the create ends. */
export type StartEnded = { projectId: string; taskKey: string; agent: string | null } & ActionResult

declare module 'orca' {
  interface PluginRequests {
    /** `filterId`: the filter of the active project to list; undefined or unknown, the one it
     *  showed last. `query`: a tracker search with the user's words; `cursor`: the next page of the
     *  filter's list, or of the tracker search with the same `query`. */
    'tasks.load': { input: { filterId?: string; cursor?: string; query?: string }; output: TaskList }
    'worktrees.load': { input: { projectId: string }; output: WorktreesResult }
    'project.active': { input: {}; output: ActiveProjectResult }
    'jira.sites': { input: {}; output: JiraSitesResult }
    'task.start': { input: { projectId: string; task: Task; templateId: string }; output: StartResult }
    'starts.load': { input: { projectId: string }; output: StartsResult }
    'worktree.open': { input: { worktreeId: string }; output: ActionResult }
  }
  interface PluginPanelEvents {
    'start.ended': StartEnded
  }
}
