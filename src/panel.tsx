// Kickoff's side panel: the active project's tracker, its open tasks, its Start options, and Start. No build
// step: Orca strips the types and compiles the JSX when the panel loads. The worker does the work;
// the panel asks it and draws the answers.
import {
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  Link,
  Row,
  Select,
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
  type ProjectRef,
  type ProviderConfigs,
  type ProviderId,
  type StartEnded,
  type StartResult,
  type Task,
  type TaskList,
  type TaskWorktree
} from './protocol'
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from './template'

/** Orca queries and the tracker can take up to about 65 s together. */
const LOAD_TIMEOUT_MS = 90_000
/** `task.start` answers after its quick checks, two Orca queries of at most 20 s each; the create
 *  goes on in the worker, which posts `start.ended` when it ends. */
const START_TIMEOUT_MS = 60_000
/** Start options save themselves after this pause. */
const SAVE_DELAY_MS = 600
/** How often the panel asks for the active project while it is visible. */
const POLL_MS = 3_000
/** Orca detects the agent of a new worktree a few seconds after its create ends, so the panel
 *  reads the worktrees once more after this pause. */
const AGENT_CHECK_MS = 5_000

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
type ShownSettings = { projectId: string; provider: ProviderId | null; providers: ProviderConfigs; agent: string; template: string }

const list = atom<TaskList | null>(null)
const loading = atom(false)
/** The tracker settings and Start options of the listed project, as the person sees them. */
const shownSettings = atom<ShownSettings | null>(null)
const optionsOpen = atom('startOptionsOpen', true, { persist: 'plugin' })
/** Whether the person left the Tracker section open; it is always open while no list is loaded. */
const trackerOpen = atom('trackerOpen', false, { persist: 'plugin' })
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
/** The error of each task's last Start, or of opening its worktree. */
const taskErrors = atom<Record<string, string>>({})

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
  const settings = readSettings(await storage.get(SETTINGS_KEY))
  await storage.set(SETTINGS_KEY, withProjectChanges(settings, toSave.projectId, toSave.changes) as unknown as JsonValue)
}

function changeSettings(changes: ProjectChanges): void {
  const current = read(shownSettings)
  if (!current) return
  const providers = { ...current.providers, ...changes.providers }
  set(shownSettings, { ...current, ...changes, provider: changes.provider ?? current.provider, providers })
  const earlier = pending?.projectId === current.projectId ? pending.changes : {}
  pending = { projectId: current.projectId, changes: { ...earlier, ...changes, providers: { ...earlier.providers, ...changes.providers } } }
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
    template: settings.template ?? DEFAULT_TEMPLATE
  })
}

/** Chooses the project's provider, saves it with its configuration and lists its tasks. */
function chooseProviderFor(value: string): void {
  const current = read(shownSettings)
  const provider = PROVIDER_OPTIONS.find((option) => option.value === value)?.value
  if (!current || !provider) return
  set(trackerOpen, true)
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
  try {
    await flushSettings()
    askedAt = ++startClock
    answer = await plugin.request('tasks.load', {}, { timeoutMs: LOAD_TIMEOUT_MS })
  } catch (error) {
    answer = { kind: 'error', project: null, message: `Kickoff's worker didn't answer (${errorCode(error)}). Reload to try again.` }
  }
  if (mine !== generation) return
  if ('project' in answer && answer.project) {
    try {
      await showSettings(answer.project)
    } catch {
      // Storage unreadable: the settings stay hidden; Start still uses what the worker reads.
    }
    if (mine !== generation) return
  }
  if (read(shownSettings)?.provider === 'jira-orca') void loadJiraSites()
  if (reason !== 'poll') lastPolledProjectId = undefined
  // Only a ready list reports the Starts under way.
  if (answer.kind === 'ready') showStarting(answer.starting, askedAt)
  else showStarting([], 0)
  if (answer.kind === 'ready' && answer.worktrees) agentsReported(answer.project.id, answer.worktrees)
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
 *  them, or null when they couldn't be read or the project changed meanwhile. */
async function refreshWorktrees(projectId: string): Promise<Record<string, TaskWorktree> | null> {
  try {
    const answer = await plugin.request('worktrees.load', { projectId })
    const current = read(list)
    if (answer.kind !== 'ready' || current?.kind !== 'ready' || current.project.id !== projectId) return null
    agentsReported(projectId, answer.worktrees)
    set(list, { ...current, worktrees: answer.worktrees, worktreesError: null })
    return answer.worktrees
  } catch {
    return null
  }
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
    answer = await plugin.request('task.start', { projectId, task }, { timeoutMs: START_TIMEOUT_MS })
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
 *  task now has a worktree: a Start that timed out may have finished. When the Start passed an
 *  agent, the card says it is starting from before that read, so it never shows the new worktree
 *  without one, until Orca reports the agent or one more read. */
async function finishStart(projectId: string, key: string, error: string | null, agent: string | null): Promise<void> {
  if (agent !== null) update(agentStarting, (keys) => ({ ...keys, [key]: projectId }))
  const worktrees = await refreshWorktrees(projectId)
  underWaySince.delete(key)
  update(starting, ({ [key]: _, ...rest }) => rest)
  const worktree = readyProjectId() === projectId ? worktrees?.[key] : undefined
  if (!worktree) stopAgentStarting(projectId, key)
  if (readyProjectId() !== projectId) return
  setTaskError(key, worktree ? null : error)
  if (read(agentStarting)[key] === projectId) checkAgentLater(projectId, key)
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
      void refreshWorktrees(projectId).finally(() => update(agentStarting, ({ [key]: _, ...rest }) => rest))
    }, AGENT_CHECK_MS)
  )
}

/** Stops showing as starting the agents of the project's tasks whose worktree Orca now reports
 *  running one. */
function agentsReported(projectId: string, worktrees: Record<string, TaskWorktree>): void {
  const shown = read(agentStarting)
  const reported = Object.keys(shown).filter((key) => shown[key] === projectId && worktrees[key]?.agent)
  if (reported.length === 0) return
  set(agentStarting, Object.fromEntries(Object.entries(shown).filter(([key]) => !reported.includes(key))))
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
  const busy = read(loading)
  const project = current && 'project' in current ? current.project : null
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={3}>{project ? project.name : 'Kickoff'}</Heading>
        <Row gap="xs" align="center">
          {busy && current ? <Spinner label="Reloading tasks" labelHidden /> : null}
          <IconButton icon="refresh" label="Reload tasks" tooltip="Reload tasks" size="sm" variant="ghost" onPress={() => void load()} />
        </Row>
      </Row>
      {project ? <TrackerSection listed={current?.kind === 'ready'} /> : null}
      {project ? <StartOptionsSection /> : null}
      {current ? <Body list={current} /> : <Spinner label="Loading tasks" />}
    </Stack>
  )
}

function TrackerSection({ listed }: { listed: boolean }) {
  const shown = read(shownSettings)
  if (!shown) return null
  const providerOptions = shown.provider === null ? [{ value: NO_TRACKER, label: 'Choose a tracker' }, ...PROVIDER_OPTIONS] : PROVIDER_OPTIONS
  return (
    <Collapsible title="Tracker" open={!listed || read(trackerOpen)} onChange={(open) => set(trackerOpen, open)}>
      <Stack gap="sm">
        <Select label="Tracker" value={shown.provider ?? NO_TRACKER} options={providerOptions} onChange={chooseProviderFor} />
        {shown.provider === 'jira-orca' ? <JiraOrcaSettings providers={shown.providers} /> : null}
        {shown.provider === 'jira-twg' ? <JiraTwgSettings providers={shown.providers} /> : null}
      </Stack>
    </Collapsible>
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
      onSubmit={() => void load()}
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
        onSubmit={() => void load()}
      />
      <Input
        label="Profile"
        value={config.profile}
        placeholder="twg's default profile"
        onChange={(profile) => changeJiraConfig('jira-twg', { profile })}
        onSubmit={() => void load()}
      />
      <Text size="sm" muted>
        Kickoff reads Jira through the Teamwork Graph CLI. Run `twg login` in a terminal first if you haven't. Leave Site and Profile empty to use twg's defaults.
      </Text>
    </Stack>
  )
}

function StartOptionsSection() {
  const shown = read(shownSettings)
  if (!shown) return null
  const agentOptions = AGENT_OPTIONS.some((option) => option.value === shown.agent)
    ? AGENT_OPTIONS
    : [...AGENT_OPTIONS, { value: shown.agent, label: shown.agent }]
  return (
    <Collapsible title="Start options" open={read(optionsOpen)} onChange={(open) => set(optionsOpen, open)}>
      <Stack gap="sm">
        <Select label="Agent" value={shown.agent} options={agentOptions} onChange={(agent) => changeSettings({ agent })} />
        <Textarea
          label="Prompt template"
          value={shown.template}
          rows={4}
          placeholder="Empty: the prompt is the task URL"
          onChange={(template) => changeSettings({ template })}
        />
        <Text size="sm" muted>
          {`Variables: ${TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(', ')}. An empty template gives the task URL.`}
        </Text>
      </Stack>
    </Collapsible>
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
          description={`Choose a tracker above to list the tasks of ${list.project.name}.`}
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
      return (
        <Stack gap="sm">
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
          {list.tasks.length === 0 ? (
            <EmptyState title="No open tasks" icon="check" />
          ) : (
            list.tasks.map((task) => <TaskCard key={task.key} task={task} projectId={list.project.id} worktrees={list.worktrees} />)
          )}
          {list.nextCursor !== null ? <LoadMore /> : null}
          {list.truncated ? (
            <Text size="sm" muted>
              {list.provider === 'github'
                ? "Showing the first 100 of your repository's issues."
                : 'Showing the first 100 tasks — narrow your JQL.'}
            </Text>
          ) : null}
        </Stack>
      )
  }
}

function LoadMore() {
  const error = read(moreError)
  return (
    <Stack gap="xs">
      {error ? (
        <Text size="sm" tone="danger">
          {`Couldn't load more tasks: ${error}`}
        </Text>
      ) : null}
      <Row gap="xs" align="center">
        <Button key="load-more" size="sm" variant="ghost" disabled={read(loadingMore)} onPress={() => void loadMore()}>
          Load more
        </Button>
        {read(loadingMore) ? <Spinner label="Loading more tasks" labelHidden /> : null}
      </Row>
    </Stack>
  )
}

/** What the card says about its worktree's agent. */
function agentLine(worktree: TaskWorktree, agentStarting: boolean): string {
  if (worktree.agent) return `Agent: ${worktree.agent}`
  return agentStarting ? 'Agent starting…' : 'No agent running'
}

function TaskCard({ task, projectId, worktrees }: { task: Task; projectId: string; worktrees: Record<string, TaskWorktree> | null }) {
  // Every GitHub task is open, so its status says nothing.
  const status = task.tracker !== 'github' ? task.status : null
  const worktree = worktrees?.[task.key] ?? null
  const isStarting = worktree === null && read(starting)[task.key] === true
  const error = read(taskErrors)[task.key]
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text>
          <Link href={task.url}>{task.key}</Link> {task.title}
        </Text>
        {worktree ? null : isStarting ? (
          <Spinner label={`Starting ${task.key}`} labelHidden />
        ) : (
          <Button key={`start:${task.key}`} size="sm" icon="play" disabled={worktrees === null} onPress={() => void startTask(task)}>
            Start
          </Button>
        )}
      </Row>
      {status || task.labels.length > 0 ? (
        <Row gap="xs" wrap>
          {status ? <Badge tone="accent">{status}</Badge> : null}
          {task.labels.map((label) => (
            <Badge key={label}>{label}</Badge>
          ))}
        </Row>
      ) : null}
      {worktree ? (
        <Row gap="xs" align="center" wrap>
          <Link onPress={() => void openWorktree(task.key, worktree.worktreeId)}>{worktree.name}</Link>
          <Text size="sm" muted>
            {agentLine(worktree, read(agentStarting)[task.key] === projectId)}
          </Text>
        </Row>
      ) : null}
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
