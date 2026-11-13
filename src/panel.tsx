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
  chooseProvider,
  projectProvider,
  projectSettings,
  providerConfig,
  readSettings,
  SETTINGS_KEY,
  withProjectChanges,
  type JiraSitesResult,
  type ProjectChanges,
  type ProjectRef,
  type ProviderConfigs,
  type ProviderId,
  type Task,
  type TaskList,
  type TaskWorktree
} from './protocol'
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from './template'

/** Orca queries and the tracker can take up to about 65 s together. */
const LOAD_TIMEOUT_MS = 90_000
/** `worktree create` may take 110 s in the worker; this is the most a request may wait. */
const START_TIMEOUT_MS = 120_000
/** Start options save themselves after this pause. */
const SAVE_DELAY_MS = 600

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
const options = atom<ShownSettings | null>(null)
const optionsOpen = atom('startOptionsOpen', true, { persist: 'plugin' })
/** Whether the person left the Tracker section open; it is always open while no list is loaded. */
const trackerOpen = atom('trackerOpen', false, { persist: 'plugin' })
/** The sites of Orca's Jira connection, asked for the first time they are needed. */
const jiraSites = atom<JiraSitesResult | 'loading' | null>(null)
/** Task keys with a Start under way. */
const starting = atom<Record<string, true>>({})
/** The error of each task's last Start, or of opening its worktree. */
const taskErrors = atom<Record<string, string>>({})

/** Rises with each load, so an answer that arrives after a newer request is dropped. */
let generation = 0

/** Settings changes not saved yet, for one project. */
let pending: { projectId: string; changes: ProjectChanges } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Saves pending settings changes now. The worker reads settings from storage, so this runs
 *  before every request that depends on them. */
async function flushOptions(): Promise<void> {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  const toSave = pending
  pending = null
  if (!toSave) return
  const settings = readSettings(await storage.get(SETTINGS_KEY))
  await storage.set(SETTINGS_KEY, withProjectChanges(settings, toSave.projectId, toSave.changes) as unknown as JsonValue)
}

function changeOptions(changes: ProjectChanges): void {
  const current = read(options)
  if (!current) return
  const providers = { ...current.providers, ...changes.providers }
  set(options, { ...current, ...changes, provider: changes.provider ?? current.provider, providers })
  const earlier = pending?.projectId === current.projectId ? pending.changes : {}
  pending = { projectId: current.projectId, changes: { ...earlier, ...changes, providers: { ...earlier.providers, ...changes.providers } } }
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void flushOptions(), SAVE_DELAY_MS)
}

/** Shows the stored settings of `project`, unless they are already shown. */
async function showOptions(project: ProjectRef): Promise<void> {
  if (read(options)?.projectId === project.id) return
  const settings = projectSettings(readSettings(await storage.get(SETTINGS_KEY)), project.id)
  const provider = projectProvider(settings, project)
  set(options, {
    projectId: project.id,
    provider,
    providers: settings.providers,
    agent: settings.agent ?? 'orca-default',
    template: settings.template ?? DEFAULT_TEMPLATE
  })
  if (provider === 'jira-orca') void loadJiraSites()
}

/** Chooses the project's provider, saves it with its configuration and lists its tasks. */
function chooseTracker(value: string): void {
  const current = read(options)
  const provider = PROVIDER_OPTIONS.find((option) => option.value === value)?.value
  if (!current || !provider) return
  set(trackerOpen, true)
  const chosen = chooseProvider({ providers: current.providers }, provider)
  changeOptions({ provider, providers: { [provider]: chosen.providers[provider] } })
  if (provider === 'jira-orca') void loadJiraSites()
  void load()
}

function changeJiraOrca(changes: Partial<Required<ProviderConfigs>['jira-orca']>): void {
  const current = read(options)
  if (!current) return
  changeOptions({ providers: { 'jira-orca': { ...providerConfig({ providers: current.providers }, 'jira-orca'), ...changes } } })
}

async function loadJiraSites(): Promise<void> {
  if (read(jiraSites) !== null) return
  set(jiraSites, 'loading')
  try {
    set(jiraSites, await plugin.request('jira.sites', {}))
  } catch (error) {
    set(jiraSites, { kind: 'error', message: `Kickoff's worker didn't answer (${errorCode(error)}).` })
  }
}

async function load(): Promise<void> {
  const mine = ++generation
  set(loading, true)
  let answer: TaskList
  try {
    await flushOptions()
    answer = await plugin.request('tasks.load', {}, { timeoutMs: LOAD_TIMEOUT_MS })
  } catch (error) {
    answer = { kind: 'error', project: null, message: `Kickoff's worker didn't answer (${errorCode(error)}). Reload to try again.` }
  }
  if (mine !== generation) return
  if ('project' in answer && answer.project) {
    try {
      await showOptions(answer.project)
    } catch {
      // Storage unreadable: the options stay hidden; Start still uses what the worker reads.
    }
    if (mine !== generation) return
  }
  set(list, answer)
  set(loading, false)
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

async function startTask(task: Task): Promise<void> {
  const projectId = readyProjectId()
  if (!projectId || read(starting)[task.key]) return
  update(starting, (keys): Record<string, true> => ({ ...keys, [task.key]: true as const }))
  setTaskError(task.key, null)
  let error: string | null = null
  try {
    await flushOptions()
    const answer = await plugin.request('task.start', { projectId, task }, { timeoutMs: START_TIMEOUT_MS })
    if (!answer.ok) error = answer.message
  } catch (thrown) {
    error = `Kickoff's worker didn't answer (${errorCode(thrown)}). Reload the tasks to see whether ${task.key} started.`
  }
  // Whatever the answer, Orca's worktrees say whether the task started: a Start that timed out
  // may have finished.
  const worktrees = await refreshWorktrees(projectId)
  if (worktrees?.[task.key]) error = null
  update(starting, ({ [task.key]: _, ...rest }) => rest)
  if (readyProjectId() === projectId) setTaskError(task.key, error)
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

export function setup(ctx: PanelContext): void {
  let started = false
  const reload = () => {
    started = true
    void load()
  }
  // Orca sends the current context to each new subscriber; load now only if it hasn't yet.
  ctx.subscriptions.push(on('workspace.changed', reload))
  ctx.subscriptions.push({ dispose: () => void flushOptions() })
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
  const shown = read(options)
  if (!shown) return null
  const providerOptions = shown.provider === null ? [{ value: NO_TRACKER, label: 'Choose a tracker' }, ...PROVIDER_OPTIONS] : PROVIDER_OPTIONS
  return (
    <Collapsible title="Tracker" open={!listed || read(trackerOpen)} onChange={(open) => set(trackerOpen, open)}>
      <Stack gap="sm">
        <Select label="Tracker" value={shown.provider ?? NO_TRACKER} options={providerOptions} onChange={chooseTracker} />
        {shown.provider === 'jira-orca' ? <JiraOrcaSettings providers={shown.providers} /> : null}
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
      <Input
        label="JQL"
        value={config.jql}
        placeholder="assignee = currentUser() AND statusCategory != Done"
        onChange={(jql) => changeJiraOrca({ jql })}
        onSubmit={() => void load()}
      />
      <Select
        label="Site"
        value={config.siteId || DEFAULT_SITE}
        options={siteOptions}
        onChange={(value) => {
          changeJiraOrca({ siteId: value === DEFAULT_SITE ? '' : value })
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

function StartOptionsSection() {
  const shown = read(options)
  if (!shown) return null
  const agentOptions = AGENT_OPTIONS.some((option) => option.value === shown.agent)
    ? AGENT_OPTIONS
    : [...AGENT_OPTIONS, { value: shown.agent, label: shown.agent }]
  return (
    <Collapsible title="Start options" open={read(optionsOpen)} onChange={(open) => set(optionsOpen, open)}>
      <Stack gap="sm">
        <Select label="Agent" value={shown.agent} options={agentOptions} onChange={(agent) => changeOptions({ agent })} />
        <Textarea
          label="Prompt template"
          value={shown.template}
          rows={4}
          placeholder="Empty: the prompt is the task URL"
          onChange={(template) => changeOptions({ template })}
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
            list.tasks.map((task) => <TaskCard key={task.key} task={task} worktrees={list.worktrees} />)
          )}
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

function TaskCard({ task, worktrees }: { task: Task; worktrees: Record<string, TaskWorktree> | null }) {
  // Every GitHub task is open, so its status says nothing.
  const status = task.tracker !== 'github' ? task.status : null
  const worktree = worktrees?.[task.key] ?? null
  const error = read(taskErrors)[task.key]
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Row justify="between" align="center" gap="xs">
        <Text>
          <Link href={task.url}>{task.key}</Link> {task.title}
        </Text>
        {worktree ? null : read(starting)[task.key] ? (
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
            {worktree.agent ? `Agent: ${worktree.agent}` : 'No agent running'}
          </Text>
        </Row>
      ) : null}
      {error ? (
        <Text size="sm" tone="danger">
          {error}
        </Text>
      ) : null}
    </Box>
  )
}
