// The search over the loaded tasks. No Node imports, so the panel can use it.
import type { Task } from './protocol'

/** Whether the task's key, title or one of its labels contains the trimmed query, ignoring case.
 *  An empty query matches every task. */
export function matchesSearch(task: Task, query: string): boolean {
  const wanted = query.trim().toLowerCase()
  return [task.key, task.title, ...task.labels].some((text) => text.toLowerCase().includes(wanted))
}
