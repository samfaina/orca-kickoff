import { assert, hostError, mockHost, mount, test, type MockHost, type MockRequests, type TestPanel } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { Task, TaskList } from './protocol'
import * as panel from './panel'
import { DEFAULT_TEMPLATE } from './template'

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

test('a project without a provider shows the tracker settings, not an error', async () => {
  const view = await show({ kind: 'needs-config', project: { id: 'repo:r1', name: 'notes', repo: null } })
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No tracker for this project')
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), ':none')
  assert.deepEqual(optionLabels(view, 'Tracker'), ['Choose a tracker', 'GitHub', 'Jira (Orca connection)', 'Jira (twg)'])
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

test('Start options show the agent choice and the template with its variables', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  assert.equal(view.valueOf({ type: 'Select', label: 'Agent' }), 'orca-default')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Prompt template' }), DEFAULT_TEMPLATE)
  assert.ok(view.find({ type: 'Text', text: /\{\{task_description\}\}/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test("Start options show the project's stored agent and template", async () => {
  const storage = { settings: { version: 1, projects: { 'github:acme/web': { providers: {}, agent: 'none', template: '' } } } }
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storage)
  assert.equal(view.valueOf({ type: 'Select', label: 'Agent' }), 'none')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Prompt template' }), '')
  await view.unmount()
})

test('template and agent changes save themselves after a pause', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.type({ type: 'Textarea', label: 'Prompt template' }, 'Fix {{task_key}}', { replace: true })
  await view.select({ type: 'Select', label: 'Agent' }, 'codex')
  assert.equal(storedProject(host), undefined)
  await wait(800)
  assert.deepEqual(storedProject(host), { providers: {}, agent: 'codex', template: 'Fix {{task_key}}' })
  await view.unmount()
})

test('a pending change is saved before a Start', async () => {
  let seen: unknown
  const { view, host } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.start': () => {
      seen = storedProject(host)
      return { ok: true }
    },
    'worktrees.load': { kind: 'ready', worktrees: {} }
  })
  await view.type({ type: 'Textarea', label: 'Prompt template' }, 'Go {{task_url}}', { replace: true })
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(seen, { providers: {}, template: 'Go {{task_url}}' })
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
      return { ok: true }
    },
    'worktrees.load': { kind: 'ready', worktrees: { '#42': started } }
  })
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(starts, [{ projectId: 'github:acme/web', task: task('#42') }])
  assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
  assert.ok(view.find({ type: 'Text', text: /claude/ }))
  assert.equal(view.find({ testId: 'start:#42' }), null)
  assert.ok(view.find({ testId: 'start:#7' }))
  assert.equal(loads, 1)
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
  let during: { spinner: boolean; button: boolean } | null = null
  let view: TestPanel | null = null
  ;({ view } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.start': async () => {
      await wait(0)
      during = {
        spinner: view?.find({ type: 'Spinner', label: 'Starting #42' }) != null,
        button: view?.find({ testId: 'start:#42' }) != null
      }
      return { ok: true }
    },
    'worktrees.load': { kind: 'ready', worktrees: { '#42': started } }
  }))
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(during, { spinner: true, button: false })
  assert.equal(view.find({ type: 'Spinner', label: 'Starting #42' }), null)
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

test("Start is disabled while Orca's worktrees couldn't be read", async () => {
  const { view } = await showWith({
    'tasks.load': ready([task('#42')], { worktrees: null, worktreesError: 'orca failed: Orca is not running.' })
  })
  assert.equal(view.find({ testId: 'start:#42' })?.disabled, true)
  assert.ok(view.find({ type: 'Text', text: /Orca is not running/ }))
  await view.unmount()
})

const notes = { id: 'repo:r1', name: 'notes', repo: null }
const SITES = { kind: 'ready' as const, sites: [{ id: 'site-1', name: 'Example' }, { id: 'site-2', name: 'Other' }] }

/** The Tracker section closes once a list is loaded, unless the person left it open. */
const openTracker = (view: TestPanel) => view.toggle({ type: 'Collapsible', label: 'Tracker' })

test('the Tracker section is open while no list is loaded, and keeps how the person left it after', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  assert.equal(view.find({ type: 'Select', label: 'Tracker' }), null)
  await openTracker(view)
  assert.ok(view.find({ type: 'Select', label: 'Tracker' }))
  assert.deepEqual(view.persisted.plugin.trackerOpen, true)
  await view.unmount()
})

test('a GitHub project shows GitHub as its tracker, without the "Choose a tracker" option', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await openTracker(view)
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
  await openTracker(view)
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
  await openTracker(view)
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
  assert.ok(view.find({ type: 'Callout', text: /JQL no válida/ }))
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), 'jira-orca')
  assert.equal(view.valueOf({ type: 'Input', label: 'JQL' }), 'project = ')
  await view.unmount()
})

test('after a site list failure or no connected site, reloading the tasks asks for the sites again', async () => {
  const answers = [{ kind: 'error' as const, message: 'orca failed: Orca is not running.' }, { kind: 'ready' as const, sites: [] }, SITES]
  let asked = 0
  const { view } = await showWith(
    { 'tasks.load': jiraReady(), 'jira.sites': () => answers[Math.min(asked++, answers.length - 1)] },
    jiraStored('project = WEB', '')
  )
  await openTracker(view)
  assert.ok(view.find({ type: 'Text', text: /Orca is not running/ }))
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site'])
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site', 'Example', 'Other'])
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
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
  await openTracker(view)
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
  await openTracker(view)
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
      'task.start': { ok: true },
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
  let reloads = 0
  let view: TestPanel | null = null
  ;({ view } = await showWith(
    {
      'tasks.load': async ({ cursor }) => {
        if (!cursor) return twgReady([twgTask(`WEB-${++reloads * 10}`)], { nextCursor: 'cursor-2' })
        // The person reloads while this page is on its way.
        void view?.press({ type: 'IconButton', label: 'Reload tasks' })
        await wait(10)
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
