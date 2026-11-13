// What both Jira providers share: the task shape, the status category and the rule that a blank
// JQL never runs.
import { CliError } from '../cli'
import { isRecord, text } from '../json'
import { DEFAULT_JQL, type Task } from '../protocol'

/** The fields of one Jira issue, as each provider finds them in its tool's output. */
export type JiraIssueFields = {
  key: unknown
  url: unknown
  title: unknown
  description: string
  statusName: unknown
  categoryKey: unknown
  /** A Jira user object, or nothing when unassigned. Only its display name is read, because it
   *  may also hold the email. */
  assignee: unknown
  labels: unknown
}

/** A Jira task, or null when the issue has no key or URL. */
export function jiraTask(fields: JiraIssueFields): Task | null {
  const key = text(fields.key)
  const url = text(fields.url)
  if (!key || !url) return null
  const assignee = isRecord(fields.assignee) ? text(fields.assignee.displayName) : ''
  return {
    tracker: 'jira',
    key,
    title: text(fields.title),
    url,
    description: fields.description,
    status: text(fields.statusName) || null,
    statusCategory: jiraStatusCategory(fields.categoryKey),
    assignees: assignee ? [assignee] : [],
    labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => text(label) !== '') : []
  }
}

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
