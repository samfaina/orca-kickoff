// Jira through the connection saved in Orca's settings, with `orca jira search`. Orca has no cursor
// for it, so a page is the first 100 tasks.
import { unreadableOutput } from '../cli'
import { isRecord, text } from '../json'
import { orcaResult } from '../orca'
import type { ProviderConfigs, Task } from '../protocol'
import { jiraTask, requireJql } from './jira'
import type { Provider } from './types'

const LIMIT = 100

export const jiraOrca: Provider<Required<ProviderConfigs>['jira-orca']> = {
  id: 'jira-orca',
  tracker: 'jira',
  label: 'Jira (Orca connection)',
  async list(run, _project, config) {
    const args = ['jira', 'search', requireJql(config.jql), '--limit', String(LIMIT), '--json']
    if (config.siteId !== '') args.push('--site', config.siteId)
    const issues = orcaResult(await run('orca', args))
    if (!Array.isArray(issues)) throw unreadableOutput('orca')
    // Counted before dropping unusable issues: 100 from Orca means there may be more.
    return { tasks: toTasks(issues), nextCursor: null, truncated: issues.length >= LIMIT }
  }
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
