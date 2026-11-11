// GitHub Issues through `gh`. gh has no cursor for this list, so a page is the first 100 issues.
import { CliError, unreadableOutput } from '../cli'
import { isRecord, parseJson, text } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import type { Provider } from './types'

const LIMIT = 100

export const github: Provider<Required<ProviderConfigs>['github']> = {
  id: 'github',
  tracker: 'github',
  label: 'GitHub',
  async list(run, project) {
    if (!project.repo) {
      throw new CliError('This project has no GitHub repository. Choose a Jira tracker for it instead.')
    }
    const stdout = await run('gh', [
      'issue', 'list',
      '--repo', project.repo,
      '--state', 'open',
      '--limit', String(LIMIT),
      '--json', 'number,title,url,body,labels,assignees'
    ])
    const issues = parseJson(stdout)
    if (!Array.isArray(issues)) throw unreadableOutput('gh')
    // Counted before dropping unusable issues: 100 from gh means there may be more.
    return { tasks: toTasks(issues), nextCursor: null, truncated: issues.length >= LIMIT }
  }
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
