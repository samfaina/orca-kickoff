// The panel <-> worker contract and the data model from the spec. src/panel.tsx and
// src/worker.ts both read it. Expected failures are data (`kind: 'error'`, `ok: false`):
// no request throws for them.
export {}

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
