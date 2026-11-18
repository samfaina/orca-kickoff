// Kickoff's worker. Orca transpiles this file when it loads. It only runs commands and wires the
// pure parts together; every expected failure is answered as data, so the panel never depends on
// a thrown message.
import type { OrcaWorkerApi } from 'orca/worker'
import { resolveAgent, systemDefaultAgentReader, type DefaultAgent } from './agent'
import { CliError, cleanMessage, systemRunCli, type RunCli } from './cli'
import { worktreeName } from './naming'
import {
  checkOrcaAnswer,
  findActiveProject,
  findActiveProjectId,
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
  projectProvider,
  projectSettings,
  queryCount,
  readSettings,
  SETTINGS_KEY,
  trackerOf,
  type ActionResult,
  type ActiveProjectResult,
  type JiraSitesResult,
  type ProjectRef,
  type ProjectSettings,
  type StartEnded,
  type StartResult,
  type Task,
  type TaskList,
  type WorktreesResult
} from './protocol'
import { taskLister } from './providers'
import { JIRA_CONNECTION_ARGS, parseJiraSites } from './providers/jira-orca'
import type { PageRequest } from './providers/types'
import { buildPrompt, projectTemplates } from './template'

/** After a timed-out `worktree create`, Orca may still finish it; a Start of the same task waits
 *  this long, so it doesn't make a second worktree. */
const TIMEOUT_GUARD_MS = 5 * 60_000

export type WorkerDependencies = {
  run: RunCli
  readDefaultAgent: () => Promise<DefaultAgent>
  now: () => number
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, { run: systemRunCli(), readDefaultAgent: systemDefaultAgentReader(), now: Date.now })
}

type OrcaState = { projects: ProjectRef[]; worktrees: OrcaWorktree[]; statuses: OrcaWorktreeStatus[] }

/** `activate` with its dependencies passed in, so tests can answer for the CLIs. */
export function activateWith(orca: OrcaWorkerApi, { run, readDefaultAgent, now }: WorkerDependencies): void {
  /** The project of the last successful lookup, used when Orca can't answer. */
  let lastProject: ProjectRef | null = null
  /** Starts running their quick checks, by project and task, so a second Start joins the first. */
  const checking = new Map<string, Promise<StartResult>>()
  /** Starts whose `worktree create` runs, by project and task. */
  const creating = new Map<string, { projectId: string; taskKey: string }>()
  /** When the last Start of a task timed out, by project and task. */
  const timedOutAt = new Map<string, number>()

  async function readWorktreeState(): Promise<Omit<OrcaState, 'projects'>> {
    const [worktrees, statuses] = await Promise.all([run('orca', WORKTREE_LIST_ARGS), run('orca', WORKTREE_PS_ARGS)])
    return { worktrees: parseWorktrees(worktrees), statuses: parseWorktreePs(statuses) }
  }

  async function readOrca(): Promise<OrcaState> {
    const [projects, state] = await Promise.all([run('orca', PROJECT_LIST_ARGS), readWorktreeState()])
    return { projects: parseProjects(projects), ...state }
  }

  async function readProjectSettings(projectId: string): Promise<ProjectSettings> {
    return projectSettings(readSettings(await orca.storage.get(SETTINGS_KEY)), projectId)
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

  /** A page of the project's tasks: of the whole list, or of a tracker search with `query`. */
  async function loadTasks(request: PageRequest): Promise<TaskList> {
    let project: ProjectRef | null = null
    try {
      const active = await activeProject()
      project = active.project
      if (!project) return { kind: 'no-project' }
      const settings = await readProjectSettings(project.id)
      const providerId = projectProvider(settings, project)
      if (!providerId) return { kind: 'needs-config', project }
      const page = await taskLister(providerId)(run, project, settings, request)
      const { state } = active
      return {
        kind: 'ready',
        project,
        provider: providerId,
        ...page,
        queryCount: queryCount(settings, providerId),
        worktrees: state ? findTaskWorktrees(trackerOf(providerId), project.id, state.worktrees, state.statuses) : null,
        worktreesError: state ? null : active.orcaError,
        starting: startsUnderWay(project.id),
        warning: active.warning
      }
    } catch (error) {
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
  function startTask(projectId: string, task: Task, templateId: string): Promise<StartResult> {
    const id = `${projectId}\n${task.key}`
    if (creating.has(id)) return Promise.resolve({ ok: true, underWay: true })
    const running = checking.get(id)
    if (running) return running
    const checked = checkAndCreate(id, projectId, task, templateId).finally(() => checking.delete(id))
    checking.set(id, checked)
    return checked
  }

  async function checkAndCreate(id: string, projectId: string, task: Task, templateId: string): Promise<StartResult> {
    try {
      const [projectsOut, worktreesOut] = await Promise.all([run('orca', PROJECT_LIST_ARGS), run('orca', WORKTREE_LIST_ARGS)])
      const project = parseProjects(projectsOut).find((candidate) => candidate.id === projectId)
      if (!project) return { ok: false, message: `Orca has no project "${projectId}".` }
      // Already started, maybe by a Start that timed out but that Orca finished.
      if (findTaskWorktrees(task.tracker, projectId, parseWorktrees(worktreesOut), [])[task.key]) {
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
      const settings = await readProjectSettings(projectId)
      const agent = await resolveAgent(settings.agent, readDefaultAgent)
      if (!agent.ok) return agent
      // Never another template: the person chose this one for this task.
      const template = projectTemplates(settings).find((candidate) => candidate.id === templateId)
      if (!template) return { ok: false, message: 'The prompt template you chose no longer exists — pick another one.' }
      const name = worktreeName(task)
      const prompt = buildPrompt(template.text, task, project, name)
      if (!prompt.ok) return prompt
      const args = worktreeCreateArgs({ projectId, name, task, agent: agent.agent, prompt: prompt.prompt })
      creating.set(id, { projectId, taskKey: task.key })
      void createAndPostEnd(id, args,{ projectId, taskKey: task.key, agent: agent.agent })
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

  async function openWorktree(worktreeId: string): Promise<ActionResult> {
    try {
      checkOrcaAnswer(await run('orca', worktreeActivateArgs(worktreeId)))
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  orca.panels.handle('tasks.load', ({ cursor, query }) => loadTasks({ cursor, query }))
  orca.panels.handle('worktrees.load', ({ projectId }) => loadWorktrees(projectId))
  orca.panels.handle('project.active', () => activeProjectId())
  orca.panels.handle('jira.sites', () => jiraSites())
  orca.panels.handle('task.start', ({ projectId, task, templateId }) => startTask(projectId, task, templateId))
  orca.panels.handle('starts.load', ({ projectId }) => ({ starting: startsUnderWay(projectId) }))
  orca.panels.handle('worktree.open', ({ worktreeId }) => openWorktree(worktreeId))
}

/** A CliError's message is ready to show; anything else is cleaned first. */
function messageOf(error: unknown): string {
  if (error instanceof CliError) return error.message
  return cleanMessage(error instanceof Error ? error.message : String(error))
}
