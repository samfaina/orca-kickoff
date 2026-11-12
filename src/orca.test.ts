import { assert, test } from 'orca/testing'
import {
  checkOrcaAnswer,
  findActiveProject,
  findTaskWorktrees,
  parseProjects,
  parseWorktreePs,
  parseWorktrees,
  worktreeActivateArgs,
  worktreeCreateArgs
} from './orca'

const wrap = (result: unknown) => JSON.stringify({ id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt-1' } })

const projectList = wrap({
  projects: [
    {
      id: 'github:acme/web',
      displayName: 'web',
      kind: 'git',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'web' },
      gitRemoteIdentity: { canonicalKey: 'github.com/acme/web', remoteName: 'origin', remoteUrl: 'https://github.com/acme/web.git' },
      sourceRepoIds: ['repo-1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    },
    {
      id: 'git:gitlab.example.com/acme/api',
      displayName: 'api',
      kind: 'git',
      gitRemoteIdentity: { canonicalKey: 'gitlab.example.com/acme/api', remoteName: 'origin', remoteUrl: '...' }
    },
    { id: 'repo:repo-3', displayName: 'notes', kind: 'folder' },
    {
      id: 'github:github.acme.example/platform/billing',
      displayName: 'billing',
      providerIdentity: { provider: 'github', owner: 'platform', repo: 'billing', host: 'github.acme.example' }
    },
    { displayName: 'no id' }
  ]
})

test('projects keep their Orca id and name, with the GitHub repo when there is one', () => {
  assert.deepEqual(parseProjects(projectList), [
    { id: 'github:acme/web', name: 'web', repo: 'acme/web' },
    { id: 'git:gitlab.example.com/acme/api', name: 'api', repo: null },
    { id: 'repo:repo-3', name: 'notes', repo: null },
    { id: 'github:github.acme.example/platform/billing', name: 'billing', repo: 'github.acme.example/platform/billing' }
  ])
})

const worktreeList = wrap({
  worktrees: [
    { id: 'repo-1::C:/src/web', projectId: 'github:acme/web', displayName: 'web', branch: 'refs/heads/main', isArchived: false, isMainWorktree: true, linkedIssue: null, linkedWorkItem: null, linkedItems: [] },
    { id: 'repo-3::C:/src/notes', projectId: 'repo:repo-3', displayName: 'notes', branch: null, isArchived: false, isMainWorktree: true, linkedIssue: null, linkedWorkItem: null, linkedItems: [] }
  ],
  totalCount: 2,
  truncated: false,
  hostScope: 'local'
})

const ps = (activeId: string | null) =>
  wrap({
    worktrees: [
      { worktreeId: 'repo-1::C:/src/web', isActive: activeId === 'repo-1::C:/src/web', displayName: 'web', branch: 'main', repo: 'web', status: 'idle', linkedIssue: null, agents: [] },
      { worktreeId: 'repo-3::C:/src/notes', isActive: activeId === 'repo-3::C:/src/notes', displayName: 'notes', branch: null, repo: 'notes', status: 'idle', linkedIssue: null, agents: [{ agentType: 'claude', state: 'working', paneKey: 'p1', prompt: '', mainAgent: true }] }
    ]
  })

test('the active project is the project of the active worktree', () => {
  const projects = parseProjects(projectList)
  const worktrees = parseWorktrees(worktreeList)
  assert.deepEqual(findActiveProject(projects, worktrees, parseWorktreePs(ps('repo-3::C:/src/notes'))), {
    id: 'repo:repo-3',
    name: 'notes',
    repo: null
  })
})

test('with no active worktree there is no active project', () => {
  const projects = parseProjects(projectList)
  const worktrees = parseWorktrees(worktreeList)
  assert.equal(findActiveProject(projects, worktrees, parseWorktreePs(ps(null))), null)
})

test('an error answer from Orca throws its message', () => {
  const stdout = JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'Orca is not running.' } })
  assert.throws(() => parseProjects(stdout), /orca failed: Orca is not running\./)
})

test('output that is not Orca JSON throws a readable message', () => {
  assert.throws(() => parseWorktrees('Usage: orca worktree list'), /orca returned output Kickoff couldn't read/)
})

const taskWorktreeList = wrap({
  worktrees: [
    // Linked to WEB-12 through Orca, renamed since.
    { id: 'r1::/w/renamed', projectId: 'git:example/web', displayName: 'my dark mode', isArchived: false, linkedIssue: null, linkedItems: [
      { provider: 'jira', type: 'issue', number: 0, identifier: 'WEB-12', jiraIdentifier: 'web-12', url: 'https://example.atlassian.net/browse/WEB-12' }
    ] },
    // Linked by name only.
    { id: 'r1::/w/web-7-fix-login', projectId: 'git:example/web', displayName: 'web-7-fix-login', isArchived: false, linkedIssue: null, linkedItems: [] },
    // Archived: doesn't count.
    { id: 'r1::/w/web-8-old', projectId: 'git:example/web', displayName: 'web-8-old', isArchived: true, linkedIssue: null, linkedItems: [] },
    // Another project's: doesn't count.
    { id: 'r2::/w/web-9-other', projectId: 'git:example/api', displayName: 'web-9-other', isArchived: false, linkedIssue: null, linkedItems: [] },
    // The main worktree: not a task name.
    { id: 'r1::/w/main', projectId: 'git:example/web', displayName: 'main', isArchived: false, linkedIssue: null, linkedItems: [] }
  ]
})

const taskPs = wrap({
  worktrees: [
    { worktreeId: 'r1::/w/renamed', isActive: false, agents: [
      { agentType: 'codex', state: 'working', paneKey: 'p2', prompt: '', mainAgent: false },
      { agentType: 'claude', state: 'working', paneKey: 'p1', prompt: '', mainAgent: true }
    ] },
    { worktreeId: 'r1::/w/web-7-fix-login', isActive: true, agents: [] }
  ]
})

test('Jira task worktrees come from linkedItems, case-insensitive, or the name prefix, with their agent', () => {
  const worktrees = findTaskWorktrees('jira', 'git:example/web', parseWorktrees(taskWorktreeList), parseWorktreePs(taskPs))
  assert.deepEqual(worktrees, {
    'WEB-12': { worktreeId: 'r1::/w/renamed', name: 'my dark mode', agent: 'claude' },
    'WEB-7': { worktreeId: 'r1::/w/web-7-fix-login', name: 'web-7-fix-login', agent: null }
  })
})

test("GitHub task worktrees count through linkedIssue or linkedItems, even renamed", () => {
  const list = wrap({
    worktrees: [
      { id: 'a', projectId: 'github:acme/web', displayName: 'renamed one', isArchived: false, linkedIssue: 42, linkedItems: [] },
      { id: 'b', projectId: 'github:acme/web', displayName: 'renamed two', isArchived: false, linkedIssue: null, linkedItems: [
        { provider: 'github', type: 'issue', number: 7, url: 'https://github.com/acme/web/issues/7' },
        { provider: 'github', type: 'pr', number: 99, url: 'https://github.com/acme/web/pull/99' }
      ] },
      { id: 'c', projectId: 'github:acme/web', displayName: 'issue-5-by-hand', isArchived: false, linkedIssue: null },
      // A Jira-shaped name means nothing on GitHub.
      { id: 'd', projectId: 'github:acme/web', displayName: 'web-12-x', isArchived: false, linkedIssue: null, linkedItems: [] }
    ]
  })
  const worktrees = findTaskWorktrees('github', 'github:acme/web', parseWorktrees(list), [])
  assert.deepEqual(worktrees, {
    '#42': { worktreeId: 'a', name: 'renamed one', agent: null },
    '#7': { worktreeId: 'b', name: 'renamed two', agent: null },
    '#5': { worktreeId: 'c', name: 'issue-5-by-hand', agent: null }
  })
})

test("a worktree linked through Orca wins over another that only has the task's name", () => {
  const list = wrap({
    worktrees: [
      { id: 'by-name', projectId: 'github:acme/web', displayName: 'issue-42-add-dark-mode', isArchived: false, linkedIssue: null },
      { id: 'linked', projectId: 'github:acme/web', displayName: 'dark mode', isArchived: false, linkedIssue: 42 }
    ]
  })
  assert.equal(findTaskWorktrees('github', 'github:acme/web', parseWorktrees(list), [])['#42']?.worktreeId, 'linked')
})

const githubTask = { tracker: 'github' as const, key: '#42', url: 'https://github.com/acme/web/issues/42' }
const jiraTask = { tracker: 'jira' as const, key: 'WEB-12', url: 'https://example.atlassian.net/browse/WEB-12' }

test('worktree create carries --issue on GitHub, never --reference', () => {
  const args = worktreeCreateArgs({ projectId: 'github:acme/web', name: 'issue-42-add-dark-mode', task: githubTask, agent: 'claude', prompt: 'Complete #42' })
  assert.deepEqual(args, [
    'worktree', 'create', '--project', 'github:acme/web', '--name', 'issue-42-add-dark-mode', '--no-parent', '--json',
    '--issue', '42', '--agent', 'claude', '--prompt', 'Complete #42'
  ])
})

test('worktree create carries --reference <url> on Jira, never --issue', () => {
  const args = worktreeCreateArgs({ projectId: 'git:example/web', name: 'web-12-add-dark-mode', task: jiraTask, agent: 'codex', prompt: 'Go' })
  assert.deepEqual(args, [
    'worktree', 'create', '--project', 'git:example/web', '--name', 'web-12-add-dark-mode', '--no-parent', '--json',
    '--reference', 'https://example.atlassian.net/browse/WEB-12', '--agent', 'codex', '--prompt', 'Go'
  ])
  assert.ok(!args.includes('--issue'))
})

test('worktree create has no --agent or --prompt when the agent choice is none', () => {
  const args = worktreeCreateArgs({ projectId: 'git:example/web', name: 'web-12', task: jiraTask, agent: null, prompt: 'ignored' })
  assert.ok(!args.includes('--agent'))
  assert.ok(!args.includes('--prompt'))
  assert.ok(!args.includes('ignored'))
})

test('worktree activate selects the worktree by id', () => {
  assert.deepEqual(worktreeActivateArgs('r1::/w/web'), ['worktree', 'activate', '--worktree', 'id:r1::/w/web', '--json'])
})

test('an answer from worktree create is checked for errors', () => {
  checkOrcaAnswer(wrap({ worktree: { id: 'x' } }))
  assert.throws(
    () => checkOrcaAnswer(JSON.stringify({ ok: false, error: { code: 'invalid_argument', message: 'Pick a different worktree name' } })),
    /orca failed: Pick a different worktree name/
  )
})
