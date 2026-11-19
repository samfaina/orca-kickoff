// Jira through the connection saved in Orca's settings, with `orca jira search`. Orca has no cursor
// for it, so the only page is the first 100 tasks of each JQL query of the filter, of its whole list
// or of a tracker search, joined in query order.
import { unreadableOutput, type RunCli } from '../cli'
import { isRecord, text } from '../json'
import { orcaResult } from '../orca'
import type { ProviderConfigs, Task } from '../protocol'
import { jiraSearchJql, jiraTask, jqlQueryFailure, mergeQueryTasks, requireJql } from './jira'
import type { Provider } from './types'

const LIMIT = 100

type Config = Required<ProviderConfigs>['jira-orca']

export const jiraOrca: Provider<Config> = {
  id: 'jira-orca',
  tracker: 'jira',
  label: 'Jira (Orca connection)',
  async list(run, _project, config, request = {}) {
    const { filter, queries } = requireJql(request.filter)
    // All at once; the first query that failed, in the filter's order, fails the list.
    const searches = await Promise.allSettled(queries.map((query) => search(run, config, jiraSearchJql(query.jql, request.query))))
    const pages = searches.map((outcome, index) => {
      if (outcome.status === 'rejected') throw jqlQueryFailure(filter, queries[index], outcome.reason)
      return outcome.value
    })
    return { tasks: mergeQueryTasks(pages.map((page) => page.tasks)), nextCursor: null, truncated: pages.some((page) => page.truncated) }
  }
}

/** The tasks of one `orca jira search`, and whether there may be more than it answered. */
async function search(run: RunCli, config: Config, jql: string): Promise<{ tasks: Task[]; truncated: boolean }> {
  const args = ['jira', 'search', jql, '--limit', String(LIMIT), '--json']
  if (config.siteId !== '') args.push('--site', config.siteId)
  const issues = orcaResult(await run('orca', args))
  if (!Array.isArray(issues)) throw unreadableOutput('orca')
  // Counted before dropping unusable issues: 100 from Orca means there may be more.
  return { tasks: toTasks(issues), truncated: issues.length >= LIMIT }
}

export const JIRA_CONNECTION_ARGS = ['jira', 'connection', '--json']

/** The connected sites from `orca jira connection --json`: id and a name to show, the display
 *  name or else the site URL. Nothing else is read, because the answer holds the user's email. */
export function parseJiraSites(stdout: string): { id: string; name: string }[] {
  const result = orcaResult(stdout)
  const sites = isRecord(result) && Array.isArray(result.sites) ? result.sites : []
  return sites.flatMap((site) => {
    if (!isRecord(site) || !text(site.id)) return []
    return [{ id: text(site.id), name: text(site.displayName) || text(site.siteUrl) || text(site.id) }]
  })
}

function toTasks(issues: unknown[]): Task[] {
  return issues.flatMap((issue): Task[] => {
    if (!isRecord(issue)) return []
    const status = isRecord(issue.status) ? issue.status : {}
    const task = jiraTask({
      key: issue.key,
      url: issue.url,
      title: issue.title,
      description: text(issue.description),
      statusName: status.name,
      categoryKey: status.categoryKey,
      assignee: issue.assignee,
      labels: issue.labels
    })
    return task ? [task] : []
  })
}
