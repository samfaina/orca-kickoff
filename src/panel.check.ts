// States of the panel for `orca plugin check` and `orca plugin shot --scenario`; the plugin itself
// never loads this file. Every scenario answers every panel request itself: a request left out goes to the
// real worker, which runs the real `orca` (Linear included), `gh` and `twg` and shows real data. All data is invented,
// and each list is short, since a tall panel draws unreliably in `shot` (`docs/reference.md`).
import { defineCheck, type MockRequests } from 'orca/testing'
import {
  DEFAULT_JQL,
  INITIAL_FILTER_ID,
  INITIAL_FILTER_NAME,
  ownFilters,
  type AgentsResult,
  type Filter,
  type JiraProviderId,
  type ProjectRef,
  type ProviderId,
  type Task,
  type TaskList,
  type WorktreesResult
} from './protocol'
import { INITIAL_TEMPLATE_ID, INITIAL_TEMPLATE_NAME, INITIAL_TEMPLATE_TEXT } from './template'

type ReadyList = Extract<TaskList, { kind: 'ready' }>

/** The agents Orca can start, Claude its default agent. */
const AVAILABLE_AGENTS: AgentsResult = {
  kind: 'ready',
  agents: [
    { id: 'claude', name: 'Claude', default: true },
    { id: 'codex', name: 'Codex', default: false },
    { id: 'copilot', name: 'GitHub Copilot', default: false }
  ]
}

/** The answers of a panel showing `tasks`, whose project is the active one. The worktrees and the
 *  Starts under way are the list's own, and Orca can start `AVAILABLE_AGENTS`. A Start, a Run here,
 *  or opening a worktree, does nothing. */
function answers(tasks: TaskList): MockRequests {
  let worktrees: WorktreesResult = { kind: 'ready', worktrees: {} }
  let starting: string[] = []
  if (tasks.kind === 'ready') {
    worktrees =
      tasks.worktrees === null
        ? { kind: 'error', message: tasks.worktreesError ?? "Couldn't read Orca's worktrees." }
        : { kind: 'ready', worktrees: tasks.worktrees }
    starting = tasks.starting
  }
  return {
    'tasks.load': tasks,
    'worktrees.load': worktrees,
    'project.active': { projectId: 'project' in tasks && tasks.project ? tasks.project.id : null },
    'starts.load': { starting },
    'jira.sites': { kind: 'ready', sites: [{ id: 'site-1', name: 'example.atlassian.net' }] },
    'linear.choices': { kind: 'ready', teams: [{ key: 'ENG', name: 'Engineering' }, { key: 'DES', name: 'Design' }] },
    'agents.load': AVAILABLE_AGENTS,
    'task.start': { ok: false, message: 'Starting is off in check scenarios.' },
    'task.runHere': { ok: false, message: 'Running here is off in check scenarios.' },
    'worktree.open': { ok: false, message: 'Opening a worktree is off in check scenarios.' },
    'about.load': { version: '0.6.0', development: true }
  }
}

/** A project with a GitHub repository, which lists its open tasks with no setup. */
const web: ProjectRef = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }
/** A project with no GitHub repository, so it has no tracker until one is chosen. */
const notes: ProjectRef = { id: 'repo:notes', name: 'notes', repo: null }

/** The filter a GitHub project starts with. */
const [openFilter] = ownFilters({}, 'github', [])

/** A GitHub filter of two queries: the issues assigned to the person, then those to triage. */
const mineFilter: Filter = { id: 'f-mine', name: 'Mine or triage', queries: ['assignee:@me', 'label:needs-triage no:assignee'] }

/** The stored settings of `web` on GitHub with its two filters, the second shown. */
const githubSettings = {
  settings: { version: 1, projects: { [web.id]: { providers: {}, filters: { github: [openFilter, mineFilter] }, shownFilterId: { github: mineFilter.id } } } }
}

/** A ready list, with no task worktree unless `fields` says otherwise. */
const ready = (project: ProjectRef, provider: ProviderId, tasks: Task[], fields: Partial<ReadyList> = {}): ReadyList => ({
  kind: 'ready',
  project,
  provider,
  tasks,
  nextCursor: null,
  truncated: false,
  filterId: provider === 'github' ? openFilter.id : INITIAL_FILTER_ID,
  queryCount: 1,
  worktrees: {},
  worktreesError: null,
  starting: [],
  warning: null,
  ...fields
})

const githubTask = (number: number, title: string, labels: string[] = [], assignees: string[] = []): Task => ({
  tracker: 'github',
  key: `#${number}`,
  title,
  url: `https://github.com/acme/web/issues/${number}`,
  description: '',
  status: 'Open',
  statusCategory: 'todo',
  assignees,
  labels
})

/** One task with a single assignee, one with several, and the rest with none. */
const githubTasks: Task[] = [
  githubTask(42, 'Add dark mode to settings', ['ui', 'enhancement'], ['octocat']),
  githubTask(41, 'Fix the login redirect after a session expires', ['bug'], ['octocat', 'hubot']),
  githubTask(39, 'Document the release steps'),
  githubTask(37, 'Cache the avatar images', ['performance'])
]

const jiraTask = (key: string, title: string, status: string, category: Task['statusCategory'], labels: string[] = []): Task => ({
  tracker: 'jira',
  key,
  title,
  url: `https://example.atlassian.net/browse/${key}`,
  description: '',
  status,
  statusCategory: category,
  assignees: ['Ana Example'],
  labels
})

const jiraTasks: Task[] = [
  jiraTask('WEB-12', 'Add dark mode to settings', 'In Progress', 'in_progress', ['ui']),
  jiraTask('WEB-14', 'Show the order history on the account page', 'In Progress', 'in_progress'),
  jiraTask('WEB-15', 'Retry failed payments once', 'To Do', 'todo', ['payments']),
  jiraTask('WEB-16', 'Remove the old checkout banner', 'To Do', 'todo'),
  jiraTask('WEB-18', 'Translate the error pages', 'To Do', 'todo', ['i18n', 'ui'])
]

/** The filter a Jira project starts with. */
const tasksFilter: Filter = { id: INITIAL_FILTER_ID, name: INITIAL_FILTER_NAME, queries: [DEFAULT_JQL] }

/** The stored settings of `web` reading Jira through `provider` with these filters, the first
 *  shown unless `shownFilterId` says otherwise, and two prompt templates so the cards that can
 *  start offer a choice. */
const jiraSettings = (provider: JiraProviderId, filters: Filter[] = [tasksFilter], shownFilterId = filters[0].id) => ({
  settings: {
    version: 1,
    projects: {
      [web.id]: {
        provider,
        providers: {
          'jira-orca': { siteId: '' },
          'jira-twg': { site: 'example.atlassian.net', profile: '' }
        },
        filters: { jira: filters },
        shownFilterId: { jira: shownFilterId },
        templates: [
          { id: INITIAL_TEMPLATE_ID, name: INITIAL_TEMPLATE_NAME, text: INITIAL_TEMPLATE_TEXT },
          { id: 'test-first', name: 'Test first', text: '/tdd {{task_key}}: {{task_title}}\n\n{{task_description}}' }
        ],
        defaultTemplateId: INITIAL_TEMPLATE_ID
      }
    }
  }
})

/** Through twg, which pages: WEB-12 runs an agent, WEB-14 has a worktree with none, and WEB-15 is
 *  starting. */
const jiraStarted = ready(web, 'jira-twg', jiraTasks, {
  nextCursor: 'cursor-2',
  worktrees: {
    'WEB-12': { worktreeId: 'wt-12', name: 'web-12-add-dark-mode-to', agent: 'claude' },
    'WEB-14': { worktreeId: 'wt-14', name: 'web-14-show-the-order-history', agent: null }
  },
  starting: ['WEB-15']
})

/** A filter of three JQL queries: the active sprint, future sprints and the backlog. */
const sprintFilter: Filter = {
  id: 'f-sprint',
  name: 'Sprint',
  queries: ['project = WEB AND sprint in openSprints()', 'project = WEB AND sprint in futureSprints()', 'project = WEB AND sprint is EMPTY']
}

/** A filter of the board's tasks in board order, with a second query and a blank third one. */
const boardFilter: Filter = { id: 'f-board', name: 'Board', queries: [DEFAULT_JQL, 'project = WEB AND labels = ui\nORDER BY rank', ''] }

/** The first page of `sprintFilter`, which holds every task of its three queries: two in the active
 *  sprint, one in a future sprint and two in the backlog, so there is no Load more. */
const sprintTasks = ready(
  web,
  'jira-twg',
  [
    jiraTask('WEB-21', 'Add dark mode to settings', 'In Progress', 'in_progress', ['ui']),
    jiraTask('WEB-22', 'Retry failed payments once', 'To Do', 'todo', ['payments']),
    jiraTask('WEB-23', 'Show the order history on the account page', 'To Do', 'todo'),
    jiraTask('WEB-30', 'Translate the error pages', 'To Do', 'todo', ['i18n']),
    jiraTask('WEB-31', 'Remove the old checkout banner', 'To Do', 'todo')
  ],
  { filterId: sprintFilter.id, queryCount: sprintFilter.queries.length }
)

const linearTask = (key: string, title: string, status: string, category: Task['statusCategory'], labels: string[] = []): Task => ({
  tracker: 'linear',
  key,
  title,
  url: `https://linear.app/acme/issue/${key}/task`,
  description: '',
  status,
  statusCategory: category,
  assignees: ['Ana Example'],
  labels
})

/** The filter a Linear project starts with. */
const [assignedFilter] = ownFilters({}, 'linear', [])

/** `web` reading Linear through Orca's connection, with its initial filter "Assigned to me". */
const linearSettings = { settings: { version: 1, projects: { [web.id]: { provider: 'linear-orca', providers: { 'linear-orca': { workspaceId: '' } } } } } }

/** The first page of "Assigned to me": ENG-12 runs an agent in its linked worktree. */
const linearStarted = ready(
  web,
  'linear-orca',
  [
    linearTask('ENG-12', 'Add dark mode to settings', 'In Progress', 'in_progress', ['Feature']),
    linearTask('ENG-14', 'Retry failed payments once', 'Todo', 'todo', ['Bug']),
    linearTask('ENG-15', 'Translate the error pages', 'Backlog', 'todo'),
    linearTask('ENG-17', 'Show the order history on the account page', 'Triage', 'todo')
  ],
  {
    filterId: assignedFilter.id,
    nextCursor: '0:cursor-2',
    worktrees: { 'ENG-12': { worktreeId: 'wt-eng-12', name: 'eng-12-add-dark-mode-to', agent: 'claude' } }
  }
)

/** A Linear filter of two Linear queries: Engineering's unassigned issues, last created first, then
 *  the issues of a team the workspace no longer has. */
const triageFilter: Filter = {
  id: 'f-triage',
  name: 'Triage',
  queries: [JSON.stringify({ team: 'ENG', assignee: 'null', orderBy: 'createdAt' }), JSON.stringify({ team: 'OPS' })]
}

/** `web` on Linear with its initial filter and `triageFilter`, which it shows. */
const linearTriageSettings = {
  settings: {
    version: 1,
    projects: {
      [web.id]: {
        provider: 'linear-orca',
        providers: { 'linear-orca': { workspaceId: '' } },
        filters: { linear: [assignedFilter, triageFilter] },
        shownFilterId: { linear: triageFilter.id }
      }
    }
  }
}

/** What the worker answers when twg has no login, when the Orca CLI can't be found, and when
 *  `orca worktree list` fails. */
const TWG_LOGGED_OUT =
  "twg failed: authentication required. No valid credentials found. You're not signed in. Run `twg login --force` to authenticate with your Atlassian account."
const ORCA_MISSING =
  "Couldn't find the Orca CLI. It comes with Orca: reinstall or update Orca, and connect Jira in Orca's settings if you read Jira through Orca. Or set ORCA_CLI_COMMAND to the full path of the CLI."
const ORCA_SLOW = "orca didn't answer in time."
/** What the worker answers when the second query of the filter "Board" is invalid. */
const SECOND_JQL_INVALID = "Board: JQL query 2 failed: twg failed: The value 'WEB' does not exist for the field 'project'."

export default defineCheck({
  'no-project': { requests: answers({ kind: 'no-project' }) },
  // Project settings opens by itself, with a tracker to choose.
  'needs-config': { requests: answers({ kind: 'needs-config', project: notes }) },
  // Project settings, open by itself, with Codex chosen as the agent among Orca default, named
  // after Claude, the three agents Orca can start by name, and No agent.
  'available-agents': {
    storage: { settings: { version: 1, projects: { [notes.id]: { providers: {}, agent: 'codex' } } } },
    requests: answers({ kind: 'needs-config', project: notes })
  },
  'github-ready': { requests: answers(ready(web, 'github', githubTasks)) },
  // One template of the project's own and two global ones: the cards' template Select lists the
  // project's first, then the global ones, marked Global; the default template is a global one.
  // "Prompt templates" in the header opens the view on it, its Global and Default template switches
  // on.
  'global-templates': {
    storage: {
      settings: {
        version: 1,
        projects: { [web.id]: { providers: {}, templates: [{ id: 'fix', name: 'Fix', text: 'Fix {{task_key}}' }], defaultTemplateId: 'test-first' } },
        global: {
          templates: [
            { id: 'test-first', name: 'Test first', text: '/tdd {{task_key}}: {{task_title}}' },
            { id: 'review', name: 'Review', text: 'Review {{task_url}}' }
          ]
        }
      }
    },
    requests: answers(ready(web, 'github', githubTasks))
  },
  // Two templates: the cards show Run here and Start, both outline, beside the template and agent
  // Selects.
  // The Prompt templates view has no New worktree switch.
  'run-here': {
    storage: {
      settings: {
        version: 1,
        projects: {
          [web.id]: {
            providers: {},
            templates: [
              { id: 'ship', name: 'Ship', text: '/ship-tickets {{task_key}}' },
              { id: 'fix', name: 'Fix', text: 'Fix {{task_key}}' }
            ],
            defaultTemplateId: 'ship'
          }
        }
      }
    },
    requests: answers(ready(web, 'github', githubTasks.slice(0, 3)))
  },
  // A project set to No agent, with two templates: each card shows the template Select, the agent
  // Select on None, and Start, with no Run here. A card set to another agent on its Select, such as
  // Codex on #41, shows Run here too; Project settings keep No agent.
  'card-agent': {
    storage: {
      settings: {
        version: 1,
        projects: {
          [web.id]: {
            providers: {},
            agent: 'none',
            templates: [
              { id: 'ship', name: 'Ship', text: '/ship-tickets {{task_key}}' },
              { id: 'fix', name: 'Fix', text: 'Fix {{task_key}}' }
            ],
            defaultTemplateId: 'ship'
          }
        }
      }
    },
    requests: answers(ready(web, 'github', githubTasks.slice(0, 3)))
  },
  // Two GitHub filters, the second of two queries shown: the filter row shows it, with ✎ and +.
  'github-filters': {
    storage: githubSettings,
    requests: answers(ready(web, 'github', githubTasks.slice(0, 2), { filterId: mineFilter.id, queryCount: 2 }))
  },
  // The project's own Jira filter and two global ones, the first shown: the filter row lists the
  // project's first, then the global ones, marked Global.
  'global-filters': {
    storage: {
      settings: {
        ...jiraSettings('jira-twg', [tasksFilter], 'g-sprint').settings,
        global: {
          filters: {
            jira: [
              { id: 'g-sprint', name: 'Sprint', queries: ['project = {{jira_project}} AND sprint in openSprints()'] },
              { id: 'g-bugs', name: 'Bugs', queries: ['project = {{jira_project}} AND type = Bug'] }
            ]
          }
        }
      }
    },
    requests: answers(ready(web, 'jira-twg', jiraTasks.slice(0, 2), { filterId: 'g-sprint' }))
  },
  'jira-started': { storage: jiraSettings('jira-twg'), requests: answers(jiraStarted) },
  // A Linear project on its initial filter: the filter row has ✎ and +, and each card shows the
  // state's name.
  'linear-ready': { storage: linearSettings, requests: answers(linearStarted) },
  // A Linear filter of two Linear queries, shown: ✎ opens a form for each, the second naming a team
  // the workspace no longer has.
  'linear-queries': {
    storage: linearTriageSettings,
    requests: answers(ready(web, 'linear-orca', linearStarted.tasks.slice(1, 3), { filterId: triageFilter.id, queryCount: 2 }))
  },
  // Five tasks stand for the 100 Orca's Jira search answers at most.
  truncated: {
    storage: jiraSettings('jira-orca'),
    requests: answers(ready(web, 'jira-orca', jiraTasks, { truncated: true }))
  },
  // A failed load that isn't about a query, such as twg without a login, opens Project settings by
  // itself, on the tracker that failed; Done shows the error under the filter row.
  'tracker-error': {
    storage: jiraSettings('jira-twg'),
    requests: answers({ kind: 'error', project: web, message: TWG_LOGGED_OUT })
  },
  // A filter of several JQL queries, the second one invalid: the filter editor opens by itself on
  // them, each with its Remove button, and Add JQL below.
  'jira-queries': {
    storage: jiraSettings('jira-twg', [tasksFilter, boardFilter], boardFilter.id),
    requests: answers({ kind: 'error', project: web, message: SECOND_JQL_INVALID, filterId: boardFilter.id })
  },
  // A filter of several JQL queries through twg, whose first page holds the tasks of all three, as
  // the provider fills a page across queries: the panel lists them all, with no Load more.
  'jira-twg-queries': { storage: jiraSettings('jira-twg', [sprintFilter]), requests: answers(sprintTasks) },
  // Two filters, the second one shown: the filter row above the field shows it, with ✎ and +.
  'jira-filters': {
    storage: jiraSettings('jira-twg', [tasksFilter, sprintFilter], sprintFilter.id),
    requests: answers(sprintTasks)
  },
  // With no project known there are no Project settings to open, so the error shows at once.
  'orca-error': {
    requests: {
      ...answers({ kind: 'error', project: null, message: ORCA_MISSING }),
      'project.active': { kind: 'error', message: ORCA_MISSING }
    }
  },
  'worktrees-unavailable': {
    requests: answers(ready(web, 'github', githubTasks, { worktrees: null, worktreesError: ORCA_SLOW }))
  }
})
