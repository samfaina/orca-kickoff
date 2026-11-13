// Jira through Atlassian's Teamwork Graph CLI, with `twg jira workitem query`. twg pages with an
// opaque cursor, so a page is 50 tasks and the panel can ask for the next one.
import { unreadableOutput } from '../cli'
import { adfToText } from '../adf'
import { isRecord, parseJson, text } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import { jiraTask, requireJql } from './jira'
import type { Provider } from './types'

const LIMIT = 50
const FIELDS = 'summary,status,assignee,labels,description'

type Config = Required<ProviderConfigs>['jira-twg']

/** The `twg` arguments for one page. `--site`, `--profile` and `--after` only when not blank, so
 *  twg uses its own defaults otherwise. */
export function jiraTwgArgs(config: Config, cursor = ''): string[] {
  const args = ['jira', 'workitem', 'query', '--jql', requireJql(config.jql), '--fields', FIELDS]
  args.push('--limit', String(LIMIT), '--output', 'json', '--api-version', 'v2')
  const site = config.site.trim()
  const profile = config.profile.trim()
  if (site !== '') args.push('--site', site)
  if (profile !== '') args.push('--profile', profile)
  if (cursor !== '') args.push('--after', cursor)
  return args
}

export const jiraTwg: Provider<Config> = {
  id: 'jira-twg',
  tracker: 'jira',
  label: 'Jira (twg)',
  async list(run, _project, config, cursor) {
    const answer = parseJson(await run('twg', jiraTwgArgs(config, cursor)))
    if (!isRecord(answer) || !isRecord(answer.data) || !Array.isArray(answer.data.issues)) throw unreadableOutput('twg')
    return { tasks: toTasks(answer.data.issues), nextCursor: nextCursor(answer), truncated: false }
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
