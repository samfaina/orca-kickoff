// Reading the Orca CLI's answers: projects, worktrees and which worktree is active. Pure functions
// over the `--json` stdout; the worker runs the commands.
import { CliError, cleanMessage, jsonErrorMessage, unreadableOutput } from './cli'
import { isRecord, parseJson } from './json'
import type { ProjectRef } from './protocol'

export const PROJECT_LIST_ARGS = ['project', 'list', '--json']
export const WORKTREE_LIST_ARGS = ['worktree', 'list', '--json']
export const WORKTREE_PS_ARGS = ['worktree', 'ps', '--json']

/** One row of `orca worktree list`, with the fields Kickoff reads. */
export type OrcaWorktree = { id: string; projectId: string }

/** One row of `orca worktree ps`. */
export type OrcaWorktreeStatus = { worktreeId: string; isActive: boolean }

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
    return [{ id: worktree.id, projectId: worktree.projectId }]
  })
}

/** Rows of `orca worktree ps --json`. */
export function parseWorktreePs(stdout: string): OrcaWorktreeStatus[] {
  return listOf(orcaResult(stdout), 'worktrees').flatMap((row) => {
    if (!isRecord(row) || !nonEmpty(row.worktreeId)) return []
    return [{ worktreeId: row.worktreeId, isActive: row.isActive === true }]
  })
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

/** `result` of an `{ ok: true, result }` answer. An error answer or unreadable output throws. */
function orcaResult(stdout: string): unknown {
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
