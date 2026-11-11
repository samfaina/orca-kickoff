import { assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import type { Task, TaskList } from './protocol'
import * as panel from './panel'

const web = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

const task = (key: string, fields: Partial<Task> = {}): Task => ({
  tracker: 'github',
  key,
  title: `Task ${key}`,
  url: `https://github.com/acme/web/issues/${key.slice(1)}`,
  description: '',
  status: 'Open',
  statusCategory: 'todo',
  assignees: [],
  labels: [],
  ...fields
})

const ready = (tasks: Task[], fields: Partial<Extract<TaskList, { kind: 'ready' }>> = {}): TaskList => ({
  kind: 'ready',
  project: web,
  provider: 'github',
  tasks,
  nextCursor: null,
  truncated: false,
  worktrees: {},
  worktreesError: null,
  warning: null,
  ...fields
})

async function show(answer: TaskList | ((input: { cursor?: string }) => TaskList | Promise<TaskList>)) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'tasks.load': answer } })
  return mount(panel, { host })
}

test("lists the project's open issues with their key, title and labels", async () => {
  const view = await show(ready([task('#42', { title: 'Add dark mode', labels: ['ui', 'good first issue'] }), task('#7')]))
  const link = view.find({ type: 'Link', text: '#42' })
  assert.ok(link)
  assert.equal(link.props.href, 'https://github.com/acme/web/issues/42')
  assert.ok(view.find({ type: 'Text', text: /Add dark mode/ }))
  assert.ok(view.find({ type: 'Badge', text: 'good first issue' }))
  assert.equal(view.findAll({ type: 'Badge', text: 'Open' }).length, 0)
  assert.ok(view.find({ type: 'Link', text: '#7' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows the status of tasks outside GitHub', async () => {
  const jira = task('WEB-12', { tracker: 'jira', url: 'https://example.atlassian.net/browse/WEB-12', status: 'In Progress' })
  const view = await show(ready([jira], { provider: 'jira-twg' }))
  assert.ok(view.find({ type: 'Badge', text: 'In Progress' }))
  await view.unmount()
})

test('shows a spinner until the first list arrives', async () => {
  // The component alone, without `setup`, is the panel before its first answer.
  const before = await mount(panel.default, { host: mockHost({ capabilities: ['storage:own', 'workspace:read'] }) })
  assert.ok(before.find({ type: 'Spinner', label: 'Loading tasks' }))
  await before.unmount()

  const after = await show(ready([task('#1')]))
  assert.equal(after.find({ type: 'Spinner', label: 'Loading tasks' }), null)
  await after.unmount()
})

test('keeps the list and shows a spinner while it reloads', async () => {
  let calls = 0
  let whileReloading: { list: boolean; spinner: boolean } | null = null
  const view: TestPanel = await show(async () => {
    if (++calls === 2) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      whileReloading = {
        list: view.find({ type: 'Link', text: '#1' }) !== null,
        spinner: view.find({ type: 'Spinner', label: 'Reloading tasks' }) !== null
      }
    }
    return ready([task(`#${calls}`)])
  })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.deepEqual(whileReloading, { list: true, spinner: true })
  assert.equal(view.find({ type: 'Spinner', label: 'Reloading tasks' }), null)
  await view.unmount()
})

test('says when no project is selected', async () => {
  const view = await show({ kind: 'no-project' })
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No project selected')
  await view.unmount()
})

test('says when the project has no tracker, without an error', async () => {
  const view = await show({ kind: 'needs-config', project: { id: 'repo:r1', name: 'notes', repo: null } })
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No tracker for this project')
  assert.equal(view.find({ type: 'Callout' }), null)
  await view.unmount()
})

test('says when there are no open tasks', async () => {
  const view = await show(ready([]))
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No open tasks')
  await view.unmount()
})

test("shows the tool's real message when loading fails", async () => {
  const message = "Couldn't find the GitHub CLI (gh). Install it from https://cli.github.com, then run `gh auth login`."
  const view = await show({ kind: 'error', project: web, message })
  const callout = view.find({ type: 'Callout' })
  assert.ok(callout)
  assert.match(callout.text, /gh auth login/)
  await view.unmount()
})

test("says so when Kickoff's worker doesn't answer", async () => {
  const view = await show(() => {
    throw hostError('timeout', 'Request timed out')
  })
  const callout = view.find({ type: 'Callout' })
  assert.ok(callout)
  assert.match(callout.text, /timeout/)
  await view.unmount()
})

test('shows a warning next to the list', async () => {
  const view = await show(ready([task('#1')], { warning: 'Using the last known project (web). orca failed: Orca is not running.' }))
  assert.match(view.find({ type: 'Callout' })?.text ?? '', /Orca is not running/)
  assert.ok(view.find({ type: 'Link', text: '#1' }))
  await view.unmount()
})

test('a truncated list says only the first 100 are shown', async () => {
  const github = await show(ready([task('#1')], { truncated: true }))
  assert.ok(github.find({ type: 'Text', text: "Showing the first 100 of your repository's issues." }))
  await github.unmount()

  const jira = await show(ready([task('WEB-1', { tracker: 'jira' })], { provider: 'jira-orca', truncated: true }))
  assert.ok(jira.find({ type: 'Text', text: 'Showing the first 100 tasks — narrow your JQL.' }))
  await jira.unmount()
})

test('reloads when the workspace changes, and on Reload', async () => {
  let calls = 0
  const view = await show(() => ready([task(`#${++calls}`)]))
  assert.ok(view.find({ type: 'Link', text: '#1' }))

  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  assert.ok(view.find({ type: 'Link', text: '#2' }))

  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.ok(view.find({ type: 'Link', text: '#3' }))
  await view.unmount()
})

test('a response that arrives after a newer request is dropped', async () => {
  let calls = 0
  const view: TestPanel = await show(async () => {
    calls++
    if (calls === 2) {
      // The workspace changes while this answer is still on its way.
      void view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return ready([task('#20')])
    }
    return ready([task(`#${calls}`)])
  })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  await view.settled()

  assert.equal(calls, 3)
  assert.ok(view.find({ type: 'Link', text: '#3' }))
  assert.equal(view.find({ type: 'Link', text: '#20' }), null)
  await view.unmount()
})
