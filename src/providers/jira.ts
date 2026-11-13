// What both Jira providers share: the status category and the rule that a blank JQL never runs.
import { CliError } from '../cli'
import { DEFAULT_JQL, type Task } from '../protocol'

/** Jira's status category key as a tracker-independent category. Jira translates status names;
 *  the category key stays the same. */
export function jiraStatusCategory(key: unknown): Task['statusCategory'] {
  switch (key) {
    case 'new':
      return 'todo'
    case 'indeterminate':
      return 'in_progress'
    case 'done':
      return 'done'
    default:
      return null
  }
}

/** The JQL to run, trimmed. A blank one throws, asking for one, so the tool never runs without it. */
export function requireJql(jql: string): string {
  const trimmed = jql.trim()
  if (!trimmed) throw new CliError(`Enter a JQL query to list Jira tasks, for example: ${DEFAULT_JQL}`)
  return trimmed
}
