// Jira through Atlassian's Teamwork Graph CLI, with `twg jira workitem query`. twg pages with an
// opaque cursor, so a page is 50 tasks of one JQL query and the panel can ask for the next one. The
// queries are paged one after the other, each to its end.
import { unreadableOutput, type RunCli } from '../cli'
import { adfToText } from '../adf'
import { isRecord, parseJson, text } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import { jiraSearchJql, jiraTask, jqlQueryFailure, requireJql } from './jira'
import type { Provider } from './types'

const LIMIT = 50
const FIELDS = 'summary,status,assignee,labels,description'

type Config = Required<ProviderConfigs>['jira-twg']

/** The `twg` arguments for one page of `jql`, after twg's cursor `after`. `--site`, `--profile`
 *  and `--after` only when not blank, so twg uses its own defaults otherwise. */
export function jiraTwgArgs(config: Config, jql: string, after = ''): string[] {
  const args = ['jira', 'workitem', 'query', '--jql', jql, '--fields', FIELDS]
  args.push('--limit', String(LIMIT), '--output', 'json', '--api-version', 'v2')
  const site = config.site.trim()
  const profile = config.profile.trim()
  if (site !== '') args.push('--site', site)
  if (profile !== '') args.push('--profile', profile)
  if (after !== '') args.push('--after', after)
  return args
}

/** Where a page starts: `index` counts the JQL queries that run (the non-blank ones) from 0, and
 *  `after` is twg's cursor in that query, '' for its first page. */
export type TwgPosition = { index: number; after: string }

/** The cursor the panel gets for a position, `<index>:<twg cursor>`. It stays opaque to the panel. */
export function encodeTwgCursor({ index, after }: TwgPosition): string {
  return `${index}:${after}`
}

/** The position of a cursor from `encodeTwgCursor`, among `count` queries. A cursor of any other
 *  shape, or past the last query, starts from the first query. */
export function decodeTwgCursor(cursor: string | undefined, count: number): TwgPosition {
  const match = /^(0|[1-9]\d*):([\s\S]*)$/.exec(cursor ?? '')
  const index = match ? Number(match[1]) : -1
  return match && index < count ? { index, after: match[2] } : { index: 0, after: '' }
}

export const jiraTwg: Provider<Config> = {
  id: 'jira-twg',
  tracker: 'jira',
  label: 'Jira (twg)',
  /** One twg call, unless a query answers no tasks: the load then goes on with the next query, so
   *  "Load more" never brings a page Jira left empty while another query follows. A page holds
   *  one query's tasks, each once; the panel's append drops those an earlier query listed, which
   *  can leave nothing new to show. A cursor belongs to its tracker search, so the next page of
   *  one sends the same words again. */
  async list(run, _project, config, request = {}) {
    const queries = requireJql(config.jql)
    let { index, after } = decodeTwgCursor(request.cursor, queries.length)
    for (;;) {
      const query = queries[index]
      const { tasks, nextCursor } = await queryPage(run, config, jiraSearchJql(query.jql, request.query), after).catch((error: unknown) => {
        throw jqlQueryFailure(queries, query, error)
      })
      if (nextCursor !== null) return { tasks, nextCursor: encodeTwgCursor({ index, after: nextCursor }), truncated: false }
      if (index === queries.length - 1) return { tasks, nextCursor: null, truncated: false }
      if (tasks.length > 0) return { tasks, nextCursor: encodeTwgCursor({ index: index + 1, after: '' }), truncated: false }
      index++
      after = ''
    }
  }
}

/** One twg page of `jql`, with twg's cursor for the next one. */
async function queryPage(run: RunCli, config: Config, jql: string, after: string): Promise<{ tasks: Task[]; nextCursor: string | null }> {
  const answer = parseJson(await run('twg', jiraTwgArgs(config, jql, after)))
  if (!isRecord(answer) || !isRecord(answer.data) || !Array.isArray(answer.data.issues)) throw unreadableOutput('twg')
  return { tasks: toTasks(answer.data.issues), nextCursor: nextCursor(answer) }
}

/** `pageInfo.nextCursor` when `hasNextPage` is true. twg leaves `pageInfo` out of some answers,
 *  such as one with fewer results than the limit; that means there is no next page. */
function nextCursor(answer: Record<string, unknown>): string | null {
  const pageInfo = answer.pageInfo
  if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true) return null
  return text(pageInfo.nextCursor) || null
}

function toTasks(issues: unknown[]): Task[] {
  return issues.flatMap((issue): Task[] => {
    if (!isRecord(issue)) return []
    const status = isRecord(issue.status) ? issue.status : {}
    const task = jiraTask({
      key: issue.key,
      url: issue.url,
      title: issue.summary,
      description: adfToText(issue.description),
      statusName: status.name,
      categoryKey: isRecord(status.statusCategory) ? status.statusCategory.key : undefined,
      assignee: issue.assignee,
      labels: issue.labels
    })
    return task ? [task] : []
  })
}
