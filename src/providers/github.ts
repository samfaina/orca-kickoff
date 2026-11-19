// GitHub Issues through `gh`. gh has no cursor for this list, so the only page is the first 100
// issues of each query of the filter, of its whole list or of a tracker search, joined in
// query order.
import { CliError, unreadableOutput, type RunCli } from '../cli'
import { isRecord, parseJson, text } from '../json'
import { DEFAULT_GITHUB_QUERY, type Filter, type FilterQuery, type ProviderConfigs, type Task } from '../protocol'
import { FilterError, requireQueries, searchEveryQuery } from './queries'
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
    const { filter, queries } = requireQueries(request.filter, `Enter a GitHub search to list issues, for example: ${DEFAULT_GITHUB_QUERY}`)
    // Words of a tracker search can make gh refuse the search too; then the filter isn't at fault.
    const searching = githubSearchWords(request.query) !== null
    return searchEveryQuery(
      queries,
      (query) => searchIssues(run, repo, githubSearch(query.text, request.query)),
      (query, error) => (searching ? error : githubQueryFailure(filter, query, error))
    )
  }
}

/** What gh answers, before asking GitHub, for a search with a pull request qualifier such as
 *  `is:pr`: the only query it refuses. GitHub itself answers a malformed search with no issues
 *  (`docs/reference.md`). */
const PR_QUALIFIER_REFUSED = 'cannot use pull request search qualifiers'

/** `error`, from running `query` of `filter`, as the failure of the whole list. When gh refused the
 *  query, it names the filter and the query's position in it, so the person knows which query to
 *  fix; any other failure, such as no login, is `error` unchanged. */
export function githubQueryFailure(filter: Filter, query: FilterQuery, error: unknown): unknown {
  if (!(error instanceof CliError) || !error.message.includes(PR_QUALIFIER_REFUSED)) return error
  return new FilterError(`${filter.name}: Query ${query.position} failed: ${error.message}`, filter.id)
}

/** The tasks of one `gh issue list --search`, and whether there may be more than it answered. */
async function searchIssues(run: RunCli, repo: string, value: string): Promise<{ tasks: Task[]; truncated: boolean }> {
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

/** The `--search` value for one query of a filter, narrowed by the words of a tracker search when
 *  `trackerSearch` has any. The filter's query goes in parentheses, so an `OR` in it can't reach
 *  the rest, and `is:open` follows: gh drops its own `state:open` when the search holds
 *  `is:closed` (`docs/reference.md`), and Kickoff lists open tasks only. */
export function githubSearch(filterQuery: string, trackerSearch = ''): string {
  const words = githubSearchWords(trackerSearch)
  return `(${filterQuery}) is:open${words === null ? '' : ` ${words}`}`
}

/** The words of a tracker search for `--search`: each in double quotes, after removing the quotes
 *  it holds, so GitHub reads a qualifier such as `is:closed` as text; gh still refuses one with
 *  `is:pr`. `#42` becomes `42`, which finds that issue. Null when no word is left. */
export function githubSearchWords(trackerSearch = ''): string | null {
  const words = searchWords(trackerSearch)
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
