// PROTOTYPE (issue #46), throwaway: invented data for `orca plugin shot --scenario`, one scenario per
// combination of the two variant switches, plus Project settings open and a project with no tracker.
import { defineCheck, type CheckScenario } from 'orca/testing'
import type { Task, TaskList, TaskWorktree } from './protocol'

const project = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

const TITLES = [
  'Add dark mode to the settings page',
  'Fix the date picker on Safari when the locale uses a 24-hour clock',
  'Show the invoice total before taxes',
  'Remove the legacy login form',
  'Retry failed webhook deliveries with backoff',
  'Translate the onboarding emails',
  'Keep the sidebar open after a reload',
  'Export reports as CSV',
  'Slow search on the orders page',
  'Upgrade the charts library'
]
const LABELS = [['ui'], ['bug', 'ui'], ['billing'], [], ['backend', 'webhooks'], ['i18n'], ['ui'], ['reports'], ['perf', 'search'], ['deps']]
const STATUSES = ['To Do', 'In Progress', 'To Do', 'Selected for Development', 'To Do']

const tasks: Task[] = Array.from({ length: 12 }, (_, i) => {
  const key = `WEB-${100 - i}`
  return {
    tracker: 'jira',
    key,
    title: TITLES[i % TITLES.length],
    url: `https://example.atlassian.net/browse/${key}`,
    description: '',
    status: STATUSES[i % STATUSES.length],
    statusCategory: 'todo',
    assignees: ['Ana Example'],
    labels: LABELS[i % LABELS.length]
  }
})

const worktrees: Record<string, TaskWorktree> = {
  'WEB-97': { worktreeId: 'repo-1::/work/web-97-remove-the-legacy-login-form', name: 'web-97-remove-the-legacy-login-form', agent: 'claude' },
  'WEB-92': { worktreeId: 'repo-1::/work/web-92-slow-search-on-the-orders-page', name: 'web-92-slow-search-on-the-orders-page', agent: null },
  'WEB-40': { worktreeId: 'repo-1::/work/web-40-old-task', name: 'web-40-old-task', agent: 'codex' }
}

const ready: TaskList = {
  kind: 'ready',
  project,
  provider: 'jira-twg',
  tasks,
  nextCursor: 'page-2',
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
          { id: 't-default', name: 'Default', text: '/tdd {{task_key}}\n\n{{task_title}}\n\n{{task_description}}\n\nTask: {{task_url}}' },
          { id: 't-review', name: 'Review', text: 'Review {{task_url}} and list what is missing.' },
          { id: 't-spike', name: 'Spike', text: '' }
        ],
        defaultTemplateId: 't-default'
      }
    }
  }
}

function scenario(list: TaskList, plugin: Record<string, unknown>, stored: CheckScenario["storage"] = storage): CheckScenario {
  return {
    storage: stored,
    persisted: { plugin },
    events: [{ event: 'workspace.changed', payload: { context: { branch: 'main', displayName: 'web', terminals: [] } } }],
    requests: {
      'tasks.load': list,
      'worktrees.load': { kind: 'ready', worktrees },
      'project.active': { projectId: project.id },
      'starts.load': { starting: [] },
      'jira.sites': { kind: 'ready', sites: [] }
    }
  }
}

const combos: Record<string, CheckScenario> = {}
for (const s of ['S-A', 'S-B', 'S-C']) {
  for (const l of ['L-A', 'L-B', 'L-C', 'L-D', 'L-E']) {
    combos[`${s}-${l}`.toLowerCase()] = scenario(ready, { protoSettingsVariant: s, protoListVariant: l })
  }
}

export default defineCheck({
  ...combos,
  // The maintainer's pick, with fewer tasks so that the replay's image stays short.
  verdict: scenario({ ...ready, tasks: tasks.slice(0, 5) }, { protoSettingsVariant: 'S-C', protoListVariant: 'L-E' }),
  'settings-open-s-a': scenario(ready, { protoSettingsVariant: 'S-A', projectSettingsOpen: true }),
  'settings-open-s-b': scenario(ready, { protoSettingsVariant: 'S-B', projectSettingsOpen: true }),
  'settings-open-s-c': scenario(ready, { protoSettingsVariant: 'S-C', protoSettingsView: true }),
  'scroll-frame': scenario(ready, { protoScrollMode: 'frame' }),
  'scroll-list-max-only': scenario(ready, { protoScrollMode: 'list-max-only' }),
  'scroll-list-height': scenario(ready, { protoScrollMode: 'list-height' }),
  'no-tracker-s-a': scenario({ kind: 'needs-config', project: { ...project, id: 'repo:docs', name: 'docs', repo: null } }, { protoSettingsVariant: 'S-A' }, {}),
  'no-tracker-s-c': scenario({ kind: 'needs-config', project: { ...project, id: 'repo:docs', name: 'docs', repo: null } }, { protoSettingsVariant: 'S-C' }, {})
})
