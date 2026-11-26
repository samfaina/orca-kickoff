// Jira through Atlassian's Teamwork Graph CLI, with `twg jira workitem query`. twg pages with an
// opaque cursor, so a page is up to 50 tasks and the panel can ask for the next one. The filter's
// JQL queries are read one after the other, each to its end, and a page fills across them with the
// shared code in ./queries; this file keeps twg's arguments, its output and its failures.
import { unreadableOutput, type RunCli } from '../cli'
import { adfToText } from '../adf'
import { isRecord, parseJson, text } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import { jiraSearchJql, jiraTask, jqlQueryFailure, requireJql } from './jira'
import { pageAcrossQueries, type QueryPage } from './queries'
import type { Provider } from './types'

const LIMIT = 50
const FIELDS = 'summary,status,assignee,labels,description,issuetype'

type Config = Required<ProviderConfigs>['jira-twg']

/** The `twg` arguments for one page of at most `limit` tasks of `jql`, after twg's cursor `after`.
 *  `--site`, `--profile` and `--after` only when not blank, so twg uses its own defaults otherwise. */
export function jiraTwgArgs(config: Config, jql: string, after = '', limit = LIMIT): string[] {
  const args = ['jira', 'workitem', 'query', '--jql', jql, '--fields', FIELDS]
  args.push('--limit', String(limit), '--output', 'json', '--api-version', 'v2')
  const site = config.site.trim()
  const profile = config.profile.trim()
  if (site !== '') args.push('--site', site)
  if (profile !== '') args.push('--profile', profile)
  if (after !== '') args.push('--after', after)
  return args
}

export const jiraTwg: Provider<Config> = {
  id: 'jira-twg',
  tracker: 'jira',
  label: 'Jira (twg)',
  /** Up to `LIMIT` tasks, filled across the filter's JQL queries (see `pageAcrossQueries`), with
   *  `<index>:<twg cursor>` as the panel's cursor. The panel's append drops the tasks an earlier
   *  page listed, so a page can show fewer than `LIMIT`. A cursor belongs to its filter and its
   *  tracker search, so the next page of one names the same filter and sends the same words again. */
  async list(run, _project, config, request = {}) {
    const { filter, queries } = requireJql(request.filter)
    return pageAcrossQueries(
      queries,
      request.cursor,
      LIMIT,
      (query, after, limit) => queryPage(run, config, jiraSearchJql(query.text, request.query), after, limit),
      (query, error) => jqlQueryFailure(filter, query, error)
    )
  }
}

/** One twg page of at most `limit` tasks of `jql`, with twg's cursor for the next one. */
async function queryPage(run: RunCli, config: Config, jql: string, after: string, limit: number): Promise<QueryPage> {
  const answer = parseJson(await run('twg', jiraTwgArgs(config, jql, after, limit)))
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
      labels: issue.labels,
      issueType: issue.issuetype
    })
    return task ? [task] : []
  })
}
