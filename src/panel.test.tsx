import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows an empty state that names what Kickoff does', async () => {
  const view = await mount(panel, { host: mockHost({ capabilities: ['storage:own', 'workspace:read'] }) })
  const empty = view.find({ type: 'EmptyState' })
  assert.ok(empty)
  assert.equal(empty.label, 'Kickoff')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
