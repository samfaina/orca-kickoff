// GitHub Issues through `gh`. gh has no cursor for this list, so the only page is the first 100
// issues of each GitHub search of the filter, of its whole list or of a tracker search, joined in
// query order.
import { CliError, unreadableOutput, type RunCli } from '../cli'
import { isRecord, parseJson, text } from '../json'
import { DEFAULT_GITHUB_QUERY, type ProviderConfigs, type Task } from '../protocol'
import { mergeQueryTasks, requireQueries } from './queries'
import { searchWords, type Provider } from './types'

const LIMIT = 100

export const github: Provider<Required<ProviderConfigs>['github']> = {
  id: 'github',
  tracker: 'github',
  label: 'GitHub',
  async list(run, project, _config, request = {}) {
    const { repo } = project
    if (!repo) {
      throw new CliError('This project has no GitHub repository. Choose a Jira tracker for it instead.')
    }
    const { queries } = requireQueries(request.filter, `Enter a GitHub search to list issues, for example: ${DEFAULT_GITHUB_QUERY}`)
    // All at once; the first query that failed, in the filter's order, fails the list.
    const searches = await Promise.allSettled(queries.map((query) => search(run, repo, githubFilterSearch(query.text, request.query))))
    const pages = searches.map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason
      return outcome.value
    })
    return { tasks: mergeQueryTasks(pages.map((page) => page.tasks)), nextCursor: null, truncated: pages.some((page) => page.truncated) }
  }
}

/** The tasks of one `gh issue list --search`, and whether there may be more than it answered. */
async function search(run: RunCli, repo: string, value: string): Promise<{ tasks: Task[]; truncated: boolean }> {
  const args = [
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', String(LIMIT),
    '--json', 'number,title,url,body,labels,assignees',
    '--search', value
  ]
  const issues = parseJson(await run('gh', args))
  if (!Array.isArray(issues)) throw unreadableOutput('gh')
  // Counted before dropping unusable issues: 100 from gh means there may be more.
  return { tasks: toTasks(issues), truncated: issues.length >= LIMIT }
}

/** The `--search` value for one GitHub search of a filter, narrowed by the words of a tracker
 *  search when `query` has any. The filter's search goes in parentheses, so an `OR` in it can't
 *  reach the rest, and `is:open` follows: gh drops its own `state:open` when the search holds
 *  `is:closed` (`docs/reference.md`), and Kickoff lists open tasks only. */
export function githubFilterSearch(filterSearch: string, query = ''): string {
  const words = githubSearch(query)
  return `(${filterSearch}) is:open${words === null ? '' : ` ${words}`}`
}

/** The words of a tracker search for `--search`: each in double quotes, so none can act as a
 *  qualifier such as `is:closed`, after removing the quotes it holds. `#42` becomes `42`, which
 *  finds that issue. Null when no word is left. */
export function githubSearch(query = ''): string | null {
  const words = searchWords(query)
    .map((word) => word.replace(/"/g, ''))
    .map((word) => (/^#\d+$/.test(word) ? word.slice(1) : word))
    .filter((word) => word !== '')
  return words.length > 0 ? words.map((word) => `"${word}"`).join(' ') : null
}

function toTasks(issues: unknown[]): Task[] {
  return issues.flatMap((issue): Task[] => {
    if (!isRecord(issue) || typeof issue.number !== 'number') return []
    if (!text(issue.title) || !text(issue.url)) return []
    return [
      {
        tracker: 'github',
        key: `#${issue.number}`,
        title: text(issue.title),
        url: text(issue.url),
        description: text(issue.body),
        status: 'Open',
        statusCategory: 'todo',
        assignees: names(issue.assignees, 'login'),
        labels: names(issue.labels, 'name')
      }
    ]
  })
}

function names(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => (isRecord(item) && text(item[field]) ? [text(item[field])] : []))
}
