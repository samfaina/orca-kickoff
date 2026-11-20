// Run here: the checks of a launch in the worktree selected in Orca, and the command, from Orca's
// answers. Pure; the worker reads Orca and runs the launch.
import { agentLaunchArgs, findTaskWorktrees, type OrcaWorktree, type OrcaWorktreeStatus } from './orca'
import { RUN_HERE_NEEDS_AGENT, type ProjectRef, type PromptTemplate, type Task } from './protocol'
import { buildPrompt, TEMPLATE_GONE } from './template'

export type RunHere = {
  projectId: string
  task: Task
  projects: ProjectRef[]
  worktrees: OrcaWorktree[]
  statuses: OrcaWorktreeStatus[]
  /** The agent the project's agent choice resolves to, null for none. */
  agent: string | null
  /** The template chosen for the task, undefined when the project no longer lists it. */
  template: PromptTemplate | undefined
  /** '' for none. */
  jiraProjectKey: string
}

/** The `orca agent launch` of a Run here of `task` in the active worktree, or why there is none: no
 *  worktree is active, it belongs to another project than `projectId`, the task already has a task
 *  worktree, there is no agent, the template is gone, or the prompt is over the limit. `{{branch}}`
 *  is the active worktree's current branch, only as text. */
export function runHereLaunch({ projectId, task, projects, worktrees, statuses, agent, template, jiraProjectKey }: RunHere): { ok: true; args: string[] } | { ok: false; message: string } {
  const project = projects.find((candidate) => candidate.id === projectId)
  if (!project) return { ok: false, message: `Orca has no project "${projectId}".` }
  const active = statuses.find((row) => row.isActive)
  if (!active) return { ok: false, message: `No worktree is selected in Orca. Select a worktree of ${project.name} to run ${task.key} here.` }
  const worktree = worktrees.find((candidate) => candidate.id === active.worktreeId)
  if (worktree?.projectId !== projectId) {
    return { ok: false, message: `The worktree selected in Orca isn't one of ${project.name}. Select a worktree of ${project.name} to run ${task.key} here.` }
  }
  const started = findTaskWorktrees(task.tracker, projectId, worktrees, statuses)[task.key]
  if (started) return { ok: false, message: `${task.key} already has a task worktree, ${started.name}. Reload the tasks.` }
  if (agent === null) return { ok: false, message: RUN_HERE_NEEDS_AGENT }
  if (!template) return { ok: false, message: TEMPLATE_GONE }
  const prompt = buildPrompt(template.text, task, project, active.branch, jiraProjectKey)
  if (!prompt.ok) return prompt
  return { ok: true, args: agentLaunchArgs({ worktreeId: worktree.id, agent, prompt: prompt.prompt }) }
}
