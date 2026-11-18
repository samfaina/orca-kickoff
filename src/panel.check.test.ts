// Each check scenario draws the state it is named after, with no panel issue, and answers every
// panel request itself: a request a scenario leaves out goes to the real worker, which would run
// the real `orca`, `gh` and `twg` and show real data.
import { afterEach, assert, mockHost, mount, test, type CheckScenario, type TestPanel } from 'orca/testing'
import type { PluginRequests } from 'orca'
import scenarios from './panel.check.ts'
import * as panel from './panel'

/** The views the running test mounted. A view left mounted keeps the panel's poll running, and
 *  then `orca plugin test` never exits (see src/panel.test.tsx). */
const views: TestPanel[] = []

afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount()
})

async function render(name: string): Promise<TestPanel> {
  const scenario: CheckScenario | undefined = (scenarios as Record<string, CheckScenario>)[name]
  assert.ok(scenario, `no scenario "${name}"`)
  const { persisted, theme, events = [], ...host } = scenario
  const view = await mount(panel, { host: mockHost(host), persisted, theme })
  views.push(view)
  for (const { event, payload } of events) await view.emit(event as 'workspace.changed', payload as never)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  return view
}

/** Every request the panel can make: the type check fails when `PluginRequests` (src/protocol.ts)
 *  gains one that isn't listed here. */
const PANEL_REQUESTS = Object.keys({
  'tasks.load': true,
  'worktrees.load': true,
  'project.active': true,
  'jira.sites': true,
  'task.start': true,
  'starts.load': true,
  'worktree.open': true
} satisfies Record<keyof PluginRequests, true>)

test('every scenario answers every panel request, so none reaches the real worker', () => {
  for (const [name, scenario] of Object.entries(scenarios as Record<string, CheckScenario>)) {
    const missing = PANEL_REQUESTS.filter((request) => !(request in (scenario.requests ?? {})))
    assert.deepEqual(missing, [], `scenario "${name}"`)
  }
})

test('no-project says no project is selected', async () => {
  const shown = await render('no-project')
  assert.ok(shown.find({ text: /No project selected/ }))
})

test('needs-config opens Project settings with a tracker to choose', async () => {
  const shown = await render('needs-config')
  assert.ok(shown.find({ type: 'Heading', text: 'Project settings' }))
  assert.equal(shown.valueOf({ label: 'Tracker' }), ':none')
})

test('github-ready lists the issues of a GitHub project, each with Start, with one assignee, several or none', async () => {
  const shown = await render('github-ready')
  assert.ok(shown.find({ type: 'Heading', text: 'web' }))
  const starts = shown.findAll({ role: 'button', label: /^Start #/ })
  assert.ok(starts.length >= 3, `${starts.length} Start buttons`)
  assert.ok(starts.every((start) => !start.disabled))
  assert.equal(shown.find({ role: 'button', text: /Load more/ }), null)
  assert.ok(shown.find({ type: 'Text', text: 'Assignee: octocat' }))
  assert.ok(shown.find({ type: 'Text', text: 'Assignees: octocat, hubot' }))
  assert.equal(shown.findAll({ type: 'Text', text: /^Assignees?:/ }).length, 2)
})

test('jira-started shows started tasks with their worktree and agent, one starting, and Load more', async () => {
  const shown = await render('jira-started')
  assert.ok(shown.find({ text: 'Agent: claude' }))
  assert.ok(shown.find({ type: 'Text', text: 'Assignee: Ana Example' }))
  assert.ok(shown.find({ label: /^Starting WEB-/ }))
  assert.ok(shown.find({ role: 'button', text: /^Showing \d+ · Load more$/ }))
  // Two templates or more give each card that can start a template Select.
  assert.ok(shown.findAll({ type: 'Select' }).length > 0)
  const starts = shown.findAll({ role: 'button', label: /^Start WEB-/ })
  assert.ok(starts.length > 0 && starts.every((start) => !start.disabled))
})

test('truncated ends the list with the truncation notice', async () => {
  const shown = await render('truncated')
  assert.ok(shown.find({ text: /^Showing the first 100 tasks — narrow your JQL/ }))
})

test('tracker-error opens Project settings on the tracker that failed', async () => {
  const shown = await render('tracker-error')
  assert.ok(shown.find({ type: 'Heading', text: 'Project settings' }))
  assert.equal(shown.valueOf({ label: 'Tracker' }), 'jira-twg')
  assert.ok(shown.find({ label: 'JQL' }))
})

test('jira-queries shows each JQL query with its Remove button, adds and removes queries, and Ctrl+Enter lists the tasks', async () => {
  const shown = await render('jira-queries')
  const labels = () => shown.findAll({ type: 'Textarea', label: /^JQL/ }).map((field) => field.label)
  const removable = () => shown.findAll({ type: 'IconButton', label: /^Remove JQL/ }).map((button) => button.label)
  assert.deepEqual(labels(), ['JQL', 'JQL 2', 'JQL 3'])
  assert.deepEqual(removable(), ['Remove JQL', 'Remove JQL 2', 'Remove JQL 3'])
  assert.equal(shown.valueOf({ type: 'Textarea', label: 'JQL 2' }), 'project = WEB AND labels = ui\nORDER BY rank')

  await shown.press({ type: 'IconButton', label: 'Remove JQL 3' })
  await shown.press({ type: 'IconButton', label: 'Remove JQL' })
  assert.deepEqual(labels(), ['JQL'])
  assert.deepEqual(removable(), [])
  await shown.press({ type: 'IconButton', label: 'Add query' })
  assert.deepEqual(labels(), ['JQL', 'JQL 2'])
  assert.deepEqual(removable(), ['Remove JQL', 'Remove JQL 2'])

  const loads = () => shown.host.calls.filter((call) => JSON.stringify(call.params ?? null).includes('tasks.load')).length
  const before = loads()
  await shown.submit({ type: 'Textarea', label: 'JQL 2' })
  assert.equal(loads(), before + 1)
  assert.ok(shown.find({ type: 'Heading', text: 'Project settings' }))
  assert.deepEqual(shown.errors, [])
})

test('orca-error shows the message of an Orca CLI that fails before any project is known', async () => {
  const shown = await render('orca-error')
  assert.ok(shown.find({ text: /^Couldn't load tasks/ }))
  assert.ok(shown.find({ text: /Couldn't find the Orca CLI/ }))
})

test('worktrees-unavailable lists the tasks with a warning and every Start off', async () => {
  const shown = await render('worktrees-unavailable')
  assert.ok(shown.find({ text: /^Couldn't read Orca's worktrees, so Start is off\./ }))
  const starts = shown.findAll({ role: 'button', label: /^Start #/ })
  assert.ok(starts.length > 0 && starts.every((start) => start.disabled))
})
