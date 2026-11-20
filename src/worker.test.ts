import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { AGENT_UNREADABLE, type DefaultAgent } from './agent'
import { CliError, cliFailureMessage, type RunCli } from './cli'
import type { StartEnded, Task } from './protocol'
import { activateWith } from './worker'

const wrap = (result: unknown) => JSON.stringify({ id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt-1' } })

const ORCA_OK = {
  'orca project list': wrap({
    projects: [
      { id: 'github:acme/web', displayName: 'web', providerIdentity: { provider: 'github', owner: 'acme', repo: 'web' } },
      { id: 'repo:r2', displayName: 'notes' }
    ]
  }),
  'orca worktree list': wrap({
    worktrees: [
      { id: 'r1::/src/web', projectId: 'github:acme/web', displayName: 'web', isArchived: false, linkedIssue: null, linkedItems: [] },
      { id: 'r2::/src/notes', projectId: 'repo:r2', displayName: 'notes', isArchived: false, linkedIssue: null, linkedItems: [] }
    ],
    totalCount: 2,
    truncated: false
  }),
  'orca worktree ps': wrap({ worktrees: [{ worktreeId: 'r1::/src/web', isActive: true, agents: [] }] })
}

const GH_ISSUES = JSON.stringify([
  { number: 42, title: 'Add dark mode', url: 'https://github.com/acme/web/issues/42', body: '', labels: [], assignees: [] }
])

type Answer = string | Error | ((args: string[]) => string | Promise<string>)

type Call = { tool: string; args: string[]; timeoutMs?: number }

/** Answers each `<tool> <subcommand> <subcommand>` with stdout, or rejects with an error, and
 *  records every call. */
function fakeRun(answers: Record<string, Answer>, calls: Call[]): RunCli {
  return async (tool, args, options) => {
    calls.push({ tool, args, timeoutMs: options?.timeoutMs })
    const answer = answers[[tool, ...args.slice(0, 2)].join(' ')]
    if (answer === undefined) throw new CliError(`unexpected call: ${tool} ${args.join(' ')}`)
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? answer(args) : answer
  }
}

type StartOptions = {
  storage?: Record<string, JsonValue>
  defaultAgent?: DefaultAgent
  now?: () => number
  /** Makes `orca.panels.post` throw this, as a post Orca refuses would. */
  postThrows?: Error
}

/** `orca` with a `panels.post` that throws `error`. */
function withFailingPost(orca: OrcaWorkerApi, error: Error): OrcaWorkerApi {
  const post = () => {
    throw error
  }
  return { ...orca, panels: { ...orca.panels, post } }
}

async function start(answers: Record<string, Answer>, options: StartOptions = {}) {
  const { storage = {}, defaultAgent = { kind: 'agent', agent: 'claude' }, now = Date.now, postThrows } = options
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], storage })
  const calls: Call[] = []
  let run = fakeRun(answers, calls)
  const worker = await mountWorker(
    {
      default: (orca) =>
        activateWith(postThrows ? withFailingPost(orca, postThrows) : orca, { run: (...args) => run(...args), readDefaultAgent: async () => defaultAgent, now })
    },
    { host }
  )
  return { worker, calls, answer: (next: Record<string, Answer>) => (run = fakeRun(next, calls)) }
}

const creates = (calls: Call[]) => calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'create')

const issue42: Task = {
  tracker: 'github',
  key: '#42',
  title: 'Add dark mode',
  url: 'https://github.com/acme/web/issues/42',
  description: 'Users want a dark theme.',
  status: 'Open',
  statusCategory: 'todo',
  assignees: [],
  labels: []
}

/** `worktree list` with the web project's main worktree and these others. */
const worktreesWith = (...extra: object[]) =>
  wrap({
    worktrees: [
      { id: 'r1::/src/web', projectId: 'github:acme/web', displayName: 'web', isArchived: false, linkedIssue: null, linkedItems: [] },
      ...extra
    ]
  })

const started42 = { id: 'r1::/src/web-42', projectId: 'github:acme/web', displayName: 'issue-42-add-dark-mode', isArchived: false, linkedIssue: 42 }

const CREATED = wrap({ worktree: { id: 'r1::/src/web-42' } })

const startWeb42 = { projectId: 'github:acme/web', task: issue42, templateId: 'default' }

test('a project with a GitHub repo lists its open issues with no configuration', async () => {
  const { worker } = await start({ ...ORCA_OK, 'gh issue list': GH_ISSUES })
  const list = await worker.request('tasks.load', {})
  assert.deepEqual(list, {
    kind: 'ready',
    project: { id: 'github:acme/web', name: 'web', repo: 'acme/web' },
    provider: 'github',
    tasks: [
      {
        tracker: 'github',
        key: '#42',
        title: 'Add dark mode',
        url: 'https://github.com/acme/web/issues/42',
        description: '',
        status: 'Open',
        statusCategory: 'todo',
        assignees: [],
        labels: []
      }
    ],
    nextCursor: null,
    truncated: false,
    filterId: 'open',
    queryCount: 1,
    worktrees: {},
    worktreesError: null,
    starting: [],
    warning: null
  })
  assert.deepEqual(worker.refusals, [])
})

test('with gh missing, the list is an error that says how to fix it, and keeps the project', async () => {
  const missing = new CliError(cliFailureMessage('gh', { kind: 'not-found' }))
  const { worker } = await start({ ...ORCA_OK, 'gh issue list': missing })
  const list = await worker.request('tasks.load', {})
  assert.deepEqual(list, {
    kind: 'error',
    project: { id: 'github:acme/web', name: 'web', repo: 'acme/web' },
    message: missing.message
  })
})

test("with gh logged out, the list is an error with gh's own words on how to log in", async () => {
  const loggedOut = Object.assign(new Error('Command failed'), {
    code: 4,
    stdout: '',
    stderr: 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n'
  })
  const failure = new CliError(cliFailureMessage('gh', { kind: 'failed', exitCode: 4, stdout: loggedOut.stdout, stderr: loggedOut.stderr }))
  const { worker } = await start({ ...ORCA_OK, 'gh issue list': failure })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'error')
  assert.equal(list.message, 'gh failed: To get started with GitHub CLI, please run:  gh auth login')
})

test('with no active worktree there is no project', async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree ps': wrap({ worktrees: [{ worktreeId: 'r1::/src/web', isActive: false, agents: [] }] }) })
  assert.deepEqual(await worker.request('tasks.load', {}), { kind: 'no-project' })
})

test('a project without a repo or a chosen provider needs configuration, not an error', async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree ps': wrap({ worktrees: [{ worktreeId: 'r2::/src/notes', isActive: true, agents: [] }] }) })
  assert.deepEqual(await worker.request('tasks.load', {}), { kind: 'needs-config', project: { id: 'repo:r2', name: 'notes', repo: null } })
})

test('a project with Jira (twg) lists its tasks through twg, one page at a time', async () => {
  const settings = {
    version: 1,
    projects: {
      'github:acme/web': { provider: 'jira-twg', providers: { 'jira-twg': { site: '', profile: 'work' } }, filters: { jira: [{ id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }] } }
    }
  }
  const page = (key: string, nextCursor: string | null) =>
    JSON.stringify({
      data: { issues: [{ key, summary: `Task ${key}`, assignee: null, url: `https://example.atlassian.net/browse/${key}` }] },
      ...(nextCursor ? { pageInfo: { hasNextPage: true, nextCursor } } : {})
    })
  const { worker, calls } = await start(
    { ...ORCA_OK, 'twg jira workitem': (args) => (args.includes('--after') ? page('WEB-2', null) : page('WEB-1', 'cursor-2')) },
    { storage: { settings } }
  )
  const first = await worker.request('tasks.load', {})
  assert.ok(first.kind === 'ready')
  assert.equal(first.provider, 'jira-twg')
  assert.deepEqual(first.tasks.map((task) => task.key), ['WEB-1'])
  assert.equal(first.nextCursor, '0:cursor-2')

  const second = await worker.request('tasks.load', { cursor: '0:cursor-2' })
  assert.ok(second.kind === 'ready')
  assert.deepEqual(second.tasks.map((task) => task.key), ['WEB-2'])
  assert.equal(second.nextCursor, null)
  const twgCalls = calls.filter((call) => call.tool === 'twg')
  assert.equal(twgCalls.length, 2)
  assert.deepEqual(twgCalls[0].args.slice(-2), ['--profile', 'work'])
  assert.deepEqual(twgCalls[1].args.slice(-4), ['--profile', 'work', '--after', 'cursor-2'])
})

test('tasks.load with a query runs a tracker search, and a Jira (twg) next page sends the query again with the cursor', async () => {
  // A JQL stored as one string, as before a project could have several queries or filters.
  const settings = {
    version: 1,
    projects: { 'github:acme/web': { provider: 'jira-twg', providers: { 'jira-twg': { jql: 'project = WEB ORDER BY rank', site: '', profile: '' } } } }
  }
  const page = JSON.stringify({
    data: { issues: [{ key: 'WEB-7', summary: 'Dark mode', assignee: null, url: 'https://example.atlassian.net/browse/WEB-7' }] },
    pageInfo: { hasNextPage: true, nextCursor: 'cursor-2' }
  })
  const { worker, calls } = await start({ ...ORCA_OK, 'twg jira workitem': page }, { storage: { settings } })
  const found = await worker.request('tasks.load', { query: 'dark' })
  assert.ok(found.kind === 'ready')
  assert.deepEqual(found.tasks.map((task) => task.key), ['WEB-7'])
  assert.equal(found.nextCursor, '0:cursor-2')
  await worker.request('tasks.load', { query: 'dark', cursor: '0:cursor-2' })
  const jqls = calls.filter((call) => call.tool === 'twg').map((call) => call.args[call.args.indexOf('--jql') + 1])
  assert.deepEqual(jqls, ['(project = WEB) AND (text ~ "dark*") ORDER BY rank', '(project = WEB) AND (text ~ "dark*") ORDER BY rank'])
  assert.equal(calls.filter((call) => call.tool === 'twg')[1].args.at(-1), 'cursor-2')
})

test('tasks.load with a query searches GitHub with the quoted words', async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'gh issue list': GH_ISSUES })
  const found = await worker.request('tasks.load', { query: 'dark #42' })
  assert.ok(found.kind === 'ready')
  const gh = calls.find((call) => call.tool === 'gh')
  assert.deepEqual(gh?.args.slice(-2), ['--search', '(is:open) is:open "dark" "42"'])
})

test("a GitHub project lists the filter tasks.load names, else GitHub's one shown last, with its count of searches that run", async () => {
  const triage = { id: 'f-triage', name: 'Triage', queries: ['label:needs-triage', '', 'assignee:@me'] }
  const mineOnJira = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }
  const settings = {
    version: 1,
    projects: {
      'github:acme/web': {
        providers: {},
        filters: { github: [{ id: 'open', name: 'Open', queries: ['is:open'] }, triage], jira: [mineOnJira] },
        shownFilterId: { github: 'f-triage', jira: 'f-mine' }
      }
    }
  }
  const { worker, calls } = await start({ ...ORCA_OK, 'gh issue list': GH_ISSUES }, { storage: { settings } })
  const searches = () => calls.splice(0).filter((call) => call.tool === 'gh').map((call) => call.args.at(-1))
  const shown = await worker.request('tasks.load', {})
  assert.ok(shown.kind === 'ready')
  assert.deepEqual([shown.filterId, shown.queryCount], ['f-triage', 2])
  assert.deepEqual(searches(), ['(label:needs-triage) is:open', '(assignee:@me) is:open'])
  const named = await worker.request('tasks.load', { filterId: 'open', query: 'dark' })
  assert.ok(named.kind === 'ready')
  assert.deepEqual([named.filterId, named.queryCount], ['open', 1])
  assert.deepEqual(searches(), ['(is:open) is:open "dark"'])
})

test('a GitHub filter whose searches are all blank is an error asking for one, naming the filter, without running gh', async () => {
  const settings = { version: 1, projects: { 'github:acme/web': { providers: {}, filters: { github: [{ id: 'f-empty', name: 'Empty', queries: [' '] }] } } } }
  const { worker, calls } = await start({ ...ORCA_OK, 'gh issue list': GH_ISSUES }, { storage: { settings } })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'error')
  assert.match(list.message, /^Empty: Enter a GitHub search/)
  assert.equal(list.filterId, 'f-empty')
  assert.equal(calls.some((call) => call.tool === 'gh'), false)
})

test("when Orca fails, its real message is shown, or the last known project is used with a warning", async () => {
  const down = new CliError('orca failed: Orca is not running.')
  const { worker, answer } = await start({ ...ORCA_OK, 'orca project list': down })
  assert.deepEqual(await worker.request('tasks.load', {}), { kind: 'error', project: null, message: 'orca failed: Orca is not running.' })

  answer({ ...ORCA_OK, 'gh issue list': GH_ISSUES })
  assert.equal((await worker.request('tasks.load', {})).kind, 'ready')

  answer({ ...ORCA_OK, 'orca worktree ps': down, 'gh issue list': GH_ISSUES })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'ready')
  assert.equal(list.project.id, 'github:acme/web')
  assert.equal(list.tasks.length, 1)
  assert.equal(list.warning, 'Using the last known project (web). orca failed: Orca is not running.')
  // Without Orca's answer the worktrees are unknown, so Start stays off.
  assert.equal(list.worktrees, null)
  assert.equal(list.worktreesError, 'orca failed: Orca is not running.')
})

test('the task list carries task worktrees with their running agent', async () => {
  const { worker } = await start({
    ...ORCA_OK,
    'orca worktree list': worktreesWith(started42),
    'orca worktree ps': wrap({
      worktrees: [
        { worktreeId: 'r1::/src/web', isActive: true, agents: [] },
        { worktreeId: 'r1::/src/web-42', isActive: false, agents: [{ agentType: 'claude', state: 'working', mainAgent: true }] }
      ]
    }),
    'gh issue list': GH_ISSUES
  })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'ready')
  assert.deepEqual(list.worktrees, { '#42': { worktreeId: 'r1::/src/web-42', name: 'issue-42-add-dark-mode', agent: 'claude' } })
})

test("project.active answers the active worktree's project id, or null with none active", async () => {
  const { worker, calls, answer } = await start(ORCA_OK)
  assert.deepEqual(await worker.request('project.active', {}), { projectId: 'github:acme/web' })
  // The panel asks every few seconds, so only the two queries that tell it run.
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2).join(' ')).sort(), ['worktree list', 'worktree ps'])

  answer({ ...ORCA_OK, 'orca worktree ps': wrap({ worktrees: [{ worktreeId: 'r2::/src/notes', isActive: true, agents: [] }] }) })
  assert.deepEqual(await worker.request('project.active', {}), { projectId: 'repo:r2' })

  answer({ ...ORCA_OK, 'orca worktree ps': wrap({ worktrees: [{ worktreeId: 'r1::/src/web', isActive: false, agents: [] }] }) })
  assert.deepEqual(await worker.request('project.active', {}), { projectId: null })
})

test("project.active answers Orca's real message as data when Orca fails", async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree ps': new CliError('orca failed: Orca is not running.') })
  assert.deepEqual(await worker.request('project.active', {}), { kind: 'error', message: 'orca failed: Orca is not running.' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const JIRA_SEARCH = wrap([
  {
    key: 'WEB-12',
    title: 'Añadir modo oscuro a ajustes',
    description: '',
    url: 'https://example.atlassian.net/browse/WEB-12',
    status: { name: 'Por hacer', categoryKey: 'new' },
    labels: []
  },
  { key: 'WEB-13', title: 'Arreglar el login', description: '', url: 'https://example.atlassian.net/browse/WEB-13', status: { name: 'Por hacer', categoryKey: 'new' }, labels: [] }
])

/** Stored settings of the web project on Jira (Orca connection), with these filters. */
const jiraSettings = (siteId = '', filters = [{ id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }], shownFilterId?: string) => ({
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        provider: 'jira-orca',
        providers: { 'jira-orca': { siteId } },
        filters: { jira: filters },
        ...(shownFilterId ? { shownFilterId: { jira: shownFilterId } } : {})
      }
    }
  }
})

test("a project on Jira (Orca connection) lists the JQL's tasks, with task worktrees linked or named after them", async () => {
  const { worker, calls } = await start(
    {
      ...ORCA_OK,
      'orca worktree list': worktreesWith(
        {
          id: 'r1::/src/dark', projectId: 'github:acme/web', displayName: 'dark-mode', isArchived: false, linkedIssue: null,
          linkedItems: [{ provider: 'jira', type: 'issue', number: 0, identifier: 'web-12', jiraIdentifier: 'web-12', url: 'https://example.atlassian.net/browse/WEB-12' }]
        },
        { id: 'r1::/src/login', projectId: 'github:acme/web', displayName: 'web-13-arreglar-el-login', isArchived: false, linkedIssue: null, linkedItems: [] }
      ),
      'orca jira search': JIRA_SEARCH
    },
    { storage: jiraSettings('site-2') }
  )
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'ready')
  assert.equal(list.provider, 'jira-orca')
  assert.deepEqual(list.tasks.map((task) => task.key), ['WEB-12', 'WEB-13'])
  assert.deepEqual(list.worktrees, {
    'WEB-12': { worktreeId: 'r1::/src/dark', name: 'dark-mode', agent: null },
    'WEB-13': { worktreeId: 'r1::/src/login', name: 'web-13-arreglar-el-login', agent: null }
  })
  const search = calls.find((call) => call.args[0] === 'jira')
  assert.deepEqual(search?.args, ['jira', 'search', 'project = WEB', '--limit', '100', '--json', '--site', 'site-2'])
})

const board = { id: 'f-board', name: 'Board', queries: ['project = WEB ORDER BY rank', ' ', 'labels = ui'] }
const mine = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }

/** The JQL of each `orca jira search` call. */
const searched = (calls: Call[]) => calls.filter((call) => call.args[0] === 'jira' && call.args[1] === 'search').map((call) => call.args[2])

test('tasks.load lists the filter it names, else the one shown last, else the first, and says which, with its count of queries that run', async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca jira search': JIRA_SEARCH }, { storage: jiraSettings('', [board, mine], 'f-mine') })
  const shown = await worker.request('tasks.load', {})
  assert.ok(shown.kind === 'ready')
  assert.deepEqual([shown.filterId, shown.queryCount], ['f-mine', 1])
  assert.deepEqual(searched(calls.splice(0)), ['assignee = currentUser()'])

  const named = await worker.request('tasks.load', { filterId: 'f-board', query: 'dark' })
  assert.ok(named.kind === 'ready')
  assert.deepEqual([named.filterId, named.queryCount], ['f-board', 2])
  assert.deepEqual(searched(calls.splice(0)), ['(project = WEB) AND (text ~ "dark*") ORDER BY rank', '(labels = ui) AND (text ~ "dark*")'])

  const gone = await worker.request('tasks.load', { filterId: 'f-gone' })
  assert.ok(gone.kind === 'ready')
  assert.equal(gone.filterId, 'f-mine')
})

test('a Jira project without filters lists the filter "Tasks" with the default JQL', async () => {
  const settings = { version: 1, projects: { 'github:acme/web': { provider: 'jira-orca', providers: {} } } }
  const { worker, calls } = await start({ ...ORCA_OK, 'orca jira search': JIRA_SEARCH }, { storage: { settings } })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'ready')
  assert.equal(list.filterId, 'tasks')
  assert.deepEqual(searched(calls), ['assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'])
})

test("an invalid JQL query fails the whole list, naming its filter and position, and the answer names the filter", async () => {
  const invalid = JSON.stringify({ ok: false, error: { code: 'runtime_error', message: 'Error 400: La consulta JQL no es válida.' } })
  const { worker } = await start(
    { ...ORCA_OK, 'orca jira search': (args) => (args.includes('labels = ui') ? invalid : JIRA_SEARCH) },
    { storage: jiraSettings('', [mine, board]) }
  )
  assert.deepEqual(await worker.request('tasks.load', { filterId: 'f-board' }), {
    kind: 'error',
    project: { id: 'github:acme/web', name: 'web', repo: 'acme/web' },
    message: 'Board: JQL query 3 failed: orca failed: Error 400: La consulta JQL no es válida.',
    filterId: 'f-board'
  })
})

test("a Jira failure that isn't about a query, such as no connected site, is the tool's own message and names no filter", async () => {
  const noSite = JSON.stringify({ ok: false, error: { code: 'invalid_argument', message: 'No matching connected Jira site.' } })
  const { worker } = await start({ ...ORCA_OK, 'orca jira search': noSite }, { storage: jiraSettings('site-9', [board]) })
  assert.deepEqual(await worker.request('tasks.load', {}), {
    kind: 'error',
    project: { id: 'github:acme/web', name: 'web', repo: 'acme/web' },
    message: 'orca failed: No matching connected Jira site.'
  })
})

test('a filter whose queries are all blank is an error asking for one, naming the filter, and keeps the project', async () => {
  const { worker, calls } = await start({ ...ORCA_OK }, { storage: jiraSettings('', [{ ...mine, queries: ['', ' '] }]) })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'error' && list.project?.id === 'github:acme/web')
  assert.match(list.message, /^Mine: Enter a JQL query/)
  assert.equal(list.filterId, 'f-mine')
  assert.equal(calls.some((call) => call.args[0] === 'jira'), false)
})

const sprint = { id: 'f-sprint', name: 'Sprint', queries: ['project = {{jira_project}} ORDER BY rank'] }

/** Stored settings of the web project on Jira (twg), with these filters and Jira project key. */
const twgSettings = (filters: { id: string; name: string; queries: string[] }[], jiraProjectKey?: string) => ({
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        provider: 'jira-twg',
        providers: { 'jira-twg': { site: '', profile: '' } },
        filters: { jira: filters },
        ...(jiraProjectKey !== undefined ? { jiraProjectKey } : {})
      }
    }
  }
})

test('a filter naming {{jira_project}} lists the tasks of the Jira project key, on its first page, its next pages and in a tracker search', async () => {
  const page = JSON.stringify({
    data: { issues: [{ key: 'WEB-7', summary: 'Dark mode', assignee: null, url: 'https://example.atlassian.net/browse/WEB-7' }] },
    pageInfo: { hasNextPage: true, nextCursor: 'cursor-2' }
  })
  const { worker, calls } = await start({ ...ORCA_OK, 'twg jira workitem': page }, { storage: twgSettings([sprint], 'WEB') })
  assert.equal((await worker.request('tasks.load', {})).kind, 'ready')
  assert.equal((await worker.request('tasks.load', { cursor: '0:cursor-2' })).kind, 'ready')
  assert.equal((await worker.request('tasks.load', { query: 'dark' })).kind, 'ready')
  const jqls = calls.filter((call) => call.tool === 'twg').map((call) => call.args[call.args.indexOf('--jql') + 1])
  assert.deepEqual(jqls, ['project = WEB ORDER BY rank', 'project = WEB ORDER BY rank', '(project = WEB) AND (text ~ "dark*") ORDER BY rank'])
})

test('without a Jira project key, a filter naming {{jira_project}} runs no query and asks for the key; a filter without it lists', async () => {
  const page = JSON.stringify({ data: { issues: [{ key: 'WEB-3', summary: 'Mine', assignee: null, url: 'https://example.atlassian.net/browse/WEB-3' }] } })
  const { worker, calls } = await start({ ...ORCA_OK, 'twg jira workitem': page }, { storage: twgSettings([sprint, mine]) })
  assert.deepEqual(await worker.request('tasks.load', {}), {
    kind: 'error',
    project: { id: 'github:acme/web', name: 'web', repo: 'acme/web' },
    message: 'This filter uses {{jira_project}}. Set the Jira project key in Project settings.',
    needsJiraProjectKey: true
  })
  assert.equal(calls.some((call) => call.tool === 'twg'), false)
  const listed = await worker.request('tasks.load', { filterId: 'f-mine' })
  assert.ok(listed.kind === 'ready')
  assert.deepEqual(listed.tasks.map((task) => task.key), ['WEB-3'])
})

test('a GitHub search naming {{jira_project}} runs as written, with or without a Jira project key', async () => {
  for (const jiraProjectKey of ['WEB', undefined]) {
    const triage = { id: 'f-triage', name: 'Triage', queries: ['label:{{jira_project}}'] }
    const project = { providers: {}, filters: { github: [triage] }, ...(jiraProjectKey ? { jiraProjectKey } : {}) }
    const { worker, calls } = await start({ ...ORCA_OK, 'gh issue list': GH_ISSUES }, { storage: { settings: { version: 1, projects: { 'github:acme/web': project } } } })
    assert.equal((await worker.request('tasks.load', {})).kind, 'ready')
    assert.deepEqual(calls.filter((call) => call.tool === 'gh').map((call) => call.args.at(-1)), ['(label:{{jira_project}}) is:open'])
  }
})

test("jira.sites answers the connected sites' ids and names, never email", async () => {
  const connection = wrap({
    connected: true,
    sites: [{ id: 'site-1', siteUrl: 'https://example.atlassian.net', displayName: 'Example', email: 'ana@example.com' }],
    viewer: { email: 'ana@example.com' }
  })
  const { worker, calls } = await start({ 'orca jira connection': connection })
  assert.deepEqual(await worker.request('jira.sites', {}), { kind: 'ready', sites: [{ id: 'site-1', name: 'Example' }] })
  assert.deepEqual(calls[0].args, ['jira', 'connection', '--json'])
})

test('jira.sites answers a failure as data', async () => {
  const { worker } = await start({ 'orca jira connection': new CliError('orca failed: Orca is not running.') })
  assert.deepEqual(await worker.request('jira.sites', {}), { kind: 'error', message: 'orca failed: Orca is not running.' })
})

const web12: Task = {
  tracker: 'jira',
  key: 'WEB-12',
  title: 'Añadir modo oscuro a ajustes',
  url: 'https://example.atlassian.net/browse/WEB-12',
  description: '',
  status: 'Por hacer',
  statusCategory: 'todo',
  assignees: [],
  labels: []
}

test('Start on Jira links the worktree with --reference <task URL>, never --issue', async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage: jiraSettings() })
  assert.deepEqual(await worker.request('task.start', { projectId: 'github:acme/web', task: web12, templateId: 'default' }), { ok: true, underWay: true })
  assert.deepEqual(creates(calls)[0].args, [
    'worktree', 'create', '--project', 'github:acme/web', '--name', 'web-12-anadir-modo-oscuro-a', '--no-parent', '--json',
    '--reference', 'https://example.atlassian.net/browse/WEB-12',
    '--agent', 'claude', '--prompt', 'Complete WEB-12: https://example.atlassian.net/browse/WEB-12'
  ])
})

test("a Start of a Jira task already linked in Orca doesn't run worktree create", async () => {
  const linked = {
    id: 'r1::/src/dark', projectId: 'github:acme/web', displayName: 'dark-mode', isArchived: false, linkedIssue: null,
    linkedItems: [{ provider: 'jira', type: 'issue', jiraIdentifier: 'WEB-12', url: 'https://example.atlassian.net/browse/WEB-12' }]
  }
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree list': worktreesWith(linked) }, { storage: jiraSettings() })
  assert.deepEqual(await worker.request('task.start', { projectId: 'github:acme/web', task: web12, templateId: 'default' }), { ok: true, underWay: false })
  assert.equal(creates(calls).length, 0)
})

test('worktrees.load answers the task worktrees of a project', async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree list': worktreesWith(started42) })
  assert.deepEqual(await worker.request('worktrees.load', { projectId: 'github:acme/web' }), {
    kind: 'ready',
    worktrees: { '#42': { worktreeId: 'r1::/src/web-42', name: 'issue-42-add-dark-mode', agent: null } }
  })
})

test('worktrees.load answers an error as data when Orca fails', async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree list': new CliError('orca failed: Orca is not running.') })
  assert.deepEqual(await worker.request('worktrees.load', { projectId: 'github:acme/web' }), {
    kind: 'error',
    message: 'orca failed: Orca is not running.'
  })
})

test("Start creates a linked worktree with Orca's default agent and the filled-in prompt", async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  const [create] = creates(calls)
  assert.deepEqual(create.args, [
    'worktree', 'create', '--project', 'github:acme/web', '--name', 'issue-42-add-dark-mode', '--no-parent', '--json',
    '--issue', '42', '--agent', 'claude', '--prompt', 'Complete #42: https://github.com/acme/web/issues/42'
  ])
  // The request doesn't wait for the create, so its limit is Orca's, not the panel's.
  assert.equal(create.timeoutMs, 600_000)
})

test("Start uses the project's template and agent choice, and no agent means no prompt", async () => {
  const storage = (agent: string) => ({
    settings: { version: 1, projects: { 'github:acme/web': { providers: {}, agent, template: 'Fix {{ task_title }} in {{repo}}' } } }
  })
  const codex = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage: storage('codex') })
  await codex.worker.request('task.start', startWeb42)
  assert.deepEqual(creates(codex.calls)[0].args.slice(-4), ['--agent', 'codex', '--prompt', 'Fix Add dark mode in acme/web'])

  const none = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage: storage('none') })
  await none.worker.request('task.start', startWeb42)
  const args = creates(none.calls)[0].args
  assert.ok(!args.includes('--agent') && !args.includes('--prompt'))
})

const twoTemplates = {
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        providers: {},
        templates: [
          { id: 't-impl', name: 'Implement', text: '/acme-skills:tdd {{task_url}}' },
          { id: 't-triage', name: 'Triage', text: 'Triage {{task_key}}' }
        ],
        defaultTemplateId: 't-impl'
      }
    }
  }
}

test("Start fills {{jira_project}} with the project's Jira project key, or with nothing without one", async () => {
  for (const [jiraProjectKey, prompt] of [['WEB', 'Fix #42 in WEB'], [undefined, 'Fix #42 in ']] as const) {
    const project = { providers: {}, template: 'Fix {{task_key}} in {{jira_project}}', ...(jiraProjectKey ? { jiraProjectKey } : {}) }
    const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage: { settings: { version: 1, projects: { 'github:acme/web': project } } } })
    await worker.request('task.start', startWeb42)
    assert.deepEqual(creates(calls)[0].args.slice(-2), ['--prompt', prompt])
  }
})

test('Start fills the prompt from the template it is given, not the default one', async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage: twoTemplates })
  assert.deepEqual(await worker.request('task.start', { ...startWeb42, templateId: 't-triage' }), { ok: true, underWay: true })
  assert.deepEqual(creates(calls)[0].args.slice(-2), ['--prompt', 'Triage #42'])
})

test("Start finds the chosen template among the global ones too, in a project with none of its own", async () => {
  const storage = {
    settings: {
      version: 1,
      projects: { 'github:acme/web': { providers: {} } },
      global: { templates: [{ id: 't-review', name: 'Review', text: 'Review {{task_key}} in {{repo}}' }] }
    }
  }
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage })
  assert.deepEqual(await worker.request('task.start', { ...startWeb42, templateId: 't-review' }), { ok: true, underWay: true })
  assert.deepEqual(creates(calls)[0].args.slice(-2), ['--prompt', 'Review #42 in acme/web'])
})

test('a Start of the initial template fails once a global template exists, since the project no longer lists it', async () => {
  const storage = {
    settings: { version: 1, projects: {}, global: { templates: [{ id: 't-review', name: 'Review', text: '' }] } }
  }
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: false, message: 'The prompt template you chose no longer exists — pick another one.' })
  assert.equal(creates(calls).length, 0)
})

test('a Start whose template no longer exists fails with a message and creates nothing', async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage: twoTemplates })
  assert.deepEqual(await worker.request('task.start', { ...startWeb42, templateId: 'default' }), {
    ok: false,
    message: 'The prompt template you chose no longer exists — pick another one.'
  })
  assert.equal(creates(calls).length, 0)
  assert.deepEqual(worker.posts, [])
})

test('Start of a project Orca no longer has fails in its answer, without creating anything', async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED })
  assert.deepEqual(await worker.request('task.start', { projectId: 'repo:gone', task: issue42, templateId: 'default' }), {
    ok: false,
    message: 'Orca has no project "repo:gone".'
  })
  assert.equal(creates(calls).length, 0)
  assert.deepEqual(worker.posts, [])
})

test("Start fails without creating anything when Orca's default agent can't be read", async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { defaultAgent: { kind: 'unreadable' } })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: false, message: AGENT_UNREADABLE })
  assert.equal(creates(calls).length, 0)
})

/** Waits until `done` holds, a millisecond at a time. */
async function until(done: () => boolean): Promise<void> {
  for (let tick = 0; tick < 500 && !done(); tick++) await new Promise((resolve) => setTimeout(resolve, 1))
}

/** A `worktree create` that answers only when the test calls `finish` or `fail`. */
function slowCreate() {
  const create = { finish: (_stdout: string) => {}, fail: (_error: Error) => {} }
  const answer = () =>
    new Promise<string>((resolve, reject) => {
      create.finish = resolve
      create.fail = reject
    })
  return { create, answer }
}

test('Start answers that it is under way before a slow worktree create ends, then posts the end', async () => {
  const { create, answer } = slowCreate()
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': answer })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  assert.equal(creates(calls).length, 1)
  assert.deepEqual(worker.posts, [])

  create.finish(CREATED)
  await until(() => worker.posts.length > 0)
  assert.deepEqual(worker.posts, [{ event: 'start.ended', payload: { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true } }])
})

test('the end of a Start with no agent says that no agent was passed', async () => {
  const storage = { settings: { version: 1, projects: { 'github:acme/web': { providers: {}, agent: 'none' } } } }
  const { worker } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage })
  await worker.request('task.start', startWeb42)
  assert.deepEqual(await nthEnd(worker), { projectId: 'github:acme/web', taskKey: '#42', agent: null, ok: true })
})

test("the task list and starts.load report the project's Starts under way until each create ends", async () => {
  const creates42 = slowCreate()
  const creates7 = slowCreate()
  const { worker, calls } = await start({
    ...ORCA_OK,
    'orca worktree create': (args) => (args.includes('42') ? creates42.answer() : creates7.answer()),
    'gh issue list': GH_ISSUES
  })
  const underWay = async () => {
    const list = await worker.request('tasks.load', {})
    const before = calls.length
    const starts = await worker.request('starts.load', { projectId: 'github:acme/web' })
    // The panel asks it every few seconds, so it runs no command.
    assert.equal(calls.length, before)
    assert.ok(list.kind === 'ready')
    assert.deepEqual(list.starting, starts.starting)
    return [...starts.starting].sort()
  }
  assert.deepEqual(await underWay(), [])
  await worker.request('task.start', startWeb42)
  await worker.request('task.start', { ...startWeb42, task: { ...issue42, key: '#7', url: 'https://github.com/acme/web/issues/7' } })
  assert.deepEqual(await underWay(), ['#42', '#7'])
  assert.deepEqual(await worker.request('starts.load', { projectId: 'repo:r2' }), { starting: [] })

  creates42.create.finish(CREATED)
  await until(() => worker.posts.length === 1)
  assert.deepEqual(await underWay(), ['#7'])
  creates7.create.fail(new CliError('orca failed: Pick a different worktree name'))
  await until(() => worker.posts.length === 2)
  assert.deepEqual(await underWay(), [])
})

test('a second Start, during the checks or the create of the first, answers under way and creates once', async () => {
  const { create, answer } = slowCreate()
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': answer })
  const together = await Promise.all([worker.request('task.start', startWeb42), worker.request('task.start', startWeb42)])
  assert.deepEqual(together, [{ ok: true, underWay: true }, { ok: true, underWay: true }])
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  assert.equal(creates(calls).length, 1)
  create.finish(CREATED)
  await until(() => worker.posts.length > 0)
  assert.equal(worker.posts.length, 1)
})

test("a Start of an already started task doesn't run worktree create", async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree list': worktreesWith(started42), 'orca worktree create': CREATED })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: false })
  assert.equal(creates(calls).length, 0)
  assert.deepEqual(worker.posts, [])
})

/** The `count`th Start end the worker posted, once it has. */
async function nthEnd(worker: { posts: readonly { event: string; payload?: unknown }[] }, count = 1): Promise<StartEnded> {
  await until(() => worker.posts.length >= count)
  const post = worker.posts[count - 1]
  assert.equal(post?.event, 'start.ended')
  return post.payload as StartEnded
}

test('a timed-out create posts a failed end, and the same task waits five minutes before creating again', async () => {
  let clock = 1_000_000
  const timeout = new CliError("orca didn't answer in time.", true)
  const { worker, calls, answer } = await start({ ...ORCA_OK, 'orca worktree create': timeout }, { now: () => clock })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  const ended = await nthEnd(worker)
  assert.equal(ended.taskKey, '#42')
  assert.equal(ended.projectId, 'github:acme/web')
  assert.ok(!ended.ok)
  assert.match(ended.message, /may still be creating/)

  answer({ ...ORCA_OK, 'orca worktree create': CREATED })
  clock += 4 * 60_000
  const waiting = await worker.request('task.start', startWeb42)
  assert.ok(!waiting.ok)
  assert.match(waiting.message, /wait/i)
  assert.equal(creates(calls).length, 1)

  clock += 61_000
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  assert.equal(creates(calls).length, 2)
  assert.deepEqual(await nthEnd(worker, 2), { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
})

test('a worktree Orca finished after a timeout counts as started', async () => {
  const timeout = new CliError("orca didn't answer in time.", true)
  const { worker, calls, answer } = await start({ ...ORCA_OK, 'orca worktree create': timeout })
  await worker.request('task.start', startWeb42)
  await nthEnd(worker)
  answer({ ...ORCA_OK, 'orca worktree list': worktreesWith(started42) })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: false })
  assert.equal(creates(calls).length, 1)
})

test('a Start whose end Orca refuses to post still ends: starts.load no longer reports it', async () => {
  const { create, answer } = slowCreate()
  const { worker } = await start({ ...ORCA_OK, 'orca worktree create': answer }, { postThrows: new Error('post refused') })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  assert.deepEqual(await worker.request('starts.load', { projectId: 'github:acme/web' }), { starting: ['#42'] })

  create.finish(CREATED)
  // A rejection nobody handles would fail the test while it waits here.
  await until(() => worker.logs.length > 0)
  assert.deepEqual(await worker.request('starts.load', { projectId: 'github:acme/web' }), { starting: [] })
  assert.deepEqual(worker.logs, ["Couldn't post the end of the Start of #42: post refused"])
})

test("a failed create posts a failed end with Orca's real message", async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree create': new CliError('orca failed: Pick a different worktree name') })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true, underWay: true })
  assert.deepEqual(await nthEnd(worker), {
    projectId: 'github:acme/web',
    taskKey: '#42',
    agent: 'claude',
    ok: false,
    message: 'orca failed: Pick a different worktree name'
  })
})

test('a prompt over the limit fails Start without creating anything', async () => {
  const storage = { settings: { version: 1, projects: { 'github:acme/web': { providers: {}, template: '{{task_description}}'.repeat(8) } } } }
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage })
  const result = await worker.request('task.start', { ...startWeb42, task: { ...issue42, description: 'x'.repeat(5000) } })
  assert.ok(!result.ok)
  assert.match(result.message, /30000/)
  assert.equal(creates(calls).length, 0)
})

test('worktree.open activates the worktree in Orca', async () => {
  const { worker, calls } = await start({ 'orca worktree activate': wrap({ worktree: { id: 'r1::/src/web-42' } }) })
  assert.deepEqual(await worker.request('worktree.open', { worktreeId: 'r1::/src/web-42' }), { ok: true })
  assert.deepEqual(calls.map((call) => call.args), [['worktree', 'activate', '--worktree', 'id:r1::/src/web-42', '--json']])
})

test('worktree.open answers a failure as data', async () => {
  const { worker } = await start({ 'orca worktree activate': new CliError('orca failed: No worktree matches.') })
  assert.deepEqual(await worker.request('worktree.open', { worktreeId: 'gone' }), { ok: false, message: 'orca failed: No worktree matches.' })
})
