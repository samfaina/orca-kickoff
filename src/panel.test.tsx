import { assert, hostError, mockHost, mount, test, type MockHost, type MockRequests, type TestPanel, type TestQuery } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { Task, TaskList, TaskWorktree } from './protocol'
import * as panel from './panel'

const web = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }
const notes = { id: 'repo:r1', name: 'notes', repo: null }

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
  starting: [],
  warning: null,
  ...fields
})

async function show(answer: TaskList | ((input: { cursor?: string }) => TaskList | Promise<TaskList>)) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'tasks.load': answer } })
  return mount(panel, { host })
}

/** What a request handler awaits so its answer waits until the test calls `release`, and the
 *  test can look at the panel meanwhile. */
function held() {
  let release = () => {}
  const released = new Promise<void>((resolve) => (release = resolve))
  return { released, release }
}

/** One turn of the event loop, not a span of time: the promise callbacks already queued, such as
 *  the panel handling an answer, run before it ends. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Waits until the panel draws an element that matches `query`, for a state drawn while a request
 *  is held, when `settled()` would wait for that request. Orca's test runtime draws on its own
 *  event-loop turn, so this yields turns, and fails if the element never appears. */
async function drawn(view: TestPanel, query: TestQuery, eachTurn: () => void = () => {}): Promise<void> {
  for (let turns = 0; turns < 100; turns++) {
    if (view.find(query)) return
    eachTurn()
    await turn()
  }
  assert.fail(`the panel never drew ${JSON.stringify(query)}`)
}

/** Yields event-loop turns until `condition` holds, while an act waits for a held request, and
 *  fails if it never does. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let turns = 0; turns < 100; turns++) {
    if (condition()) return
    await turn()
  }
  assert.fail(`never ${what}`)
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
  const reload = held()
  let calls = 0
  const view = await show(async () => {
    if (++calls === 2) await reload.released
    return ready([task(`#${calls}`)])
  })
  const pressed = view.press({ type: 'IconButton', label: 'Reload tasks' })
  await drawn(view, { type: 'Spinner', label: 'Reloading tasks' })
  const listWhileReloading = view.find({ type: 'Link', text: '#1' })
  reload.release()
  await pressed
  assert.ok(listWhileReloading)
  assert.equal(view.find({ type: 'Spinner', label: 'Reloading tasks' }), null)
  assert.ok(view.find({ type: 'Link', text: '#2' }))
  await view.unmount()
})

test('says when no project is selected', async () => {
  const view = await show({ kind: 'no-project' })
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No project selected')
  await view.unmount()
})

const gear = { type: 'IconButton', label: 'Project settings' }
const done = { type: 'Button', text: 'Done' }
const settingsTitle = { type: 'Heading', text: 'Project settings' }

test('the header says "Kickoff ·" and the project\'s name, or only "Kickoff" without a project', async () => {
  const listed = await show(ready([task('#42')]))
  const kickoff = listed.find({ type: 'Text', text: 'Kickoff ·' })
  assert.equal(kickoff?.props.muted, true)
  assert.equal(listed.find({ type: 'Heading', text: 'web' })?.props.level, 2)
  assert.equal(listed.find({ type: 'Heading', text: 'Kickoff' }), null)
  const button = listed.find(gear)
  assert.equal(button?.props.icon, 'settings')
  assert.equal(button?.props.tooltip, 'Project settings')
  assert.ok(listed.find({ type: 'IconButton', label: 'Reload tasks' }))
  await listed.unmount()

  const none = await show({ kind: 'no-project' })
  assert.equal(none.find({ type: 'Heading', text: 'Kickoff' })?.props.level, 2)
  assert.equal(none.find({ type: 'Text', text: 'Kickoff ·' }), null)
  assert.equal(none.find(gear), null)
  assert.ok(none.find({ type: 'IconButton', label: 'Reload tasks' }))
  await none.unmount()
})

test('the gear opens Project settings in place of the list, and Done goes back to the list', async () => {
  const view = await show(ready([task('#42')]))
  assert.equal(view.find(settingsTitle), null)
  await view.press(gear)
  assert.equal(view.find(settingsTitle)?.props.level, 3)
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  assert.equal(view.find(gear), null)
  assert.equal(view.find(done)?.props.icon, 'close')
  assert.ok(view.find({ type: 'Text', text: 'Tracker' }))
  assert.ok(view.find({ type: 'Text', text: 'Start' }))
  assert.ok(view.find({ type: 'Separator' }))
  assert.ok(view.find({ type: 'Select', label: 'Tracker' }))
  assert.ok(view.find({ type: 'Select', label: 'Agent' }))

  await view.press(done)
  assert.equal(view.find(settingsTitle), null)
  assert.ok(view.find({ type: 'Link', text: '#42' }))
  assert.equal(view.find({ type: 'Select', label: 'Tracker' }), null)
  assert.equal(view.find({ type: 'Select', label: 'Agent' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('Project settings opens by itself for a project without a tracker, not an error, and Done shows the empty state', async () => {
  const view = await show({ kind: 'needs-config', project: notes })
  assert.ok(view.find({ type: 'Text', text: 'notes ·' }))
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), ':none')
  assert.deepEqual(optionLabels(view, 'Tracker'), ['Choose a tracker', 'GitHub', 'Jira (Orca connection)', 'Jira (twg)'])
  await view.press(done)
  assert.equal(view.find(settingsTitle), null)
  const empty = view.find({ type: 'EmptyState' })
  assert.equal(empty?.label, 'No tracker for this project')
  assert.equal(empty?.props.description, 'Choose a tracker in Project settings to list the tasks of notes.')
  await view.unmount()
})

test('Project settings opens by itself when the load fails, and Done shows the error', async () => {
  const view = await show({ kind: 'error', project: web, message: 'gh failed: not logged in.' })
  assert.ok(view.find(settingsTitle))
  assert.equal(view.find({ type: 'Callout' }), null)
  await view.press(done)
  assert.match(view.find({ type: 'Callout' })?.text ?? '', /not logged in/)
  // A reload that fails again keeps the list the person went back to.
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(view.find(settingsTitle), null)
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
  await view.press(done)
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
  const newer = held()
  let calls = 0
  const view: TestPanel = await show(async () => {
    calls++
    if (calls === 2) {
      // The workspace changes while this answer is still on its way: it arrives after the newer one.
      void view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
      await newer.released
      await turn()
      return ready([task('#20')])
    }
    if (calls === 3) newer.release()
    return ready([task(`#${calls}`)])
  })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  await view.settled()

  assert.equal(calls, 3)
  assert.ok(view.find({ type: 'Link', text: '#3' }))
  assert.equal(view.find({ type: 'Link', text: '#20' }), null)
  await view.unmount()
})

/** Stands in for `setInterval` while `body` runs, so a test fires the panel's timers by hand:
 *  `tick()` runs every live interval once and waits for the panel to settle. */
async function withIntervals(body: (timers: { tick: (view: TestPanel) => Promise<void>; live: () => number[] }) => Promise<void>) {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const live = new Map<number, { run: () => void; ms: number }>()
  let next = 1
  globalThis.setInterval = ((run: () => void, ms: number) => {
    live.set(next, { run, ms })
    return next++
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: number) => void live.delete(id)) as unknown as typeof clearInterval
  try {
    await body({
      tick: async (view) => {
        for (const timer of [...live.values()]) timer.run()
        await view.settled()
      },
      live: () => [...live.values()].map((timer) => timer.ms)
    })
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
}

const api = { id: 'github:acme/api', name: 'api', repo: 'acme/api' }

test('a change of active project goes back to the list, unless the new project needs Project settings', async () => {
  let answer: TaskList = ready([task('#42')])
  const view = await show(() => answer)
  const changeTo = async (next: TaskList, displayName: string) => {
    answer = next
    await view.emit('workspace.changed', { context: { branch: 'main', displayName, terminals: [] } })
  }

  await view.press(gear)
  // A reload of the same project keeps the view open.
  await changeTo(ready([task('#43')]), 'web')
  assert.ok(view.find(settingsTitle))

  await changeTo(ready([task('#9')], { project: api }), 'api')
  assert.equal(view.find(settingsTitle), null)
  assert.ok(view.find({ type: 'Link', text: '#9' }))

  await view.press(gear)
  await changeTo({ kind: 'needs-config', project: notes }, 'notes')
  assert.ok(view.find({ type: 'Text', text: 'notes ·' }))

  // Done in a project that needs the settings, then another that needs them too: it opens again.
  await view.press(done)
  await changeTo({ kind: 'error', project: web, message: 'gh failed.' }, 'web')
  assert.ok(view.find({ type: 'Text', text: 'web ·' }))
  await view.unmount()
})

test('while visible, the panel polls the active project every 3 s and reloads when it changes', async () => {
  await withIntervals(async ({ tick, live }) => {
    let active = web
    let loads = 0
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      requests: {
        'tasks.load': () => (loads++, ready([task('#1')], { project: active })),
        'project.active': () => ({ projectId: active.id })
      }
    })
    const view = await mount(panel, { host })
    assert.deepEqual(live(), [3000])
    await tick(view)
    assert.equal(loads, 1)

    // Two `main` worktrees of different projects: Orca sends no workspace.changed.
    active = api
    await tick(view)
    assert.equal(loads, 2)
    assert.ok(view.find({ type: 'Heading', text: 'api' }))
    await tick(view)
    assert.equal(loads, 2)
    await view.unmount()
  })
})

test('after a reload for workspace.changed, the next poll measures against the new list', async () => {
  await withIntervals(async ({ tick }) => {
    let active = web
    let loads = 0
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      requests: {
        'tasks.load': () => (loads++, ready([task('#1')], { project: active })),
        'project.active': () => ({ projectId: active.id })
      }
    })
    const view = await mount(panel, { host })
    await tick(view)
    active = api
    await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
    assert.equal(loads, 2)
    await tick(view)
    assert.equal(loads, 2)
    await view.unmount()
  })
})

test('an active project the list never shows reloads it once, not on every poll', async () => {
  await withIntervals(async ({ tick }) => {
    let loads = 0
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      requests: {
        // Orca's active worktree belongs to a project its project list doesn't have.
        'tasks.load': () => (loads++, { kind: 'no-project' }),
        'project.active': { projectId: 'repo:gone' }
      }
    })
    const view = await mount(panel, { host })
    await tick(view)
    await tick(view)
    await tick(view)
    assert.equal(loads, 2)
    await view.unmount()
  })
})

test('while a Start shows its spinner, the poll asks the worker, so a worker that restarted clears it', async () => {
  await withIntervals(async ({ tick }) => {
    let underWay = ['#42']
    const asked: unknown[] = []
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      requests: {
        'tasks.load': ready([task('#42')], { starting: ['#42'] }),
        'project.active': { projectId: web.id },
        'starts.load': (input) => (asked.push(input), { starting: underWay })
      }
    })
    const view = await mount(panel, { host })
    await tick(view)
    assert.deepEqual(asked, [{ projectId: web.id }])
    assert.ok(view.find({ type: 'Spinner', label: 'Starting #42' }))

    // The worker restarted: it knows no Start, and no end will come.
    underWay = []
    await tick(view)
    assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
    assert.ok(view.find({ testId: 'start:#42' }))
    await tick(view)
    assert.equal(asked.length, 2)
    await view.unmount()
  })
})

test('polling stops while the panel is hidden, and when it closes', async () => {
  await withIntervals(async ({ tick, live }) => {
    let polls = 0
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      requests: { 'tasks.load': ready([task('#1')]), 'project.active': () => (polls++, { projectId: web.id }) }
    })
    const view = await mount(panel, { host })
    await view.setVisible(false)
    await tick(view)
    assert.equal(polls, 0)

    await view.setVisible(true)
    await tick(view)
    assert.equal(polls, 1)

    await view.unmount()
    assert.deepEqual(live(), [])
  })
})

test("a failed poll keeps the list as it is", async () => {
  await withIntervals(async ({ tick }) => {
    let loads = 0
    const host = mockHost({
      capabilities: ['storage:own', 'workspace:read'],
      requests: {
        'tasks.load': () => (loads++, ready([task('#1')])),
        'project.active': { kind: 'error', message: 'orca failed: Orca is not running.' }
      }
    })
    const view = await mount(panel, { host })
    await tick(view)
    assert.equal(loads, 1)
    assert.ok(view.find({ type: 'Link', text: '#1' }))
    assert.equal(view.find({ type: 'Callout' }), null)
    await view.unmount()
  })
})

/** The panel with these worker answers and stored values, and its host. */
async function showWith(requests: MockRequests, storage: Record<string, JsonValue> = {}) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests, storage })
  return { view: await mount(panel, { host }), host }
}

const started = { worktreeId: 'r1::/src/web-42', name: 'issue-42-add-dark-mode', agent: 'claude' }

const storedProject = (host: MockHost) => {
  const settings = host.data().storage.settings as { projects: Record<string, unknown> } | undefined
  return settings?.projects['github:acme/web']
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function optionLabels(view: TestPanel, label: string): string[] {
  const options = view.find({ type: 'Select', label })?.props.options as { label: string }[] | undefined
  return (options ?? []).map((option) => option.label)
}

test('Project settings show the agent choice, the default template and the buttons to edit or add one', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Agent' }), 'orca-default')
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 'default')
  assert.deepEqual(optionLabels(view, 'Default template'), ['Default'])
  assert.ok(view.find({ type: 'IconButton', label: 'Edit template' }))
  assert.ok(view.find({ type: 'IconButton', label: 'New template' }))
  assert.equal(view.find({ type: 'Textarea' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

const implement = { id: 't-impl', name: 'Implement', text: '/acme-skills:tdd {{task_url}}' }
const triage = { id: 't-triage', name: 'Triage', text: 'Triage {{task_key}}' }

/** Stored settings of the web project with these fields. */
const stored = (project: Record<string, JsonValue>) => ({ settings: { version: 1, projects: { 'github:acme/web': { providers: {}, ...project } } } })

const twoTemplates = stored({ templates: [implement, triage], defaultTemplateId: 't-triage' })

test("Project settings show the project's stored agent and default template", async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, { settings: { ...twoTemplates.settings, projects: { 'github:acme/web': { ...twoTemplates.settings.projects['github:acme/web'], agent: 'none' } } } })
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Agent' }), 'none')
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-triage')
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Triage'])
  await view.unmount()
})

test('a project with a template stored before several templates shows it as "Default", unchanged', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ template: 'Fix {{task_key}}' }))
  await view.press(gear)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Default'])
  await view.press({ type: 'IconButton', label: 'Edit template' })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Default')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Text' }), 'Fix {{task_key}}')
  await view.unmount()
})

test('default template and agent changes save themselves after a pause', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.select({ type: 'Select', label: 'Agent' }, 'codex')
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, 't-triage')
  await wait(800)
  assert.deepEqual(storedProject(host), { providers: {}, templates: [implement, triage], defaultTemplateId: 't-impl', agent: 'codex' })
  await view.unmount()
})

test('a pending change is saved before a Start', async () => {
  let seen: unknown
  const { view, host } = await showWith(
    {
      'tasks.load': ready([task('#42')]),
      'task.start': () => {
        seen = storedProject(host)
        return { ok: true, underWay: false }
      },
      'worktrees.load': { kind: 'ready', worktrees: {} }
    },
    twoTemplates
  )
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Agent' }, 'none')
  await view.press(done)
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(seen, { providers: {}, templates: [implement, triage], defaultTemplateId: 't-triage', agent: 'none' })
  await view.unmount()
})

test('Start starts the task, then shows its worktree and agent, keeping the loaded tasks', async () => {
  const starts: unknown[] = []
  let loads = 0
  const { view } = await showWith({
    'tasks.load': () => {
      loads++
      return ready([task('#42'), task('#7')])
    },
    'task.start': (input) => {
      starts.push(input)
      return { ok: true, underWay: false }
    },
    'worktrees.load': { kind: 'ready', worktrees: { '#42': started } }
  })
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(starts, [{ projectId: 'github:acme/web', task: task('#42'), templateId: 'default' }])
  assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
  assert.ok(view.find({ type: 'Text', text: /claude/ }))
  assert.equal(view.find({ testId: 'start:#42' }), null)
  assert.ok(view.find({ testId: 'start:#7' }))
  assert.equal(loads, 1)
  await view.unmount()
})

/** The card's template Select of a task. */
const cardTemplate = (key: string) => ({ type: 'Select', label: `Template for ${key}` })

test('Start uses the template chosen on the card, or the default template when none was chosen', async () => {
  const starts: { templateId: string }[] = []
  const { view } = await showWith(
    {
      'tasks.load': ready([task('#42'), task('#7')]),
      'task.start': (input) => (starts.push(input), { ok: true, underWay: true })
    },
    twoTemplates
  )
  assert.equal(view.valueOf(cardTemplate('#42')), 't-triage')
  assert.deepEqual(optionLabels(view, 'Template for #42'), ['Implement', 'Triage'])
  await view.select(cardTemplate('#42'), 't-impl')
  await view.press({ testId: 'start:#42' })
  await view.press({ testId: 'start:#7' })
  assert.deepEqual(starts.map((start) => start.templateId), ['t-impl', 't-triage'])
  // A started or starting task offers no templates.
  assert.equal(view.find(cardTemplate('#42')), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('with one template, cards show no template Select', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  assert.equal(view.find(cardTemplate('#42')), null)
  assert.ok(view.find({ testId: 'start:#42' }))
  await view.unmount()
})

test('a change of default template shows in the cards without a choice of their own', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42'), task('#7')]) }, twoTemplates)
  await view.select(cardTemplate('#7'), 't-triage')
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  assert.equal(view.valueOf(cardTemplate('#7')), 't-triage')
  await view.unmount()
})

test("a card's template choice survives a reload", async () => {
  let loads = 0
  const { view } = await showWith({ 'tasks.load': () => (loads++, ready([task('#42')])) }, twoTemplates)
  await view.select(cardTemplate('#42'), 't-impl')
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(loads, 2)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  await view.unmount()
})

const saveButton = { type: 'Button', text: 'Save' }

/** How long Delete waits for its second click. */
const CONFIRM_DELETE_MS = 4_000

test("Project settings shows the default template's text, read-only, or says that an empty one gives the task URL", async () => {
  const empty = { id: 't-empty', name: 'Empty', text: '' }
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ templates: [implement, empty], defaultTemplateId: 't-impl' }))
  await view.press(gear)
  const code = view.find({ type: 'CodeView' })
  assert.equal(code?.props.code, '/acme-skills:tdd {{task_url}}')
  assert.equal(code?.props.wrap, true)
  assert.equal(code?.props.maxHeight, 'sm')
  assert.equal(view.find({ type: 'Text', text: 'Empty: the prompt is the task URL.' }), null)

  await view.select({ type: 'Select', label: 'Default template' }, 't-empty')
  assert.equal(view.find({ type: 'CodeView' }), null)
  assert.ok(view.find({ type: 'Text', text: 'Empty: the prompt is the task URL.' }))
  await view.unmount()
})

test('the template detail opened from Project settings goes back to it on Save, Cancel and Delete', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  const backInSettings = () => {
    assert.equal(view.find({ type: 'Input', label: 'Name' }), null)
    assert.ok(view.find(settingsTitle))
    assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  }

  await view.press({ type: 'IconButton', label: 'New template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  backInSettings()

  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Cancel' })
  backInSettings()

  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Delete' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  backInSettings()
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Review'])
  await view.unmount()
})

test('the template detail opened from Project settings that opened by itself goes back to it', async () => {
  const { view } = await showWith({ 'tasks.load': { kind: 'error', project: web, message: 'gh failed.' } }, twoTemplates)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(view.find(settingsTitle))
  await view.unmount()
})

test('"New template" opens the detail with an empty name and the initial text; Save adds it at the end and goes back to Project settings', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  assert.ok(view.find({ type: 'Heading', text: 'web' }))
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), '')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Text' }), 'Complete {{task_key}}: {{task_url}}')
  assert.ok(view.find({ type: 'Text', text: /\{\{task_description\}\}/ }))
  assert.equal(view.find({ type: 'Button', text: 'Delete' }), null)
  assert.equal(view.find(saveButton)?.disabled, true)
  assert.ok(view.find({ type: 'Text', text: 'Give the template a name.' }))

  await view.type({ type: 'Input', label: 'Name' }, ' triage')
  assert.equal(view.find(saveButton)?.disabled, true)
  assert.ok(view.find({ type: 'Text', text: 'Another template is already called "Triage".' }))

  await view.type({ type: 'Input', label: 'Name' }, 'Review ', { replace: true })
  await view.type({ type: 'Textarea', label: 'Text' }, 'Review {{branch}}', { replace: true })
  assert.equal(view.find(saveButton)?.disabled, false)
  assert.equal(view.find({ type: 'Text', text: /Give the template a name|already called/ }), null)
  await view.press(saveButton)

  const { templates, defaultTemplateId } = storedProject(host) as { templates: { id: string; name: string; text: string }[]; defaultTemplateId: string }
  assert.deepEqual(templates.slice(0, 2), [implement, triage])
  assert.deepEqual({ ...templates[2], id: '' }, { id: '', name: 'Review', text: 'Review {{branch}}' })
  assert.ok(templates[2].id !== '' && templates[2].id !== implement.id && templates[2].id !== triage.id)
  assert.equal(defaultTemplateId, 't-triage')
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Triage', 'Review'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-triage')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('the pencil edits the template chosen as default, and Save stores it in its place', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.press({ type: 'IconButton', label: 'Edit template' })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Implement')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Text' }), '/acme-skills:tdd {{task_url}}')
  // Its own name in another case is fine.
  await view.type({ type: 'Input', label: 'Name' }, 'IMPLEMENT', { replace: true })
  await view.type({ type: 'Textarea', label: 'Text' }, '', { replace: true })
  await view.press(saveButton)
  assert.deepEqual(storedProject(host), {
    providers: {},
    templates: [{ id: 't-impl', name: 'IMPLEMENT', text: '' }, triage],
    defaultTemplateId: 't-impl'
  })
  assert.deepEqual(optionLabels(view, 'Default template'), ['IMPLEMENT', 'Triage'])
  await view.unmount()
})

test('saving a template of a project that stored none stores it, without the earlier field', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ template: 'Fix {{task_key}}', agent: 'codex' }))
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Implement', { replace: true })
  await view.press(saveButton)
  assert.deepEqual(storedProject(host), {
    providers: {},
    templates: [{ id: 'default', name: 'Implement', text: 'Fix {{task_key}}' }],
    defaultTemplateId: 'default',
    agent: 'codex'
  })
  await view.unmount()
})

test('Cancel goes back to Project settings without storing anything', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Changed', { replace: true })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  await view.press({ type: 'IconButton', label: 'Edit template' })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Triage')
  await view.unmount()
})

test('a failed write keeps the detail open with the error and the draft', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': ready([task('#42')]) },
    storage: twoTemplates,
    results: {
      'storage.set': () => {
        throw hostError('quota_exceeded', 'Storage is full')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  assert.ok(view.find({ type: 'Text', text: /Couldn't save the template/ }))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Review')
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  await view.unmount()
})

test('Delete needs a second click, and deleting the default template makes the first remaining one the default', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Delete' })
  assert.ok(view.find({ type: 'Button', text: 'Confirm delete' }))
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedProject(host), { providers: {}, templates: [implement], defaultTemplateId: 't-impl' })
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-impl')
  await view.unmount()
})

test('Delete turns back after a few seconds without the second click', async () => {
  await withTimeouts(CONFIRM_DELETE_MS, async ({ fire }) => {
    const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
    await view.press(gear)
    await view.press({ type: 'IconButton', label: 'Edit template' })
    await view.press({ type: 'Button', text: 'Delete' })
    await fire(view)
    assert.ok(view.find({ type: 'Button', text: 'Delete' }))
    assert.equal(view.find({ type: 'Button', text: 'Confirm delete' }), null)
    await view.press({ type: 'Button', text: 'Delete' })
    assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
    await view.unmount()
  })
})

test('Delete is disabled for the only template', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  assert.equal(view.find({ type: 'Button', text: 'Delete' })?.disabled, true)
  await view.unmount()
})

test("a card whose template is deleted falls back to the default template", async () => {
  const starts: { templateId: string }[] = []
  const three = stored({ templates: [implement, triage, { id: 't-review', name: 'Review', text: '' }], defaultTemplateId: 't-impl' })
  const { view } = await showWith(
    { 'tasks.load': ready([task('#42')]), 'task.start': (input) => (starts.push(input), { ok: true, underWay: true }) },
    three
  )
  await view.select(cardTemplate('#42'), 't-triage')
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-triage')
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Delete' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(starts.map((start) => start.templateId), ['t-impl'])
  await view.unmount()
})

test("a change of active project while the detail is open drops the draft and shows the new project's list", async () => {
  let project = web
  const { view, host } = await showWith(
    { 'tasks.load': () => ready([task(project === web ? '#42' : '#9')], { project }) },
    twoTemplates
  )
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  project = api
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  assert.equal(view.find({ type: 'Input', label: 'Name' }), null)
  assert.ok(view.find({ type: 'Heading', text: 'api' }))
  assert.ok(view.find({ type: 'Link', text: '#9' }))

  // Back in the first project, the draft is gone.
  project = web
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  assert.ok(view.find({ type: 'Link', text: '#42' }))
  assert.equal(view.find({ type: 'Input', label: 'Name' }), null)
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  await view.unmount()
})

test('a reload of the same project keeps the detail open with its draft', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Review')
  await view.unmount()
})

test('closing the panel drops the draft', async () => {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'tasks.load': ready([task('#42')]) }, storage: twoTemplates })
  const first = await mount(panel, { host })
  await first.press(gear)
  await first.press({ type: 'IconButton', label: 'New template' })
  await first.type({ type: 'Input', label: 'Name' }, 'Review')
  await first.unmount()
  const second = await mount(panel, { host })
  assert.equal(second.find({ type: 'Input', label: 'Name' }), null)
  assert.ok(second.find({ type: 'Link', text: '#42' }))
  await second.unmount()
})

test("a Start after the project's settings couldn't be read reads them again for the default template", async () => {
  let reads = 0
  const starts: { templateId: string }[] = []
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': ready([task('#42')]), 'task.start': (input) => (starts.push(input), { ok: true, underWay: true }) },
    results: {
      'storage.get': () => {
        if (++reads === 1) throw hostError('unavailable', 'Storage is busy')
        return { value: twoTemplates.settings }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ type: 'Select', label: 'Default template' }), null)
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(starts.map((start) => start.templateId), ['t-triage'])
  await view.unmount()
})

test("a Start whose project's settings can't be read fails on its card without asking the worker", async () => {
  let starts = 0
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': ready([task('#42')]), 'task.start': () => (starts++, { ok: true, underWay: true }), 'worktrees.load': { kind: 'ready', worktrees: {} } },
    results: {
      'storage.get': () => {
        throw hostError('unavailable', 'Storage is busy')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ testId: 'start:#42' })
  assert.equal(starts, 0)
  assert.ok(view.find({ type: 'Text', text: /Couldn't read the prompt templates/ }))
  assert.ok(view.find({ testId: 'start:#42' }))
  await view.unmount()
})

test('a pending Project settings change survives a failed template write, and the next Save stores both', async () => {
  let writes = 0
  let data: JsonValue = twoTemplates.settings
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': ready([task('#42')]) },
    results: {
      'storage.get': () => ({ value: data }),
      'storage.set': (params: { key: string; value: JsonValue }) => {
        if (++writes === 1) throw hostError('quota_exceeded', 'Storage is full')
        data = params.value
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Agent' }, 'codex')
  await view.press({ type: 'IconButton', label: 'New template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  assert.ok(view.find({ type: 'Text', text: /Couldn't save the template/ }))
  await view.press(saveButton)
  const project = (data as { projects: Record<string, { agent?: string; templates: { name: string }[] }> }).projects['github:acme/web']
  assert.equal(project.agent, 'codex')
  assert.deepEqual(project.templates.map((template) => template.name), ['Implement', 'Triage', 'Review'])
  await view.unmount()
})

test('a started task opens its worktree in Orca from the link', async () => {
  const opened: unknown[] = []
  const { view } = await showWith({
    'tasks.load': ready([task('#42')], { worktrees: { '#42': { ...started, agent: null } } }),
    'worktree.open': (input) => {
      opened.push(input)
      return { ok: true }
    }
  })
  assert.ok(view.find({ type: 'Text', text: /No agent running/ }))
  await view.press({ type: 'Link', text: 'issue-42-add-dark-mode' })
  assert.deepEqual(opened, [{ worktreeId: 'r1::/src/web-42' }])
  await view.unmount()
})

test('a spinner shows on the card while it starts', async () => {
  const start = held()
  const { view } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.start': async () => {
      await start.released
      return { ok: true, underWay: false }
    },
    'worktrees.load': { kind: 'ready', worktrees: { '#42': started } }
  })
  const pressed = view.press({ testId: 'start:#42' })
  await drawn(view, { type: 'Spinner', label: 'Starting #42' })
  const buttonWhileStarting = view.find({ testId: 'start:#42' })
  start.release()
  await pressed
  assert.equal(buttonWhileStarting, null)
  assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
  await view.unmount()
})

const CAN_TAKE_A_MINUTE = /Creating the worktree can take a minute/

test('a Start under way shows the spinner and says that creating the worktree can take a minute', async () => {
  const { view } = await showWith({
    'tasks.load': ready([task('#42'), task('#7')]),
    'task.start': { ok: true, underWay: true }
  })
  await view.press({ testId: 'start:#42' })
  assert.ok(view.find({ type: 'Spinner', label: 'Starting #42' }))
  assert.equal(view.find({ testId: 'start:#42' }), null)
  assert.equal(view.findAll({ type: 'Text', text: CAN_TAKE_A_MINUTE }).length, 1)
  assert.ok(view.find({ testId: 'start:#7' }))
  await view.unmount()
})

test('a panel opened while the worker reports a Start under way shows its spinner and line, then its end', async () => {
  let worktrees = {}
  const { view } = await showWith({
    'tasks.load': ready([task('#42'), task('#7')], { starting: ['#42'] }),
    'worktrees.load': () => ({ kind: 'ready', worktrees })
  })
  assert.ok(view.find({ type: 'Spinner', label: 'Starting #42' }))
  assert.ok(view.find({ type: 'Text', text: CAN_TAKE_A_MINUTE }))
  assert.equal(view.find({ testId: 'start:#42' }), null)
  assert.ok(view.find({ testId: 'start:#7' }))

  worktrees = { '#42': started }
  await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
  assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
  assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
  await view.unmount()
})

test('a list asked for before a Start went under way, and answered after, keeps its spinner', async () => {
  const start = held()
  let loads = 0
  const { view } = await showWith({
    'tasks.load': async () => {
      if (++loads === 1) return ready([task('#42')])
      // The worker read its Starts before this one was under way. The list arrives after the
      // panel has handled the Start's answer.
      await start.released
      await turn()
      return ready([task('#42')], { starting: [] })
    },
    'task.start': () => {
      start.release()
      return { ok: true, underWay: true }
    }
  })
  await Promise.all([view.press({ type: 'IconButton', label: 'Reload tasks' }), view.press({ testId: 'start:#42' })])
  assert.equal(loads, 2)
  assert.ok(view.find({ type: 'Spinner', label: 'Starting #42' }))
  assert.ok(view.find({ type: 'Text', text: CAN_TAKE_A_MINUTE }))
  await view.unmount()
})

test("a Start's successful end clears the spinner and shows the worktree", async () => {
  let worktrees = {}
  const { view } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.start': { ok: true, underWay: true },
    'worktrees.load': () => ({ kind: 'ready', worktrees })
  })
  await view.press({ testId: 'start:#42' })
  worktrees = { '#42': started }
  await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
  assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
  assert.equal(view.find({ type: 'Text', text: CAN_TAKE_A_MINUTE }), null)
  assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
  await view.unmount()
})

test("a Start's failed end clears the spinner and shows its message, unless the worktree is there anyway", async () => {
  let worktrees = {}
  const { view } = await showWith({
    'tasks.load': ready([task('#42'), task('#7')]),
    'task.start': { ok: true, underWay: true },
    'worktrees.load': () => ({ kind: 'ready', worktrees })
  })
  await view.press({ testId: 'start:#42' })
  await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: null, ok: false, message: 'orca failed: Pick a different worktree name' })
  assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
  assert.ok(view.find({ type: 'Text', text: 'orca failed: Pick a different worktree name' }))
  assert.ok(view.find({ testId: 'start:#42' }))

  // A timed-out create that Orca finished anyway.
  await view.press({ testId: 'start:#7' })
  worktrees = { '#7': { worktreeId: 'r1::/src/web-7', name: 'issue-7-task-7', agent: null } }
  await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#7', agent: null, ok: false, message: "Orca didn't finish creating the worktree for #7 in time" })
  assert.ok(view.find({ type: 'Link', text: 'issue-7-task-7' }))
  assert.equal(view.find({ type: 'Text', text: /didn't finish/ }), null)
  await view.unmount()
})

test('a failed Start shows its error on the card and refreshes the worktrees', async () => {
  let refreshed = 0
  const { view } = await showWith({
    'tasks.load': ready([task('#42'), task('#7')]),
    'task.start': { ok: false, message: "Couldn't read Orca's default agent — pick one in the panel." },
    'worktrees.load': () => {
      refreshed++
      return { kind: 'ready', worktrees: {} }
    }
  })
  await view.press({ testId: 'start:#42' })
  assert.equal(refreshed, 1)
  assert.ok(view.find({ type: 'Text', text: "Couldn't read Orca's default agent — pick one in the panel." }))
  assert.ok(view.find({ testId: 'start:#42' }))
  await view.unmount()
})

test('a Start whose request timed out counts as done when the task now has a worktree', async () => {
  const { view } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.start': () => {
      throw hostError('timeout', 'Request timed out')
    },
    'worktrees.load': { kind: 'ready', worktrees: { '#42': started } }
  })
  await view.press({ testId: 'start:#42' })
  assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
  assert.equal(view.find({ type: 'Text', text: /didn't answer/ }), null)
  await view.unmount()
})

test("a failure reading Orca's worktrees still lists the tasks, with Start disabled", async () => {
  const { view } = await showWith({
    'tasks.load': ready([task('#42', { title: 'Add dark mode' }), task('#7')], { worktrees: null, worktreesError: 'orca failed: Orca is not running.' })
  })
  assert.ok(view.find({ type: 'Link', text: '#42' }))
  assert.ok(view.find({ type: 'Text', text: /Add dark mode/ }))
  assert.equal(view.find({ testId: 'start:#42' })?.disabled, true)
  assert.equal(view.find({ testId: 'start:#7' })?.disabled, true)
  assert.ok(view.find({ type: 'Text', text: /Orca is not running/ }))
  await view.unmount()
})

/** Stands in for `setTimeout` while `body` runs, for the timers of `ms` only, so a test fires them
 *  by hand: `fire()` runs every one still pending and waits for the panel to settle. Other timers,
 *  such as the settings save, run as usual. */
async function withTimeouts(
  ms: number,
  body: (timers: { fire: (view: TestPanel) => Promise<void>; pending: () => number }) => Promise<void>
) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const held = new Map<number, () => void>()
  let next = 1
  globalThis.setTimeout = ((run: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== ms) return realSet(run, delay, ...args)
    held.set(next, run)
    return next++
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: unknown) => {
    if (typeof id === 'number' && held.delete(id)) return
    realClear(id as ReturnType<typeof setTimeout>)
  }) as unknown as typeof clearTimeout
  try {
    await body({
      fire: async (view) => {
        const runs = [...held.values()]
        held.clear()
        for (const run of runs) run()
        await view.settled()
      },
      pending: () => held.size
    })
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
}

/** How long after a Start's end the panel reads the worktrees again for its agent. */
const AGENT_CHECK_MS = 5_000

test('after a Start with an agent, the card says the agent is starting until Orca reports it', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ fire }) => {
    let worktrees = {}
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': () => ({ kind: 'ready', worktrees })
    })
    await view.press({ testId: 'start:#42' })
    // Orca hasn't detected the new agent yet when the create ends.
    worktrees = { '#42': { ...started, agent: null } }
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
    assert.ok(view.find({ type: 'Text', text: 'Agent starting…' }))
    assert.equal(view.find({ type: 'Text', text: 'No agent running' }), null)

    worktrees = { '#42': started }
    await fire(view)
    assert.ok(view.find({ type: 'Text', text: 'Agent: claude' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    await view.unmount()
  })
})

/** `drawn`, while another act waits for a held request. That act draws nothing more until the
 *  request answers, so each turn asks for a draw with `rerender`, as Orca would draw a change.
 *  Returns the rerenders, which also wait for the held request: await them once it is released. */
async function drawnWhileHeld(view: TestPanel, query: TestQuery): Promise<Promise<void>[]> {
  const rerenders: Promise<void>[] = []
  await drawn(view, query, () => rerenders.push(view.rerender()))
  return rerenders
}

test('after a Start with an agent, no card says no agent is running before it says the agent is starting', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
    const refresh = held()
    let created = false
    const { view } = await showWith({
      'tasks.load': () => ready([task('#42')], { worktrees: created ? { '#42': { ...started, agent: null } } : {} }),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': async () => {
        await refresh.released
        return { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } }
      }
    })
    await view.press({ testId: 'start:#42' })
    // Orca hasn't detected the new agent yet when the create ends, and it switches to the new
    // worktree while the Start reads the worktrees again, so the list loads again meanwhile.
    created = true
    const ended = view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    const switched = view.emit('workspace.changed', { context: { branch: 'issue-42-add-dark-mode', displayName: 'web', terminals: [] } })
    const rerenders = await drawnWhileHeld(view, { type: 'Link', text: 'issue-42-add-dark-mode' })
    const flashed = view.find({ type: 'Text', text: 'No agent running' })
    const startingWhileRead = view.find({ type: 'Text', text: 'Agent starting…' })
    refresh.release()
    await Promise.all([ended, switched, ...rerenders])
    assert.equal(flashed, null)
    assert.ok(startingWhileRead)
    assert.ok(view.find({ type: 'Text', text: 'Agent starting…' }))
    assert.equal(pending(), 1)
    await view.unmount()
  })
})

test('after a Start with an agent that Orca already reports, the card shows it and reads the worktrees no more', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
    let worktrees = {}
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': () => ({ kind: 'ready', worktrees })
    })
    await view.press({ testId: 'start:#42' })
    worktrees = { '#42': started }
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    assert.ok(view.find({ type: 'Text', text: 'Agent: claude' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    assert.equal(pending(), 0)
    await view.unmount()
  })
})

test('after a Start with an agent that left no worktree, the card shows its error and no agent starting', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': { kind: 'ready', worktrees: {} }
    })
    await view.press({ testId: 'start:#42' })
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: false, message: 'Orca could not create the worktree.' })
    assert.ok(view.find({ type: 'Text', text: 'Orca could not create the worktree.' }))
    assert.ok(view.find({ testId: 'start:#42' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    assert.equal(pending(), 0)
    await view.unmount()
  })
})

test("after a Start with an agent whose worktree Orca doesn't list yet, the card shows Start and no agent starting", async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': { kind: 'ready', worktrees: {} }
    })
    await view.press({ testId: 'start:#42' })
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    assert.ok(view.find({ testId: 'start:#42' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    assert.equal(pending(), 0)
    await view.unmount()
  })
})

test("an earlier Start's delayed load in another project doesn't end the agent starting of a new Start", async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ fire, pending }) => {
    const refresh = held()
    let project = web
    let webReads = 0
    let apiAsked = false
    const { view } = await showWith({
      'tasks.load': () => ready([task('#42')], { project, worktrees: {} }),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': async ({ projectId }: { projectId: string }) => {
        if (projectId === web.id) return (webReads++, { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } })
        apiAsked = true
        await refresh.released
        return { kind: 'ready', worktrees: { '#42': { ...started, worktreeId: 'r2::/src/api-42', agent: null } } }
      }
    })
    await view.press({ testId: 'start:#42' })
    await view.post('start.ended', { projectId: web.id, taskKey: '#42', agent: 'claude', ok: true })
    project = api
    await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
    await view.press({ testId: 'start:#42' })
    const ended = view.post('start.ended', { projectId: api.id, taskKey: '#42', agent: 'claude', ok: true })
    for (let turns = 0; turns < 100 && !apiAsked; turns++) await turn()
    // The web Start's delayed load runs while the api Start reads the worktrees.
    const fired = fire(view)
    for (let turns = 0; turns < 100 && webReads < 2; turns++) await turn()
    assert.equal(webReads, 2)
    refresh.release()
    await Promise.all([ended, fired])
    assert.ok(view.find({ type: 'Text', text: 'Agent starting…' }))
    assert.equal(pending(), 1)
    await view.unmount()
  })
})

test('after a Start with "No agent", the card says no agent is running straight away', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
    let worktrees = {}
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': () => ({ kind: 'ready', worktrees })
    })
    await view.press({ testId: 'start:#42' })
    worktrees = { '#42': { ...started, agent: null } }
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: null, ok: true })
    assert.ok(view.find({ type: 'Text', text: 'No agent running' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    assert.equal(pending(), 0)
    await view.unmount()
  })
})

/** The panel after a Start whose agent Orca doesn't report yet, and how often it read the worktrees. */
async function startedWithoutAgentYet() {
  let reads = 0
  const { view } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.start': { ok: true, underWay: true },
    'worktrees.load': () => (reads++, { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } })
  })
  await view.press({ testId: 'start:#42' })
  await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
  return { view, reads: () => reads }
}

test('one delayed worktrees.load runs after a Start, and then the card shows what Orca reports', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ fire, pending }) => {
    const { view, reads } = await startedWithoutAgentYet()
    assert.equal(reads(), 1)
    assert.equal(pending(), 1)
    await fire(view)
    assert.equal(reads(), 2)
    assert.equal(pending(), 0)
    // Orca still reports no agent.
    assert.ok(view.find({ type: 'Text', text: 'No agent running' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    await view.unmount()
  })
})

test('once a reload reports the agent, the card shows what Orca reports from then on', async () => {
  await withTimeouts(AGENT_CHECK_MS, async () => {
    let loads = 0
    let agent: string | null = null
    const { view } = await showWith({
      'tasks.load': () => ready([task('#42')], { worktrees: ++loads === 1 ? {} : { '#42': { ...started, agent } } }),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } }
    })
    await view.press({ testId: 'start:#42' })
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    agent = 'claude'
    await view.press({ type: 'IconButton', label: 'Reload tasks' })
    assert.ok(view.find({ type: 'Text', text: 'Agent: claude' }))
    // The agent exits before the delayed load.
    agent = null
    await view.press({ type: 'IconButton', label: 'Reload tasks' })
    assert.ok(view.find({ type: 'Text', text: 'No agent running' }))
    await view.unmount()
  })
})

test("a Start's agent shows as starting only in its own project", async () => {
  await withTimeouts(AGENT_CHECK_MS, async () => {
    let project = web
    const { view } = await showWith({
      'tasks.load': () => ready([task('#42')], { project, worktrees: project === web ? {} : { '#42': { ...started, agent: null } } }),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } }
    })
    await view.press({ testId: 'start:#42' })
    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    assert.ok(view.find({ type: 'Text', text: 'Agent starting…' }))
    project = api
    await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
    assert.ok(view.find({ type: 'Heading', text: 'api' }))
    assert.ok(view.find({ type: 'Text', text: 'No agent running' }))
    await view.unmount()
  })
})

test('no delayed worktrees.load runs after the panel is deactivated', async () => {
  await withTimeouts(AGENT_CHECK_MS, async ({ fire, pending }) => {
    const { view, reads } = await startedWithoutAgentYet()
    assert.equal(pending(), 1)
    await view.unmount()
    assert.equal(pending(), 0)
    await fire(view)
    assert.equal(reads(), 1)
  })
})

/** How long the panel waits after a workspace is created or removed before it reads the worktrees. */
const WORKSPACE_REFRESH_MS = 300

const removed = { workspaceId: 'r1::/src/web-42', kind: 'worktree' as const, path: '/src/web-42' }
const created = { ...removed, branch: 'someone/issue-42-add-dark-mode' }

test('a removed worktree reads the worktrees again once, and its card shows Start again', async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire, pending }) => {
    const reads: unknown[] = []
    const { view } = await showWith({
      'tasks.load': ready([task('#42'), task('#7')], { worktrees: { '#42': started } }),
      'worktrees.load': (input) => (reads.push(input), { kind: 'ready', worktrees: {} })
    })
    assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
    await view.emit('workspace.removed', removed)
    assert.equal(pending(), 1)
    await fire(view)
    assert.deepEqual(reads, [{ projectId: 'github:acme/web' }])
    assert.equal(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }), null)
    assert.ok(view.find({ testId: 'start:#42' }))
    assert.ok(view.find({ testId: 'start:#7' }))
    await view.unmount()
  })
})

test('workspaces created and removed within the pause read the worktrees once', async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire, pending }) => {
    let reads = 0
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'worktrees.load': () => (reads++, { kind: 'ready', worktrees: {} })
    })
    await view.emit('workspace.created', created)
    await view.emit('workspace.removed', removed)
    await view.emit('workspace.created', { ...created, kind: 'folder' })
    await view.emit('workspace.removed', { ...removed, workspaceId: 'r1::/src/web-7' })
    assert.equal(pending(), 1)
    await fire(view)
    assert.equal(reads, 1)
    await view.unmount()
  })
})

test('a workspace event reads no worktrees while no project is listed, nor after the panel closes', async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire, pending }) => {
    let reads = 0
    const worktreesLoad = () => (reads++, { kind: 'ready' as const, worktrees: {} })
    const none = await showWith({ 'tasks.load': { kind: 'no-project' }, 'worktrees.load': worktreesLoad })
    await none.view.emit('workspace.removed', removed)
    await fire(none.view)
    await none.view.unmount()

    const closed = await showWith({ 'tasks.load': ready([task('#42')]), 'worktrees.load': worktreesLoad })
    await closed.view.emit('workspace.removed', removed)
    await closed.view.unmount()
    assert.equal(pending(), 0)
    assert.equal(reads, 0)
  })
})

test("a workspace event during a Start under way reads the worktrees but leaves that card's spinner", async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire }) => {
    let reads = 0
    const other = { worktreeId: 'r1::/src/web-7', name: 'issue-7-task-7', agent: null }
    const { view } = await showWith({
      'tasks.load': ready([task('#42'), task('#7')]),
      'task.start': { ok: true, underWay: true },
      // Orca lists the Start's new worktree before the create ends.
      'worktrees.load': () => (reads++, { kind: 'ready', worktrees: { '#42': { ...started, agent: null }, '#7': other } })
    })
    await view.press({ testId: 'start:#42' })
    await view.emit('workspace.created', created)
    await fire(view)
    assert.equal(reads, 1)
    assert.ok(view.find({ type: 'Link', text: 'issue-7-task-7' }))
    assert.ok(view.find({ type: 'Spinner', label: 'Starting #42' }))
    assert.ok(view.find({ type: 'Text', text: CAN_TAKE_A_MINUTE }))
    assert.equal(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }), null)

    await view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: 'claude', ok: true })
    assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
    assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
    assert.ok(view.find({ type: 'Text', text: 'Agent starting…' }))
    await view.unmount()
  })
})

test("a workspace event before a Start's task.start answers reads the worktrees but leaves that card's spinner", async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire, pending }) => {
    const start = held()
    let reads = 0
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': async () => {
        await start.released
        return { ok: true, underWay: true }
      },
      'worktrees.load': () => (reads++, { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } })
    })
    const pressed = view.press({ testId: 'start:#42' })
    await drawn(view, { type: 'Spinner', label: 'Starting #42' })
    // Every act waits for the held task.start, so the event and the pause run without awaiting.
    const emitted = view.emit('workspace.created', created)
    await until(() => pending() === 1, 'waited to read the worktrees')
    const fired = fire(view)
    await until(() => reads === 1, 'read the worktrees')
    start.release()
    await Promise.all([pressed, emitted, fired])
    assert.ok(view.find({ type: 'Spinner', label: 'Starting #42' }))
    assert.equal(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }), null)
    await view.unmount()
  })
})

test("a Start's error stays on its card after a workspace event reads the worktrees", async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire }) => {
    let reads = 0
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: false, message: "Couldn't read Orca's default agent — pick one in the panel." },
      'worktrees.load': () => (reads++, { kind: 'ready', worktrees: {} })
    })
    await view.press({ testId: 'start:#42' })
    await view.emit('workspace.removed', removed)
    await fire(view)
    assert.equal(reads, 2)
    assert.ok(view.find({ type: 'Text', text: "Couldn't read Orca's default agent — pick one in the panel." }))
    assert.ok(view.find({ testId: 'start:#42' }))
    await view.unmount()
  })
})

test("a workspace event's read that answers after a Start's own read doesn't undo its worktree", async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire }) => {
    const first = held()
    let reads = 0
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': async () => {
        // The event's read, asked before Orca listed the new worktree, answers last.
        const mine = ++reads
        if (mine === 1) await first.released
        const worktrees: Record<string, TaskWorktree> = mine === 1 ? {} : { '#42': { ...started, agent: null } }
        return { kind: 'ready', worktrees }
      }
    })
    await view.press({ testId: 'start:#42' })
    await view.emit('workspace.created', created)
    const fired = fire(view)
    await until(() => reads === 1, "read the worktrees for the event")
    const ended = view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: null, ok: true })
    await until(() => reads === 2, "read the worktrees for the Start's end")
    for (let turns = 0; turns < 5; turns++) await turn()
    first.release()
    await Promise.all([fired, ended])
    assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
    assert.equal(view.find({ testId: 'start:#42' }), null)
    await view.unmount()
  })
})

test("a workspace event's read while a Start reads its own end shows the new worktree", async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire, pending }) => {
    const first = held()
    let reads = 0
    const { view } = await showWith({
      'tasks.load': ready([task('#42')]),
      'task.start': { ok: true, underWay: true },
      'worktrees.load': async () => {
        // The Start's own read answers after the event's.
        if (++reads === 1) await first.released
        return { kind: 'ready', worktrees: { '#42': { ...started, agent: null } } }
      }
    })
    await view.press({ testId: 'start:#42' })
    const ended = view.post('start.ended', { projectId: 'github:acme/web', taskKey: '#42', agent: null, ok: true })
    await until(() => reads === 1, "read the worktrees for the Start's end")
    const emitted = view.emit('workspace.created', created)
    await until(() => pending() === 1, 'waited to read the worktrees')
    const fired = fire(view)
    await until(() => reads === 2, 'read the worktrees for the event')
    for (let turns = 0; turns < 5; turns++) await turn()
    first.release()
    await Promise.all([ended, emitted, fired])
    assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
    assert.equal(view.find({ testId: 'start:#42' }), null)
    await view.unmount()
  })
})

test('a workspace event during a reload reads the worktrees once the reload ends', async () => {
  await withTimeouts(WORKSPACE_REFRESH_MS, async ({ fire, pending }) => {
    const reload = held()
    let loads = 0
    let reads = 0
    const { view } = await showWith({
      'tasks.load': async () => {
        if (++loads === 2) await reload.released
        return ready([task('#42')], { worktrees: { '#42': started } })
      },
      'worktrees.load': () => (reads++, { kind: 'ready', worktrees: {} })
    })
    const pressed = view.press({ type: 'IconButton', label: 'Reload tasks' })
    await until(() => loads === 2, 'reloaded')
    const emitted = view.emit('workspace.removed', removed)
    await until(() => pending() === 1, 'waited to read the worktrees')
    const fired = fire(view)
    for (let turns = 0; turns < 5; turns++) await turn()
    assert.equal(reads, 0)
    assert.equal(pending(), 1)
    reload.release()
    await Promise.all([pressed, emitted, fired])
    await fire(view)
    assert.equal(reads, 1)
    assert.ok(view.find({ testId: 'start:#42' }))
    await view.unmount()
  })
})

const SITES = { kind: 'ready' as const, sites: [{ id: 'site-1', name: 'Example' }, { id: 'site-2', name: 'Other' }] }

test('whether Project settings is open is kept in memory only, and a panel opened again shows the list', async () => {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'tasks.load': ready([task('#42')]) } })
  const first = await mount(panel, { host })
  await first.press(gear)
  assert.deepEqual(first.persisted.plugin, {})
  assert.deepEqual(first.persisted.workspace, {})
  await first.unmount()
  const second = await mount(panel, { host })
  assert.equal(second.find(settingsTitle), null)
  assert.ok(second.find({ type: 'Link', text: '#42' }))
  await second.unmount()
})

test('a GitHub project shows GitHub as its tracker, without the "Choose a tracker" option', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), 'github')
  assert.deepEqual(optionLabels(view, 'Tracker'), ['GitHub', 'Jira (Orca connection)', 'Jira (twg)'])
  assert.equal(view.find({ type: 'Input', label: 'JQL' }), null)
  await view.unmount()
})

test('choosing Jira (Orca connection) saves it with the default JQL, shows its settings and reloads', async () => {
  let loads = 0
  let seen: unknown
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith({
    'tasks.load': () => {
      seen = host?.data().storage.settings
      return ++loads === 1 ? { kind: 'needs-config', project: notes } : ready([], { project: notes, provider: 'jira-orca' })
    },
    'jira.sites': SITES
  }))
  await view.select({ type: 'Select', label: 'Tracker' }, 'jira-orca')
  assert.equal(loads, 2)
  assert.deepEqual(seen, {
    version: 1,
    projects: {
      'repo:r1': {
        provider: 'jira-orca',
        providers: { 'jira-orca': { jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', siteId: '' } }
      }
    }
  })
  assert.equal(view.valueOf({ type: 'Input', label: 'JQL' }), 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')
  assert.equal(view.valueOf({ type: 'Select', label: 'Site' }), ':default')
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site', 'Example', 'Other'])
  assert.deepEqual(optionLabels(view, 'Tracker'), ['GitHub', 'Jira (Orca connection)', 'Jira (twg)'])
  assert.ok(view.find({ type: 'Text', text: /Connect Jira in Orca's settings/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

const jiraStored = (jql: string, siteId: string) => ({
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        provider: 'jira-orca',
        providers: { 'jira-orca': { jql, siteId }, 'jira-twg': { jql: 'project = OLD', site: '', profile: 'work' } }
      }
    }
  }
})

const jiraReady = (tasks: Task[] = []) => ready(tasks, { provider: 'jira-orca' })

test("the JQL and site save themselves, keeping the other providers' settings, and Enter reloads", async () => {
  let loads = 0
  const { view, host } = await showWith(
    { 'tasks.load': () => (loads++, jiraReady()), 'jira.sites': SITES },
    jiraStored('project = WEB', 'site-1')
  )
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Input', label: 'JQL' }), 'project = WEB')
  assert.equal(view.valueOf({ type: 'Select', label: 'Site' }), 'site-1')
  await view.type({ type: 'Input', label: 'JQL' }, 'project = API', { replace: true })
  await view.select({ type: 'Select', label: 'Site' }, 'site-2')
  await wait(800)
  assert.deepEqual(storedProject(host), {
    provider: 'jira-orca',
    providers: { 'jira-orca': { jql: 'project = API', siteId: 'site-2' }, 'jira-twg': { jql: 'project = OLD', site: '', profile: 'work' } }
  })
  const before = loads
  await view.submit({ type: 'Input', label: 'JQL' })
  assert.equal(loads, before + 1)
  await view.unmount()
})

test("a stored site that isn't connected any more stays selectable, and a site list failure is shown", async () => {
  const { view } = await showWith(
    { 'tasks.load': jiraReady(), 'jira.sites': { kind: 'error', message: 'orca failed: Orca is not running.' } },
    jiraStored('project = WEB', 'site-9')
  )
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Site' }), 'site-9')
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site', 'site-9'])
  assert.ok(view.find({ type: 'Text', text: /Orca is not running/ }))
  await view.unmount()
})

test('a load failure keeps the provider settings visible', async () => {
  const { view } = await showWith(
    { 'tasks.load': { kind: 'error', project: web, message: 'orca failed: Error 400: JQL no válida.' }, 'jira.sites': SITES },
    jiraStored('project = ', '')
  )
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), 'jira-orca')
  assert.equal(view.valueOf({ type: 'Input', label: 'JQL' }), 'project = ')
  await view.press(done)
  assert.ok(view.find({ type: 'Callout', text: /JQL no válida/ }))
  await view.unmount()
})

test('Project settings that opened by itself stays open once a load from it, or from its template detail, lists the tasks', async () => {
  let fixed = false
  const { view } = await showWith(
    { 'tasks.load': () => (fixed ? jiraReady([task('WEB-1', { tracker: 'jira' })]) : { kind: 'error', project: web, message: 'orca failed: Error 400.' }), 'jira.sites': SITES },
    jiraStored('project = ', '')
  )
  await view.type({ type: 'Input', label: 'JQL' }, 'project = WEB', { replace: true })
  fixed = true
  await view.submit({ type: 'Input', label: 'JQL' })
  assert.ok(view.find(settingsTitle))
  await view.press(done)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  await view.unmount()

  fixed = false
  const second = await showWith({ 'tasks.load': () => (fixed ? jiraReady() : { kind: 'error', project: web, message: 'orca failed.' }), 'jira.sites': SITES })
  await second.view.press({ type: 'IconButton', label: 'Edit template' })
  fixed = true
  await second.view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  await second.view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(second.view.find(settingsTitle))
  await second.view.unmount()
})

test('after a site list failure or no connected site, reloading the tasks asks for the sites again', async () => {
  const answers = [{ kind: 'error' as const, message: 'orca failed: Orca is not running.' }, { kind: 'ready' as const, sites: [] }, SITES]
  let asked = 0
  const { view } = await showWith(
    { 'tasks.load': jiraReady(), 'jira.sites': () => answers[Math.min(asked++, answers.length - 1)] },
    jiraStored('project = WEB', '')
  )
  const reloadAndOpen = async () => {
    await view.press(done)
    await view.press({ type: 'IconButton', label: 'Reload tasks' })
    await view.press(gear)
  }
  await view.press(gear)
  assert.ok(view.find({ type: 'Text', text: /Orca is not running/ }))
  await reloadAndOpen()
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site'])
  await reloadAndOpen()
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site', 'Example', 'Other'])
  await reloadAndOpen()
  assert.equal(asked, 3)
  await view.unmount()
})

const twgStored = (config: { jql: string; site: string; profile: string }) => ({
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        provider: 'jira-twg',
        providers: { 'jira-twg': config, 'jira-orca': { jql: 'project = OLD', siteId: 'site-1' } }
      }
    }
  }
})

const twgTask = (key: string) => task(key, { tracker: 'jira', url: `https://example.atlassian.net/browse/${key}`, status: 'To Do' })
const twgReady = (tasks: Task[], fields: Partial<Extract<TaskList, { kind: 'ready' }>> = {}) => ready(tasks, { provider: 'jira-twg', ...fields })

test('choosing Jira (twg) shows its stored JQL, Site and Profile fields, with the twg login hint', async () => {
  let loads = 0
  const { view, host } = await showWith(
    { 'tasks.load': () => (++loads === 1 ? ready([], { provider: 'jira-orca' }) : twgReady([])) },
    jiraStored('project = WEB', 'site-1')
  )
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Tracker' }, 'jira-twg')
  assert.equal(loads, 2)
  assert.equal(view.valueOf({ type: 'Input', label: 'JQL' }), 'project = OLD')
  assert.equal(view.valueOf({ type: 'Input', label: 'Site' }), '')
  assert.equal(view.valueOf({ type: 'Input', label: 'Profile' }), 'work')
  assert.equal(view.find({ type: 'Select', label: 'Site' }), null)
  assert.ok(view.find({ type: 'Text', text: /twg login/ }))
  assert.equal((storedProject(host) as { provider: string }).provider, 'jira-twg')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test("the twg JQL, site and profile save themselves, keeping the other providers' settings, and Enter reloads", async () => {
  let loads = 0
  const { view, host } = await showWith({ 'tasks.load': () => (loads++, twgReady([])) }, twgStored({ jql: 'project = WEB', site: '', profile: '' }))
  await view.press(gear)
  await view.type({ type: 'Input', label: 'JQL' }, 'project = API', { replace: true })
  await view.type({ type: 'Input', label: 'Site' }, 'example')
  await view.type({ type: 'Input', label: 'Profile' }, 'work')
  await wait(800)
  assert.deepEqual(storedProject(host), {
    provider: 'jira-twg',
    providers: { 'jira-twg': { jql: 'project = API', site: 'example', profile: 'work' }, 'jira-orca': { jql: 'project = OLD', siteId: 'site-1' } }
  })
  for (const label of ['JQL', 'Site', 'Profile']) {
    const before = loads
    await view.submit({ type: 'Input', label })
    assert.equal(loads, before + 1)
  }
  await view.unmount()
})

const keysShown = (view: TestPanel, keys: string[]) => keys.filter((key) => view.findAll({ type: 'Link', text: key }).length === 1)

test('"Load more" appends the next page without duplicate keys, and the loaded pages stay in place after a Start', async () => {
  const cursors: (string | undefined)[] = []
  const { view } = await showWith(
    {
      'tasks.load': ({ cursor }) => {
        cursors.push(cursor)
        if (!cursor) return twgReady([twgTask('WEB-1'), twgTask('WEB-2')], { nextCursor: 'cursor-2' })
        return twgReady([twgTask('WEB-2'), twgTask('WEB-3')], { nextCursor: null })
      },
      'task.start': { ok: true, underWay: false },
      'worktrees.load': { kind: 'ready', worktrees: { 'WEB-3': { worktreeId: 'r1::/src/web-3', name: 'web-3-task-web-3', agent: 'claude' } } }
    },
    twgStored({ jql: 'project = WEB', site: '', profile: '' })
  )
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1', 'WEB-2'])
  await view.press({ type: 'Button', text: 'Load more' })
  assert.deepEqual(cursors, [undefined, 'cursor-2'])
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1', 'WEB-2', 'WEB-3'])
  assert.equal(view.find({ type: 'Button', text: 'Load more' }), null)

  await view.press({ testId: 'start:WEB-3' })
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1', 'WEB-2', 'WEB-3'])
  assert.ok(view.find({ type: 'Link', text: 'web-3-task-web-3' }))
  assert.equal(cursors.length, 2)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a "Load more" failure keeps the loaded tasks and says why', async () => {
  const { view } = await showWith(
    {
      'tasks.load': ({ cursor }) =>
        cursor ? { kind: 'error', project: web, message: 'twg failed: The cursor has expired.' } : twgReady([twgTask('WEB-1')], { nextCursor: 'cursor-2' })
    },
    twgStored({ jql: 'project = WEB', site: '', profile: '' })
  )
  await view.press({ type: 'Button', text: 'Load more' })
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  assert.ok(view.find({ type: 'Text', text: /The cursor has expired/ }))
  assert.ok(view.find({ type: 'Button', text: 'Load more' }))
  await view.unmount()
})

test('a page that arrives after a reload is dropped', async () => {
  const reloaded = held()
  let reloads = 0
  let view: TestPanel | null = null
  ;({ view } = await showWith(
    {
      'tasks.load': async ({ cursor }) => {
        if (!cursor) {
          if (++reloads === 2) reloaded.release()
          return twgReady([twgTask(`WEB-${reloads * 10}`)], { nextCursor: 'cursor-2' })
        }
        // The person reloads while this page is on its way: it arrives after the reloaded list.
        void view?.press({ type: 'IconButton', label: 'Reload tasks' })
        await reloaded.released
        await turn()
        return twgReady([twgTask('WEB-99')])
      }
    },
    twgStored({ jql: 'project = WEB', site: '', profile: '' })
  ))
  await view.press({ type: 'Button', text: 'Load more' })
  await view.settled()
  assert.ok(view.find({ type: 'Link', text: 'WEB-20' }))
  assert.equal(view.find({ type: 'Link', text: 'WEB-99' }), null)
  await view.unmount()
})
