import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { JsonValue } from 'orca'
import { CliError, cliFailureMessage, type RunCli } from './cli'
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

type Answer = string | Error

/** Answers each `<tool> <subcommand> <subcommand>` with stdout, or rejects with an error. */
function fakeRun(answers: Record<string, Answer>): RunCli {
  return async (tool, args) => {
    const answer = answers[[tool, ...args.slice(0, 2)].join(' ')]
    if (answer === undefined) throw new CliError(`unexpected call: ${tool} ${args.join(' ')}`)
    if (answer instanceof Error) throw answer
    return answer
  }
}

async function start(answers: Record<string, Answer>, storage: Record<string, JsonValue> = {}) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], storage })
  let run = fakeRun(answers)
  const worker = await mountWorker({ default: (orca) => activateWith(orca, { run: (...args) => run(...args) }) }, { host })
  return { worker, answer: (next: Record<string, Answer>) => (run = fakeRun(next)) }
}

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

test('a provider this version cannot read yet is an error that keeps the project', async () => {
  const settings = { version: 1, projects: { 'github:acme/web': { provider: 'jira-twg', providers: {} } } }
  const { worker } = await start({ ...ORCA_OK }, { settings })
  const list = await worker.request('tasks.load', {})
  assert.equal(list.kind, 'error')
  assert.ok(list.kind === 'error' && list.project?.id === 'github:acme/web')
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
})

test('the requests not built yet answer with data instead of throwing', async () => {
  const { worker } = await start({})
  const task = {
    tracker: 'jira' as const,
    key: 'WEB-12',
    title: 'Add dark mode to settings',
    url: 'https://example.atlassian.net/browse/WEB-12',
    description: '',
    status: 'To Do',
    statusCategory: 'todo' as const,
    assignees: [],
    labels: []
  }
  assert.equal((await worker.request('worktrees.load', { projectId: 'github:acme/web' })).kind, 'error')
  const active = await worker.request('project.active', {})
  assert.ok('kind' in active && active.kind === 'error')
  assert.equal((await worker.request('jira.sites', {})).kind, 'error')
  assert.equal((await worker.request('task.start', { projectId: 'github:acme/web', task })).ok, false)
  assert.equal((await worker.request('worktree.open', { worktreeId: 'repo::path' })).ok, false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
