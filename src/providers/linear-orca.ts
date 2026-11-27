// Linear through the connection saved in Orca, with `orca linear list-issues`. Kickoff never sees
// the API key (ADR-0001). Orca pages with an opaque cursor, so a page is up to 50 tasks, filled
// across the filter's Linear queries with the shared code in ./queries. Rows carry the Linear
// organisation's name, so only the fields a task needs are read, and the raw answer is never logged.
import { CliError, unreadableOutput, type RunCli } from '../cli'
import { isRecord, text } from '../json'
import { readLinearQuery, type LinearQuery } from '../linear-query'
import { orcaResult } from '../orca'
import type { LinearTeam, ProviderConfigs, Task } from '../protocol'
import { pageAcrossQueries, requireQueries, type QueryPage } from './queries'
import type { Provider } from './types'

const LIMIT = 50

type Config = Required<ProviderConfigs>['linear-orca']

/** What the list says when Orca has no Linear connection. */
export const LINEAR_NOT_CONNECTED = "Linear isn't connected in Orca. Connect Linear in Orca's settings (Settings › Integrations › Linear), then reload the tasks."

/** The `orca linear list-issues` arguments for one page of at most `limit` tasks of `query`, after
 *  Orca's cursor `after`, of a tracker search for `search` when it isn't blank: each field of the
 *  query as its flag, `--state open` and `--order-by updatedAt` when it has none, and `--cursor`,
 *  `--workspace` and `--query` only when not blank. Never `--workspace all`, which refuses a
 *  cursor. Each flag takes one value, passed as it is. */
export function linearListArgs(config: Config, query: LinearQuery, after = '', limit = LIMIT, search = ''): string[] {
  const args = ['linear', 'list-issues']
  if (query.team !== undefined) args.push('--team', query.team)
  args.push('--state', query.state ?? 'open')
  if (query.assignee !== undefined) args.push('--assignee', query.assignee)
  if (query.label !== undefined) args.push('--label', query.label)
  if (query.project !== undefined) args.push('--project', query.project)
  args.push('--order-by', query.orderBy ?? 'updatedAt', '--limit', String(limit))
  if (after !== '') args.push('--cursor', after)
  const workspace = config.workspaceId.trim()
  if (workspace !== '') args.push('--workspace', workspace)
  // Linear matches the whole text as one substring of the title or the description.
  if (search.trim() !== '') args.push('--query', search.trim())
  args.push('--json')
  return args
}

/** The `orca linear team list` arguments for the workspace `workspaceId`: `--workspace` only when
 *  it isn't blank, so Orca reads the workspace it picks, as `list-issues` does. */
export function linearTeamListArgs(workspaceId: string): string[] {
  return ['linear', 'team', 'list', ...workspaceArgs(workspaceId), '--json']
}

/** The `orca linear team states` or `team labels` arguments for the team of key `team` in the
 *  workspace `workspaceId`, with `--workspace` as for `team list`. */
export function linearTeamArgs(list: 'states' | 'labels', workspaceId: string, team: string): string[] {
  return ['linear', 'team', list, '--team', team.trim(), ...workspaceArgs(workspaceId), '--json']
}

function workspaceArgs(workspaceId: string): string[] {
  const workspace = workspaceId.trim()
  return workspace !== '' ? ['--workspace', workspace] : []
}

/** The names in the list `list` of a `team states` or `team labels` answer, in Orca's order; an
 *  entry without one is dropped. Nothing else is read, since the answer carries the workspace's
 *  name. */
export function parseLinearTeamNames(stdout: string, list: 'states' | 'labels'): string[] {
  const result = orcaResult(stdout)
  const entries = isRecord(result) ? result[list] : undefined
  if (!Array.isArray(entries)) throw unreadableOutput('orca')
  return entries.flatMap((entry) => (isRecord(entry) && text(entry.name) ? [text(entry.name)] : []))
}

/** The teams of a `team list` answer, by key and name, in Orca's order; a team without either is
 *  dropped. Nothing else is read, since each team carries the workspace's name. Orca lists none
 *  without a Linear connection, as for a workspace with no teams. */
export function parseLinearTeams(stdout: string): LinearTeam[] {
  const result = orcaResult(stdout)
  if (!isRecord(result) || !Array.isArray(result.teams)) throw unreadableOutput('orca')
  return result.teams.flatMap((team) => (isRecord(team) && text(team.key) && text(team.name) ? [{ key: text(team.key), name: text(team.name) }] : []))
}

export const linearOrca: Provider<Config> = {
  id: 'linear-orca',
  tracker: 'linear',
  label: 'Linear (Orca connection)',
  /** Up to `LIMIT` tasks, filled across the filter's Linear queries (see `pageAcrossQueries`), with
   *  `<index>:<Orca cursor>` as the panel's cursor. A filter with no Linear query to run fails
   *  naming it (see `requireQueries`), so the panel opens its filter editor. */
  async list(run, _project, config, request = {}) {
    const { queries } = requireQueries(request.filter, 'Add a Linear query to list Linear tasks.')
    return pageAcrossQueries(
      queries,
      request.cursor,
      LIMIT,
      (query, after, limit) => queryPage(run, linearListArgs(config, readLinearQuery(query.text), after, limit, request.query)),
      (_query, error) => linearFailure(error)
    )
  }
}

/** `error` as the failure of the list: no Linear connection says how to connect; any other failure,
 *  such as an unknown workspace, is Orca's own message. Linear rejects none of a query's values (an
 *  unknown team, state or label lists nothing), so no failure of Orca's is the filter's: only one
 *  with no Linear query to run is (see `list`). */
function linearFailure(error: unknown): unknown {
  return error instanceof CliError && error.code === 'linear_not_connected' ? new CliError(LINEAR_NOT_CONNECTED, false, error.code) : error
}

/** One `list-issues` page, with Orca's cursor for the next one while `meta.hasMore` is true. */
async function queryPage(run: RunCli, args: string[]): Promise<QueryPage> {
  const result = orcaResult(await run('orca', args))
  if (!isRecord(result) || !Array.isArray(result.issues)) throw unreadableOutput('orca')
  const meta = isRecord(result.meta) ? result.meta : {}
  return { tasks: toTasks(result.issues), nextCursor: meta.hasMore === true ? text(meta.nextCursor) || null : null }
}

function toTasks(issues: unknown[]): Task[] {
  return issues.flatMap((issue): Task[] => {
    if (!isRecord(issue)) return []
    const key = text(issue.identifier)
    const title = text(issue.title)
    const url = text(issue.url)
    if (!key || !title || !url) return []
    const state = isRecord(issue.state) ? issue.state : {}
    const assignee = isRecord(issue.assignee) ? text(issue.assignee.displayName) : ''
    const labels = Array.isArray(issue.labels) ? issue.labels.flatMap((label) => (isRecord(label) && text(label.name) ? [text(label.name)] : [])) : []
    return [
      {
        tracker: 'linear',
        key,
        title,
        url,
        description: text(issue.description),
        status: text(state.name) || null,
        statusCategory: linearStatusCategory(state.type),
        assignees: assignee ? [assignee] : [],
        labels
      }
    ]
  })
}

/** Linear's state type as a tracker-independent category. The type stays the same whatever the
 *  workspace calls its states. Orca's `--state open` keeps `duplicate`, so an open list can show a
 *  task whose category is done: accepted (#157), rather than leaving such rows out. */
function linearStatusCategory(type: unknown): Task['statusCategory'] {
  switch (type) {
    case 'backlog':
    case 'triage':
    case 'unstarted':
      return 'todo'
    case 'started':
      return 'in_progress'
    case 'completed':
    case 'canceled':
    case 'duplicate':
      return 'done'
    default:
      return null
  }
}
