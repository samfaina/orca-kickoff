// Kickoff's worker. Orca transpiles this file when it loads. It only runs commands and wires the
// pure parts together; every expected failure is answered as data, so the panel never depends on
// a thrown message.
import type { OrcaWorkerApi } from 'orca/worker'
import { CliError, cleanMessage, systemRunCli, type RunCli } from './cli'
import {
  findActiveProject,
  parseProjects,
  parseWorktreePs,
  parseWorktrees,
  PROJECT_LIST_ARGS,
  WORKTREE_LIST_ARGS,
  WORKTREE_PS_ARGS
} from './orca'
import { projectProvider, projectSettings, readSettings, SETTINGS_KEY, type ProjectRef, type TaskList } from './protocol'
import { taskLister } from './providers'

const NOT_READY = 'Kickoff is not ready yet.'

export type WorkerDependencies = { run: RunCli }

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, { run: systemRunCli() })
}

/** `activate` with its dependencies passed in, so tests can answer for the CLIs. */
export function activateWith(orca: OrcaWorkerApi, { run }: WorkerDependencies): void {
  /** The project of the last successful lookup, used when Orca can't answer. */
  let lastProject: ProjectRef | null = null

  async function activeProject(): Promise<{ project: ProjectRef | null; warning: string | null }> {
    try {
      const [projects, worktrees, statuses] = await Promise.all([
        run('orca', PROJECT_LIST_ARGS),
        run('orca', WORKTREE_LIST_ARGS),
        run('orca', WORKTREE_PS_ARGS)
      ])
      const project = findActiveProject(parseProjects(projects), parseWorktrees(worktrees), parseWorktreePs(statuses))
      if (project) lastProject = project
      return { project, warning: null }
    } catch (error) {
      if (!lastProject) throw error
      return { project: lastProject, warning: `Using the last known project (${lastProject.name}). ${messageOf(error)}` }
    }
  }

  async function loadTasks(cursor: string | undefined): Promise<TaskList> {
    let project: ProjectRef | null = null
    try {
      const active = await activeProject()
      project = active.project
      if (!project) return { kind: 'no-project' }
      const settings = projectSettings(readSettings(await orca.storage.get(SETTINGS_KEY)), project.id)
      const providerId = projectProvider(settings, project)
      if (!providerId) return { kind: 'needs-config', project }
      const listTasks = taskLister(providerId)
      if (!listTasks) {
        return { kind: 'error', project, message: `This version of Kickoff can't read tasks with "${providerId}" yet.` }
      }
      const page = await listTasks(run, project, settings, cursor)
      return {
        kind: 'ready',
        project,
        provider: providerId,
        ...page,
        // Task worktrees come with Start; until then no task has one.
        worktrees: {},
        worktreesError: null,
        warning: active.warning
      }
    } catch (error) {
      return { kind: 'error', project, message: messageOf(error) }
    }
  }

  orca.panels.handle('tasks.load', ({ cursor }) => loadTasks(cursor))
  orca.panels.handle('worktrees.load', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('project.active', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('jira.sites', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('task.start', () => ({ ok: false as const, message: NOT_READY }))
  orca.panels.handle('worktree.open', () => ({ ok: false as const, message: NOT_READY }))
}

/** A CliError's message is ready to show; anything else is cleaned first. */
function messageOf(error: unknown): string {
  if (error instanceof CliError) return error.message
  return cleanMessage(error instanceof Error ? error.message : String(error))
}
