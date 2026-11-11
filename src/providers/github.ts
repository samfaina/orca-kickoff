// GitHub Issues through `gh`. gh has no cursor for this list, so a page is the first 100 issues.
import { CliError } from '../cli'
import { isRecord } from '../json'
import type { ProviderConfigs, Task } from '../protocol'
import type { Provider } from './types'

const LIMIT = 100

export const github: Provider<NonNullable<ProviderConfigs['github']>> = {
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
    const tasks = parseIssues(stdout)
    return { tasks, nextCursor: null, truncated: tasks.length >= LIMIT }
  }
}

function parseIssues(stdout: string): Task[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    parsed = undefined
  }
  if (!Array.isArray(parsed)) throw new CliError("gh returned output Kickoff couldn't read. Update gh and try again.")
  return parsed.flatMap((issue): Task[] => {
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function names(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => (isRecord(item) && text(item[field]) ? [text(item[field])] : []))
}
