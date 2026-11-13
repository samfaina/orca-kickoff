// Jira through Atlassian's Teamwork Graph CLI, with `twg jira workitem query`. twg pages with an
// opaque cursor, so a page is 50 tasks and the panel can ask for the next one.
import { unreadableOutput } from '../cli'
import { adfToText } from '../adf'
import { isRecord, parseJson, text } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import { jiraStatusCategory, requireJql } from './jira'
import type { Provider } from './types'

const LIMIT = 50
const FIELDS = 'summary,status,assignee,labels,description'

type Config = Required<ProviderConfigs>['jira-twg']

/** The `twg` arguments for one page. `--site`, `--profile` and `--after` only when set, so twg
 *  uses its own defaults otherwise. */
export function jiraTwgArgs(config: Config, cursor?: string): string[] {
  const args = ['jira', 'workitem', 'query', '--jql', requireJql(config.jql), '--fields', FIELDS]
  args.push('--limit', String(LIMIT), '--output', 'json', '--api-version', 'v2')
  if (config.site !== '') args.push('--site', config.site)
  if (config.profile !== '') args.push('--profile', config.profile)
  if (cursor) args.push('--after', cursor)
  return args
}

export const jiraTwg: Provider<Config> = {
  id: 'jira-twg',
  tracker: 'jira',
  label: 'Jira (twg)',
  async list(run, _project, config, cursor) {
    const args = jiraTwgArgs(config, cursor)
    const answer = parseJson(await run('twg', args))
    if (!isRecord(answer) || !isRecord(answer.data) || !Array.isArray(answer.data.issues)) throw unreadableOutput('twg')
    const issues = answer.data.issues
    return { tasks: toTasks(issues), nextCursor: nextCursor(answer), truncated: false }
  }
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
    if (!isRecord(issue) || !text(issue.key) || !text(issue.url)) return []
    const status = isRecord(issue.status) ? issue.status : {}
    const category = isRecord(status.statusCategory) ? status.statusCategory.key : undefined
    // A Jira user object; only its display name is read, because it also holds the email.
    const assignee = isRecord(issue.assignee) ? text(issue.assignee.displayName) : ''
    return [
      {
        tracker: 'jira',
        key: text(issue.key),
        title: text(issue.summary),
        url: text(issue.url),
        description: adfToText(issue.description),
        status: text(status.name) || null,
        statusCategory: jiraStatusCategory(category),
        assignees: assignee ? [assignee] : [],
        labels: Array.isArray(issue.labels) ? issue.labels.filter((label): label is string => text(label) !== '') : []
      }
    ]
  })
}
