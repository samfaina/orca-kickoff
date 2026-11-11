// The panel <-> worker contract, the data model from the spec and the settings reader.
// src/panel.tsx and src/worker.ts both read it, so it imports nothing from Node. Expected failures
// are data (`kind: 'error'`, `ok: false`): no request throws for them.
import { isRecord } from './json'

export type TrackerId = 'github' | 'jira'
export type ProviderId = 'github' | 'jira-orca' | 'jira-twg'

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

/** Each provider's configuration, kept separately so switching provider and back loses nothing. */
export type ProviderConfigs = {
  github?: {}
  /** siteId '' = Orca's default site. */
  'jira-orca'?: { jql: string; siteId: string }
  /** '' = twg's default. */
  'jira-twg'?: { jql: string; site: string; profile: string }
}

/** 'orca-default', 'none', or any other string as an Orca agent id. */
export type AgentChoice = string

export type ProjectSettings = {
  /** undefined: GitHub when the project has a repo, else none. */
  provider?: ProviderId
  providers: ProviderConfigs
  /** undefined: DEFAULT_TEMPLATE; '': the prompt is the task URL. */
  template?: string
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
  if (typeof raw.template === 'string') project.template = raw.template
  if (typeof raw.agent === 'string' && raw.agent !== '') project.agent = raw.agent
  return project
}

function readProviderConfigs(raw: unknown): ProviderConfigs {
  const configs: ProviderConfigs = {}
  if (!isRecord(raw)) return configs
  if (isRecord(raw.github)) configs.github = {}
  const orca = raw['jira-orca']
  if (isRecord(orca) && strings(orca, 'jql', 'siteId')) configs['jira-orca'] = { jql: orca.jql, siteId: orca.siteId }
  const twg = raw['jira-twg']
  if (isRecord(twg) && strings(twg, 'jql', 'site', 'profile')) {
    configs['jira-twg'] = { jql: twg.jql, site: twg.site, profile: twg.profile }
  }
  return configs
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

/** A provider's stored configuration, or its defaults when none is stored. A Jira provider's
 *  default JQL is the other Jira provider's, or DEFAULT_JQL. */
export function providerConfig<K extends ProviderId>(settings: ProjectSettings, id: K): Required<ProviderConfigs>[K] {
  const { providers } = settings
  const defaults: Required<ProviderConfigs> = {
    github: {},
    'jira-orca': { jql: providers['jira-twg']?.jql ?? DEFAULT_JQL, siteId: '' },
    'jira-twg': { jql: providers['jira-orca']?.jql ?? DEFAULT_JQL, site: '', profile: '' }
  }
  const configs: Required<ProviderConfigs> = { ...defaults, ...providers }
  return configs[id]
}

/** Chooses a provider, keeping every provider's configuration and filling in the chosen one's
 *  defaults the first time. */
export function chooseProvider(settings: ProjectSettings, provider: ProviderId): ProjectSettings {
  return { ...settings, provider, providers: { ...settings.providers, [provider]: providerConfig(settings, provider) } }
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
      /** null when Orca's worktrees couldn't be read. */
      worktrees: Record<string, TaskWorktree> | null
      worktreesError: string | null
      /** For example "using the last known project". */
      warning: string | null
    }

/** Task keys mapped to their task worktrees. */
export type WorktreesResult =
  | { kind: 'ready'; worktrees: Record<string, TaskWorktree> }
  | { kind: 'error'; message: string }

export type ActiveProjectResult = { projectId: string | null } | { kind: 'error'; message: string }

export type JiraSitesResult =
  | { kind: 'ready'; sites: { id: string; name: string }[] }
  | { kind: 'error'; message: string }

export type ActionResult = { ok: true } | { ok: false; message: string }

declare module 'orca' {
  interface PluginRequests {
    'tasks.load': { input: { cursor?: string }; output: TaskList }
    'worktrees.load': { input: { projectId: string }; output: WorktreesResult }
    'project.active': { input: {}; output: ActiveProjectResult }
    'jira.sites': { input: {}; output: JiraSitesResult }
    'task.start': { input: { projectId: string; task: Task }; output: ActionResult }
    'worktree.open': { input: { worktreeId: string }; output: ActionResult }
  }
  interface PluginPanelEvents {}
}
