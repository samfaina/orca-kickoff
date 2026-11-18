// What both Jira providers share: the task shape, the status category, the rule that a blank
// JQL never runs, how the tasks and failures of several JQL queries make one list, and the JQL of
// a tracker search.
import { cleanMessage, CliError } from '../cli'
import { isRecord, text } from '../json'
import { appendTasks, DEFAULT_JQL, jqlQueries, type JqlQuery, type Task } from '../protocol'
import { searchWords } from './types'

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

/** The JQL queries to run (see `jqlQueries`). With none that isn't blank it throws, asking for one,
 *  so the tool never runs without one. */
export function requireJql(jql: readonly string[]): JqlQuery[] {
  const queries = jqlQueries(jql)
  if (queries.length === 0) throw new CliError(`Enter a JQL query to list Jira tasks, for example: ${DEFAULT_JQL}`)
  return queries
}

/** `error`, from running `query`, as the failure of the whole list. With more than one query it
 *  says which one failed, by its position in the settings; with one, it is `error` unchanged. */
export function jqlQueryFailure(queries: readonly JqlQuery[], query: JqlQuery, error: unknown): unknown {
  if (queries.length < 2) return error
  const message = error instanceof CliError ? error.message : cleanMessage(error instanceof Error ? error.message : String(error))
  return new CliError(`JQL query ${query.position} failed: ${message}`, error instanceof CliError && error.timedOut)
}

/** The tasks of each query's page, in query order, each task once, where it first appears. */
export function mergeQueryTasks(pages: readonly Task[][]): Task[] {
  return pages.reduce<Task[]>((tasks, page) => appendTasks(tasks, page), [])
}

/** The JQL that narrows the user's `jql` to the tasks matching the words of `query`, or `jql`
 *  unchanged when the query has none. Its conditions go in parentheses before the match, and its
 *  `ORDER BY` stays after it: Jira rejects an `ORDER BY` inside parentheses. Each word matches as
 *  a prefix, and a word shaped like a task key also matches that key, which `text ~` doesn't. */
export function jiraSearchJql(jql: string, query = ''): string {
  const words = searchWords(query)
  if (words.length === 0) return jql
  const text = `text ~ "${words.map((word) => `${jqlStringContent(word)}*`).join(' ')}"`
  const keys = [...new Set(words.filter(isJiraTaskKey).map((word) => word.toUpperCase()))].map((key) => `key = "${key}"`)
  const match = `(${[text, ...keys].join(' OR ')})`
  const { conditions, orderBy } = splitJql(jql)
  const narrowed = conditions === '' ? match : `(${conditions}) AND ${match}`
  return orderBy === null ? narrowed : `${narrowed} ${orderBy}`
}

/** A JQL split into its conditions and its top-level `ORDER BY ...`, matched in any case and
 *  never inside a quoted string. `orderBy` is null when the JQL has none. */
export function splitJql(jql: string): { conditions: string; orderBy: string | null } {
  let quote: string | null = null
  let depth = 0
  for (let index = 0; index < jql.length; index++) {
    const char = jql[index]
    if (quote !== null) {
      if (char === '\\') index++
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
    } else if (depth === 0 && /^order\s+by\b/i.test(jql.slice(index)) && !/\w/.test(jql[index - 1] ?? '')) {
      return { conditions: jql.slice(0, index).trim(), orderBy: jql.slice(index).trim() }
    }
  }
  return { conditions: jql.trim(), orderBy: null }
}

/** Whether a word has the shape of a Jira task key, in any case: letters, then letters, digits or
 *  `_`, then `-` and digits. Only such a word may go into `key = "..."`: a malformed key makes the
 *  whole JQL fail, while a well-formed one that doesn't exist matches nothing. */
export function isJiraTaskKey(word: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(word)
}

/** `value` escaped to go between the double quotes of a JQL string. */
function jqlStringContent(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`)
}
