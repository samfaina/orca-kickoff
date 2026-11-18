// The panel <-> worker contract, the data model from the spec and the settings reader.
// src/panel.tsx and src/worker.ts both read it, so it imports nothing from Node. Expected failures
// are data (`kind: 'error'`, `ok: false`): no request throws for them.
import { isRecord } from './json'
import { INITIAL_TEMPLATE_ID, INITIAL_TEMPLATE_NAME, sameTemplateName } from './template'

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

/** Each provider's configuration, kept separately so switching provider and back loses nothing.
 *  A Jira provider's `jql` is its JQL queries, in order, as the settings show them: blank ones
 *  are kept, so the person can type into a new one, and never run. */
export type ProviderConfigs = {
  github?: {}
  /** siteId '' = Orca's default site. */
  'jira-orca'?: { jql: string[]; siteId: string }
  /** '' = twg's default. */
  'jira-twg'?: { jql: string[]; site: string; profile: string }
}

/** 'orca-default', 'none', or any other string as an Orca agent id. */
export type AgentChoice = string

/** A named text with task variables that becomes the prompt of a Start. */
export type PromptTemplate = {
  /** Stable, made by the panel; never shown. */
  id: string
  /** Trimmed, not empty, unique in the project ignoring case. */
  name: string
  /** '': the prompt is the task URL. */
  text: string
}

export type ProjectSettings = {
  /** undefined: GitHub when the project has a repo, else none. */
  provider?: ProviderId
  providers: ProviderConfigs
  /** undefined or empty: one template "Default" with INITIAL_TEMPLATE_TEXT. */
  templates?: PromptTemplate[]
  /** undefined or unknown: the first template. */
  defaultTemplateId?: string
  /** undefined: 'orca-default'. */
  agent?: AgentChoice
}

export type Settings = { version: 1; projects: Record<string, ProjectSettings> }

/** Where the settings live in the plugin's storage. */
export const SETTINGS_KEY = 'settings'

export const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

const PROVIDER_IDS: readonly ProviderId[] = ['github', 'jira-orca', 'jira-twg']

/** Settings as read from storage. Anything of an unexpected shape (empty, an old version,
 *  corrupt data) falls back to the defaults instead of failing. */
export function readSettings(raw: unknown): Settings {
  const settings: Settings = { version: 1, projects: {} }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.projects)) return settings
  for (const [id, project] of Object.entries(raw.projects)) {
    if (isRecord(project)) settings.projects[id] = readProjectSettings(project)
  }
  return settings
}

function readProjectSettings(raw: Record<string, unknown>): ProjectSettings {
  const project: ProjectSettings = { providers: readProviderConfigs(raw.providers) }
  if (PROVIDER_IDS.includes(raw.provider as ProviderId)) project.provider = raw.provider as ProviderId
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

function readProviderConfigs(raw: unknown): ProviderConfigs {
  const configs: ProviderConfigs = {}
  if (!isRecord(raw)) return configs
  if (isRecord(raw.github)) configs.github = {}
  const orca = readJiraConfig(raw['jira-orca'])
  if (orca && strings(orca.stored, 'siteId')) configs['jira-orca'] = { jql: orca.jql, siteId: orca.stored.siteId }
  const twg = readJiraConfig(raw['jira-twg'])
  if (twg && strings(twg.stored, 'site', 'profile')) {
    configs['jira-twg'] = { jql: twg.jql, site: twg.stored.site, profile: twg.stored.profile }
  }
  return configs
}

/** A Jira provider's stored configuration with its JQL queries read, or null when it isn't a
 *  record or its JQL is of an unexpected shape. Before a project could have several queries, it
 *  stored one string, which is read as a list of one. */
function readJiraConfig(raw: unknown): { stored: Record<string, unknown>; jql: string[] } | null {
  if (!isRecord(raw)) return null
  if (typeof raw.jql === 'string') return { stored: raw, jql: [raw.jql] }
  if (Array.isArray(raw.jql) && raw.jql.every((jql) => typeof jql === 'string')) return { stored: raw, jql: [...raw.jql] }
  return null
}

function strings<K extends string>(record: Record<string, unknown>, ...keys: K[]): record is Record<K, string> {
  return keys.every((key) => typeof record[key] === 'string')
}

/** A project's settings, or empty ones when it has none. */
export function projectSettings(settings: Settings, projectId: string): ProjectSettings {
  return settings.projects[projectId] ?? { providers: {} }
}

/** The provider a project reads tasks with: the chosen one, else GitHub when it has a repo. */
export function projectProvider(settings: ProjectSettings, project: ProjectRef): ProviderId | null {
  return settings.provider ?? (project.repo !== null ? 'github' : null)
}

/** The tracker a provider reads. */
export function trackerOf(provider: ProviderId): TrackerId {
  return provider === 'github' ? 'github' : 'jira'
}

/** A provider's stored configuration, or its defaults when none is stored. A Jira provider's
 *  default JQL queries are the other Jira provider's, all of them, or DEFAULT_JQL alone. */
export function providerConfig<K extends ProviderId>(settings: ProjectSettings, id: K): Required<ProviderConfigs>[K] {
  const { providers } = settings
  const defaults: Required<ProviderConfigs> = {
    github: {},
    'jira-orca': { jql: [...(providers['jira-twg']?.jql ?? [DEFAULT_JQL])], siteId: '' },
    'jira-twg': { jql: [...(providers['jira-orca']?.jql ?? [DEFAULT_JQL])], site: '', profile: '' }
  }
  const configs: Required<ProviderConfigs> = { ...defaults, ...providers }
  return configs[id]
}

/** One JQL query to run: trimmed, each line break a space, and its position from 1 among the
 *  queries as the settings show them, blank ones included. */
export type JqlQuery = { jql: string; position: number }

/** The JQL queries that run, in order: the non-blank ones. What is stored doesn't change. */
export function jqlQueries(jql: readonly string[]): JqlQuery[] {
  return jql.flatMap((query, index) => {
    const normalized = query.replace(/\r\n|\r|\n/g, ' ').trim()
    return normalized === '' ? [] : [{ jql: normalized, position: index + 1 }]
  })
}

/** How many queries a provider runs to list the project's tasks: its non-blank JQL queries on
 *  Jira, one on GitHub. */
export function queryCount(settings: ProjectSettings, id: ProviderId): number {
  return id === 'github' ? 1 : jqlQueries(providerConfig(settings, id).jql).length
}

/** Chooses a provider, keeping every provider's configuration and filling in the chosen one's
 *  defaults the first time. */
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
  | { kind: 'error'; project: ProjectRef | null; message: string }
  | {
      kind: 'ready'
      project: ProjectRef
      provider: ProviderId
      tasks: Task[]
      nextCursor: string | null
      truncated: boolean
      /** How many queries listed the tasks: the non-blank JQL queries on Jira, 1 on GitHub. A
       *  truncated list's notice says whether it has the first 100 of each. */
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
    /** `query`: a tracker search with the user's words; `cursor`: the next page of the list, or
     *  of the tracker search with the same `query`. */
    'tasks.load': { input: { cursor?: string; query?: string }; output: TaskList }
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
