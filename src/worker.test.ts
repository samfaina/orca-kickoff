import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca'
import { AGENT_UNREADABLE, type DefaultAgent } from './agent'
import { CliError, cliFailureMessage, type RunCli } from './cli'
import type { Task } from './protocol'
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

type StartOptions = { storage?: Record<string, JsonValue>; defaultAgent?: DefaultAgent; now?: () => number }

async function start(answers: Record<string, Answer>, options: StartOptions = {}) {
  const { storage = {}, defaultAgent = { kind: 'agent', agent: 'claude' }, now = Date.now } = options
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], storage })
  const calls: Call[] = []
  let run = fakeRun(answers, calls)
  const worker = await mountWorker(
    { default: (orca) => activateWith(orca, { run: (...args) => run(...args), readDefaultAgent: async () => defaultAgent, now }) },
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

const startWeb42 = { projectId: 'github:acme/web', task: issue42 }

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
    worktrees: {},
    worktreesError: null,
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
    projects: { 'github:acme/web': { provider: 'jira-twg', providers: { 'jira-twg': { jql: 'project = WEB', site: '', profile: 'work' } } } }
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
  assert.equal(first.nextCursor, 'cursor-2')

  const second = await worker.request('tasks.load', { cursor: 'cursor-2' })
  assert.ok(second.kind === 'ready')
  assert.deepEqual(second.tasks.map((task) => task.key), ['WEB-2'])
  assert.equal(second.nextCursor, null)
  const twgCalls = calls.filter((call) => call.tool === 'twg')
  assert.equal(twgCalls.length, 2)
  assert.deepEqual(twgCalls[0].args.slice(-2), ['--profile', 'work'])
  assert.deepEqual(twgCalls[1].args.slice(-4), ['--profile', 'work', '--after', 'cursor-2'])
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

test('the requests not built yet answer with data instead of throwing', async () => {
  const { worker } = await start({})
  const active = await worker.request('project.active', {})
  assert.ok('kind' in active && active.kind === 'error')
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

const jiraSettings = (siteId = '') => ({
  settings: { version: 1, projects: { 'github:acme/web': { provider: 'jira-orca', providers: { 'jira-orca': { jql: 'project = WEB', siteId } } } } }
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

test('a blank JQL is an error asking for one, and keeps the project so the settings stay', async () => {
  const settings = { version: 1, projects: { 'github:acme/web': { provider: 'jira-orca', providers: { 'jira-orca': { jql: '', siteId: '' } } } } }
  const { worker, calls } = await start({ ...ORCA_OK }, { storage: { settings } })
  const list = await worker.request('tasks.load', {})
  assert.ok(list.kind === 'error' && list.project?.id === 'github:acme/web')
  assert.match(list.message, /Enter a JQL query/)
  assert.equal(calls.some((call) => call.args[0] === 'jira'), false)
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
  assert.deepEqual(await worker.request('task.start', { projectId: 'github:acme/web', task: web12 }), { ok: true })
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
  assert.deepEqual(await worker.request('task.start', { projectId: 'github:acme/web', task: web12 }), { ok: true })
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
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true })
  const [create] = creates(calls)
  assert.deepEqual(create.args, [
    'worktree', 'create', '--project', 'github:acme/web', '--name', 'issue-42-add-dark-mode', '--no-parent', '--json',
    '--issue', '42', '--agent', 'claude', '--prompt', 'Complete #42: https://github.com/acme/web/issues/42'
  ])
  assert.equal(create.timeoutMs, 110_000)
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

test("Start fails without creating anything when Orca's default agent can't be read", async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { defaultAgent: { kind: 'unreadable' } })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: false, message: AGENT_UNREADABLE })
  assert.equal(creates(calls).length, 0)
})

test('two simultaneous Starts of the same task create one worktree', async () => {
  let finish: (stdout: string) => void = () => {}
  const { worker, calls } = await start({
    ...ORCA_OK,
    'orca worktree create': () => new Promise<string>((resolve) => (finish = resolve))
  })
  const first = worker.request('task.start', startWeb42)
  const second = worker.request('task.start', startWeb42)
  for (let tick = 0; tick < 500 && creates(calls).length === 0; tick++) await new Promise((resolve) => setTimeout(resolve, 1))
  finish(CREATED)
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }])
  assert.equal(creates(calls).length, 1)
})

test("a Start of an already started task doesn't run worktree create", async () => {
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree list': worktreesWith(started42), 'orca worktree create': CREATED })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true })
  assert.equal(creates(calls).length, 0)
})

test('after a timed-out Start, the same task waits five minutes before creating again', async () => {
  let clock = 1_000_000
  const timeout = new CliError("orca didn't answer in time.", true)
  const { worker, calls, answer } = await start({ ...ORCA_OK, 'orca worktree create': timeout }, { now: () => clock })
  const failed = await worker.request('task.start', startWeb42)
  assert.ok(!failed.ok)
  assert.match(failed.message, /may still be creating/)

  answer({ ...ORCA_OK, 'orca worktree create': CREATED })
  clock += 4 * 60_000
  const waiting = await worker.request('task.start', startWeb42)
  assert.ok(!waiting.ok)
  assert.match(waiting.message, /wait/i)
  assert.equal(creates(calls).length, 1)

  clock += 61_000
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true })
  assert.equal(creates(calls).length, 2)
})

test('a worktree Orca finished after a timeout counts as started', async () => {
  const timeout = new CliError("orca didn't answer in time.", true)
  const { worker, calls, answer } = await start({ ...ORCA_OK, 'orca worktree create': timeout })
  await worker.request('task.start', startWeb42)
  answer({ ...ORCA_OK, 'orca worktree list': worktreesWith(started42) })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: true })
  assert.equal(creates(calls).length, 1)
})

test("Start answers Orca's real message when worktree create fails", async () => {
  const { worker } = await start({ ...ORCA_OK, 'orca worktree create': new CliError('orca failed: Pick a different worktree name') })
  assert.deepEqual(await worker.request('task.start', startWeb42), { ok: false, message: 'orca failed: Pick a different worktree name' })
})

test('a prompt over the limit fails Start without creating anything', async () => {
  const storage = { settings: { version: 1, projects: { 'github:acme/web': { providers: {}, template: '{{task_description}}'.repeat(8) } } } }
  const { worker, calls } = await start({ ...ORCA_OK, 'orca worktree create': CREATED }, { storage })
  const result = await worker.request('task.start', { projectId: 'github:acme/web', task: { ...issue42, description: 'x'.repeat(5000) } })
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
