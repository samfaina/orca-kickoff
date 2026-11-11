// Kickoff's worker. Orca transpiles this file when it loads. Every request is still a stub: it
// answers with an expected-failure result, as data, so the panel never depends on a thrown message.
import type { OrcaWorkerApi } from 'orca/worker'

const NOT_READY = 'Kickoff is not ready yet.'

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('tasks.load', () => ({ kind: 'error' as const, project: null, message: NOT_READY }))
  orca.panels.handle('worktrees.load', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('project.active', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('jira.sites', () => ({ kind: 'error' as const, message: NOT_READY }))
  orca.panels.handle('task.start', () => ({ ok: false as const, message: NOT_READY }))
  orca.panels.handle('worktree.open', () => ({ ok: false as const, message: NOT_READY }))
}
