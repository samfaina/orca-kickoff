// Reading the Orca CLI's answers: projects, worktrees and which worktree is active. Pure functions
// over the `--json` stdout; the worker runs the commands.
import { CliError, cleanMessage, jsonErrorMessage, unreadableOutput } from './cli'
import { isRecord, parseJson } from './json'
import { githubIssueNumber, taskKeyFromWorktreeName } from './naming'
import type { ProjectRef, Task, TaskWorktree, TrackerId } from './protocol'

export const PROJECT_LIST_ARGS = ['project', 'list', '--json']
export const WORKTREE_LIST_ARGS = ['worktree', 'list', '--json']
export const WORKTREE_PS_ARGS = ['worktree', 'ps', '--json']

/** `worktree create` can take long: Orca creates the worktree, runs setup and starts the agent. */
export const WORKTREE_CREATE_TIMEOUT_MS = 110_000

/** One row of `orca worktree list`, with the fields Kickoff reads. */
export type OrcaWorktree = {
  id: string
  projectId: string
  name: string
  isArchived: boolean
  /** GitHub issue numbers linked through `linkedIssue` or `linkedItems`. */
  githubIssues: number[]
  /** Jira keys linked through `linkedItems`, upper-cased. */
  jiraKeys: string[]
}

/** One row of `orca worktree ps`. */
export type OrcaWorktreeStatus = { worktreeId: string; isActive: boolean; agent: string | null }

/** Projects from `orca project list --json`. Projects without an id are dropped. */
export function parseProjects(stdout: string): ProjectRef[] {
  return listOf(orcaResult(stdout), 'projects').flatMap((project) => {
    if (!isRecord(project) || !nonEmpty(project.id)) return []
    const name = nonEmpty(project.displayName) ? project.displayName : project.id
    return [{ id: project.id, name, repo: githubRepo(project.providerIdentity) }]
  })
}

/** "owner/name", or "host/owner/name" on GitHub Enterprise; null for anything but GitHub. */
function githubRepo(identity: unknown): string | null {
  if (!isRecord(identity) || identity.provider !== 'github') return null
  if (!nonEmpty(identity.owner) || !nonEmpty(identity.repo)) return null
  const path = `${identity.owner}/${identity.repo}`
  return nonEmpty(identity.host) ? `${identity.host}/${path}` : path
}

/** Worktrees from `orca worktree list --json`. */
export function parseWorktrees(stdout: string): OrcaWorktree[] {
  return listOf(orcaResult(stdout), 'worktrees').flatMap((worktree) => {
    if (!isRecord(worktree) || !nonEmpty(worktree.id) || !nonEmpty(worktree.projectId)) return []
    const items = Array.isArray(worktree.linkedItems) ? worktree.linkedItems.filter(isRecord) : []
    const githubIssues = [
      worktree.linkedIssue,
      ...items.filter((item) => item.provider === 'github' && item.type === 'issue').map((item) => item.number)
    ].filter(isIssueNumber)
    return [
      {
        id: worktree.id,
        projectId: worktree.projectId,
        name: nonEmpty(worktree.displayName) ? worktree.displayName : '',
        isArchived: worktree.isArchived === true,
        githubIssues,
        jiraKeys: items.flatMap((item) => (nonEmpty(item.jiraIdentifier) ? [item.jiraIdentifier.toUpperCase()] : []))
      }
    ]
  })
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** Rows of `orca worktree ps --json`. */
export function parseWorktreePs(stdout: string): OrcaWorktreeStatus[] {
  return listOf(orcaResult(stdout), 'worktrees').flatMap((row) => {
    if (!isRecord(row) || !nonEmpty(row.worktreeId)) return []
    return [{ worktreeId: row.worktreeId, isActive: row.isActive === true, agent: runningAgent(row.agents) }]
  })
}

/** The main agent's type, else the first agent's; null when none runs. */
function runningAgent(agents: unknown): string | null {
  const list = Array.isArray(agents) ? agents.filter((agent) => isRecord(agent) && nonEmpty(agent.agentType)) : []
  const main = list.find((agent) => agent.mainAgent === true) ?? list[0]
  return main ? (main.agentType as string) : null
}

/** The project of the active worktree, or null when no worktree is active. */
export function findActiveProject(
  projects: ProjectRef[],
  worktrees: OrcaWorktree[],
  statuses: OrcaWorktreeStatus[]
): ProjectRef | null {
  const active = statuses.find((row) => row.isActive)
  const worktree = active && worktrees.find((candidate) => candidate.id === active.worktreeId)
  return (worktree && projects.find((project) => project.id === worktree.projectId)) ?? null
}

/** Task keys mapped to the project's task worktrees: its non-archived worktrees linked to a task
 *  through Orca (ADR-0002), or, as a fallback, named after one. A linked worktree wins over one
 *  that only has the name. Each carries the agent running in it. */
export function findTaskWorktrees(
  tracker: TrackerId,
  projectId: string,
  worktrees: OrcaWorktree[],
  statuses: OrcaWorktreeStatus[]
): Record<string, TaskWorktree> {
  const own = worktrees.filter((worktree) => worktree.projectId === projectId && !worktree.isArchived)
  const found: Record<string, TaskWorktree> = {}
  const add = (key: string, worktree: OrcaWorktree) => {
    if (found[key]) return
    const agent = statuses.find((row) => row.worktreeId === worktree.id)?.agent ?? null
    found[key] = { worktreeId: worktree.id, name: worktree.name, agent }
  }
  for (const worktree of own) {
    const keys = tracker === 'github' ? worktree.githubIssues.map((n) => `#${n}`) : worktree.jiraKeys
    for (const key of keys) add(key, worktree)
  }
  for (const worktree of own) {
    const key = taskKeyFromWorktreeName(worktree.name, tracker)
    if (key) add(key, worktree)
  }
  return found
}

export type WorktreeCreate = {
  projectId: string
  name: string
  task: Pick<Task, 'tracker' | 'key' | 'url'>
  /** null: no agent, so no prompt either. */
  agent: string | null
  prompt: string
}

/** `orca worktree create` for a task, linked with `--issue <n>` on GitHub or `--reference <url>`
 *  on Jira (the full URL, so Orca needs no Jira connection to resolve it). */
export function worktreeCreateArgs({ projectId, name, task, agent, prompt }: WorktreeCreate): string[] {
  const args = ['worktree', 'create', '--project', projectId, '--name', name, '--no-parent', '--json']
  if (task.tracker === 'github') args.push('--issue', githubIssueNumber(task.key))
  else args.push('--reference', task.url)
  if (agent !== null) args.push('--agent', agent, '--prompt', prompt)
  return args
}

export function worktreeActivateArgs(worktreeId: string): string[] {
  return ['worktree', 'activate', '--worktree', `id:${worktreeId}`, '--json']
}

/** Throws when an Orca answer is an error or can't be read. */
export function checkOrcaAnswer(stdout: string): void {
  orcaResult(stdout)
}

/** `result` of an `{ ok: true, result }` answer. An error answer or unreadable output throws. */
export function orcaResult(stdout: string): unknown {
  const error = jsonErrorMessage(stdout)
  if (error) throw new CliError(cleanMessage(`orca failed: ${error}`))
  const parsed = parseJson(stdout)
  if (isRecord(parsed) && parsed.ok === true && 'result' in parsed) return parsed.result
  throw unreadableOutput('orca')
}

function listOf(result: unknown, key: string): unknown[] {
  const list = isRecord(result) ? result[key] : undefined
  return Array.isArray(list) ? list : []
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
