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
  readSettings,
  SETTINGS_KEY,
  trackerOf,
  type ActionResult,
  type JiraSitesResult,
  type ProjectRef,
  type ProjectSettings,
  type Task,
  type TaskList,
  type WorktreesResult
} from './protocol'
import { taskLister } from './providers'
import { JIRA_CONNECTION_ARGS, parseJiraSites } from './providers/jira-orca'
import { buildPrompt } from './template'

const NOT_READY = 'Kickoff is not ready yet.'

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
  /** Starts under way, by project and task, so a second Start joins the first. */
  const starting = new Map<string, Promise<ActionResult>>()
  /** When the last Start of a task timed out, by project and task. */
  const timedOutAt = new Map<string, number>()

  async function readOrca(): Promise<OrcaState> {
    const [projects, worktrees, statuses] = await Promise.all([
      run('orca', PROJECT_LIST_ARGS),
      run('orca', WORKTREE_LIST_ARGS),
      run('orca', WORKTREE_PS_ARGS)
    ])
    return { projects: parseProjects(projects), worktrees: parseWorktrees(worktrees), statuses: parseWorktreePs(statuses) }
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

  async function loadTasks(cursor: string | undefined): Promise<TaskList> {
    let project: ProjectRef | null = null
    try {
      const active = await activeProject()
      project = active.project
      if (!project) return { kind: 'no-project' }
      const settings = await readProjectSettings(project.id)
      const providerId = projectProvider(settings, project)
      if (!providerId) return { kind: 'needs-config', project }
      const page = await taskLister(providerId)(run, project, settings, cursor)
      const { state } = active
      return {
        kind: 'ready',
        project,
        provider: providerId,
        ...page,
        worktrees: state ? findTaskWorktrees(trackerOf(providerId), project.id, state.worktrees, state.statuses) : null,
        worktreesError: state ? null : active.orcaError,
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

  function startTask(projectId: string, task: Task): Promise<ActionResult> {
    const id = `${projectId}\n${task.key}`
    const running = starting.get(id)
    if (running) return running
    const started = createTaskWorktree(id, projectId, task).finally(() => starting.delete(id))
    starting.set(id, started)
    return started
  }

  async function createTaskWorktree(id: string, projectId: string, task: Task): Promise<ActionResult> {
    try {
      const [projectsOut, worktreesOut] = await Promise.all([run('orca', PROJECT_LIST_ARGS), run('orca', WORKTREE_LIST_ARGS)])
      const project = parseProjects(projectsOut).find((candidate) => candidate.id === projectId)
      if (!project) return { ok: false, message: `Orca has no project "${projectId}".` }
      // Already started, maybe by a Start that timed out but that Orca finished.
      if (findTaskWorktrees(task.tracker, projectId, parseWorktrees(worktreesOut), [])[task.key]) {
        timedOutAt.delete(id)
        return { ok: true }
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
      const name = worktreeName(task)
      const prompt = buildPrompt(settings.template, task, project, name)
      if (!prompt.ok) return prompt
      const args = worktreeCreateArgs({ projectId, name, task, agent: agent.agent, prompt: prompt.prompt })
      try {
        checkOrcaAnswer(await run('orca', args, { timeoutMs: WORKTREE_CREATE_TIMEOUT_MS }))
      } catch (error) {
        if (!(error instanceof CliError && error.timedOut)) throw error
        timedOutAt.set(id, now())
        return {
          ok: false,
          message: `Orca didn't finish creating the worktree for ${task.key} in time, and may still be creating it. Wait a few minutes and reload the tasks.`
        }
      }
      timedOutAt.delete(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
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

  orca.panels.handle('tasks.load', ({ cursor }) => loadTasks(cursor))
  orca.panels.handle('worktrees.load', ({ projectId }) => loadWorktrees(projectId))
  orca.panels.handle('project.active', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('jira.sites', () => jiraSites())
  orca.panels.handle('task.start', ({ projectId, task }) => startTask(projectId, task))
  orca.panels.handle('worktree.open', ({ worktreeId }) => openWorktree(worktreeId))
}

/** A CliError's message is ready to show; anything else is cleaned first. */
function messageOf(error: unknown): string {
  if (error instanceof CliError) return error.message
  return cleanMessage(error instanceof Error ? error.message : String(error))
}
