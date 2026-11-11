import { assert, test } from 'orca/testing'
import { findActiveProject, parseProjects, parseWorktreePs, parseWorktrees } from './orca'

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
