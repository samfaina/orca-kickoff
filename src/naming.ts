// Worktree names for tasks, and reading a task key back from a name. The name is only a readable
// label and a fallback link (ADR-0002): Orca's own link on the worktree comes first. No Node
// imports, so the panel can use it too.
import type { Task, TrackerId } from './protocol'

const MAX_TITLE_WORDS = 4

/** Accents folded (NFD, marks stripped), lower-cased, every run of anything but `a-z0-9` turned
 *  into one `-`, and `-` trimmed at the ends. */
export function titleWords(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** `<prefix>-<up to four words of the title>`: `issue-42-add-dark-mode` on GitHub,
 *  `web-12-anadir-modo-oscuro-a` on Jira. */
export function worktreeName(task: Pick<Task, 'tracker' | 'key' | 'title'>): string {
  const prefix = task.tracker === 'github' ? `issue-${githubIssueNumber(task.key)}` : task.key.toLowerCase()
  const words = titleWords(task.title).split('-').filter((word) => word !== '').slice(0, MAX_TITLE_WORDS)
  return [prefix, ...words].join('-')
}

/** `42` for the GitHub task key `#42`. */
export function githubIssueNumber(key: string): string {
  return key.replace(/^#/, '')
}

const GITHUB_NAME = /^issue-(\d+)(?:-|$)/
/** Orca's Jira key pattern (`/^[A-Za-z][A-Za-z0-9_]*-\d+$/`), at the start of a name. */
const JIRA_NAME = /^([a-z][a-z0-9_]*-\d+)(?:-|$)/i

/** The task key a worktree name starts with, or null. It follows the project's tracker, because
 *  `issue-42-...` also matches the Jira pattern. */
export function taskKeyFromWorktreeName(name: string, tracker: TrackerId): string | null {
  if (tracker === 'github') {
    const match = GITHUB_NAME.exec(name)
    return match ? `#${match[1]}` : null
  }
  const match = JIRA_NAME.exec(name)
  return match ? match[1].toUpperCase() : null
}
