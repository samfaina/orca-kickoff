// GitHub Issues through `gh`. gh has no cursor for this list, so a page is the first 100 issues, of
// the whole list or of a tracker search.
import { CliError, unreadableOutput } from '../cli'
import { isRecord, parseJson, text } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import { searchWords, type Provider } from './types'

const LIMIT = 100

export const github: Provider<Required<ProviderConfigs>['github']> = {
  id: 'github',
  tracker: 'github',
  label: 'GitHub',
  async list(run, project, _config, request = {}) {
    if (!project.repo) {
      throw new CliError('This project has no GitHub repository. Choose a Jira tracker for it instead.')
    }
    const args = [
      'issue', 'list',
      '--repo', project.repo,
      '--state', 'open',
      '--limit', String(LIMIT),
      '--json', 'number,title,url,body,labels,assignees'
    ]
    const search = githubSearch(request.query)
    if (search !== null) args.push('--search', search)
    const stdout = await run('gh', args)
    const issues = parseJson(stdout)
    if (!Array.isArray(issues)) throw unreadableOutput('gh')
    // Counted before dropping unusable issues: 100 from gh means there may be more.
    return { tasks: toTasks(issues), nextCursor: null, truncated: issues.length >= LIMIT }
  }
}

/** The `--search` value of a tracker search: each word in double quotes, so none can act as a
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
