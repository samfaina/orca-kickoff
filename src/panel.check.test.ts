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
  'linear.choices': true,
  'agents.load': true,
  'task.start': true,
  'task.runHere': true,
  'starts.load': true,
  'worktree.open': true,
  'about.load': true
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

test('available-agents opens Project settings with Codex chosen among Orca default named after Claude, the three available agents, and No agent', async () => {
  const shown = await render('available-agents')
  assert.ok(shown.find({ type: 'Heading', text: 'Project settings' }))
  const options = shown.find({ type: 'Select', label: 'Agent' })?.props.options as { label: string }[]
  assert.deepEqual(options.map((option) => option.label), ['Orca default (Claude)', 'Claude', 'Codex', 'GitHub Copilot', 'No agent'])
  assert.equal(shown.valueOf({ type: 'Select', label: 'Agent' }), 'codex')
  assert.equal(shown.find({ type: 'Text', text: "Couldn't read Orca's agents." }), null)
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

test("global-templates offers the project's own template, then the global ones marked Global, with a global one as the default", async () => {
  const shown = await render('global-templates')
  const [select] = shown.findAll({ type: 'Select', label: /^Template for #/ })
  assert.ok(select)
  assert.deepEqual(
    (select.props.options as { label: string }[]).map((option) => option.label),
    ['Fix', 'Test first (Global)', 'Review (Global)']
  )
  assert.equal(select.props.value, 'test-first')
})

test('global-templates opens the Prompt templates view from the header on the default template, global, with every template to choose', async () => {
  const shown = await render('global-templates')
  await shown.press({ type: 'IconButton', label: 'Prompt templates' })
  assert.ok(shown.find({ type: 'Heading', text: 'Prompt templates' }))
  const select = shown.find({ type: 'Select', label: 'Template' })
  assert.equal(select?.props.value, 'test-first')
  assert.deepEqual(
    (select?.props.options as { label: string }[]).map((option) => option.label),
    ['Fix', 'Test first (Global)', 'Review (Global)']
  )
  assert.equal(shown.find({ type: 'Switch', label: 'Global' })?.props.checked, true)
  assert.equal(shown.find({ type: 'Switch', label: 'Default template' })?.props.checked, true)
  assert.ok(shown.find({ type: 'Text', text: 'Deletes it in every project.' }))
  assert.deepEqual(shown.errors, [])
  assert.deepEqual(shown.warnings, [])
})

test('run-here shows Run here and Start on every card, both outline with no tone, also once a card chooses another template, and no New worktree switch', async () => {
  const shown = await render('run-here')
  const outline = (button: { props: Record<string, unknown> }) => button.props.variant === 'outline' && button.props.tone === undefined
  const buttons = () => ({
    runs: shown.findAll({ role: 'button', label: /^Run #\d+ here$/ }),
    starts: shown.findAll({ role: 'button', label: /^Start #\d+$/ })
  })
  const { runs, starts } = buttons()
  assert.equal(runs.length, 3)
  assert.equal(starts.length, 3)
  assert.ok([...runs, ...starts].every((button) => !button.disabled))
  assert.ok([...runs, ...starts].every(outline))
  assert.equal(shown.find({ type: 'Switch' }), null)
  await shown.select({ type: 'Select', label: 'Template for #41' }, 'fix')
  const after = buttons()
  assert.ok([...after.runs, ...after.starts].every(outline))
  await shown.press({ type: 'IconButton', label: 'Prompt templates' })
  assert.equal(shown.find({ type: 'Switch', label: 'New worktree' }), null)
})

test('card-agent offers each card the agent Select on None with only Start; a card set to Codex offers Run here, and Project settings keep No agent', async () => {
  const shown = await render('card-agent')
  const options = shown.find({ type: 'Select', label: 'Agent for #41' })?.props.options as { label: string }[]
  assert.deepEqual(options.map((option) => option.label), ['Default', 'Claude', 'Codex', 'GitHub Copilot', 'None'])
  assert.deepEqual(shown.findAll({ type: 'Select', label: /^Agent for #/ }).map((select) => select.props.value), ['none', 'none', 'none'])
  assert.deepEqual(shown.findAll({ role: 'button', label: /^Run #\d+ here$/ }), [])
  await shown.select({ type: 'Select', label: 'Agent for #41' }, 'codex')
  assert.deepEqual(shown.findAll({ role: 'button', label: /^Run #\d+ here$/ }).map((button) => button.label), ['Run #41 here'])
  await shown.press({ type: 'IconButton', label: 'Project settings' })
  assert.equal(shown.valueOf({ type: 'Select', label: 'Agent' }), 'none')
  assert.deepEqual(shown.errors, [])
  assert.deepEqual(shown.warnings, [])
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

test('linear-ready lists the Linear issues assigned to the user, with their state, one started, Load more, ✎ and +', async () => {
  const shown = await render('linear-ready')
  assert.equal(shown.valueOf({ type: 'Select', label: 'Filter' }), 'assigned')
  assert.ok(shown.find({ type: 'IconButton', label: 'Edit filter' }))
  assert.ok(shown.find({ type: 'IconButton', label: 'New filter' }))
  assert.ok(shown.find({ type: 'Link', text: 'ENG-12' }))
  assert.ok(shown.find({ type: 'Badge', text: 'Triage' }))
  assert.ok(shown.find({ text: 'Agent: claude' }))
  const starts = shown.findAll({ role: 'button', label: /^Start ENG-/ })
  assert.ok(starts.length >= 3 && starts.every((start) => !start.disabled), `${starts.length} Start buttons`)
  assert.ok(shown.find({ role: 'button', text: /^Showing \d+ · Load more$/ }))
  await shown.press({ type: 'IconButton', label: 'Project settings' })
  assert.equal(shown.valueOf({ label: 'Tracker' }), 'linear-orca')
})

test('linear-queries opens, with ✎, a Linear query form per query, the stored team the workspace lacks marked not found', async () => {
  const shown = await render('linear-queries')
  assert.equal(shown.valueOf({ type: 'Select', label: 'Filter' }), 'f-triage')
  await shown.press({ type: 'IconButton', label: 'Edit filter' })
  assert.deepEqual(
    shown.findAll({ type: 'Field', label: /^Linear query/ }).map((field) => field.label),
    ['Linear query', 'Linear query 2']
  )
  assert.deepEqual(
    ['team', 'assignee', 'order'].map((field) => shown.valueOf({ type: 'Select', testId: `linear-${field}-0` })),
    ['ENG', 'null', 'createdAt']
  )
  const second = shown.find({ type: 'Select', testId: 'linear-team-1' })?.props.options as { label: string }[]
  assert.deepEqual(second.map((option) => option.label), ['Any team', 'Engineering (ENG)', 'Design (DES)', 'OPS (not found)'])
  assert.deepEqual(shown.errors, [])
  assert.deepEqual(shown.warnings, [])
})

test('truncated ends the list with the truncation notice', async () => {
  const shown = await render('truncated')
  assert.ok(shown.find({ text: /^Showing the first 100 tasks — narrow your JQL/ }))
})

test('tracker-error opens Project settings on the tracker that failed, without JQL, and Done shows the error under the filter row', async () => {
  const shown = await render('tracker-error')
  assert.ok(shown.find({ type: 'Heading', text: 'Project settings' }))
  assert.equal(shown.valueOf({ label: 'Tracker' }), 'jira-twg')
  assert.equal(shown.find({ type: 'Textarea' }), null)
  await shown.press({ type: 'Button', text: 'Done' })
  assert.ok(shown.find({ text: /twg failed: authentication required/ }))
  assert.ok(shown.find({ type: 'Select', label: 'Filter' }))
})

test('jira-filters shows the filter row with the filter shown, then ✎ and +, above the field', async () => {
  const shown = await render('jira-filters')
  assert.equal(shown.valueOf({ type: 'Select', label: 'Filter' }), 'f-sprint')
  const options = shown.find({ type: 'Select', label: 'Filter' })?.props.options as { label: string }[]
  assert.deepEqual(options.map((option) => option.label), ['Tasks', 'Sprint'])
  assert.ok(shown.find({ type: 'IconButton', label: 'Edit filter' }))
  assert.ok(shown.find({ type: 'IconButton', label: 'New filter' }))
  assert.ok(shown.find({ type: 'Input', label: 'Search tasks' }))
})

test('github-filters shows the filter row of a GitHub project with its second filter shown, of two queries', async () => {
  const shown = await render('github-filters')
  assert.equal(shown.valueOf({ type: 'Select', label: 'Filter' }), 'f-mine')
  const options = shown.find({ type: 'Select', label: 'Filter' })?.props.options as { label: string }[]
  assert.deepEqual(options.map((option) => option.label), ['Open', 'Mine or triage'])
  assert.ok(shown.find({ type: 'Link', text: '#42' }))
  await shown.press({ type: 'IconButton', label: 'Edit filter' })
  assert.ok(shown.find({ type: 'Textarea', label: 'Query 2' }))
})

test("global-filters lists the project's own filter, then the global ones marked Global, with a global one shown, and its editor's Global switch on", async () => {
  const shown = await render('global-filters')
  assert.equal(shown.valueOf({ type: 'Select', label: 'Filter' }), 'g-sprint')
  const options = shown.find({ type: 'Select', label: 'Filter' })?.props.options as { label: string }[]
  assert.deepEqual(options.map((option) => option.label), ['Tasks', 'Sprint (Global)', 'Bugs (Global)'])
  await shown.press({ type: 'IconButton', label: 'Edit filter' })
  assert.equal(shown.find({ type: 'Switch', label: 'Global' })?.props.checked, true)
  assert.ok(shown.find({ type: 'Text', text: 'Deletes it in every project.' }))
})

test('jira-queries opens the filter editor on each JQL query with its Remove button, adds and removes queries, and Ctrl+Enter saves and lists the tasks', async () => {
  const shown = await render('jira-queries')
  assert.ok(shown.find({ type: 'Heading', text: 'Edit filter' }))
  assert.ok(shown.find({ text: /^Board: JQL query 2 failed/ }))
  const labels = () => shown.findAll({ type: 'Textarea', label: /^JQL/ }).map((field) => field.label)
  const removable = () => shown.findAll({ type: 'IconButton', label: /^Remove JQL/ }).map((button) => button.label)
  assert.deepEqual(labels(), ['JQL', 'JQL 2', 'JQL 3'])
  assert.deepEqual(removable(), ['Remove JQL', 'Remove JQL 2', 'Remove JQL 3'])
  assert.equal(shown.valueOf({ type: 'Textarea', label: 'JQL 2' }), 'project = WEB AND labels = ui\nORDER BY rank')

  await shown.press({ type: 'IconButton', label: 'Remove JQL 3' })
  await shown.press({ type: 'IconButton', label: 'Remove JQL' })
  assert.deepEqual(labels(), ['JQL'])
  assert.deepEqual(removable(), [])
  await shown.press({ type: 'Button', text: 'Add JQL' })
  assert.deepEqual(labels(), ['JQL', 'JQL 2'])
  assert.deepEqual(removable(), ['Remove JQL', 'Remove JQL 2'])

  const loads = () => shown.host.calls.filter((call) => JSON.stringify(call.params ?? null).includes('tasks.load')).length
  const before = loads()
  await shown.submit({ type: 'Textarea', label: 'JQL 2' })
  assert.equal(loads(), before + 1)
  // The scenario's list fails again, so the editor opens on the filter again.
  assert.ok(shown.find({ type: 'Heading', text: 'Edit filter' }))
  assert.deepEqual(shown.errors, [])
})

test('jira-twg-queries lists a first page that holds the tasks of every JQL query, with no Load more', async () => {
  const shown = await render('jira-twg-queries')
  for (const key of ['WEB-21', 'WEB-22', 'WEB-23', 'WEB-30', 'WEB-31']) assert.ok(shown.find({ role: 'button', label: `Start ${key}` }), key)
  assert.equal(shown.find({ role: 'button', text: /Load more/ }), null)
})

test('orca-error shows the message of an Orca CLI that fails before any project is known', async () => {
  const shown = await render('orca-error')
  assert.ok(shown.find({ text: /^Couldn't load tasks/ }))
  assert.ok(shown.find({ text: /Couldn't find the Orca CLI/ }))
})

test('worktrees-unavailable lists the tasks with a warning and every Start off', async () => {
  const shown = await render('worktrees-unavailable')
  assert.ok(shown.find({ text: /^Couldn't read Orca's worktrees, so Start and Run here are off\./ }))
  const starts = shown.findAll({ role: 'button', label: /^Start #/ })
  assert.ok(starts.length > 0 && starts.every((start) => start.disabled))
})
