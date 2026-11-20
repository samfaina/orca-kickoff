// What both Jira providers share: the task shape, the status category, asking for a JQL query when
// a filter has none, how a failure of a filter's JQL queries fails the list, and the JQL of a
// tracker search.
import { CliError } from '../cli'
import { isRecord, text } from '../json'
import { jqlStringContent } from '../jql'
import { DEFAULT_JQL, type Filter, type FilterQuery, type Task } from '../protocol'
import { FilterError, requireQueries } from './queries'
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
  /** The issue type object; only its `name` is read. */
  issueType: unknown
}

/** A Jira task, or null when the issue has no key or URL. */
export function jiraTask(fields: JiraIssueFields): Task | null {
  const key = text(fields.key)
  const url = text(fields.url)
  if (!key || !url) return null
  const assignee = isRecord(fields.assignee) ? text(fields.assignee.displayName) : ''
  const issueType = isRecord(fields.issueType) ? text(fields.issueType.name) : ''
  return {
    tracker: 'jira',
    key,
    title: text(fields.title),
    url,
    description: fields.description,
    status: text(fields.statusName) || null,
    statusCategory: jiraStatusCategory(fields.categoryKey),
    assignees: assignee ? [assignee] : [],
    labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => text(label) !== '') : [],
    ...(issueType ? { issueType } : {})
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

/** The codes of the JSON error with which each tool answers a JQL query Jira rejected
 *  (`docs/reference.md`): `orca jira search` and `twg jira workitem query`. Any other failure, such
 *  as no login, an unknown site or profile, a missing tool or a timeout, isn't about the query. */
const JQL_REJECTED = new Set(['runtime_error', 'TWG_TOOL_EXECUTION_FAILED'])

/** The filter to list and its JQL queries to run (see `requireQueries`), asking for one by the
 *  filter's name when none is left. */
export function requireJql(filter: Filter | undefined): { filter: Filter; queries: FilterQuery[] } {
  return requireQueries(filter, `Enter a JQL query to list Jira tasks, for example: ${DEFAULT_JQL}`)
}

/** `error`, from running `query` of `filter`, as the failure of the whole list. When Jira rejected
 *  the query, it names the filter and the query's position in it, so the person knows which query
 *  to fix; any other failure is `error` unchanged. */
export function jqlQueryFailure(filter: Filter, query: FilterQuery, error: unknown): unknown {
  if (!(error instanceof CliError) || error.code === null || !JQL_REJECTED.has(error.code)) return error
  return new FilterError(`${filter.name}: JQL query ${query.position} failed: ${error.message}`, filter.id)
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
