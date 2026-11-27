// Kickoff's worker. Orca transpiles this file when it loads. It only runs commands and wires the
// pure parts together; every expected failure is answered as data, so the panel never depends on
// a thrown message.
import { readFile } from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'
import { aboutKickoff, manifestUrl, type About } from './about'
import { agentInstalledArgs, parseAvailableAgents, resolveAgent } from './agent'
import { projectBranchSettings } from './branch-settings'
import { CliError, cleanMessage, systemRunCli, type RunCli } from './cli'
import { startBranch, worktreeName } from './naming'
import {
  checkOrcaAnswer,
  findActiveProject,
  findActiveProjectId,
  findActiveWorktreeId,
  findTaskWorktrees,
  parseProjects,
  parseWorktreePs,
  parseWorktrees,
  PROJECT_LIST_ARGS,
  worktreeActivateArgs,
  worktreeCreateArgs,
  WORKTREE_CREATE_TIMEOUT_MS,
  WORKTREE_LIST_ARGS,
  WORKTREE_PS_ARGS,
  type OrcaWorktree,
  type OrcaWorktreeStatus
} from './orca'
import {
  filterAsRun,
  globalFilters,
  globalSettings,
  globalTemplates,
  listedFilter,
  projectProvider,
  projectSettings,
  queryCount,
  readSettings,
  SETTINGS_KEY,
  trackerOf,
  type ActionResult,
  type ActiveProjectResult,
  type AgentsResult,
  type JiraSitesResult,
  type LaunchRequest,
  type LinearChoicesResult,
  type ProjectRef,
  type ProjectSettings,
  type Settings,
  type StartEnded,
  type StartResult,
  type Task,
  type TaskList,
  type WorktreesResult
} from './protocol'
import { taskLister } from './providers'
import { runHereLaunch } from './run-here'
import { JIRA_CONNECTION_ARGS, parseJiraSites } from './providers/jira-orca'
import {
  LINEAR_PROJECT_LIST_TIMEOUT_MS,
  linearProjectListArgs,
  linearTeamArgs,
  linearTeamListArgs,
  parseLinearProjects,
  parseLinearTeamNames,
  parseLinearTeams
} from './providers/linear-orca'
import { FilterError } from './providers/queries'
import type { PageRequest } from './providers/types'
import { buildPrompt, findTemplate, TEMPLATE_GONE } from './template'

/** After a timed-out `worktree create`, Orca may still finish it; a Start of the same task waits
 *  this long, so it doesn't make a second worktree. */
const TIMEOUT_GUARD_MS = 5 * 60_000

/** Why the agents of the active worktree's host can't be read when no worktree is active. */
const NO_ACTIVE_WORKTREE = "No worktree is selected in Orca, so Kickoff can't read the agents of its host."

export type WorkerDependencies = {
  run: RunCli
  now: () => number
  /** The file URL of this file, where Orca loaded it from: inside the installed content folder,
   *  or the folder of a development plugin. */
  workerUrl: string
  readFile: (url: URL) => Promise<string>
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, { run: systemRunCli(), now: Date.now, workerUrl: import.meta.url, readFile: (url) => readFile(url, 'utf8') })
}

type OrcaState = { projects: ProjectRef[]; worktrees: OrcaWorktree[]; statuses: OrcaWorktreeStatus[] }

/** `activate` with its dependencies passed in, so tests can answer for the CLIs. */
export function activateWith(orca: OrcaWorkerApi, { run, now, workerUrl, readFile }: WorkerDependencies): void {
  /** The project of the last successful lookup, used when Orca can't answer. */
  let lastProject: ProjectRef | null = null
  /** Starts running their quick checks, by project and task, so a second Start joins the first. */
  const checking = new Map<string, Promise<StartResult>>()
  /** Starts whose `worktree create` runs, by project and task. */
  const creating = new Map<string, { projectId: string; taskKey: string }>()
  /** When the last Start of a task timed out, by project and task. */
  const timedOutAt = new Map<string, number>()
  /** Run heres still running, by project and task, so a second one joins the first. */
  const runningHere = new Map<string, Promise<ActionResult>>()

  async function readWorktreeState(): Promise<Omit<OrcaState, 'projects'>> {
    const [worktrees, statuses] = await Promise.all([run('orca', WORKTREE_LIST_ARGS), run('orca', WORKTREE_PS_ARGS)])
    return { worktrees: parseWorktrees(worktrees), statuses: parseWorktreePs(statuses) }
  }

  async function readOrca(): Promise<OrcaState> {
    const [projects, state] = await Promise.all([run('orca', PROJECT_LIST_ARGS), readWorktreeState()])
    return { projects: parseProjects(projects), ...state }
  }

  /** The agents Orca can start on the host of the worktree `worktreeId`, read each time they are
   *  asked for: turning an agent off in Orca shows at once. A failure is data. */
  async function readAgents(worktreeId: string): Promise<AgentsResult> {
    try {
      return parseAvailableAgents(await run('orca', agentInstalledArgs(worktreeId)))
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** The agents of the active worktree's host, for Project settings and the task's card. A failure
   *  is data. */
  async function loadAgents(): Promise<AgentsResult> {
    try {
      const worktreeId = findActiveWorktreeId(parseWorktreePs(await run('orca', WORKTREE_PS_ARGS)))
      return worktreeId === null ? { kind: 'error', message: NO_ACTIVE_WORKTREE } : await readAgents(worktreeId)
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  async function readStoredSettings(): Promise<Settings> {
    return readSettings(await orca.storage.get(SETTINGS_KEY))
  }

  async function readProjectSettings(projectId: string): Promise<ProjectSettings> {
    return projectSettings(await readStoredSettings(), projectId)
  }

  /** The active project and Orca's state, or the last known project with a warning (and no
   *  state) when Orca can't answer. */
  async function activeProject(): Promise<{ project: ProjectRef | null; state: OrcaState | null; warning: string | null; orcaError: string | null }> {
    try {
      const state = await readOrca()
      const project = findActiveProject(state.projects, state.worktrees, state.statuses)
      if (project) lastProject = project
      return { project, state, warning: null, orcaError: null }
    } catch (error) {
      if (!lastProject) throw error
      const message = messageOf(error)
      return { project: lastProject, state: null, warning: `Using the last known project (${lastProject.name}). ${message}`, orcaError: message }
    }
  }

  /** A page of the tasks of the filter `filterId` names, on the project's tracker, among its own
   *  and the global ones of that tracker: of its whole list, or of a tracker search with `query`. Its queries run as `filterAsRun` gives them, with
   *  the project's Jira project key. A failure its queries cause names it. */
  async function loadTasks({ filterId, ...request }: { filterId?: string } & Omit<PageRequest, 'filter'>): Promise<TaskList> {
    let project: ProjectRef | null = null
    try {
      const active = await activeProject()
      project = active.project
      if (!project) return { kind: 'no-project' }
      const stored = await readStoredSettings()
      const settings = projectSettings(stored, project.id)
      const providerId = projectProvider(settings, project)
      if (!providerId) return { kind: 'needs-config', project }
      const tracker = trackerOf(providerId)
      const global = globalFilters(stored, tracker)
      const filter = listedFilter(settings, tracker, global, filterId)
      const asRun = filterAsRun(filter, tracker, settings.jiraProjectKey ?? '')
      if (!asRun.ok) return { kind: 'error', project, message: asRun.message, needsJiraProjectKey: true }
      const page = await taskLister(providerId)(run, project, settings, { ...request, filter: asRun.filter })
      const { state } = active
      return {
        kind: 'ready',
        project,
        provider: providerId,
        ...page,
        filterId: filter.id,
        queryCount: queryCount(settings, providerId, global, filter.id),
        worktrees: state ? findTaskWorktrees(tracker, project.id, state.worktrees, state.statuses) : null,
        worktreesError: state ? null : active.orcaError,
        starting: startsUnderWay(project.id),
        warning: active.warning
      }
    } catch (error) {
      if (error instanceof FilterError) return { kind: 'error', project, message: error.message, filterId: error.filterId }
      return { kind: 'error', project, message: messageOf(error) }
    }
  }

  async function loadWorktrees(projectId: string): Promise<WorktreesResult> {
    try {
      const state = await readOrca()
      const project = state.projects.find((candidate) => candidate.id === projectId)
      if (!project) return { kind: 'error', message: `Orca has no project "${projectId}".` }
      const providerId = projectProvider(await readProjectSettings(projectId), project)
      if (!providerId) return { kind: 'error', message: `${project.name} has no tracker.` }
      return { kind: 'ready', worktrees: findTaskWorktrees(trackerOf(providerId), projectId, state.worktrees, state.statuses) }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** Keys of the project's tasks whose `worktree create` runs. A restarted worker knows none. */
  function startsUnderWay(projectId: string): string[] {
    return [...creating.values()].filter((start) => start.projectId === projectId).map((start) => start.taskKey)
  }

  /** Runs the quick checks and answers with their failure, or starts the create and answers that
   *  it is under way without waiting for it. */
  function startTask(launch: LaunchRequest): Promise<StartResult> {
    const id = `${launch.projectId}\n${launch.task.key}`
    if (creating.has(id)) return Promise.resolve({ ok: true, underWay: true })
    const running = checking.get(id)
    if (running) return running
    const checked = checkAndCreate(id, launch).finally(() => checking.delete(id))
    checking.set(id, checked)
    return checked
  }

  async function checkAndCreate(id: string, { projectId, task, templateId, agent: choice }: LaunchRequest): Promise<StartResult> {
    try {
      const [projectsOut, worktreesOut] = await Promise.all([run('orca', PROJECT_LIST_ARGS), run('orca', WORKTREE_LIST_ARGS)])
      const project = parseProjects(projectsOut).find((candidate) => candidate.id === projectId)
      if (!project) return { ok: false, message: `Orca has no project "${projectId}".` }
      const worktrees = parseWorktrees(worktreesOut)
      // Already started, maybe by a Start that timed out but that Orca finished.
      if (findTaskWorktrees(task.tracker, projectId, worktrees, [])[task.key]) {
        timedOutAt.delete(id)
        return { ok: true, underWay: false }
      }
      const timedOut = timedOutAt.get(id)
      if (timedOut !== undefined && now() - timedOut < TIMEOUT_GUARD_MS) {
        return {
          ok: false,
          message: `The last Start of ${task.key} timed out less than five minutes ago, and Orca may still be creating its worktree. Wait a few minutes and reload the tasks before starting it again.`
        }
      }
      const stored = await readStoredSettings()
      const settings = projectSettings(stored, projectId)
      // The worktree is created on the host of the project's main worktree, which may not be the
      // active one's: the person may have switched projects since the list loaded.
      const main = worktrees.find((worktree) => worktree.projectId === projectId && worktree.isMain)
      const agents: AgentsResult = main
        ? await readAgents(main.id)
        : { kind: 'error', message: `Orca lists no main worktree of ${project.name}.` }
      // The agent chosen on the task's card, else the project's agent choice.
      const agent = resolveAgent(choice ?? settings.agent, agents)
      if (!agent.ok) return agent
      // Never another template: the person chose this one for this task, own or global.
      const template = findTemplate(settings, globalTemplates(stored), templateId)
      if (!template) return { ok: false, message: TEMPLATE_GONE }
      // The project's own branch settings, or the global ones, as stored, name both.
      const branchSettings = projectBranchSettings(settings, globalSettings(stored).branch)
      const name = worktreeName(task, branchSettings)
      // A taken branch is Orca's: it retries it as <branch>-2, -3 and so on.
      const { branch, problem } = startBranch(branchSettings, task)
      if (problem !== null) return { ok: false, message: problem }
      // {{branch}} is the branch as filled in, without a -2 Orca may add: the prompt comes first.
      const prompt = buildPrompt(template.text, task, project, branch ?? name, settings.jiraProjectKey ?? '')
      if (!prompt.ok) return prompt
      const args = worktreeCreateArgs({ projectId, name, branch, task, agent: agent.agent, prompt: prompt.prompt })
      creating.set(id, { projectId, taskKey: task.key })
      void createAndPostEnd(id, args, { projectId, taskKey: task.key, agent: agent.agent })
      return { ok: true, underWay: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /** Waits for the create, drops the Start from those under way, and posts how it ended. A post
   *  that throws is logged, and the panel learns the end from `starts.load`. It rejects only if the
   *  log throws too: then the channel to Orca is gone, and the worker exits with it. */
  async function createAndPostEnd(id: string, args: string[], start: Omit<StartEnded, 'ok' | 'message'>): Promise<void> {
    const result = await createWorktree(id, start.taskKey, args)
    creating.delete(id)
    try {
      orca.panels.post('start.ended', { ...start, ...result })
    } catch (error) {
      orca.log(`Couldn't post the end of the Start of ${start.taskKey}: ${messageOf(error)}`)
    }
  }

  /** Runs `worktree create` and says how it ended. A timeout sets the five-minute guard. */
  async function createWorktree(id: string, taskKey: string, args: string[]): Promise<ActionResult> {
    try {
      checkOrcaAnswer(await run('orca', args, { timeoutMs: WORKTREE_CREATE_TIMEOUT_MS }))
      timedOutAt.delete(id)
      return { ok: true }
    } catch (error) {
      if (!(error instanceof CliError && error.timedOut)) return { ok: false, message: messageOf(error) }
      timedOutAt.set(id, now())
      return {
        ok: false,
        message: `Orca didn't finish creating the worktree for ${taskKey} in time, and may still be creating it. Wait a few minutes and reload the tasks.`
      }
    }
  }

  /** Runs a Run here of the task, or joins the one of the same task still running, so two presses
   *  launch one agent. */
  function runHere(launch: LaunchRequest): Promise<ActionResult> {
    const id = `${launch.projectId}\n${launch.task.key}`
    const running = runningHere.get(id)
    if (running) return running
    const ran = checkAndLaunch(id, launch).finally(() => runningHere.delete(id))
    runningHere.set(id, ran)
    return ran
  }

  /** Reads Orca and the settings, then launches the agent in the active worktree once `runHereLaunch`
   *  finds nothing in the way. Orca answers the launch in under a second, so this waits for it. */
  async function checkAndLaunch(id: string, { projectId, task, templateId, agent: choice }: LaunchRequest): Promise<ActionResult> {
    try {
      // The task is about to have a task worktree. The other way round needs no check: a Run here
      // creates nothing a Start would collide with.
      if (creating.has(id) || checking.has(id)) return { ok: false, message: `${task.key} is being started. Wait for its worktree.` }
      const [state, stored] = await Promise.all([readOrca(), readStoredSettings()])
      const settings = projectSettings(stored, projectId)
      // The launch runs in the active worktree, so its host's agents are the ones to check. With none
      // active, runHereLaunch refuses before it looks at the agent.
      const activeId = findActiveWorktreeId(state.statuses)
      const agents: AgentsResult = activeId === null ? { kind: 'error', message: NO_ACTIVE_WORKTREE } : await readAgents(activeId)
      const launch = runHereLaunch({
        projectId,
        task,
        ...state,
        // The agent chosen on the task's card, else the project's agent choice.
        agent: resolveAgent(choice ?? settings.agent, agents),
        template: findTemplate(settings, globalTemplates(stored), templateId),
        jiraProjectKey: settings.jiraProjectKey ?? ''
      })
      if (!launch.ok) return launch
      checkOrcaAnswer(await run('orca', launch.args))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /** The active worktree's project id, for the panel to poll: only the two Orca queries that
   *  tell it, since the panel asks every few seconds. */
  async function activeProjectId(): Promise<ActiveProjectResult> {
    try {
      const { worktrees, statuses } = await readWorktreeState()
      return { projectId: findActiveProjectId(worktrees, statuses) }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  async function jiraSites(): Promise<JiraSitesResult> {
    try {
      return { kind: 'ready', sites: parseJiraSites(await run('orca', JIRA_CONNECTION_ARGS)) }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  /** The Linear query form's choices for the workspace `workspaceId`: its teams, with its Linear
   *  projects when `team` is blank, else with the states and labels of the team `team`, all read at
   *  once. A failure of any is data. */
  async function linearChoices(workspaceId: string, team = ''): Promise<LinearChoicesResult> {
    try {
      const teams = run('orca', linearTeamListArgs(workspaceId)).then(parseLinearTeams)
      if (team.trim() === '') {
        const projects = run('orca', linearProjectListArgs(workspaceId), { timeoutMs: LINEAR_PROJECT_LIST_TIMEOUT_MS }).then(parseLinearProjects)
        const [teamsListed, projectsListed] = await Promise.all([teams, projects])
        return { kind: 'ready', teams: teamsListed, projects: projectsListed.projects, ...(projectsListed.truncated ? { projectsTruncated: true as const } : {}) }
      }
      const teamNames = (list: 'states' | 'labels') => run('orca', linearTeamArgs(list, workspaceId, team)).then((stdout) => parseLinearTeamNames(stdout, list))
      const [listed, states, labels] = await Promise.all([teams, teamNames('states'), teamNames('labels')])
      return { kind: 'ready', teams: listed, states, labels }
    } catch (error) {
      return { kind: 'error', message: messageOf(error) }
    }
  }

  async function openWorktree(worktreeId: string): Promise<ActionResult> {
    try {
      checkOrcaAnswer(await run('orca', worktreeActivateArgs(worktreeId)))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /** Kickoff's version from the manifest next to the worker's `src/` folder, or null, logging why,
   *  when it can't be read or has none. It logs where the worker runs too, for whoever checks
   *  which Kickoff Orca loaded. */
  async function loadAbout(): Promise<About | null> {
    orca.log(`about.load: the worker runs from ${workerUrl}`)
    let manifest: URL | null = null
    try {
      manifest = manifestUrl(workerUrl)
      // readFile refuses a URL that isn't a file URL, so a null here is the manifest's.
      const about = aboutKickoff(workerUrl, await readFile(manifest))
      if (about === null) orca.log(`Couldn't read Kickoff's version from ${manifest.href}: it isn't JSON with a version.`)
      return about
    } catch (error) {
      orca.log(`Couldn't read Kickoff's version from ${manifest?.href ?? workerUrl}: ${messageOf(error)}`)
      return null
    }
  }

  orca.panels.handle('tasks.load', ({ filterId, cursor, query }) => loadTasks({ filterId, cursor, query }))
  orca.panels.handle('worktrees.load', ({ projectId }) => loadWorktrees(projectId))
  orca.panels.handle('project.active', () => activeProjectId())
  orca.panels.handle('jira.sites', () => jiraSites())
  orca.panels.handle('linear.choices', ({ workspaceId, team }) => linearChoices(workspaceId, team))
  orca.panels.handle('agents.load', () => loadAgents())
  orca.panels.handle('task.start', startTask)
  orca.panels.handle('task.runHere', runHere)
  orca.panels.handle('starts.load', ({ projectId }) => ({ starting: startsUnderWay(projectId) }))
  orca.panels.handle('worktree.open', ({ worktreeId }) => openWorktree(worktreeId))
  orca.panels.handle('about.load', () => loadAbout())
}

/** A CliError's message is ready to show; anything else is cleaned first. */
function messageOf(error: unknown): string {
  if (error instanceof CliError) return error.message
  return cleanMessage(error instanceof Error ? error.message : String(error))
}
