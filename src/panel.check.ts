// PROTOTYPE (issue #47), throwaway: invented data for `orca plugin shot --scenario`, one scenario per
// detail variant and per entry variant, with the detail open on a template or on a new one.
import { defineCheck, type CheckScenario } from 'orca/testing'
import type { Task, TaskList, TaskWorktree } from './protocol'

const project = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

const TITLES = ['Add dark mode to the settings page', 'Show the invoice total before taxes', 'Retry failed webhook deliveries with backoff']

const tasks: Task[] = TITLES.map((title, i) => {
  const key = `WEB-${12 + i}`
  return {
    tracker: 'jira',
    key,
    title,
    url: `https://example.atlassian.net/browse/${key}`,
    description: i === 0 ? 'The settings page ignores the system theme. Follow it, and add a switch to override it.' : '',
    status: 'To Do',
    statusCategory: 'todo',
    assignees: ['Ana Example'],
    labels: ['ui']
  }
})

const worktrees: Record<string, TaskWorktree> = {}

const ready: TaskList = {
  kind: 'ready',
  project,
  provider: 'jira-twg',
  tasks,
  nextCursor: null,
  truncated: false,
  worktrees,
  worktreesError: null,
  starting: [],
  warning: null
}

const storage = {
  settings: {
    version: 1,
    projects: {
      [project.id]: {
        provider: 'jira-twg',
        providers: { 'jira-twg': { jql: 'project = WEB AND statusCategory != Done ORDER BY rank', site: 'example.atlassian.net', profile: '' } },
        agent: 'claude',
        templates: [
          { id: 't-default', name: 'Default', text: '/tdd {{task_key}}\n\n{{task_title}}\n\n{{task_description}}\n\nTask: {{task_url}}\nBranch: {{branch}}' },
          { id: 't-review', name: 'Review', text: 'Review {{task_url}} and list what is missing.' },
          { id: 't-spike', name: 'Spike', text: '' }
        ],
        defaultTemplateId: 't-default'
      }
    }
  }
}

function scenario(plugin: Record<string, unknown>): CheckScenario {
  return {
    storage,
    persisted: { plugin },
    events: [{ event: 'workspace.changed', payload: { context: { branch: 'main', displayName: 'web', terminals: [] } } }],
    requests: {
      'tasks.load': ready,
      'worktrees.load': { kind: 'ready', worktrees },
      'project.active': { projectId: project.id },
      'starts.load': { starting: [] },
      'jira.sites': { kind: 'ready', sites: [] }
    }
  }
}

export default defineCheck({
  'd-a': scenario({ protoDetailVariant: 'D-A', protoOpenTemplate: 't-default' }),
  'd-a-new': scenario({ protoDetailVariant: 'D-A', protoOpenTemplate: ':new' }),
  'd-b': scenario({ protoDetailVariant: 'D-B', protoOpenTemplate: 't-default' }),
  'd-c-text': scenario({ protoDetailVariant: 'D-C', protoOpenTemplate: 't-default', protoDetailTab: 'text' }),
  'd-c-preview': scenario({ protoDetailVariant: 'D-C', protoOpenTemplate: 't-default', protoDetailTab: 'preview' }),
  // Project settings, where the entry variants differ.
  'e-a': scenario({ protoEntryVariant: 'E-A', protoOpenTemplate: ':settings' }),
  'e-b': scenario({ protoEntryVariant: 'E-B', protoOpenTemplate: ':settings' })
})
