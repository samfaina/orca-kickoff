import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as worker from './worker'

test('every request answers with data instead of throwing while still stubbed', async () => {
  const mounted = await mountWorker(worker, { host: mockHost({ capabilities: ['storage:own', 'workspace:read'] }) })
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

  assert.equal((await mounted.request('tasks.load', {})).kind, 'error')
  assert.equal((await mounted.request('worktrees.load', { projectId: 'github:acme/web' })).kind, 'error')
  const active = await mounted.request('project.active', {})
  assert.ok('kind' in active && active.kind === 'error')
  assert.equal((await mounted.request('jira.sites', {})).kind, 'error')
  assert.equal((await mounted.request('task.start', { projectId: 'github:acme/web', task })).ok, false)
  assert.equal((await mounted.request('worktree.open', { worktreeId: 'repo::path' })).ok, false)
  assert.deepEqual(mounted.refusals, [])
  await mounted.deactivate()
})
