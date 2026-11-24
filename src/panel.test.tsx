import { afterEach, assert, hostError, mockHost, mount as mountUntracked, test, type MockHost, type MockRequests, type TestPanel, type TestQuery, type TreeSnapshot } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { AgentsResult, Task, TaskList, TaskWorktree } from './protocol'
import * as panel from './panel'
import { SAVE_DELAY_MS } from './settings-save'

/** The views the running test mounted and hasn't unmounted. A view left mounted keeps the panel's
 *  poll, a real `setInterval`, running, and then `orca plugin test` never exits. */
const mounted = new Set<TestPanel>()

/** `mount` from `orca/testing`, for a view that is unmounted when the test ends, passing or failing,
 *  or earlier when a fake-timer helper (`withIntervals`, `withTimeouts`) ends. That is how a test's
 *  views normally get unmounted: a test calls `unmount()` itself only when more work follows, such
 *  as another statement or the next loop iteration. */
const mount: typeof mountUntracked = async (target, options) => {
  const view = await mountUntracked(target, options)
  const unmount = view.unmount
  view.unmount = () => {
    mounted.delete(view)
    return unmount.call(view)
  }
  mounted.add(view)
  return view
}

/** Unmounts every view still mounted, each once. */
async function unmountAll(): Promise<void> {
  for (const view of [...mounted]) await view.unmount()
}

afterEach(unmountAll)

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
  filterId: 'open',
  queryCount: 1,
  worktrees: {},
  worktreesError: null,
  starting: [],
  warning: null,
  ...fields
})

async function show(answer: TaskList | ((input: { cursor?: string }) => TaskList | Promise<TaskList>)) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'tasks.load': answer, 'agents.load': availableAgents() } })
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
})

test('shows the status of tasks outside GitHub', async () => {
  const jira = task('WEB-12', { tracker: 'jira', url: 'https://example.atlassian.net/browse/WEB-12', status: 'In Progress' })
  const view = await show(ready([jira], { provider: 'jira-twg' }))
  assert.ok(view.find({ type: 'Badge', text: 'In Progress' }))
})

const searchField = { type: 'Input', label: 'Search tasks' }

/** The keys of `keys` whose card the panel shows, once each. */
const keysShown = (view: TestPanel, keys: string[]) => keys.filter((key) => view.findAll({ type: 'Link', text: key }).length === 1)

test('typing in the field above the list narrows the loaded tasks, as the text filter, to those whose key, title or label contains it', async () => {
  const view = await show(ready([task('#42', { title: 'Add dark mode', labels: ['ui'] }), task('#7', { title: 'Fix login' }), task('#8', { labels: ['UI polish'] })]))
  const field = view.find(searchField)
  assert.equal(field?.props.type, 'search')
  assert.equal(field?.props.labelHidden, true)
  assert.equal(field?.props.placeholder, 'Filter loaded tasks · Enter searches the tracker')
  assert.deepEqual(keysShown(view, ['#42', '#7', '#8']), ['#42', '#7', '#8'])

  await view.type(searchField, '  ui ')
  assert.deepEqual(keysShown(view, ['#42', '#7', '#8']), ['#42', '#8'])
  await view.type(searchField, 'LOGIN', { replace: true })
  assert.deepEqual(keysShown(view, ['#42', '#7', '#8']), ['#7'])
  await view.type(searchField, '', { replace: true })
  assert.deepEqual(keysShown(view, ['#42', '#7', '#8']), ['#42', '#7', '#8'])
  assert.deepEqual(view.warnings, [])
})

test('while the field is not blank, the hint says it filters the loaded tasks and that Enter searches the tracker', async () => {
  const github = await show(ready([task('#1'), task('#2')]))
  assert.equal(github.find({ type: 'Text', text: /^Filtering/ }), null)
  await github.type(searchField, 'dark')
  assert.equal(github.find({ type: 'Text', text: 'Filtering 2 loaded tasks · Enter searches GitHub' })?.props.muted, true)
  await github.type(searchField, '   ', { replace: true })
  assert.equal(github.find({ type: 'Text', text: /^Filtering/ }), null)
  await github.unmount()

  const jira = await show(ready([task('WEB-1', { tracker: 'jira' })], { provider: 'jira-twg', nextCursor: 'cursor-2' }))
  assert.equal(jira.find({ type: 'Text', text: /^Filtering/ }), null)
  await jira.type(searchField, 'dark')
  assert.ok(jira.find({ type: 'Text', text: 'Filtering 1 loaded tasks · Enter searches Jira' }))
})

const searchIn = (tracker: string) => ({ type: 'Button', text: `Search in ${tracker}` })
const clearSearch = { type: 'Button', text: 'Clear search' }

type LoadInput = { filterId?: string; cursor?: string; query?: string }

/** A panel whose `tasks.load` answers `list` without a query and `found(query)` with one, and the
 *  inputs it was asked with. */
async function showSearching(list: TaskList, found: (query: string, input: LoadInput) => TaskList | Promise<TaskList>) {
  const inputs: LoadInput[] = []
  const view = await show(async (input: LoadInput) => {
    inputs.push(input)
    return input.query === undefined ? list : found(input.query, input)
  })
  return { view, inputs }
}

test('Enter or "Search in GitHub" with a non-blank field asks the tracker for the trimmed words; a blank field asks nothing', async () => {
  const { view, inputs } = await showSearching(ready([task('#1'), task('#2')]), () => ready([task('#90')]))
  assert.equal(view.find(searchIn('GitHub')), null)
  await view.type(searchField, '   ')
  assert.equal(view.find(searchIn('GitHub')), null)
  await view.submit(searchField)
  assert.deepEqual(inputs, [{}])

  await view.type(searchField, '  dark mode ', { replace: true })
  await view.submit(searchField)
  assert.deepEqual(inputs, [{}, { query: 'dark mode' }])
  await view.press(searchIn('GitHub'))
  assert.deepEqual(inputs, [{}, { query: 'dark mode' }, { query: 'dark mode' }])
  assert.deepEqual(view.warnings, [])
  await view.unmount()

  const jira = await showSearching(ready([task('WEB-1', { tracker: 'jira' })], { provider: 'jira-orca' }), () => ready([], { provider: 'jira-orca' }))
  await jira.view.type(searchField, 'dark')
  await jira.view.press(searchIn('Jira'))
  assert.deepEqual(jira.inputs, [{}, { query: 'dark' }])
})

test('the results replace the list, without the text filter, under "Results in GitHub for" and Clear search', async () => {
  const { view } = await showSearching(ready([task('#1', { title: 'Dark mode' }), task('#2')]), () =>
    ready([task('#90', { title: 'Settings page' }), task('#91', { title: 'Theme' })])
  )
  await view.type(searchField, ' dark ')
  await view.submit(searchField)
  assert.deepEqual(keysShown(view, ['#1', '#2', '#90', '#91']), ['#90', '#91'])
  assert.ok(view.find({ type: 'Text', text: 'Results in GitHub for "dark"' }))
  assert.ok(view.find(clearSearch))
  assert.equal(view.find({ type: 'Text', text: /^Filtering/ }), null)
  assert.deepEqual(view.warnings, [])
})

test('a tracker search without results says that no task in the tracker matches', async () => {
  const github = await showSearching(ready([task('#1')]), () => ready([]))
  await github.view.type(searchField, 'nothing')
  await github.view.submit(searchField)
  assert.equal(github.view.find({ type: 'Text', text: 'No task in GitHub matches "nothing".' })?.props.muted, true)
  assert.equal(github.view.find({ type: 'EmptyState' }), null)
  assert.equal(github.view.find({ type: 'Link', text: '#1' }), null)
  await github.view.unmount()

  const jira = await showSearching(ready([], { provider: 'jira-twg' }), () => ready([], { provider: 'jira-twg' }))
  await jira.view.type(searchField, 'nothing')
  await jira.view.submit(searchField)
  assert.ok(jira.view.find({ type: 'Text', text: 'No task in Jira matches "nothing".' }))
  assert.ok(jira.view.find({ type: 'Text', text: 'Results in Jira for "nothing"' }))
})

test('editing the field or Clear search goes back to the loaded pages, with the text filter, without loading them again', async () => {
  const inputs: LoadInput[] = []
  const view = await show(({ cursor, query }: LoadInput) => {
    inputs.push(cursor === undefined ? { query } : { cursor, query })
    if (query !== undefined) return ready([task('WEB-90', { tracker: 'jira' })], { provider: 'jira-twg' })
    if (cursor) return ready([task('WEB-3', { tracker: 'jira', title: 'Login page' })], { provider: 'jira-twg' })
    return ready([task('WEB-1', { tracker: 'jira', title: 'Login form' }), task('WEB-2', { tracker: 'jira' })], { provider: 'jira-twg', nextCursor: 'cursor-2' })
  })
  await view.press({ type: 'Button', text: /· Load more$/ })
  const keys = ['WEB-1', 'WEB-2', 'WEB-3', 'WEB-90']
  await view.type(searchField, 'login')
  await view.submit(searchField)
  assert.deepEqual(keysShown(view, keys), ['WEB-90'])
  const asked = inputs.length

  await view.type(searchField, ' form')
  assert.equal(view.find({ type: 'Text', text: /^Results in/ }), null)
  assert.deepEqual(keysShown(view, keys), ['WEB-1'])
  assert.equal(view.valueOf(searchField), 'login form')

  await view.submit(searchField)
  assert.deepEqual(keysShown(view, keys), ['WEB-90'])
  await view.press(clearSearch)
  assert.equal(view.valueOf(searchField), '')
  assert.deepEqual(keysShown(view, keys), ['WEB-1', 'WEB-2', 'WEB-3'])
  assert.equal(view.find(clearSearch), null)
  assert.deepEqual(inputs, [{ query: undefined }, { cursor: 'cursor-2', query: undefined }, { query: 'login' }, { query: 'login form' }])
  assert.equal(inputs.length, asked + 1)
})

test('editing the field while a tracker search loads drops its answer and keeps the loaded pages, without loading them again', async () => {
  const answer = held()
  const inputs: LoadInput[] = []
  const view = await show(async ({ cursor, query }: LoadInput) => {
    inputs.push({ cursor, query })
    if (query !== undefined) {
      await answer.released
      return ready([task('#90')])
    }
    return cursor ? ready([task('#2')]) : ready([task('#1')], { nextCursor: 'cursor-2' })
  })
  await view.press({ type: 'Button', text: /· Load more$/ })
  await view.type(searchField, 'task')
  const submitted = view.submit(searchField)
  try {
    await drawn(view, { type: 'Spinner', label: 'Searching GitHub' })
    const typed = view.type(searchField, ' #')
    await turn()
    answer.release()
    await submitted
    await typed
  } finally {
    answer.release()
  }
  await view.settled()
  assert.equal(view.valueOf(searchField), 'task #')
  assert.deepEqual(keysShown(view, ['#1', '#2', '#90']), ['#1', '#2'])
  assert.equal(view.find({ type: 'Text', text: /^Results in/ }), null)
  assert.deepEqual(inputs, [
    { cursor: undefined, query: undefined },
    { cursor: 'cursor-2', query: undefined },
    { cursor: undefined, query: 'task' }
  ])
})

test('a change of active project seen by the poll leaves the tracker search before loading the new list', async () => {
  await withIntervals(async ({ tick }) => {
    let project = web
    const inputs: LoadInput[] = []
    const { view } = await showWith({
      'tasks.load': ({ query }) => {
        inputs.push({ query })
        return query === undefined ? ready([task(project === web ? '#1' : '#9')], { project }) : ready([task('#90')], { project })
      },
      'project.active': () => ({ projectId: project.id })
    })
    await view.type(searchField, 'dark')
    await view.submit(searchField)
    project = api
    await tick(view)
    assert.deepEqual(inputs, [{ query: undefined }, { query: 'dark' }, { query: undefined }])
    assert.equal(view.valueOf(searchField), '')
    assert.deepEqual(keysShown(view, ['#1', '#9', '#90']), ['#9'])
  })
})

test('while a tracker search loads, the list shows a spinner in place of the tasks', async () => {
  const answer = held()
  const { view } = await showSearching(ready([task('#1')]), async () => {
    await answer.released
    return ready([task('#90')])
  })
  await view.type(searchField, 'dark')
  const submitted = view.submit(searchField)
  await drawn(view, { type: 'Spinner', label: 'Searching GitHub' })
  const cardWhileLoading = view.find({ type: 'Link', text: '#1' })
  const titleWhileLoading = view.find({ type: 'Text', text: 'Results in GitHub for "dark"' })
  answer.release()
  await submitted
  assert.equal(cardWhileLoading, null)
  assert.ok(titleWhileLoading)
  assert.equal(view.find({ type: 'Spinner', label: 'Searching GitHub' }), null)
  assert.ok(view.find({ type: 'Link', text: '#90' }))
})

test('a failed tracker search shows like a load error, and Clear search goes back to the list', async () => {
  const { view } = await showSearching(ready([task('#1')]), () => ({ kind: 'error', project: web, message: 'gh failed: HTTP 502.' }))
  await view.type(searchField, 'dark')
  await view.submit(searchField)
  assert.ok(view.find({ type: 'Callout', text: /Couldn't load tasks.*HTTP 502/ }))
  assert.equal(view.find(settingsTitle), null)
  assert.equal(view.find({ type: 'Link', text: '#1' }), null)
  await view.press(clearSearch)
  assert.ok(view.find({ type: 'Link', text: '#1' }))
  assert.equal(view.find({ type: 'Callout' }), null)
})

test('a text filter that no loaded task matches says so, and an empty project still says it has no open tasks', async () => {
  const view = await show(ready([task('#42')]))
  await view.type(searchField, ' dark mode ')
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  assert.equal(view.find({ type: 'Text', text: 'No loaded task matches "dark mode".' })?.props.muted, true)
  assert.equal(view.find({ type: 'EmptyState' }), null)
  await view.unmount()

  const empty = await show(ready([]))
  await empty.type(searchField, 'dark')
  assert.equal(empty.find({ type: 'EmptyState' })?.label, 'No open tasks')
  assert.equal(empty.find({ type: 'Text', text: /No loaded task matches/ }), null)
})

test('only the list scrolls: the header, the warnings and the field stay above it, and Load more and the truncation notice end it', async () => {
  const view = await show(ready([task('#1'), task('#2')], { nextCursor: 'cursor-2', truncated: true, warning: 'Using the last known project (web).' }))
  const frame = view.tree()
  assert.ok(frame && typeof frame !== 'string')
  assert.equal(frame.type, 'Box')
  assertProps(frame, { direction: 'column', gap: 'sm', height: '100%' })
  const parts = elementsIn(frame)
  const scrolling = parts.filter((part) => part.props?.scroll !== undefined)
  assert.equal(scrolling.length, 1)
  const [list] = scrolling
  assert.equal(parts.at(-1), list)
  assertProps(list, { direction: 'column', gap: 'xs', grow: true, minHeight: 0, maxHeight: '100%', scroll: 'y' })
  assert.deepEqual(
    elementsIn(list).map(wordsOf),
    ['#1 Task #1', '#2 Task #2', 'Showing 2 · Load more', "Showing the first 100 of your repository's issues."]
  )
  const above = parts.slice(0, -1).map(wordsOf).join(' | ')
  assert.match(above, /Kickoff ·/)
  assert.match(above, /Using the last known project/)
  assert.equal(nodesIn(list, (node) => node.type === 'Input').length, 0)
  const searches = nodesIn(frame, (node) => node.type === 'Input' && node.props?.label === 'Search tasks')
  assert.equal(searches.length, 1)
  assert.deepEqual(view.warnings, [])
})

test('shows a spinner until the first list arrives', async () => {
  // The component alone, without `setup`, is the panel before its first answer.
  const before = await mount(panel.default, { host: mockHost({ capabilities: ['storage:own', 'workspace:read'] }) })
  assert.ok(before.find({ type: 'Spinner', label: 'Loading tasks' }))
  await before.unmount()

  const after = await show(ready([task('#1')]))
  assert.equal(after.find({ type: 'Spinner', label: 'Loading tasks' }), null)
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
})

/** The words in a drawn node and its descendants, as `TestElement.text` folds them. */
const wordsOf = (node: TreeSnapshot | string): string =>
  typeof node === 'string' ? node : (node.children ?? []).map(wordsOf).join('').replace(/\s+/g, ' ').trim()

/** The drawn nodes under `node`, itself included, that `match`. */
function nodesIn(node: TreeSnapshot | string | null, match: (node: TreeSnapshot) => boolean): TreeSnapshot[] {
  if (node === null || typeof node === 'string') return []
  return [...(match(node) ? [node] : []), ...(node.children ?? []).flatMap((child) => nodesIn(child, match))]
}

/** The card of the task `key`: the bordered `Box` around the link to it. */
function cardOf(view: TestPanel, key: string): TreeSnapshot {
  const holdsKey = (node: TreeSnapshot) => nodesIn(node, (inner) => inner.type === 'Link' && wordsOf(inner) === key).length > 0
  const [card] = nodesIn(view.tree(), (node) => node.type === 'Box' && node.props?.border === true && holdsKey(node))
  assert.ok(card, `no card for ${key}`)
  return card
}

/** The drawn elements directly under `node`, without its bare text: a card's rows, one per part. */
const elementsIn = (node: TreeSnapshot) => (node.children ?? []).filter((child): child is TreeSnapshot => typeof child !== 'string')

/** Checks the props of `node` that `expected` names, whatever other props it has. */
function assertProps(node: TreeSnapshot, expected: Record<string, unknown>): void {
  const named = Object.fromEntries(Object.keys(expected).map((name) => [name, node.props?.[name]]))
  assert.deepEqual(named, expected)
}

const badgesIn = (node: TreeSnapshot) => nodesIn(node, (inner) => inner.type === 'Badge').map((badge) => ({ text: wordsOf(badge), tone: badge.props?.tone }))

test('a GitHub card without a worktree shows its key and whole title, then its labels, then Start', async () => {
  const title = 'Add dark mode to every settings page, including the ones nobody opens'
  const view = await show(ready([task('#42', { title, labels: ['ui', 'good first issue'] })]))
  const card = cardOf(view, '#42')
  assertProps(card, { border: true, radius: 'md', padding: 'sm', direction: 'column', gap: 'sm', shrink: false })
  const [heading, meta, start, ...rest] = elementsIn(card)
  assert.equal(heading.type, 'Text')
  assert.equal(heading.props?.truncate, undefined)
  assert.equal(wordsOf(heading), `#42 ${title}`)
  assertProps(meta, { direction: 'row', wrap: true, gap: 'xs', align: 'center' })
  assert.deepEqual(badgesIn(meta), [
    { text: 'ui', tone: undefined },
    { text: 'good first issue', tone: undefined }
  ])
  assert.equal(start.props?.justify, 'end')
  assert.equal(nodesIn(start, (node) => node.key === 'start:#42').length, 1)
  assert.deepEqual(rest, [])
})

test('a Jira card without a worktree shows its status as an accent badge before its labels', async () => {
  const jira = task('WEB-12', { tracker: 'jira', url: 'https://example.atlassian.net/browse/WEB-12', status: 'In Progress', labels: ['ui'] })
  const view = await show(ready([jira], { provider: 'jira-twg' }))
  const [, meta] = elementsIn(cardOf(view, 'WEB-12'))
  assert.deepEqual(badgesIn(meta), [
    { text: 'In Progress', tone: 'accent' },
    { text: 'ui', tone: undefined }
  ])
})

/** A started task's worktree, running `claude`. */
const started = { worktreeId: 'r1::/src/web-42', name: 'issue-42-add-dark-mode', agent: 'claude' }

test('a card with a worktree shows its key and title, then the worktree as a truncated link, then its agent', async () => {
  const cases = [
    { key: '#42', list: ready([task('#42', { labels: ['ui'] })], { worktrees: { '#42': started } }) },
    {
      key: 'WEB-12',
      list: ready([task('WEB-12', { tracker: 'jira', status: 'In Progress', labels: ['ui'] })], { provider: 'jira-twg', worktrees: { 'WEB-12': started } })
    }
  ]
  for (const { key, list } of cases) {
    const view = await show(list)
    const card = cardOf(view, key)
    const [heading, name, agent, ...rest] = elementsIn(card)
    assert.equal(wordsOf(heading), `${key} Task ${key}`)
    assert.equal(name.type, 'Text')
    assert.equal(name.props?.truncate, true)
    assert.deepEqual(
      nodesIn(name, (node) => node.type === 'Link').map(wordsOf),
      ['issue-42-add-dark-mode']
    )
    assert.equal(wordsOf(agent), 'Agent: claude')
    assert.deepEqual(rest, [])
    assert.deepEqual(badgesIn(card), [])
    assert.equal(nodesIn(card, (node) => node.key === `start:${key}`).length, 0)
    await view.unmount()
  }
})

/** The words of the one line of the card of `key` that `pattern` matches, or null when it has none. */
function lineShown(view: TestPanel, key: string, pattern: RegExp): string | null {
  const lines = nodesIn(cardOf(view, key), (node) => node.type === 'Text' && pattern.test(wordsOf(node)))
  assert.ok(lines.length <= 1)
  return lines.length === 1 ? wordsOf(lines[0]) : null
}

/** The card's assignee line: "Assignee: <name>", "Assignees: <a>, <b>", or null when it has none. */
const assigneeShown = (view: TestPanel, key: string) => lineShown(view, key, /^Assignees?:/)

/** The card's agent line: "Agent: <id>", "Agent starting…", or null when it has none. */
const agentShown = (view: TestPanel, key: string) => lineShown(view, key, /^(Agent|No agent)/)

test('a card without a worktree shows its assignee as a small muted line after its labels, before Start', async () => {
  const view = await show(ready([task('#42', { labels: ['ui'], assignees: ['octocat'] })]))
  const [, meta, assignee, start, ...rest] = elementsIn(cardOf(view, '#42'))
  assert.deepEqual(badgesIn(meta), [{ text: 'ui', tone: undefined }])
  assert.equal(assignee.type, 'Text')
  assertProps(assignee, { size: 'sm', muted: true })
  assert.equal(wordsOf(assignee), 'Assignee: octocat')
  assert.equal(nodesIn(start, (node) => node.key === 'start:#42').length, 1)
  assert.deepEqual(rest, [])
})

test('a card with several assignees names them all, in the order the tracker gives', async () => {
  const view = await show(ready([task('#42', { assignees: ['octocat', 'hubot', 'monalisa'] })]))
  assert.equal(assigneeShown(view, '#42'), 'Assignees: octocat, hubot, monalisa')
})

test('a card shows its assignee on GitHub and Jira, after the status and labels or after the worktree, before the agent', async () => {
  const github = task('#42', { assignees: ['octocat'] })
  const jira = task('WEB-12', { tracker: 'jira', status: 'In Progress', assignees: ['Ana Example'] })
  const cases = [
    { key: '#42', list: ready([github]), rows: ['#42 Task #42', 'Assignee: octocat', ''] },
    { key: 'WEB-12', list: ready([jira], { provider: 'jira-twg' }), rows: ['WEB-12 Task WEB-12', 'In Progress', 'Assignee: Ana Example', ''] },
    { key: '#42', list: ready([github], { worktrees: { '#42': started } }), rows: ['#42 Task #42', 'issue-42-add-dark-mode', 'Assignee: octocat', 'Agent: claude'] },
    {
      key: 'WEB-12',
      list: ready([jira], { provider: 'jira-twg', worktrees: { 'WEB-12': started } }),
      rows: ['WEB-12 Task WEB-12', 'issue-42-add-dark-mode', 'Assignee: Ana Example', 'Agent: claude']
    }
  ]
  for (const { key, list, rows } of cases) {
    const view = await show(list)
    assert.deepEqual(elementsIn(cardOf(view, key)).map(wordsOf), rows)
    await view.unmount()
  }
})

test('a card without assignees has no assignee line, with or without a worktree', async () => {
  for (const list of [ready([task('#42')]), ready([task('#42')], { worktrees: { '#42': started } })]) {
    const view = await show(list)
    assert.equal(assigneeShown(view, '#42'), null)
    await view.unmount()
  }
})

test('a card whose worktree runs no agent shows no agent line', async () => {
  const view = await show(ready([task('#42')], { worktrees: { '#42': { worktreeId: 'r1::/src/web-42', name: 'issue-42-add-dark-mode', agent: null } } }))
  assert.equal(agentShown(view, '#42'), null)
  assert.equal(elementsIn(cardOf(view, '#42')).length, 2)
})

test('a card that can start ends its row with Run here, a terminal icon, then Start, a play icon, with no switch; both disabled without worktrees', async () => {
  const view = await show(ready([task('#42')]))
  const start = view.find({ type: 'IconButton', label: 'Start #42' })
  assert.ok(start)
  assert.equal(view.find({ testId: 'start:#42' })?.label, 'Start #42')
  assertProps(start, { icon: 'play', tooltip: 'Start in a new worktree' })
  assert.equal(start.disabled, false)
  const run = view.find({ type: 'IconButton', label: 'Run #42 here' })
  assert.ok(run)
  assert.equal(view.find({ testId: 'run-here:#42' })?.label, 'Run #42 here')
  assertProps(run, { icon: 'terminal', tooltip: 'Run here, in the selected worktree' })
  assert.equal(run.disabled, false)
  // Both are plain outline buttons, with no tone.
  assertProps(start, { variant: 'outline', tone: undefined })
  assertProps(run, { variant: 'outline', tone: undefined })
  const [, startRow] = elementsIn(cardOf(view, '#42'))
  assertProps(startRow, { direction: 'row', align: 'center', justify: 'end', gap: 'xs' })
  // With one template, the agent Select, 96 px wide, Run here, then Start, at the end of the row.
  const [agentHolder, runHolder, startHolder, ...others] = elementsIn(startRow)
  assertProps(agentHolder, { width: 96, shrink: false })
  assert.deepEqual(nodesIn(agentHolder, (node) => node.type === 'Select').map((node) => node.props?.label), ['Agent for #42'])
  assertProps(runHolder, { shrink: false })
  assert.deepEqual(nodesIn(runHolder, (node) => node.type === 'IconButton').map((node) => node.key), ['run-here:#42'])
  assertProps(startHolder, { shrink: false })
  assert.deepEqual(nodesIn(startHolder, (node) => node.type === 'IconButton').map((node) => node.key), ['start:#42'])
  assert.deepEqual(others, [])
  assert.equal(view.find({ type: 'Switch' }), null)
  assert.equal(view.find({ type: 'Button', text: 'Start' }), null)
  await view.unmount()

  const unread = await show(ready([task('#42')], { worktrees: null, worktreesError: 'orca failed.' }))
  assert.equal(unread.find({ type: 'IconButton', label: 'Start #42' })?.disabled, true)
  assert.equal(unread.find({ type: 'IconButton', label: 'Run #42 here' })?.disabled, true)
})

test('says when no project is selected', async () => {
  const view = await show({ kind: 'no-project' })
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No project selected')
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
})

test('the gear opens Project settings in place of the list, and Done goes back to the list', async () => {
  const view = await show(ready([task('#42')]))
  assert.equal(view.find(settingsTitle), null)
  await view.press(gear)
  assert.equal(view.find(settingsTitle)?.props.level, 3)
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  assert.equal(view.find(gear), null)
  // Done looks like the Prompt templates view's Save.
  const doneProps = view.find(done)?.props
  assert.deepEqual([doneProps?.variant, doneProps?.size, doneProps?.icon], ['solid', 'sm', undefined])
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
})

test('says when there are no open tasks', async () => {
  const view = await show(ready([]))
  assert.equal(view.find({ type: 'EmptyState' })?.label, 'No open tasks')
})

test("shows the tool's real message when loading fails", async () => {
  const message = "Couldn't find the GitHub CLI (gh). Install it from https://cli.github.com, then run `gh auth login`."
  const view = await show({ kind: 'error', project: web, message })
  await view.press(done)
  const callout = view.find({ type: 'Callout' })
  assert.ok(callout)
  assert.match(callout.text, /gh auth login/)
})

test("says so when Kickoff's worker doesn't answer", async () => {
  const view = await show(() => {
    throw hostError('timeout', 'Request timed out')
  })
  const callout = view.find({ type: 'Callout' })
  assert.ok(callout)
  assert.match(callout.text, /timeout/)
})

test('shows a warning next to the list', async () => {
  const view = await show(ready([task('#1')], { warning: 'Using the last known project (web). orca failed: Orca is not running.' }))
  assert.match(view.find({ type: 'Callout' })?.text ?? '', /Orca is not running/)
  assert.ok(view.find({ type: 'Link', text: '#1' }))
})

test('a truncated list says only the first 100 are shown', async () => {
  const github = await show(ready([task('#1')], { truncated: true }))
  assert.ok(github.find({ type: 'Text', text: "Showing the first 100 of your repository's issues." }))
  await github.unmount()

  const jira = await show(ready([task('WEB-1', { tracker: 'jira' })], { provider: 'jira-orca', truncated: true }))
  assert.ok(jira.find({ type: 'Text', text: 'Showing the first 100 tasks — narrow your JQL.' }))
})

test('reloads when the workspace changes, and on Reload', async () => {
  let calls = 0
  const view = await show(() => ready([task(`#${++calls}`)]))
  assert.ok(view.find({ type: 'Link', text: '#1' }))

  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  assert.ok(view.find({ type: 'Link', text: '#2' }))

  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.ok(view.find({ type: 'Link', text: '#3' }))
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
})

type TimerGlobal = 'setInterval' | 'clearInterval' | 'setTimeout' | 'clearTimeout'

/** Puts `fakes` in place of those timer globals while `body` runs. When `body` ends, even by
 *  failing, it unmounts the views still mounted while the fakes are in place, so each view clears
 *  its timers in the fakes. Then it puts the real timers back, even if an unmount fails. */
async function withFakeTimers<K extends TimerGlobal>(fakes: Pick<typeof globalThis, K>, body: () => Promise<void>): Promise<void> {
  const names = Object.keys(fakes) as K[]
  const real = Object.fromEntries(names.map((name) => [name, globalThis[name]])) as Pick<typeof globalThis, K>
  Object.assign(globalThis, fakes)
  try {
    await body()
  } finally {
    try {
      await unmountAll()
    } finally {
      Object.assign(globalThis, real)
    }
  }
}

/** Stands in for `setInterval` while `body` runs, so a test fires the panel's timers by hand:
 *  `tick()` runs every live interval once and waits for the panel to settle. When `body` ends, even
 *  by failing, it unmounts the views still mounted, then puts the real timers back. */
async function withIntervals(body: (timers: { tick: (view: TestPanel) => Promise<void>; live: () => number[] }) => Promise<void>) {
  const live = new Map<number, { run: () => void; ms: number }>()
  let next = 1
  const fakes = {
    setInterval: ((run: () => void, ms: number) => {
      live.set(next, { run, ms })
      return next++
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => void live.delete(id)) as unknown as typeof clearInterval
  }
  await withFakeTimers(fakes, () =>
    body({
      tick: async (view) => {
        for (const timer of [...live.values()]) timer.run()
        await view.settled()
      },
      live: () => [...live.values()].map((timer) => timer.ms)
    })
  )
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
})

test('the text filter stays through a reload and "Load more", and a change of active project clears it', async () => {
  let answer: (input: { cursor?: string }) => TaskList = ({ cursor }) =>
    cursor ? ready([task('#3', { title: 'Dark theme' }), task('#4')]) : ready([task('#1', { title: 'Dark mode' }), task('#2')], { nextCursor: 'cursor-2' })
  const view = await show((input) => answer(input))
  await view.type(searchField, 'dark')
  assert.deepEqual(view.persisted, { plugin: {}, workspace: {}, storage: {} })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(view.valueOf(searchField), 'dark')
  assert.deepEqual(keysShown(view, ['#1', '#2']), ['#1'])

  await view.press({ type: 'Button', text: /Load more/ })
  assert.equal(view.valueOf(searchField), 'dark')
  assert.deepEqual(keysShown(view, ['#1', '#2', '#3', '#4']), ['#1', '#3'])

  // A worker that didn't answer says nothing about the project, and a reload of it keeps the filter.
  answer = () => {
    throw hostError('timeout', 'Request timed out')
  }
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  answer = () => ready([task('#1', { title: 'Dark mode' }), task('#2')])
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(view.valueOf(searchField), 'dark')

  answer = () => ready([task('#9'), task('#10', { title: 'Dark mode' })], { project: api })
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  assert.equal(view.valueOf(searchField), '')
  assert.deepEqual(keysShown(view, ['#9', '#10']), ['#9', '#10'])

  // A project that lists no tasks counts as a change too.
  await view.type(searchField, 'dark')
  answer = () => ({ kind: 'no-project' })
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'nothing', terminals: [] } })
  answer = () => ready([task('#9'), task('#10', { title: 'Dark mode' })], { project: api })
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  assert.equal(view.valueOf(searchField), '')
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
  })
})

test('withIntervals unmounts a view the body left mounted and puts the real timers back when the body fails', async () => {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  let liveOnceDone = (): number[] => [-1]
  await assert.rejects(
    withIntervals(async ({ live }) => {
      const host = mockHost({
        capabilities: ['storage:own', 'workspace:read'],
        requests: { 'tasks.load': ready([task('#1')]), 'project.active': { projectId: web.id } }
      })
      await mount(panel, { host })
      assert.deepEqual(live(), [3000])
      liveOnceDone = live
      throw new Error('body failed')
    }),
    /body failed/
  )
  assert.deepEqual(liveOnceDone(), [])
  assert.equal(globalThis.setInterval, realSet)
  assert.equal(globalThis.clearInterval, realClear)
})

/** The panel with these worker answers and stored values, and its host. Unless `requests` says
 *  otherwise, Orca can start Claude, Codex and Gemini, Claude its default agent. */
async function showWith(requests: MockRequests, storage: Record<string, JsonValue> = {}) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'agents.load': availableAgents(), ...requests }, storage })
  return { view: await mount(panel, { host }), host }
}

const storedProject = (host: MockHost) => {
  const settings = host.data().storage.settings as { projects: Record<string, unknown> } | undefined
  return settings?.projects['github:acme/web']
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function optionLabels(view: TestPanel, label: string): string[] {
  const options = view.find({ type: 'Select', label })?.props.options as { label: string }[] | undefined
  return (options ?? []).map((option) => option.label)
}

test('Project settings show the agent choice, and the default template with "Manage templates" beside it, in the same row', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Agent' }), 'orca-default')
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 'default')
  assert.deepEqual(optionLabels(view, 'Default template'), ['Default'])
  const [row] = nodesIn(
    view.tree(),
    (node) => node.type === 'Box' && node.props?.direction === 'row' && nodesIn(node, (inner) => inner.props?.label === 'Default template').length > 0
  )
  const [select, button] = elementsIn(row)
  assertProps(select, { grow: true, minWidth: 0 })
  assert.deepEqual(nodesIn(select, (node) => node.type === 'Select').map((node) => node.props?.label), ['Default template'])
  assertProps(button, { shrink: false })
  assert.deepEqual(nodesIn(button, (node) => node.type === 'IconButton').map((node) => node.props?.label), ['Manage templates'])
  assertProps(view.find(manageTemplates)!, { icon: 'layers', tooltip: 'Manage templates', size: 'sm', variant: 'ghost' })
  // No preview of the default's text, no pencil and no + any more.
  assert.equal(view.find({ type: 'CodeView' }), null)
  assert.equal(view.find({ label: 'Edit template' }), null)
  assert.equal(view.find(newTemplate), null)
  assert.equal(view.find({ type: 'Textarea' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
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
})

/** `agents.load` with Claude, Codex and Gemini available, `defaultId` marked default. */
const availableAgents = (defaultId: string | null = 'claude', ids: string[] = ['claude', 'codex', 'gemini']): AgentsResult => ({
  kind: 'ready',
  agents: ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), default: id === defaultId }))
})

const agentSelect = { type: 'Select', label: 'Agent' }

function agentOptions(view: TestPanel): { value: string; label: string }[] {
  return (view.find(agentSelect)?.props.options as { value: string; label: string }[] | undefined) ?? []
}

const agentsNote = { type: 'Text', text: "Couldn't read Orca's agents." }

test("Project settings' Agent offers Orca default named after Orca's default agent, each available agent by name, then No agent", async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': availableAgents('codex') })
  await view.press(gear)
  assert.deepEqual(agentOptions(view), [
    { value: 'orca-default', label: 'Orca default (Codex)' },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'none', label: 'No agent' }
  ])
  assert.equal(view.find(agentsNote), null)
})

test('with no agent marked default, Orca default says it is not set', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': availableAgents(null) })
  await view.press(gear)
  assert.equal(agentOptions(view)[0].label, 'Orca default (not set)')
  assert.equal(view.valueOf(agentSelect), 'orca-default')
})

test("a stored agent that isn't available stays chosen, marked not available, and isn't changed", async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': availableAgents() }, stored({ agent: 'opencode' }))
  await view.press(gear)
  assert.equal(view.valueOf(agentSelect), 'opencode')
  assert.deepEqual(agentOptions(view).map((option) => option.label), ['Orca default (Claude)', 'Claude', 'Codex', 'Gemini', 'No agent', 'opencode (not available)'])
  await wait(800)
  assert.deepEqual(storedProject(host), { providers: {}, agent: 'opencode' })
})

test("when Orca's agents can't be read, Agent offers only Orca default, No agent and the stored choice, with a note", async () => {
  const failed = { kind: 'error', message: 'orca failed: Unknown command.' } as const
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': failed }, stored({ agent: 'codex' }))
  await view.press(gear)
  assert.deepEqual(agentOptions(view), [
    { value: 'orca-default', label: 'Orca default' },
    { value: 'none', label: 'No agent' },
    { value: 'codex', label: 'codex' }
  ])
  assert.equal(view.valueOf(agentSelect), 'codex')
  assert.equal(view.find(agentsNote)?.props.muted, true)
  await view.unmount()

  const silent = await showWith({
    'tasks.load': ready([task('#42')]),
    'agents.load': () => {
      throw hostError('timeout', 'No answer.')
    }
  })
  await silent.view.press(gear)
  assert.deepEqual(agentOptions(silent.view).map((option) => option.label), ['Orca default', 'No agent'])
  assert.ok(silent.view.find(agentsNote))
})

test("Orca's agents are read again each time Project settings opens and on Reload", async () => {
  let answer = availableAgents('claude')
  let asked = 0
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': () => (asked++, answer) })
  const before = asked
  answer = availableAgents('claude', ['claude', 'gemini'])
  await view.press(gear)
  assert.equal(asked, before + 1)
  assert.deepEqual(agentOptions(view).map((option) => option.label), ['Orca default (Claude)', 'Claude', 'Gemini', 'No agent'])
  await view.press(done)
  await view.press(gear)
  assert.equal(asked, before + 2)
  await view.press(done)
  answer = availableAgents(null, ['gemini'])
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(asked, before + 3)
  await view.press(gear)
  assert.deepEqual(agentOptions(view).map((option) => option.label), ['Orca default (not set)', 'Gemini', 'No agent'])
})

test('a project with a template stored before several templates shows it as "Default", unchanged', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ template: 'Fix {{task_key}}' }))
  await view.press(gear)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Default'])
  await view.press(manageTemplates)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Default')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Text' }), 'Fix {{task_key}}')
})

test('default template and agent changes save themselves after a pause', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.select({ type: 'Select', label: 'Agent' }, 'codex')
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, 't-triage')
  await wait(800)
  assert.deepEqual(storedProject(host), { providers: {}, templates: [implement, triage], defaultTemplateId: 't-impl', agent: 'codex' })
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
  assert.deepEqual(starts, [{ projectId: 'github:acme/web', task: task('#42'), templateId: 'default', agent: 'orca-default' }])
  assert.ok(view.find({ type: 'Link', text: 'issue-42-add-dark-mode' }))
  assert.ok(view.find({ type: 'Text', text: /claude/ }))
  assert.equal(view.find({ testId: 'start:#42' }), null)
  assert.ok(view.find({ testId: 'start:#7' }))
  assert.equal(loads, 1)
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
})

test('with two templates, the template Select fills the Start row before the agent Select, 96 px wide, Run here and Start', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  const [, startRow] = elementsIn(cardOf(view, '#42'))
  const [select, agent, run, start, ...rest] = elementsIn(startRow)
  assertProps(select, { grow: true, minWidth: 0 })
  assert.deepEqual(nodesIn(select, (node) => node.type === 'Select').map((node) => node.props?.label), ['Template for #42'])
  assertProps(agent, { width: 96, shrink: false })
  assert.deepEqual(nodesIn(agent, (node) => node.type === 'Select').map((node) => node.props?.label), ['Agent for #42'])
  assertProps(run, { shrink: false })
  assert.equal(nodesIn(run, (node) => node.key === 'run-here:#42').length, 1)
  assertProps(start, { shrink: false })
  assert.equal(nodesIn(start, (node) => node.key === 'start:#42').length, 1)
  assert.deepEqual(rest, [])
  assert.equal(view.find({ type: 'Switch' }), null)
  assert.deepEqual(view.warnings, [])
})

test('with one template, cards show no template Select', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  assert.equal(view.find(cardTemplate('#42')), null)
  assert.ok(view.find({ testId: 'start:#42' }))
})

/** The card's Start and Run here buttons of a task. */
const startButton = (key: string) => ({ testId: `start:${key}` })
const runHereButton = (key: string) => ({ testId: `run-here:${key}` })

/** The card's agent Select of a task. */
const cardAgent = (key: string) => ({ type: 'Select', label: `Agent for ${key}` })

test("with two or more available agents, the card offers an agent Select with short labels, starting at the project's agent choice", async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': availableAgents('codex') }, stored({ agent: 'gemini' }))
  assert.deepEqual(view.find(cardAgent('#42'))?.props.options, [
    { value: 'orca-default', label: 'Default' },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'none', label: 'None' }
  ])
  assert.equal(view.valueOf(cardAgent('#42')), 'gemini')
  assertProps(view.find(cardAgent('#42'))!, { labelHidden: true })
  await view.unmount()

  const unset = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': availableAgents('claude', ['claude', 'codex']) })
  assert.equal(unset.view.valueOf(cardAgent('#42')), 'orca-default')
  assert.deepEqual(optionLabels(unset.view, 'Agent for #42'), ['Default', 'Claude', 'Codex', 'None'])
})

test("with fewer than two available agents, or when Orca's agents can't be read, the card offers no agent Select", async () => {
  const lists: MockRequests['agents.load'][] = [
    availableAgents('claude', ['claude']),
    availableAgents(null, []),
    { kind: 'error', message: 'orca failed: Unknown command.' },
    () => {
      throw hostError('timeout', 'No answer.')
    }
  ]
  for (const agents of lists) {
    const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'agents.load': agents }, stored({ agent: 'codex' }))
    assert.ok(view.find(startButton('#42')))
    assert.equal(view.find(cardAgent('#42')), null)
    await view.unmount()
  }
})

test("a project agent that isn't available gives the card's Select an option labelled by its id, where it starts; another can be chosen", async () => {
  const starts: { agent?: string }[] = []
  const { view } = await showWith(
    { 'tasks.load': ready([task('#42')]), 'task.start': (input) => (starts.push(input), { ok: true, underWay: true }) },
    stored({ agent: 'opencode' })
  )
  assert.deepEqual(optionLabels(view, 'Agent for #42'), ['Default', 'Claude', 'Codex', 'Gemini', 'None', 'opencode'])
  assert.equal(view.valueOf(cardAgent('#42')), 'opencode')
  await view.select(cardAgent('#42'), 'codex')
  assert.equal(view.valueOf(cardAgent('#42')), 'codex')
  await view.press(startButton('#42'))
  assert.equal(starts[0].agent, 'codex')
})

test("Start and Run here launch the agent chosen on the card, other cards the project's agent choice, and Project settings don't change", async () => {
  const starts: { agent?: string }[] = []
  const runs: { agent?: string }[] = []
  const { view, host } = await showWith(
    {
      'tasks.load': ready([task('#42'), task('#7')]),
      'task.start': (input) => (starts.push(input), { ok: true, underWay: true }),
      'task.runHere': (input) => (runs.push(input), { ok: true })
    },
    stored({ agent: 'claude' })
  )
  await view.select(cardAgent('#42'), 'gemini')
  await view.press(runHereButton('#42'))
  await view.press(runHereButton('#7'))
  await view.press(startButton('#42'))
  await view.press(startButton('#7'))
  assert.deepEqual(runs.map((run) => run.agent), ['gemini', 'claude'])
  assert.deepEqual(starts.map((start) => start.agent), ['gemini', 'claude'])
  await wait(800)
  assert.deepEqual(storedProject(host), { providers: {}, agent: 'claude' })
  await view.press(gear)
  assert.equal(view.valueOf(agentSelect), 'claude')
})

test("the card's agent stays after a Run here, and falls back to the project's agent choice when it stops being available or the panel opens again", async () => {
  let agents = availableAgents()
  const runs: { agent?: string }[] = []
  const requests: MockRequests = {
    'tasks.load': ready([task('#42')]),
    'agents.load': () => agents,
    'task.runHere': (input) => (runs.push(input), { ok: true })
  }
  const { view } = await showWith(requests, stored({ agent: 'claude' }))
  await view.select(cardAgent('#42'), 'codex')
  await view.press(runHereButton('#42'))
  assert.equal(view.valueOf(cardAgent('#42')), 'codex')
  await view.press(runHereButton('#42'))
  assert.deepEqual(runs.map((run) => run.agent), ['codex', 'codex'])
  // A load of the list keeps it while Orca can still start it.
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(view.valueOf(cardAgent('#42')), 'codex')

  // Codex turned off in Orca: the next load of the list no longer offers it.
  agents = availableAgents('claude', ['claude', 'gemini'])
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(view.valueOf(cardAgent('#42')), 'claude')
  await view.press(runHereButton('#42'))
  assert.equal(runs[2].agent, 'claude')

  await view.select(cardAgent('#42'), 'gemini')
  await view.unmount()
  const again = await showWith(requests, stored({ agent: 'claude' }))
  assert.equal(again.view.valueOf(cardAgent('#42')), 'claude')
})

test('Run here follows the agent chosen on the card: "None" removes it, and an agent in a project set to No agent offers it', async () => {
  const offered = await showWith({ 'tasks.load': ready([task('#42'), task('#7')]) })
  await offered.view.select(cardAgent('#42'), 'none')
  assert.equal(offered.view.find(runHereButton('#42')), null)
  assert.ok(offered.view.find(startButton('#42')))
  assert.ok(offered.view.find(runHereButton('#7')))
  await offered.view.select(cardAgent('#42'), 'codex')
  assert.ok(offered.view.find(runHereButton('#42')))
  await offered.view.unmount()

  const runs: { agent?: string }[] = []
  const { view } = await showWith(
    { 'tasks.load': ready([task('#42'), task('#7')]), 'task.runHere': (input) => (runs.push(input), { ok: true }) },
    stored({ agent: 'none' })
  )
  assert.equal(view.valueOf(cardAgent('#42')), 'none')
  assert.equal(view.find(runHereButton('#42')), null)
  await view.select(cardAgent('#42'), 'codex')
  assert.ok(view.find(runHereButton('#42')))
  assert.equal(view.find(runHereButton('#7')), null)
  await view.press(runHereButton('#42'))
  assert.deepEqual(runs.map((run) => run.agent), ['codex'])
})

/** A template of the project's own, other than the initial one. */
const ship = { id: 't-ship', name: 'Ship', text: '/ship-tickets {{task_key}}' }

/** How the card's Start and Run here look: their variant and tone. */
function looksOf(view: TestPanel, key: string): { start: unknown[]; runHere: unknown[] } {
  const look = ({ variant, tone }: Record<string, unknown>) => [variant, tone]
  return { start: look(view.find(startButton(key))!.props), runHere: look(view.find(runHereButton(key))!.props) }
}
/** Both buttons plain outline, with no tone. */
const bothOutline = { start: ['outline', undefined], runHere: ['outline', undefined] }

test("Start and Run here are both outline with no tone, with one template and with several, and choosing another template in the card's Select doesn't change them", async () => {
  const one = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ templates: [ship], defaultTemplateId: 't-ship' }))
  assert.deepEqual(looksOf(one.view, '#42'), bothOutline)
  await one.view.unmount()

  const { view } = await showWith({ 'tasks.load': ready([task('#42'), task('#7')]) }, stored({ templates: [ship, implement], defaultTemplateId: 't-ship' }))
  assert.deepEqual(looksOf(view, '#42'), bothOutline)
  assert.deepEqual(looksOf(view, '#7'), bothOutline)
  await view.select(cardTemplate('#42'), 't-impl')
  assert.deepEqual(looksOf(view, '#42'), bothOutline)
  assert.deepEqual(looksOf(view, '#7'), bothOutline)
  await view.select(cardTemplate('#42'), 't-ship')
  assert.deepEqual(looksOf(view, '#42'), bothOutline)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('pressing Run here runs the task here with its template; the card keeps its look and nothing is stored', async () => {
  const runs: unknown[] = []
  const starts: unknown[] = []
  const { view, host } = await showWith({
    'tasks.load': ready([task('#42')]),
    'task.runHere': (input) => (runs.push(input), { ok: true }),
    'task.start': (input) => (starts.push(input), { ok: true, underWay: true })
  })
  const before = storedProject(host)
  await view.press(runHereButton('#42'))
  assert.deepEqual(runs, [{ projectId: 'github:acme/web', task: task('#42'), templateId: 'default', agent: 'orca-default' }])
  assert.deepEqual(starts, [])
  assert.deepEqual(looksOf(view, '#42'), bothOutline)
  assert.deepEqual(storedProject(host), before)
})

test("pressing Start starts the task with the card's template; nothing is stored", async () => {
  const starts: unknown[] = []
  const runs: unknown[] = []
  const { view, host } = await showWith(
    {
      'tasks.load': ready([task('#42')]),
      'task.start': (input) => (starts.push(input), { ok: true, underWay: true }),
      'task.runHere': (input) => (runs.push(input), { ok: true })
    },
    stored({ templates: [ship], defaultTemplateId: 't-ship' })
  )
  await view.press(startButton('#42'))
  assert.deepEqual(starts, [{ projectId: 'github:acme/web', task: task('#42'), templateId: 't-ship', agent: 'orca-default' }])
  assert.deepEqual(runs, [])
  assert.deepEqual((storedProject(host) as { templates: unknown[] }).templates, [ship])
})

test('while Run here runs, a spinner "Running #42 here" takes the place of the Start row; a success leaves the card as it was', async () => {
  const run = held()
  let worktreeLoads = 0
  const { view } = await showWith(
    {
      'tasks.load': ready([task('#42'), task('#7')]),
      'task.runHere': async () => {
        await run.released
        return { ok: true }
      },
      'worktrees.load': () => (worktreeLoads++, { kind: 'ready', worktrees: {} })
    },
    stored({ templates: [ship], defaultTemplateId: 't-ship' })
  )
  const pressed = view.press(runHereButton('#42'))
  await drawn(view, { type: 'Spinner', label: 'Running #42 here' })
  const [, spinner, ...rest] = elementsIn(cardOf(view, '#42'))
  assert.equal(spinner.type, 'Spinner')
  assert.deepEqual(rest, [])
  assert.equal(view.find(runHereButton('#42')), null)
  assert.equal(view.find(startButton('#42')), null)
  assert.ok(view.find(runHereButton('#7')))
  run.release()
  await pressed
  assert.equal(view.find({ type: 'Spinner', label: 'Running #42 here' }), null)
  assert.ok(view.find(runHereButton('#42')))
  assert.equal(view.find({ type: 'Text', text: /Creating the worktree/ }), null)
  assert.equal(worktreeLoads, 0)
})

test('two presses of Run here ask the worker once', async () => {
  const run = held()
  let runs = 0
  const { view } = await showWith(
    {
      'tasks.load': ready([task('#42')]),
      'task.runHere': async () => {
        runs++
        await run.released
        return { ok: true }
      }
    },
    stored({ templates: [ship], defaultTemplateId: 't-ship' })
  )
  const presses = Promise.all([view.press(runHereButton('#42')), view.press(runHereButton('#42'))])
  await drawn(view, { type: 'Spinner', label: 'Running #42 here' })
  run.release()
  await presses
  assert.equal(runs, 1)
})

test('a Run here of a closed panel that answers late leaves the spinner of the panel opened again', async () => {
  const first = held()
  const second = held()
  let runs = 0
  const requests: MockRequests = {
    'tasks.load': ready([task('#42')]),
    'task.runHere': async () => {
      await (++runs === 1 ? first : second).released
      return { ok: true }
    }
  }
  const { view } = await showWith(requests, stored({ templates: [ship] }))
  const pressed = view.press(runHereButton('#42'))
  await drawn(view, { type: 'Spinner', label: 'Running #42 here' })

  // Mounting again ends the first view and opens the panel afresh, as Orca does.
  const again = await showWith(requests, stored({ templates: [ship] }))
  const pressedAgain = again.view.press(runHereButton('#42'))
  await drawn(again.view, { type: 'Spinner', label: 'Running #42 here' })
  assert.equal(runs, 2)
  first.release()
  await pressed
  // Drawn while the second Run here is still held.
  const redrawn = again.view.rerender()
  for (let turns = 0; turns < 5; turns++) await turn()
  const spinnerAfterFirst = again.view.find({ type: 'Spinner', label: 'Running #42 here' })
  second.release()
  await Promise.all([redrawn, pressedAgain])
  assert.ok(spinnerAfterFirst)
  assert.equal(again.view.find({ type: 'Spinner', label: 'Running #42 here' }), null)
})

test("a failed Run here shows the worker's message on the card, as a failed Start does, and the next one clears it", async () => {
  let answer: { ok: true } | { ok: false; message: string } = { ok: false, message: "The worktree selected in Orca isn't one of web. Select a worktree of web to run #42 here." }
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]), 'task.runHere': () => answer }, stored({ templates: [ship], defaultTemplateId: 't-ship' }))
  await view.press(runHereButton('#42'))
  const error = view.find({ type: 'Text', text: /^The worktree selected in Orca isn't one of web/ })
  assert.equal(error?.props.tone, 'danger')
  assert.ok(view.find(runHereButton('#42')))
  answer = { ok: true }
  await view.press(runHereButton('#42'))
  assert.equal(view.find({ type: 'Text', text: /^The worktree selected in Orca/ }), null)
})

test("a Run here the worker doesn't answer says so on the card", async () => {
  const { view } = await showWith(
    {
      'tasks.load': ready([task('#42')]),
      'task.runHere': () => {
        throw hostError('timeout', 'Request timed out')
      }
    },
    stored({ templates: [ship], defaultTemplateId: 't-ship' })
  )
  await view.press(runHereButton('#42'))
  assert.ok(view.find({ type: 'Text', text: "Kickoff's worker didn't answer (timeout). Look in Orca whether an agent started for #42." }))
})

test('with the agent choice "No agent", a card has no Run here, only Start, outline, and no note', async () => {
  const starts: unknown[] = []
  const { view } = await showWith(
    { 'tasks.load': ready([task('#42')]), 'task.start': (input) => (starts.push(input), { ok: true, underWay: true }) },
    stored({ templates: [ship], defaultTemplateId: 't-ship', agent: 'none' })
  )
  assert.equal(view.find(runHereButton('#42')), null)
  assertProps(view.find(startButton('#42'))!, { icon: 'play', variant: 'outline', tone: undefined })
  const [, startRow, ...rest] = elementsIn(cardOf(view, '#42'))
  assert.deepEqual(nodesIn(startRow, (node) => node.type === 'IconButton').map((node) => node.key), ['start:#42'])
  assert.deepEqual(rest, [])
  assert.equal(view.find({ type: 'Text', text: /needs an agent/ }), null)
  await view.press(startButton('#42'))
  assert.deepEqual(starts, [{ projectId: 'github:acme/web', task: task('#42'), templateId: 't-ship', agent: 'none' }])
})

test("a started task's card has neither Start nor Run here", async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')], { worktrees: { '#42': started } }) }, stored({ templates: [ship], defaultTemplateId: 't-ship' }))
  assert.equal(view.find(startButton('#42')), null)
  assert.equal(view.find(runHereButton('#42')), null)
  assert.equal(view.find({ type: 'Switch' }), null)
})

test('a change of default template shows in the cards without a choice of their own', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42'), task('#7')]) }, twoTemplates)
  await view.select(cardTemplate('#7'), 't-triage')
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  assert.equal(view.valueOf(cardTemplate('#7')), 't-triage')
})

test("a card's template choice survives a reload", async () => {
  let loads = 0
  const { view } = await showWith({ 'tasks.load': () => (loads++, ready([task('#42')])) }, twoTemplates)
  await view.select(cardTemplate('#42'), 't-impl')
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(loads, 2)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
})

const saveButton = { type: 'Button', text: 'Save' }

/** How long Delete waits for its second click. */
const CONFIRM_DELETE_MS = 4_000

/** The header button that opens the Prompt templates view, and the one beside the Default template
 *  `Select` of Project settings. */
const promptTemplates = { type: 'IconButton', label: 'Prompt templates' }
const manageTemplates = { type: 'IconButton', label: 'Manage templates' }
const templatesTitle = { type: 'Heading', text: 'Prompt templates' }
const templateSelect = { type: 'Select', label: 'Template' }
const newTemplate = { type: 'IconButton', label: 'New template' }
const cancelButton = { type: 'Button', text: 'Cancel' }

test('the header has "Prompt templates", with the layers icon, between Reload tasks and Project settings', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  const header = elementsIn(view.tree() as TreeSnapshot)[0]
  assert.deepEqual(
    nodesIn(header, (node) => node.type === 'IconButton').map((node) => node.props?.label),
    ['Reload tasks', 'Prompt templates', 'Project settings']
  )
  assertProps(view.find(promptTemplates)!, { icon: 'layers', tooltip: 'Prompt templates', size: 'sm', variant: 'ghost' })
  assert.deepEqual(view.warnings, [])
})

test('"Prompt templates" opens the view on the default template, in place of the list, and Cancel and Save go back to the list', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  const backInList = () => {
    assert.equal(view.find(templatesTitle), null)
    assert.equal(view.find(settingsTitle), null)
    assert.ok(view.find({ type: 'Link', text: '#42' }))
  }
  await view.press(promptTemplates)
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find(templatesTitle)?.props.level, 3)
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  assert.equal(view.valueOf(templateSelect), 't-triage')
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Triage')
  await view.press(cancelButton)
  backInList()

  await view.press(promptTemplates)
  await view.press(saveButton)
  backInList()
  assert.deepEqual(view.errors, [])
})

test('"Manage templates" opens the view on the default template, and Cancel and Save go back to Project settings', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  const backInSettings = () => {
    assert.equal(view.find(templatesTitle), null)
    assert.ok(view.find(settingsTitle))
    assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  }

  await view.press(manageTemplates)
  assert.ok(view.find(templatesTitle))
  assert.equal(view.valueOf(templateSelect), 't-triage')
  await view.press(newTemplate)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  backInSettings()
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Triage', 'Review'])

  await view.press(manageTemplates)
  await view.press(cancelButton)
  backInSettings()
})

test('after the view opened from the list, a load that needs Project settings still opens them by itself', async () => {
  let failing = false
  const { view } = await showWith(
    { 'tasks.load': () => (failing ? { kind: 'error', project: web, message: 'gh failed.' } : ready([task('#42')])) },
    twoTemplates
  )
  await view.press(promptTemplates)
  await view.press(cancelButton)
  assert.ok(view.find({ type: 'Link', text: '#42' }))
  failing = true
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.ok(view.find(settingsTitle))
})

test('the title says "Prompt templates" after the project\'s name, also on a new template', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find(templatesTitle)?.props.level, 3)
  assert.equal(view.find({ type: 'Heading', text: 'web' }), null)
  await view.press(newTemplate)
  assert.equal(view.find(templatesTitle)?.props.level, 3)
  assert.equal(view.find({ type: 'Heading', text: 'New template' }), null)
})

test('the Template Select lists every template, own first then global, marked Global, and + beside it adds one', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement, triage], defaultTemplateId: 't-triage' }, [review]))
  await view.press(promptTemplates)
  const { picker } = viewParts(view)
  assertProps(picker, { direction: 'row', align: 'center' })
  const [select, plus] = elementsIn(picker)
  assertProps(select, { grow: true, minWidth: 0 })
  assertProps(plus, { shrink: false })
  assert.equal(view.find(templateSelect)?.props.labelHidden, true)
  assert.deepEqual(optionLabels(view, 'Template'), ['Implement', 'Triage', 'Review (Global)'])
  assertProps(view.find(newTemplate)!, { icon: 'add', tooltip: 'New template', size: 'sm', variant: 'ghost' })
  await view.press(newTemplate)
  assert.deepEqual(optionLabels(view, 'Template'), ['New template', 'Implement', 'Triage', 'Review (Global)'])
  assert.equal(optionLabels(view, 'Template')[0], 'New template')
  assert.deepEqual(view.warnings, [])
})

test('any template can be chosen and edited without changing the default template', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement, triage], defaultTemplateId: 't-triage' }, [review]))
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-impl')
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Implement')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Text' }), '/acme-skills:tdd {{task_url}}')
  assert.equal(view.find(defaultSwitch)?.props.checked, false)
  await view.select(templateSelect, 't-review')
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Review')
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  await view.type({ type: 'Textarea', label: 'Text' }, 'Look at {{task_key}}', { replace: true })
  await view.press(saveButton)
  assert.deepEqual(storedGlobal(host), [{ ...review, text: 'Look at {{task_key}}' }])
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, 't-triage')
  assert.equal(view.valueOf(cardTemplate('#42')), 't-triage')
})

const defaultSwitch = { type: 'Switch', label: 'Default template' }

test('the Default template switch makes the template the default on Save, and is on and disabled on the current default', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  assert.equal(view.find(defaultSwitch)?.props.checked, true)
  assert.equal(view.find(defaultSwitch)?.disabled, true)
  await view.select(templateSelect, 't-impl')
  assert.equal(view.find(defaultSwitch)?.props.checked, false)
  assert.equal(view.find(defaultSwitch)?.disabled, false)
  await view.toggle(defaultSwitch)
  assert.equal(view.find(defaultSwitch)?.props.checked, true)
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, 't-triage')

  await view.press(saveButton)
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, 't-impl')
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  await view.press(promptTemplates)
  assert.equal(view.valueOf(templateSelect), 't-impl')
  assert.equal(view.find(defaultSwitch)?.disabled, true)
})

test('a new template made the default template is the default once saved', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  await view.press(newTemplate)
  assert.equal(view.find(defaultSwitch)?.props.checked, false)
  assert.equal(view.find(defaultSwitch)?.disabled, false)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.toggle(defaultSwitch)
  await view.press(saveButton)
  const { templates, defaultTemplateId } = storedProject(host) as { templates: { id: string; name: string }[]; defaultTemplateId: string }
  assert.equal(templates[2].name, 'Review')
  assert.equal(defaultTemplateId, templates[2].id)
})

test('a template stored with newWorktree: false opens like any other, with no New worktree switch or note, and its Save writes it without the field', async () => {
  const { view, host } = await showWith(
    { 'tasks.load': ready([task('#42')]) },
    stored({ templates: [{ ...implement, newWorktree: false }, triage], defaultTemplateId: 't-impl' })
  )
  assert.deepEqual(looksOf(view, '#42'), bothOutline)
  await view.press(promptTemplates)
  assert.equal(view.find({ type: 'Switch', label: 'New worktree' }), null)
  assert.equal(view.find({ type: 'Text', text: /without a new worktree/ }), null)
  await view.type({ type: 'Input', label: 'Name' }, ' 2')
  await view.press(saveButton)
  assert.deepEqual((storedProject(host) as { templates: unknown[] }).templates, [{ ...implement, name: 'Implement 2' }, triage])
})

/** The bar under the form: its text and its buttons. */
const barOf = (view: TestPanel) => {
  const { bar } = viewParts(view)
  assert.ok(bar)
  return { words: nodesIn(bar, (node) => node.type === 'Text').map(wordsOf), buttons: buttonsIn(bar) }
}

test('choosing another template, or +, with unsaved changes asks first; Keep editing keeps the draft, and Discard switches', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  await view.type({ type: 'Input', label: 'Name' }, 'Triage now', { replace: true })
  await view.select(templateSelect, 't-impl')
  assert.deepEqual(barOf(view), { words: ['Discard your changes to Triage?'], buttons: ['Keep editing', 'Discard'] })
  assert.equal(view.find(templateSelect)?.props.value, 't-triage')
  assert.equal(view.find(templateSelect)?.disabled, true)
  assert.equal(view.find(newTemplate)?.disabled, true)

  await view.press({ type: 'Button', text: 'Keep editing' })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Triage now')
  assert.deepEqual(barOf(view).buttons, ['Delete template'])
  assert.equal(view.find(templateSelect)?.disabled, false)

  await view.press(newTemplate)
  assert.deepEqual(barOf(view).buttons, ['Keep editing', 'Discard'])
  await view.press({ type: 'Button', text: 'Discard' })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), '')
  assert.equal(optionLabels(view, 'Template')[0], 'New template')

  // A change to a new template asks too, naming it as new.
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.select(templateSelect, 't-impl')
  assert.deepEqual(barOf(view).words, ['Discard your changes to the new template?'])
  await view.press({ type: 'Button', text: 'Discard' })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Implement')
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
})

test('without unsaved changes another template, or +, opens at once, and a change of the Global or Default template switch counts as one', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-impl')
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Implement')
  await view.press(newTemplate)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), '')
  await view.select(templateSelect, 't-impl')
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Implement')
  // A name typed and typed back is no change.
  await view.type({ type: 'Input', label: 'Name' }, 'Build', { replace: true })
  await view.type({ type: 'Input', label: 'Name' }, 'Implement', { replace: true })
  await view.select(templateSelect, 't-triage')
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Triage')

  await view.select(templateSelect, 't-impl')
  await view.toggle(globalSwitch)
  await view.select(templateSelect, 't-triage')
  assert.deepEqual(barOf(view).words, ['Discard your changes to Implement?'])
  await view.press({ type: 'Button', text: 'Discard' })
  await view.select(templateSelect, 't-impl')
  await view.toggle(defaultSwitch)
  await view.press(newTemplate)
  assert.deepEqual(barOf(view).words, ['Discard your changes to Implement?'])
})

/** The parts of the Prompt templates view: its title row, the Template `Select` with +, its form, and
 *  the bar under the form when it has one. */
function viewParts(view: TestPanel) {
  const frame = view.tree()
  assert.ok(frame && typeof frame !== 'string')
  assert.equal(frame.type, 'Box')
  assertProps(frame, { direction: 'column', height: '100%' })
  const [title, picker, form, bar, ...extra] = elementsIn(frame) as (TreeSnapshot | undefined)[]
  assert.ok(title && picker && form)
  assert.deepEqual(extra, [])
  return { frame, title, picker, form, bar }
}

/** The parts of the filter editor and of what + offers on Jira: the title row, the form, and the
 *  Delete bar when there is one. */
function editorParts(view: TestPanel) {
  const frame = view.tree()
  assert.ok(frame && typeof frame !== 'string')
  assert.equal(frame.type, 'Box')
  assertProps(frame, { direction: 'column', height: '100%' })
  const [title, form, deleteBar, ...extra] = elementsIn(frame) as (TreeSnapshot | undefined)[]
  assert.ok(title && form)
  assert.deepEqual(extra, [])
  return { frame, title, form, deleteBar }
}

/** The text of each button under `node`, in order. */
const buttonsIn = (node: TreeSnapshot) => nodesIn(node, (inner) => inner.type === 'Button').map(wordsOf)

/** The button under `node` whose text is `text`. */
function buttonIn(node: TreeSnapshot, text: string): TreeSnapshot {
  const [button] = nodesIn(node, (inner) => inner.type === 'Button' && wordsOf(inner) === text)
  assert.ok(button, `no button "${text}"`)
  return button
}

test('Cancel and Save are on the right of the title row, the Template Select is under it, and only the form scrolls, from Name to "Run a skill"', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  const { frame, title, picker, form, bar } = viewParts(view)
  assert.deepEqual(nodesIn(title, (node) => node.type === 'Text' || node.type === 'Heading').map(wordsOf), ['web ·', 'Prompt templates'])
  assert.deepEqual(buttonsIn(title), ['Cancel', 'Save'])
  assertProps(buttonIn(title, 'Cancel'), { variant: 'ghost', size: 'sm' })
  assertProps(buttonIn(title, 'Save'), { variant: 'solid', size: 'sm' })
  assert.deepEqual(nodesIn(picker, (node) => node.type === 'Select' || node.type === 'IconButton').map((node) => node.props?.label), ['Template', 'New template'])
  assertProps(form, { direction: 'column', grow: true, minHeight: 0, maxHeight: '100%', scroll: 'y' })
  assert.deepEqual(
    nodesIn(frame, (node) => node.props?.scroll !== undefined),
    [form]
  )
  assert.deepEqual(
    nodesIn(form, (node) => ['Input', 'Switch', 'Textarea', 'Collapsible', 'Callout'].includes(node.type)).map((node) => node.props?.label ?? node.props?.title),
    ['Name', 'Global', 'Default template', 'Text', 'Variables', 'Run a skill']
  )
  assert.equal(nodesIn(form, (node) => node.type === 'Button').length, 0)
  // The bar stays in place under the form, however far the form scrolls.
  assert.ok(bar)
  assertProps(bar, { shrink: false })
  assert.equal(bar.props?.scroll, undefined)
})

/** Finders take a Collapsible's `title` as its label. */
const variables = { type: 'Collapsible', label: 'Variables' }

test('the hint follows the text, and the closed Variables list gives each variable with what it gives', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press(manageTemplates)
  const { form } = viewParts(view)
  const parts = elementsIn(form)
  const textPart = parts.findIndex((part) => nodesIn(part, (node) => node.type === 'Textarea').length > 0)
  const [field] = nodesIn(parts[textPart], (node) => node.type === 'Textarea')
  assertProps(field, { label: 'Text', rows: 12 })
  const hint = nodesIn(parts[textPart], (node) => node.type === 'Text' && wordsOf(node) === 'An empty text gives the task URL.')
  assert.equal(hint.length, 1)
  assertProps(hint[0], { size: 'sm', muted: true })
  const fieldAndHint = elementsIn(parts[textPart])
  assert.deepEqual(fieldAndHint.map((part) => part.type), ['Textarea', 'Text'])
  assert.equal(parts[textPart + 1].type, 'Collapsible')

  assert.equal(view.find(variables)?.props.open, false)
  assert.equal(view.find({ type: 'Code', text: '{{task_key}}' }), null)
  await view.toggle(variables)
  const rows = elementsIn(nodesIn(view.tree(), (node) => node.type === 'Collapsible')[0]).flatMap(elementsIn)
  assert.deepEqual(
    rows.map((row) => [elementsIn(row).map((code) => `${code.type} ${wordsOf(code)}`), wordsOf(row)]),
    [
      [['Code {{task_key}}'], '{{task_key}} The task key, such as WEB-12 or #42.'],
      [['Code {{task_title}}'], "{{task_title}} The task's title."],
      [['Code {{task_url}}'], "{{task_url}} The task's link in the tracker."],
      [['Code {{task_description}}'], "{{task_description}} The task's description as plain text, cut to 4000 characters."],
      [['Code {{task_status}}'], '{{task_status}} The status as the tracker shows it, such as "In Progress". "Open" on GitHub.'],
      [['Code {{tracker}}'], '{{tracker}} "github" or "jira".'],
      [['Code {{repo}}'], "{{repo}} The project's repository (owner/name) when Orca knows it, else the project's name."],
      [
        ['Code {{branch}}'],
        "{{branch}} The new worktree's git branch from the branch template the project uses, its own or the global one, such as feature/WEB-12__add-dark-mode. Without a branch template, the worktree's name, such as web-12-add-dark-mode. It doesn't include a -2 Orca may add. In a Run here, the current branch of the worktree selected in Orca, or nothing when it has none."
      ],
      [['Code {{jira_project}}'], "{{jira_project}} The project's Jira project key, such as WEB, set in Project settings. Empty when it has none."]
    ]
  )
  assert.deepEqual(view.warnings, [])
})

test('the Variables list stays as it was left while the panel is open, and starts closed in a panel opened again', async () => {
  const first = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await first.view.press(gear)
  await first.view.press(manageTemplates)
  await first.view.toggle(variables)
  await first.view.press({ type: 'Button', text: 'Cancel' })
  await first.view.press(manageTemplates)
  await first.view.press(newTemplate)
  assert.equal(first.view.find(variables)?.props.open, true)
  assert.ok(first.view.find({ type: 'Code', text: '{{branch}}' }))
  await first.view.unmount()

  const again = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await again.view.press(gear)
  await again.view.press(manageTemplates)
  assert.equal(again.view.find(variables)?.props.open, false)
})

test('the "Run a skill" Callout ends the form, after the error of a failed write', async () => {
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
  await view.press(manageTemplates)
  const skill = viewParts(view).form.children?.at(-1)
  assert.ok(skill && typeof skill !== 'string')
  assert.equal(skill.type, 'Callout')
  assertProps(skill, { icon: 'info', title: 'Run a skill' })
  assert.match(wordsOf(skill), /^To run a Claude Code skill, start the template with its command, for example `\/tdd \{\{task_key\}\}`/)

  await view.press(saveButton)
  const parts = elementsIn(viewParts(view).form)
  assert.deepEqual(
    parts.slice(-2).map((part) => [part.type, part.props?.tone ?? null, part.props?.title ?? null]),
    [
      ['Callout', 'danger', null],
      ['Callout', null, 'Run a skill']
    ]
  )
  assert.match(wordsOf(parts.at(-2)!), /Couldn't save the template/)
})

test('"Delete template" sits in a bar of its own under the form, on the right, and asks for a second click', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press(manageTemplates)
  const { form, bar } = viewParts(view)
  assert.ok(bar)
  assertProps(bar, { direction: 'row', justify: 'end', shrink: false })
  assert.equal(bar.props?.scroll, undefined)
  assert.deepEqual(buttonsIn(bar), ['Delete template'])
  assert.equal(nodesIn(form, (node) => node.type === 'Button').length, 0)
  assertProps(buttonIn(bar, 'Delete template'), { variant: 'ghost', tone: 'danger', icon: 'delete', size: 'sm' })

  await view.press({ type: 'Button', text: 'Delete template' })
  assert.deepEqual(buttonsIn(viewParts(view).bar!), ['Confirm delete'])
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
})

test('a new template has no Delete bar', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  await view.press(newTemplate)
  assert.equal(viewParts(view).bar, undefined)
  assert.equal(view.find({ type: 'Button', text: /Delete/ }), null)
})

test('the Prompt templates view opened from Project settings that opened by itself goes back to it', async () => {
  const { view } = await showWith({ 'tasks.load': { kind: 'error', project: web, message: 'gh failed.' } }, twoTemplates)
  await view.press(manageTemplates)
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(view.find(settingsTitle))
})

test('"New template" opens an empty name and the initial text; Save adds it at the end and goes back to Project settings', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press(manageTemplates)
  await view.press(newTemplate)
  assert.ok(view.find(templatesTitle))
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), '')
  assert.equal(view.valueOf({ type: 'Textarea', label: 'Text' }), 'Complete {{task_key}}: {{task_url}}')
  assert.equal(view.find({ type: 'Button', text: 'Delete template' }), null)
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
})

test('"Manage templates" opens the template chosen as default, and Save stores it in its place', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.press(manageTemplates)
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
})

test('saving a template of a project that stored none stores it, without the earlier field', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ template: 'Fix {{task_key}}', agent: 'codex' }))
  await view.press(gear)
  await view.press(manageTemplates)
  await view.type({ type: 'Input', label: 'Name' }, 'Implement', { replace: true })
  await view.press(saveButton)
  assert.deepEqual(storedProject(host), {
    providers: {},
    templates: [{ id: 'default', name: 'Implement', text: 'Fix {{task_key}}' }],
    defaultTemplateId: 'default',
    agent: 'codex'
  })
})

test('Cancel goes back to Project settings without storing anything', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press(manageTemplates)
  await view.type({ type: 'Input', label: 'Name' }, 'Changed', { replace: true })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  await view.press(manageTemplates)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Triage')
})

test('a failed write keeps the view open with the error and the draft', async () => {
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
  await view.press(promptTemplates)
  await view.press(newTemplate)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  assert.ok(view.find({ type: 'Text', text: /Couldn't save the template/ }))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Review')
  assert.equal(view.find({ type: 'Link', text: '#42' }), null)
})

test('Delete needs a second click, and deleting the default template makes the first remaining one the default, which the view then shows', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press(manageTemplates)
  await view.press({ type: 'Button', text: 'Delete template' })
  assert.ok(view.find({ type: 'Button', text: 'Confirm delete' }))
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedProject(host), { providers: {}, templates: [implement], defaultTemplateId: 't-impl' })
  assert.ok(view.find(templatesTitle))
  assert.deepEqual(optionLabels(view, 'Template'), ['Implement'])
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Implement')
  assert.equal(view.find(defaultSwitch)?.props.checked, true)
  await view.press(cancelButton)
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-impl')
})

test('deleting a template that is not the default keeps the default, which the view then shows', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-impl')
  await view.press({ type: 'Button', text: 'Delete template' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedProject(host), { providers: {}, templates: [triage], defaultTemplateId: 't-triage' })
  assert.equal(view.valueOf(templateSelect), 't-triage')
  await view.press(cancelButton)
  assert.ok(view.find({ type: 'Link', text: '#42' }))
})

test('Delete turns back after a few seconds without the second click', async () => {
  await withTimeouts(CONFIRM_DELETE_MS, async ({ fire }) => {
    const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
    await view.press(gear)
    await view.press(manageTemplates)
    await view.press({ type: 'Button', text: 'Delete template' })
    await fire(view)
    assert.ok(view.find({ type: 'Button', text: 'Delete template' }))
    assert.equal(view.find({ type: 'Button', text: 'Confirm delete' }), null)
    await view.press({ type: 'Button', text: 'Delete template' })
    assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  })
})

test('Delete is disabled for the only template', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  await view.press(manageTemplates)
  assert.equal(view.find({ type: 'Button', text: 'Delete template' })?.disabled, true)
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
  await view.press(manageTemplates)
  await view.press({ type: 'Button', text: 'Delete template' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  await view.press(cancelButton)
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(starts.map((start) => start.templateId), ['t-impl'])
})

const review = { id: 't-review', name: 'Review', text: 'Review {{task_key}}' }

/** Stored settings of the web project with these fields, and these global templates. */
const storedWithGlobal = (project: Record<string, JsonValue>, templates: JsonValue[]) => ({
  settings: { ...stored(project).settings, global: { templates } }
})

const globalSwitch = { type: 'Switch', label: 'Global' }

/** The stored global templates. */
const storedGlobal = (host: MockHost) => (host.data().storage.settings as { global?: { templates?: unknown[] } } | undefined)?.global?.templates

test("Project settings list the project's own templates first, then the global ones, marked Global, and a global one can be the default template", async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement, triage] }, [review]))
  assert.deepEqual(optionLabels(view, 'Template for #42'), ['Implement', 'Triage', 'Review (Global)'])
  await view.press(gear)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Triage', 'Review (Global)'])
  await view.select({ type: 'Select', label: 'Default template' }, 't-review')
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-review')
  await wait(800)
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, 't-review')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('a project with no template of its own lists the global ones, without "Default"', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({}, [review, triage]))
  await view.press(gear)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Review (Global)', 'Triage (Global)'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-review')
})

test('the view has a Global switch, off for an own template and on for a global one', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement], defaultTemplateId: 't-impl' }, [review]))
  await view.press(promptTemplates)
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  await view.select(templateSelect, 't-review')
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.deepEqual(view.warnings, [])
})

test('a template made global in one project is listed, marked Global, in another, which can start a task with it, edit it for both, and delete it from both', async () => {
  let project = web
  const starts: { projectId: string; templateId: string }[] = []
  const { view, host } = await showWith(
    {
      'tasks.load': () => ready([task(project === web ? '#42' : '#9')], { project }),
      'task.start': (input) => (starts.push(input), { ok: true, underWay: true })
    },
    { settings: { version: 1, projects: { [web.id]: { providers: {}, templates: [implement, triage] }, [api.id]: { providers: {}, templates: [triage] } } } }
  )
  await view.press(gear)
  await view.press(manageTemplates)
  await view.toggle(globalSwitch)
  // Nothing moves before Save.
  assert.deepEqual(storedGlobal(host), undefined)
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  await view.press(saveButton)
  assert.deepEqual(storedProject(host), { providers: {}, templates: [triage], defaultTemplateId: 't-impl' })
  assert.deepEqual(storedGlobal(host), [implement])
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(optionLabels(view, 'Default template'), ['Triage', 'Implement (Global)'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-impl')

  project = api
  await view.press(done)
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.deepEqual(optionLabels(view, 'Template for #9'), ['Triage', 'Implement (Global)'])
  await view.select(cardTemplate('#9'), 't-impl')
  await view.press({ testId: 'start:#9' })
  assert.deepEqual(starts, [{ projectId: api.id, task: task('#9'), templateId: 't-impl', agent: 'orca-default' }])

  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.press(manageTemplates)
  await view.type({ type: 'Textarea', label: 'Text' }, 'Build {{task_key}}', { replace: true })
  await view.press(saveButton)
  assert.deepEqual(storedGlobal(host), [{ ...implement, text: 'Build {{task_key}}' }])

  await view.press(manageTemplates)
  const { bar } = viewParts(view)
  assert.ok(bar)
  assert.ok(nodesIn(bar, (node) => node.type === 'Text' && wordsOf(node) === 'Deletes it in every project.').length === 1)
  await view.press({ type: 'Button', text: 'Delete template' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedGlobal(host), [])
  await view.press(cancelButton)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Triage'])

  project = web
  await view.press(done)
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  await view.press(gear)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Triage'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('an own template says nothing about other projects in its Delete bar', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press(manageTemplates)
  assert.equal(view.find({ type: 'Text', text: 'Deletes it in every project.' }), null)
})

test('turning Global off asks first, and Save then moves the template to the active project only', async () => {
  const { view, host } = await showWith(
    { 'tasks.load': ready([task('#42')]) },
    storedWithGlobal({ templates: [implement], defaultTemplateId: 't-review' }, [review, triage])
  )
  await view.press(gear)
  await view.press(manageTemplates)
  await view.toggle(globalSwitch)
  // A confirmation bar in place of the Delete bar; nothing is stored yet.
  const { bar } = viewParts(view)
  assert.ok(bar)
  assert.ok(nodesIn(bar, (node) => node.type === 'Text' && wordsOf(node) === 'Other projects will stop offering it.').length === 1)
  assert.deepEqual(buttonsIn(bar), ['Keep global', 'Confirm'])
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  assert.deepEqual(storedGlobal(host), [review, triage])

  await view.press({ type: 'Button', text: 'Keep global' })
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.deepEqual(buttonsIn(viewParts(view).bar!), ['Delete template'])
  assert.deepEqual(storedGlobal(host), [review, triage])

  await view.toggle(globalSwitch)
  await view.press({ type: 'Button', text: 'Confirm' })
  // Confirm changes only the draft: the Delete bar is back, still about the global template.
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  assert.deepEqual(buttonsIn(viewParts(view).bar!), ['Delete template'])
  assert.deepEqual(storedGlobal(host), [review, triage])
  await view.press(saveButton)
  assert.deepEqual(storedGlobal(host), [triage])
  assert.deepEqual(storedProject(host), { providers: {}, templates: [implement, review], defaultTemplateId: 't-review' })
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Review', 'Triage (Global)'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-review')
})

test('Save is disabled while the bar asks to confirm Global off, or to discard the changes', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement], defaultTemplateId: 't-review' }, [review]))
  await view.press(promptTemplates)
  await view.toggle(globalSwitch)
  assert.equal(view.find(saveButton)?.disabled, true)
  await view.press({ type: 'Button', text: 'Confirm' })
  assert.equal(view.find(saveButton)?.disabled, false)
  await view.select(templateSelect, 't-impl')
  assert.deepEqual(barOf(view).buttons, ['Keep editing', 'Discard'])
  assert.equal(view.find(saveButton)?.disabled, true)
  await view.press({ type: 'Button', text: 'Keep editing' })
  assert.equal(view.find(saveButton)?.disabled, false)
})

test('turning Global on or off, then Cancel, leaves the template where it was', async () => {
  const settings = storedWithGlobal({ templates: [implement, triage], defaultTemplateId: 't-triage' }, [review])
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, settings)
  await view.press(promptTemplates)
  await view.toggle(globalSwitch)
  await view.press(cancelButton)
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-review')
  await view.toggle(globalSwitch)
  await view.press({ type: 'Button', text: 'Confirm' })
  await view.press(cancelButton)
  assert.deepEqual(host.calls.filter((call) => call.method === 'storage.set'), [])
  assert.deepEqual(storedGlobal(host), [review])
  assert.deepEqual(optionLabels(view, 'Template for #42'), ['Implement', 'Triage', 'Review (Global)'])
})

test('Save writes a template moved, renamed, edited and made the default template in a single write', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement, triage], defaultTemplateId: 't-triage' }, [review]))
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-impl')
  await view.toggle(globalSwitch)
  await view.toggle(defaultSwitch)
  await view.type({ type: 'Input', label: 'Name' }, 'Build', { replace: true })
  await view.type({ type: 'Textarea', label: 'Text' }, 'Build {{task_key}}', { replace: true })
  await view.press(saveButton)
  assert.equal(host.calls.filter((call) => call.method === 'storage.set').length, 1)
  assert.deepEqual(storedGlobal(host), [review, { id: 't-impl', name: 'Build', text: 'Build {{task_key}}' }])
  assert.deepEqual(storedProject(host), { providers: {}, templates: [triage], defaultTemplateId: 't-impl' })
  assert.deepEqual(optionLabels(view, 'Template for #42'), ['Triage', 'Review (Global)', 'Build (Global)'])
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
})

test('a Save whose write fails leaves the template where it was, with the change still in the view', async () => {
  let failing = true
  const { host, project } = failingWritesHost(() => failing)
  const view = await mount(panel, { host })
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-impl')
  await view.toggle(globalSwitch)
  await view.toggle(defaultSwitch)
  await view.press(saveButton)
  assert.ok(view.find({ type: 'Text', text: "Couldn't save the template (quota_exceeded). Try again." }))
  assert.deepEqual(project(), twoTemplates.settings.projects['github:acme/web'])
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.equal(view.find(defaultSwitch)?.props.checked, true)
  assert.equal(view.valueOf(templateSelect), 't-impl')
  assert.deepEqual(optionLabels(view, 'Template'), ['Implement', 'Triage'])

  failing = false
  await view.press(saveButton)
  assert.deepEqual(project(), { providers: {}, templates: [triage], defaultTemplateId: 't-impl' })
  assert.ok(view.find({ type: 'Link', text: '#42' }))
})

test('a move whose name the destination group already has is refused on Save with a message, and changes nothing', async () => {
  const settings = storedWithGlobal({ templates: [implement, triage], defaultTemplateId: 't-triage' }, [])
  let data: JsonValue = settings.settings
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': ready([task('#42')]) },
    results: {
      'storage.get': () => ({ value: data }),
      'storage.set': (params: { key: string; value: JsonValue }) => {
        data = params.value
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press(promptTemplates)
  await view.toggle(globalSwitch)
  // Another project made a template called "Triage" global meanwhile.
  data = storedWithGlobal({ templates: [implement, triage], defaultTemplateId: 't-triage' }, [{ ...review, name: 'triage' }]).settings
  await view.press(saveButton)
  assert.ok(view.find({ type: 'Text', text: 'A global template is already called "triage". Rename one of them first.' }))
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.ok(view.find(templatesTitle))
  const stored = data as { projects: Record<string, unknown>; global: { templates: unknown[] } }
  assert.deepEqual(stored.projects['github:acme/web'], settings.settings.projects['github:acme/web'])
  assert.deepEqual(stored.global.templates, [{ ...review, name: 'triage' }])
})

test('a new template with Global on is saved among the global ones, and a project that listed only "Default" keeps it', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  await view.press(manageTemplates)
  await view.press(newTemplate)
  await view.toggle(globalSwitch)
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.equal(storedGlobal(host), undefined)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  const [saved] = storedGlobal(host) as { id: string; name: string }[]
  assert.equal(saved.name, 'Review')
  assert.deepEqual(storedProject(host), {
    providers: {},
    templates: [{ id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }],
    defaultTemplateId: 'default'
  })
  assert.deepEqual(optionLabels(view, 'Default template'), ['Default', 'Review (Global)'])
})

test("a global template's name is checked against the global ones only, also when Global is turned on for a stored one", async () => {
  const globalTriage = { id: 't-global-triage', name: 'Triage', text: '' }
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storedWithGlobal({ templates: [implement, triage] }, [review, globalTriage]))
  await view.press(promptTemplates)
  await view.select(templateSelect, 't-triage')
  await view.toggle(globalSwitch)
  assert.ok(view.find({ type: 'Text', text: 'Another global template is already called "Triage".' }))
  assert.equal(view.find(saveButton)?.disabled, true)
  await view.toggle(globalSwitch)
  await view.press(newTemplate)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  assert.equal(view.find(saveButton)?.disabled, false)
  await view.toggle(globalSwitch)
  assert.ok(view.find({ type: 'Text', text: 'Another global template is already called "Review".' }))
  assert.equal(view.find(saveButton)?.disabled, true)
  await view.type({ type: 'Input', label: 'Name' }, 'Implement', { replace: true })
  assert.equal(view.find(saveButton)?.disabled, false)
})

test("the initial template made global keeps being the project's default template and the card's choice", async () => {
  const starts: { templateId: string }[] = []
  const { view, host } = await showWith(
    { 'tasks.load': ready([task('#42'), task('#7')]), 'task.start': (input) => (starts.push(input), { ok: true, underWay: true }) },
    stored({ templates: [{ id: 'default', name: 'Default', text: 'Fix' }, triage], defaultTemplateId: 't-triage' })
  )
  await view.select(cardTemplate('#7'), 'default')
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 'default')
  await view.press(manageTemplates)
  await view.toggle(globalSwitch)
  await view.press(saveButton)
  const [moved] = storedGlobal(host) as { id: string }[]
  assert.notEqual(moved.id, 'default')
  assert.equal((storedProject(host) as { defaultTemplateId: string }).defaultTemplateId, moved.id)
  assert.ok(view.find(settingsTitle))
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), moved.id)
  // Only the card's own choice can keep #7 on the moved template now.
  await view.select({ type: 'Select', label: 'Default template' }, 't-triage')
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-triage')
  assert.equal(view.valueOf(cardTemplate('#7')), moved.id)
  await view.press({ testId: 'start:#7' })
  assert.deepEqual(starts.map((start) => start.templateId), [moved.id])
})

test("a change of active project while the view is open drops the draft and shows the new project's list", async () => {
  let project = web
  const { view, host } = await showWith(
    { 'tasks.load': () => ready([task(project === web ? '#42' : '#9')], { project }) },
    twoTemplates
  )
  await view.press(gear)
  await view.press(manageTemplates)
  await view.press(newTemplate)
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
})

test('a reload of the same project keeps the view open with its draft', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(promptTemplates)
  await view.press(newTemplate)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Review')
})

test('closing the panel drops the draft', async () => {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests: { 'tasks.load': ready([task('#42')]) }, storage: twoTemplates })
  const first = await mount(panel, { host })
  await first.press(promptTemplates)
  await first.press(newTemplate)
  await first.type({ type: 'Input', label: 'Name' }, 'Review')
  await first.unmount()
  const second = await mount(panel, { host })
  assert.equal(second.find({ type: 'Input', label: 'Name' }), null)
  assert.ok(second.find({ type: 'Link', text: '#42' }))
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
})

test('a pending Project settings change survives a failed template write, and the next Save stores both', async () => {
  let writes = 0
  let data: JsonValue = twoTemplates.settings
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': ready([task('#42')]), 'agents.load': availableAgents() },
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
  await view.press(manageTemplates)
  await view.press(newTemplate)
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.press(saveButton)
  assert.ok(view.find({ type: 'Text', text: /Couldn't save the template/ }))
  await view.press(saveButton)
  const project = (data as { projects: Record<string, { agent?: string; templates: { name: string }[] }> }).projects['github:acme/web']
  assert.equal(project.agent, 'codex')
  assert.deepEqual(project.templates.map((template) => template.name), ['Implement', 'Triage', 'Review'])
})

/** A host with the two templates stored and these worker answers, and Orca's agents as `showWith`
 *  gives them. Each settings write calls `write` first and lands once it ends: a promise it answers
 *  holds the write, a throw fails it. `project()` gives the web project's stored settings. */
function settingsHost(requests: MockRequests, write: () => void | Promise<void>) {
  let data: JsonValue = twoTemplates.settings
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'agents.load': availableAgents(), ...requests },
    results: {
      'storage.get': () => ({ value: data }),
      'storage.set': (params: { key: string; value: JsonValue }) => {
        const land = () => {
          data = params.value
          return { ok: true }
        }
        const writing = write()
        return writing instanceof Promise ? writing.then(land) : land()
      }
    }
  })
  const project = () => (data as { projects: Record<string, { agent?: string; defaultTemplateId?: string }> }).projects['github:acme/web']
  return { host, project }
}

/** A host with the two templates stored, whose settings writes wait until `write` is released. Its
 *  log says when each write starts and ends, and when the worker is asked for the list. */
function heldWritesHost(write: ReturnType<typeof held>) {
  const log: string[] = []
  const requests: MockRequests = {
    'tasks.load': () => {
      log.push('tasks.load')
      return ready([task('#42')])
    }
  }
  const { host, project } = settingsHost(requests, async () => {
    log.push('write starts')
    await write.released
    log.push('write ends')
  })
  return { host, log, project }
}

// While a write is held, every act waits for it, so these tests start their acts without awaiting
// them, and release the write before they assert anything.

test('a Reload while the timed save of a change is still writing asks for the list only after that write', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ fire }) => {
    const write = held()
    const { host, log, project } = heldWritesHost(write)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    await view.press({ type: 'Button', text: 'Done' })
    log.length = 0
    const saving = fire(view)
    await until(() => log.includes('write starts'), 'started the timed save')
    const reloading = view.press({ type: 'IconButton', label: 'Reload tasks' })
    for (let turns = 0; turns < 10; turns++) await turn()
    const whileWriting = [...log]
    write.release()
    await Promise.all([saving, reloading])
    assert.deepEqual(whileWriting, ['write starts'])
    assert.deepEqual(log, ['write starts', 'write ends', 'tasks.load'])
    assert.equal(project().agent, 'codex')
  })
})

test('a second change saved while the first is still writing keeps both in storage', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ fire, pending }) => {
    const write = held()
    const { host, log, project } = heldWritesHost(write)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    const first = fire(view)
    await until(() => log.includes('write starts'), 'started the first save')
    const selecting = view.select({ type: 'Select', label: 'Default template' }, 't-impl')
    await until(() => pending() === 1, 'timed the second save')
    const second = fire(view)
    for (let turns = 0; turns < 10; turns++) await turn()
    write.release()
    await Promise.all([first, selecting, second])
    assert.equal(project().agent, 'codex')
    assert.equal(project().defaultTemplateId, 't-impl')
  })
})

// `orca plugin test` fails the running test with the reason of any promise rejection that nothing
// handles, so these tests need no watch of their own for one.

/** A host with the two templates stored, whose settings writes fail while `failing()` says so. */
const failingWritesHost = (failing: () => boolean) =>
  settingsHost({ 'tasks.load': ready([task('#42')]) }, () => {
    if (failing()) throw hostError('quota_exceeded', 'Storage is full')
  })

const SAVE_FAILED = "Couldn't save Project settings (quota_exceeded). Kickoff tries again with your next change."

/** The danger Callout that says the timed save failed, or null. */
function saveFailedNotice(view: TestPanel) {
  const callout = view.find({ type: 'Callout', text: SAVE_FAILED })
  return callout?.props.tone === 'danger' ? callout : null
}

/** Whether a settings write reached the host. */
const wroteSettings = (host: MockHost) => host.calls.some((call) => call.method === 'storage.set')

test('a failed timed save of Project settings shows a danger notice, and rejects nothing', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ fire }) => {
    const { host } = failingWritesHost(() => true)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    assert.equal(saveFailedNotice(view), null)
    await fire(view)
    assert.equal(saveFailedNotice(view)?.props.icon, 'error')
    assert.deepEqual(view.errors, [])
  })
})

test('after a failed timed save, the next one stores the failed change and the later one, and the notice goes away', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ fire }) => {
    let failing = true
    const { host, project } = failingWritesHost(() => failing)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    await fire(view)
    assert.ok(saveFailedNotice(view))
    failing = false
    await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
    assert.ok(saveFailedNotice(view))
    await fire(view)
    assert.equal(project().agent, 'codex')
    assert.equal(project().defaultTemplateId, 't-impl')
    assert.equal(saveFailedNotice(view), null)
  })
})

test('the notice of a failed timed save shows in Project settings, then in the list after Done', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ fire }) => {
    const { host } = failingWritesHost(() => true)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    await fire(view)
    assert.ok(view.find({ type: 'Heading', text: 'Project settings' }))
    assert.ok(saveFailedNotice(view))
    await view.press(done)
    assert.equal(view.find({ type: 'Heading', text: 'Project settings' }), null)
    assert.ok(view.find({ testId: 'start:#42' }))
    assert.ok(saveFailedNotice(view))
  })
})

test('the save before a Reload ends the notice of a failed timed save once it succeeds', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ fire }) => {
    let failing = true
    const { host, project } = failingWritesHost(() => failing)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    await fire(view)
    await view.press(done)
    failing = false
    await view.press({ type: 'IconButton', label: 'Reload tasks' })
    assert.equal(project().agent, 'codex')
    assert.equal(saveFailedNotice(view), null)
  })
})

test('closing the panel right after a change whose save fails throws nothing, and a panel opened after it saves nothing', async () => {
  await withTimeouts(SAVE_DELAY_MS, async ({ pending }) => {
    const { host } = failingWritesHost(() => true)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    assert.equal(pending(), 1)
    await view.unmount()
    // The save runs on after `unmount()` ends.
    await until(() => wroteSettings(host), 'tried the save on close')
    await turn()
    assert.deepEqual(view.errors, [])

    const next = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
    await next.view.press({ type: 'IconButton', label: 'Reload tasks' })
    assert.equal(wroteSettings(next.host), false)
  })
})

test("a load whose save of Project settings fails says so, not that Kickoff's worker didn't answer", async () => {
  await withTimeouts(SAVE_DELAY_MS, async () => {
    let failing = false
    const { host } = failingWritesHost(() => failing)
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    await view.press(done)
    failing = true
    await view.press({ type: 'IconButton', label: 'Reload tasks' })
    assert.ok(view.find({ type: 'Text', text: "Couldn't save Project settings (quota_exceeded). Reload to try again." }))
    assert.equal(view.find({ type: 'Text', text: /worker didn't answer/ }), null)
  })
})

test('a Start whose save of Project settings fails asks the worker nothing and says that the task didn\'t start', async () => {
  await withTimeouts(SAVE_DELAY_MS, async () => {
    let starts = 0
    const { host } = settingsHost(
      {
        'tasks.load': ready([task('#42')]),
        'task.start': () => (starts++, { ok: true, underWay: true }),
        'worktrees.load': { kind: 'ready', worktrees: {} }
      },
      () => {
        throw hostError('quota_exceeded', 'Storage is full')
      }
    )
    const view = await mount(panel, { host })
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Agent' }, 'codex')
    await view.press(done)
    await view.press({ testId: 'start:#42' })
    assert.equal(starts, 0)
    assert.ok(view.find({ type: 'Text', text: "Couldn't save Project settings (quota_exceeded), so #42 didn't start. Try again." }))
    assert.ok(view.find({ testId: 'start:#42' }))
  })
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
  assert.equal(agentShown(view, '#42'), null)
  await view.press({ type: 'Link', text: 'issue-42-add-dark-mode' })
  assert.deepEqual(opened, [{ worktreeId: 'r1::/src/web-42' }])
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
})

const CAN_TAKE_A_MINUTE = /Creating the worktree can take a minute/

test('a Start under way shows the spinner and says that creating the worktree can take a minute', async () => {
  const { view } = await showWith({
    'tasks.load': ready([task('#42'), task('#7')]),
    'task.start': { ok: true, underWay: true }
  })
  await view.press({ testId: 'start:#42' })
  // The spinner, with its label shown, takes the place of the Start row; the line comes below it.
  const [, spinner, line, ...rest] = elementsIn(cardOf(view, '#42'))
  assert.equal(spinner.type, 'Spinner')
  assert.equal(spinner.props?.label, 'Starting #42')
  assert.equal(spinner.props?.labelHidden, undefined)
  assert.match(wordsOf(line), CAN_TAKE_A_MINUTE)
  assert.deepEqual(rest, [])
  assert.equal(view.find({ testId: 'start:#42' }), null)
  assert.equal(view.findAll({ type: 'Text', text: CAN_TAKE_A_MINUTE }).length, 1)
  assert.ok(view.find({ testId: 'start:#7' }))
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
})

/** Stands in for `setTimeout` while `body` runs, for the timers of `ms` only, so a test fires them
 *  by hand: `fire()` runs every one still pending and waits for the panel to settle. Other timers,
 *  such as the settings save, run as usual. When `body` ends, even by failing, it unmounts the
 *  views still mounted, then puts the real timers back. */
async function withTimeouts(
  ms: number,
  body: (timers: { fire: (view: TestPanel) => Promise<void>; pending: () => number }) => Promise<void>
) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const held = new Map<number, () => void>()
  let next = 1
  const fakes = {
    setTimeout: ((run: () => void, delay?: number, ...args: unknown[]) => {
      if (delay !== ms) return realSet(run, delay, ...args)
      held.set(next, run)
      return next++
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: unknown) => {
      if (typeof id === 'number' && held.delete(id)) return
      realClear(id as ReturnType<typeof setTimeout>)
    }) as unknown as typeof clearTimeout
  }
  await withFakeTimers(fakes, () =>
    body({
      fire: async (view) => {
        const runs = [...held.values()]
        held.clear()
        for (const run of runs) run()
        await view.settled()
      },
      pending: () => held.size
    })
  )
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

    worktrees = { '#42': started }
    await fire(view)
    assert.ok(view.find({ type: 'Text', text: 'Agent: claude' }))
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
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

test('after a Start with an agent, no card shows the new worktree without an agent line before it says the agent is starting', async () => {
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
    const startingWhileRead = view.find({ type: 'Text', text: 'Agent starting…' })
    refresh.release()
    await Promise.all([ended, switched, ...rerenders])
    assert.ok(startingWhileRead)
    assert.ok(view.find({ type: 'Text', text: 'Agent starting…' }))
    assert.equal(pending(), 1)
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
  })
})

test('after a Start with "No agent", the card shows no agent line straight away', async () => {
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
    assert.equal(agentShown(view, '#42'), null)
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
    assert.equal(pending(), 0)
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
    assert.equal(agentShown(view, '#42'), null)
    assert.equal(view.find({ type: 'Text', text: 'Agent starting…' }), null)
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
    assert.equal(agentShown(view, '#42'), null)
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
    assert.equal(agentShown(view, '#42'), null)
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

test('withTimeouts unmounts a view the body left mounted while its timers are still held', async () => {
  let pendingOnceDone = () => -1
  await withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
    await startedWithoutAgentYet()
    assert.equal(pending(), 1)
    pendingOnceDone = pending
  })
  assert.equal(pendingOnceDone(), 0)
})

test('withTimeouts unmounts and puts the real timers back when the body fails', async () => {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  let pendingOnceDone = () => -1
  await assert.rejects(
    withTimeouts(AGENT_CHECK_MS, async ({ pending }) => {
      await startedWithoutAgentYet()
      pendingOnceDone = pending
      throw new Error('body failed')
    }),
    /body failed/
  )
  assert.equal(pendingOnceDone(), 0)
  assert.equal(globalThis.setTimeout, realSet)
  assert.equal(globalThis.clearTimeout, realClear)
})

test('withTimeouts puts the real timers back when an unmount fails', async () => {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  await assert.rejects(
    withTimeouts(AGENT_CHECK_MS, async () => {
      const { view } = await startedWithoutAgentYet()
      const unmount = view.unmount
      view.unmount = async () => {
        await unmount.call(view)
        throw new Error('unmount failed')
      }
    }),
    /unmount failed/
  )
  assert.equal(globalThis.setTimeout, realSet)
  assert.equal(globalThis.clearTimeout, realClear)
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
  })
})

const SITES = { kind: 'ready' as const, sites: [{ id: 'site-1', name: 'Example' }, { id: 'site-2', name: 'Other' }] }

/** Stored settings of the web project on Jira (twg) with `config`, and these other fields. */
const twgStored = (config: { site: string; profile: string }, project: Record<string, JsonValue> = {}) => ({
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        provider: 'jira-twg',
        providers: { 'jira-twg': config, 'jira-orca': { siteId: 'site-1' } },
        ...project
      }
    }
  }
})

const twgTask = (key: string) => task(key, { tracker: 'jira', url: `https://example.atlassian.net/browse/${key}`, status: 'To Do' })
const twgReady = (tasks: Task[], fields: Partial<Extract<TaskList, { kind: 'ready' }>> = {}) => ready(tasks, { provider: 'jira-twg', ...fields })

const tasksFilter = { id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }
const boardFilter = { id: 'f-board', name: 'Board', queries: ['project = WEB ORDER BY rank', 'project = API'] }
const mineFilter = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }

type StoredFilter = { id: string; name: string; queries: string[] }
type StoredFilters = { filters?: { jira?: StoredFilter[] }; shownFilterId?: { jira?: string } }

/** Stored settings of the web project on Jira (twg) with these filters, and the one shown last. */
const filtersStored = (filters: StoredFilter[], shownFilterId?: string) =>
  twgStored({ site: '', profile: '' }, { filters: { jira: filters }, ...(shownFilterId ? { shownFilterId: { jira: shownFilterId } } : {}) })

/** The key each filter lists in `showFilters`, by filter id. */
const FILTER_KEYS: Record<string, string> = { tasks: 'WEB-1', 'f-board': 'WEB-2', 'f-mine': 'WEB-3' }

/** Stored settings as `showFilters` takes them: the web project's, and the global filters. */
type StoredForFilters = { settings: { version: number; projects: Record<string, JsonValue>; global?: { filters?: Record<string, StoredFilter[]> } } }

/** The panel on the web project with `storage`, whose `tasks.load` lists, as the worker does, the
 *  filter the request names, else the one stored as shown when it is asked, else the first, among
 *  the project's own and the global Jira ones: one task each, `FILTER_KEYS`, or WEB-9 for a filter
 *  not in it. It answers an error naming the filter instead for a filter whose queries are all
 *  blank. Also its host and the inputs `tasks.load` was asked with. */
async function showFilters(storage: StoredForFilters, requests: MockRequests = {}) {
  const inputs: LoadInput[] = []
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith(
    {
      'tasks.load': (input: LoadInput) => {
        inputs.push(input)
        // `host` is set once the panel has mounted, after the first load.
        const settings = (host ? host.data().storage.settings : storage.settings) as StoredForFilters['settings']
        const project = settings.projects['github:acme/web'] as StoredFilters
        const global = settings.global?.filters?.jira ?? []
        const own = project.filters?.jira?.length ? project.filters.jira : global.length > 0 ? [] : [{ id: 'tasks', name: 'Tasks', queries: ['assignee = currentUser()'] }]
        const filters = [...own, ...global]
        const filter = filters.find((f) => f.id === input.filterId) ?? filters.find((f) => f.id === project.shownFilterId?.jira) ?? filters[0]
        if (filter.queries.every((query) => query.trim() === '')) {
          return { kind: 'error', project: web, message: `${filter.name}: Enter a JQL query to list Jira tasks.`, filterId: filter.id }
        }
        return twgReady([twgTask(FILTER_KEYS[filter.id] ?? 'WEB-9')], { filterId: filter.id })
      },
      ...requests
    },
    storage
  ))
  return { view, host, inputs }
}

const filterSelect = { type: 'Select', label: 'Filter' }
const editFilter = { type: 'IconButton', label: 'Edit filter' }
const newFilter = { type: 'IconButton', label: 'New filter' }

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
})

test('a GitHub project shows GitHub as its tracker, without the "Choose a tracker" option', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), 'github')
  assert.deepEqual(optionLabels(view, 'Tracker'), ['GitHub', 'Jira (Orca connection)', 'Jira (twg)'])
  assert.equal(view.find({ label: /^JQL/ }), null)
})

test("setting up a Jira project takes the tracker and its site, no JQL, and Done shows the tasks of its filter \"Tasks\"", async () => {
  let loads = 0
  let seen: unknown
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith({
    'tasks.load': () => {
      seen = host?.data().storage.settings
      return ++loads === 1 ? { kind: 'needs-config', project: notes } : ready([task('WEB-1', { tracker: 'jira' })], { project: notes, provider: 'jira-orca', filterId: 'tasks' })
    },
    'jira.sites': SITES
  }))
  await view.select({ type: 'Select', label: 'Tracker' }, 'jira-orca')
  assert.equal(loads, 2)
  assert.deepEqual(seen, { version: 1, projects: { 'repo:r1': { provider: 'jira-orca', providers: { 'jira-orca': { siteId: '' } } } } })
  assert.equal(view.find({ type: 'Textarea' }), null)
  assert.equal(view.find({ text: /JQL/ }), null)
  assert.equal(view.valueOf({ type: 'Select', label: 'Site' }), ':default')
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site', 'Example', 'Other'])
  assert.deepEqual(optionLabels(view, 'Tracker'), ['GitHub', 'Jira (Orca connection)', 'Jira (twg)'])
  assert.ok(view.find({ type: 'Text', text: /Connect Jira in Orca's settings/ }))
  await view.press(done)
  assert.equal(loads, 2)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks'])
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

/** Stored settings of the web project on Jira (Orca connection) with `siteId`, and these other fields. */
const jiraStored = (siteId: string, project: Record<string, JsonValue> = {}) => ({
  settings: {
    version: 1,
    projects: {
      'github:acme/web': {
        provider: 'jira-orca',
        providers: { 'jira-orca': { siteId }, 'jira-twg': { site: '', profile: 'work' } },
        ...project
      }
    }
  }
})

const jiraReady = (tasks: Task[] = []) => ready(tasks, { provider: 'jira-orca', filterId: 'tasks' })

test("the site saves itself, keeping the other providers' settings, and lists the tasks", async () => {
  let loads = 0
  const { view, host } = await showWith({ 'tasks.load': () => (loads++, jiraReady()), 'jira.sites': SITES }, jiraStored('site-1'))
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Site' }), 'site-1')
  await view.select({ type: 'Select', label: 'Site' }, 'site-2')
  assert.equal(loads, 2)
  await wait(800)
  assert.deepEqual(storedProject(host), { provider: 'jira-orca', providers: { 'jira-orca': { siteId: 'site-2' }, 'jira-twg': { site: '', profile: 'work' } } })
})

const queryField = (label: string) => ({ type: 'Textarea', label })
const removeQuery = (label: string) => ({ type: 'IconButton', label: `Remove ${label}` })
const addJql = { type: 'Button', text: 'Add JQL' }
const filterTitle = (title: 'Edit filter' | 'New filter') => ({ type: 'Heading', text: title })

/** A recipe's button in the editor of a new filter. */
const recipe = (name: string) => ({ type: 'Button', text: name })

/** The query fields shown, as [label, value, rows], in order: JQL on Jira, Query on GitHub. */
const queryFields = (view: TestPanel, label: 'JQL' | 'Query' = 'JQL') =>
  view.findAll({ type: 'Textarea', label: new RegExp(`^${label}`) }).map((field) => [field.label, view.valueOf(field), field.props.rows])

test("✎ opens the filter editor on the filter shown, in place of the list, with its name and JQL queries, and Cancel goes back loading nothing", async () => {
  const { view, inputs } = await showFilters(filtersStored([tasksFilter, boardFilter], 'f-board'))
  await view.press(editFilter)
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find(filterTitle('Edit filter'))?.props.level, 3)
  assert.equal(view.find(searchField), null)
  assert.equal(view.find({ type: 'Link', text: 'WEB-2' }), null)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Board')
  assert.deepEqual(queryFields(view), [
    ['JQL', 'project = WEB ORDER BY rank', 3],
    ['JQL 2', 'project = API', 3]
  ])
  // As the Prompt templates view: Cancel and Save in the title row, Delete in a bar of its own.
  const { title, deleteBar } = editorParts(view)
  assert.deepEqual(buttonsIn(title), ['Cancel', 'Save'])
  assert.ok(deleteBar)
  assertProps(buttonIn(deleteBar, 'Delete filter'), { tone: 'danger', icon: 'delete', variant: 'ghost' })

  await view.type({ type: 'Input', label: 'Name' }, 'Sprint', { replace: true })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board'])
  assert.equal(inputs.length, 1)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('Save stores the filter as edited, blank queries included, shows it, goes back to the list and loads it again', async () => {
  const { view, host, inputs } = await showFilters(filtersStored([tasksFilter, boardFilter], 'f-board'))
  await view.press(editFilter)
  await view.type({ type: 'Input', label: 'Name' }, ' Sprint ', { replace: true })
  await view.press(addJql)
  await view.type(queryField('JQL 2'), 'sprint in openSprints()', { replace: true })
  await view.press(saveButton)
  assert.deepEqual((storedProject(host) as StoredFilters).filters, {
    jira: [tasksFilter, { id: 'f-board', name: 'Sprint', queries: ['project = WEB ORDER BY rank', 'sprint in openSprints()', ''] }]
  })
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Sprint'])
  assert.equal(view.valueOf(filterSelect), 'f-board')
  assert.equal(inputs.length, 2)
  assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
})

/** The choice that + offers on Jira, of the kind of filter to start from, and its Continue. */
const startFrom = { type: 'RadioGroup', label: 'Start from' }
const continueButton = { type: 'Button', text: 'Continue' }
const projectKeyField = { type: 'Input', label: 'Jira project key' }
const whoseTasks = { type: 'RadioGroup', label: 'Whose tasks' }
const leaveOutField = { type: 'Input', label: 'Statuses to leave out' }

/** The labels of the options of the RadioGroup labelled `label`. */
const radioLabels = (view: TestPanel, label: string) =>
  ((view.find({ type: 'RadioGroup', label })?.props.options ?? []) as { label: string }[]).map((option) => option.label)

/** Presses + on a Jira project and goes on with `kind`, Custom unless told: the filter editor opens. */
async function newJiraFilter(view: TestPanel, kind: 'custom' | 'board-order' | 'my-open-tasks' = 'custom') {
  await view.press(newFilter)
  if (kind !== 'custom') await view.select(startFrom, kind)
  await view.press(continueButton)
}

test('+ on Jira offers Custom, Board order and My open tasks, in place of the list, with Cancel and Continue; Cancel goes back storing nothing', async () => {
  const { view, host, inputs } = await showFilters(filtersStored([tasksFilter]))
  await view.press(newFilter)
  assert.ok(view.find(filterTitle('New filter')))
  assert.equal(view.find(searchField), null)
  assert.equal(view.find({ type: 'Input', label: 'Name' }), null)
  assert.deepEqual(radioLabels(view, 'Start from'), ['Custom', 'Board order', 'My open tasks'])
  assert.equal(view.valueOf(startFrom), 'custom')
  const { title } = editorParts(view)
  assert.deepEqual(buttonsIn(title), ['Cancel', 'Continue'])
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(view.find(startFrom), null)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  assert.deepEqual((storedProject(host) as StoredFilters).filters?.jira, [tasksFilter])
  assert.equal(inputs.length, 1)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test("Board order asks for the Jira project key, whose tasks and the statuses to leave out, and can't go on without a key", async () => {
  const { view } = await showFilters(filtersStored([tasksFilter]))
  await view.press(newFilter)
  assert.equal(view.find(projectKeyField), null)
  await view.select(startFrom, 'board-order')
  assert.equal(view.valueOf(projectKeyField), '')
  assert.deepEqual(radioLabels(view, 'Whose tasks'), ['Mine', 'Mine or unassigned', 'Anyone'])
  assert.equal(view.valueOf(whoseTasks), 'mine-or-unassigned')
  assert.equal(view.valueOf(leaveOutField), 'Done')
  assert.equal(view.find(continueButton)?.disabled, true)
  await view.type(projectKeyField, '   ')
  assert.equal(view.find(continueButton)?.disabled, true)
  await view.submit(projectKeyField)
  assert.ok(view.find(startFrom))
  await view.type(projectKeyField, 'WEB', { replace: true })
  assert.equal(view.find(continueButton)?.disabled, false)
})

test('Board order writes its three queries into a new filter named after it and opens the filter editor on it; Save stores it, and + starts afresh', async () => {
  const { view, host } = await showFilters(filtersStored([tasksFilter]))
  await view.press(newFilter)
  await view.select(startFrom, 'board-order')
  await view.type(projectKeyField, ' WEB ')
  await view.select(whoseTasks, 'mine')
  await view.type(leaveOutField, 'Done, Closed, To validate', { replace: true })
  await view.press(continueButton)
  assert.ok(view.find(filterTitle('New filter')))
  assert.equal(view.find(startFrom), null)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Board order')
  const queries = [
    'project = WEB AND sprint in openSprints() AND assignee = currentUser() AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Rank ASC',
    'project = WEB AND sprint in futureSprints() AND assignee = currentUser() AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Sprint ASC, Rank ASC',
    'project = WEB AND (sprint IS EMPTY OR sprint NOT IN (openSprints(), futureSprints())) AND assignee = currentUser() AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Rank ASC'
  ]
  assert.deepEqual(queryFields(view), [
    ['JQL', queries[0], 3],
    ['JQL 2', queries[1], 3],
    ['JQL 3', queries[2], 3]
  ])
  assert.deepEqual((storedProject(host) as StoredFilters).filters?.jira, [tasksFilter])
  await view.press(saveButton)
  const added = (storedProject(host) as StoredFilters).filters?.jira?.[1]
  assert.ok(added)
  assert.deepEqual({ ...added, id: '' }, { id: '', name: 'Board order', queries })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board order'])

  // The answers are not kept: + starts again from Custom, and Board order from a blank key.
  await view.press(newFilter)
  assert.equal(view.valueOf(startFrom), 'custom')
  await view.select(startFrom, 'board-order')
  assert.equal(view.valueOf(projectKeyField), '')
  assert.equal(view.valueOf(whoseTasks), 'mine-or-unassigned')
  assert.equal(view.valueOf(leaveOutField), 'Done')
})

test('My open tasks asks only for the statuses to leave out and writes one query, into a filter with the first free name', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter, { ...mineFilter, name: 'My open tasks' }]))
  await view.press(newFilter)
  await view.select(startFrom, 'my-open-tasks')
  assert.equal(view.find(projectKeyField), null)
  assert.equal(view.find(whoseTasks), null)
  assert.equal(view.valueOf(leaveOutField), 'Done')
  await view.type(leaveOutField, ' ', { replace: true })
  await view.submit(leaveOutField)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'My open tasks 2')
  assert.deepEqual(queryFields(view), [['JQL', 'assignee = currentUser() ORDER BY updated DESC', 3]])
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'My open tasks'])
})

test('+ then Custom opens the editor on a new filter, "Filter 2" or the first free number, with one blank query; Save adds it at the end and shows its tasks', async () => {
  const { view, host } = await showFilters(filtersStored([tasksFilter, { ...boardFilter, name: 'Filter 2' }]))
  await newJiraFilter(view)
  assert.ok(view.find(filterTitle('New filter')))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Filter 3')
  assert.deepEqual(queryFields(view), [['JQL', '', 3]])
  assert.equal(view.find(queryField('JQL'))?.props.placeholder, 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')
  assert.equal(editorParts(view).deleteBar, undefined)
  await view.type(queryField('JQL'), 'assignee = currentUser()')
  await view.press(saveButton)
  const stored = storedProject(host) as StoredFilters
  const added = stored.filters?.jira?.[2]
  assert.ok(added)
  assert.deepEqual({ ...added, id: '' }, { id: '', name: 'Filter 3', queries: ['assignee = currentUser()'] })
  assert.match(added.id, /^f-/)
  assert.deepEqual(stored.shownFilterId, { jira: added.id })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Filter 2', 'Filter 3'])
  assert.equal(view.valueOf(filterSelect), added.id)
  assert.ok(view.find({ type: 'Link', text: 'WEB-9' }))
})

test("a filter's name can't be blank or another filter's, ignoring case, and Save waits until it can", async () => {
  const { view, host } = await showFilters(filtersStored([tasksFilter, boardFilter]))
  await newJiraFilter(view)
  const name = { type: 'Input', label: 'Name' }
  await view.type(name, '   ', { replace: true })
  assert.ok(view.find({ type: 'Text', text: 'Give the filter a name.' }))
  assert.equal(view.find(name)?.props.invalid, true)
  assert.equal(view.find(saveButton)?.disabled, true)
  await view.type(name, ' board', { replace: true })
  assert.ok(view.find({ type: 'Text', text: 'Another filter is already called "Board".' }))
  assert.equal(view.find(saveButton)?.disabled, true)
  await view.submit(queryField('JQL'))
  assert.ok(view.find(filterTitle('New filter')))
  await view.type(name, 'Board 2', { replace: true })
  assert.equal(view.find(saveButton)?.disabled, false)
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal((storedProject(host) as StoredFilters).filters?.jira?.length, 2)
})

test('each JQL query is a three-row field, "JQL" then "JQL 2"…, with Remove beside each while more than one is left and Add JQL below', async () => {
  const { view, host } = await showFilters(filtersStored([{ ...tasksFilter, queries: ['project = WEB', '', 'labels = ui'] }]))
  await view.press(editFilter)
  assert.deepEqual(queryFields(view), [
    ['JQL', 'project = WEB', 3],
    ['JQL 2', '', 3],
    ['JQL 3', 'labels = ui', 3]
  ])
  for (const label of ['JQL', 'JQL 2', 'JQL 3']) {
    // Remove is a red trash can, as the template's Delete is.
    const remove = view.find(removeQuery(label))
    assert.ok(remove)
    assertProps(remove, { tooltip: 'Remove query', icon: 'delete', tone: 'danger' })
  }
  // Add JQL is the "add" icon and its text, coloured as Save is.
  const add = view.find(addJql)
  const saveProps = view.find(saveButton)?.props
  assert.ok(add && saveProps)
  assertProps(add, { icon: 'add', variant: saveProps.variant, tone: saveProps.tone, size: saveProps.size })
  assert.equal(add.props.variant, 'solid')
  assert.ok(view.find({ type: 'Text', text: 'Ctrl+Enter (Cmd+Enter on macOS) saves the filter and lists its tasks.' })?.props.muted)

  await view.press(removeQuery('JQL 2'))
  assert.deepEqual(queryFields(view), [
    ['JQL', 'project = WEB', 3],
    ['JQL 2', 'labels = ui', 3]
  ])
  await view.press(removeQuery('JQL'))
  assert.deepEqual(queryFields(view), [['JQL', 'labels = ui', 3]])
  assert.equal(view.find(removeQuery('JQL')), null)

  await view.press(addJql)
  await view.type(queryField('JQL 2'), 'project = API')
  assert.deepEqual(queryFields(view), [
    ['JQL', 'labels = ui', 3],
    ['JQL 2', 'project = API', 3]
  ])
  // Nothing is stored before Save.
  await wait(800)
  assert.deepEqual((storedProject(host) as StoredFilters).filters?.jira?.[0].queries, ['project = WEB', '', 'labels = ui'])
  await view.press(saveButton)
  assert.deepEqual((storedProject(host) as StoredFilters).filters?.jira?.[0].queries, ['labels = ui', 'project = API'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('each JQL label sits above its query, and Remove is centred beside the query, not the label', async () => {
  const { view } = await showFilters(filtersStored([boardFilter]))
  await view.press(editFilter)
  const fields = nodesIn(view.tree(), (node) => node.type === 'Field')
  assert.deepEqual(
    fields.map((field) => field.props?.label),
    ['JQL', 'JQL 2']
  )
  for (const field of fields) {
    const [row, ...extra] = elementsIn(field)
    assert.deepEqual(extra, [])
    assertProps(row, { direction: 'row', align: 'center' })
    const [query, remove] = elementsIn(row).map((box) => elementsIn(box)[0])
    assert.equal(query?.type, 'Textarea')
    assertProps(query, { label: field.props?.label, labelHidden: true })
    assert.equal(remove?.type, 'IconButton')
    assertProps(remove, { label: `Remove ${field.props?.label}` })
  }
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('Ctrl+Enter in any JQL field saves the filter with the queries as typed and lists its tasks', async () => {
  const seen: unknown[] = []
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith(
    {
      'tasks.load': () => {
        // `host` is set once the panel has mounted, after the first load.
        if (host) seen.push((storedProject(host) as StoredFilters).filters?.jira?.[0].queries)
        return twgReady([twgTask('WEB-1')], { filterId: 'tasks' })
      }
    },
    filtersStored([tasksFilter])
  ))
  await view.press(editFilter)
  await view.press(addJql)
  await view.type(queryField('JQL 2'), 'labels = ui\nAND status = Open')
  await view.submit(queryField('JQL 2'))
  assert.equal(view.find(filterTitle('Edit filter')), null)
  await view.press(editFilter)
  await view.submit(queryField('JQL'))
  assert.deepEqual(seen, [
    ['project = WEB', 'labels = ui\nAND status = Open'],
    ['project = WEB', 'labels = ui\nAND status = Open']
  ])
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
})

test('Delete needs a second click, and deleting the filter shown shows the first remaining one and loads its tasks', async () => {
  const { view, host, inputs } = await showFilters(filtersStored([tasksFilter, boardFilter, mineFilter], 'f-board'))
  await view.press(editFilter)
  await view.press({ type: 'Button', text: 'Delete filter' })
  assert.ok(view.find(filterTitle('Edit filter')))
  assert.equal((storedProject(host) as StoredFilters).filters?.jira?.length, 3)
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedProject(host) as StoredFilters, {
    ...(storedProject(host) as object),
    filters: { jira: [tasksFilter, mineFilter] },
    shownFilterId: { jira: 'tasks' }
  })
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Mine'])
  assert.equal(view.valueOf(filterSelect), 'tasks')
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  assert.equal(inputs.length, 2)
})

test('Delete turns back after a few seconds without the second click, and is disabled for the only filter', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter]))
  await view.press(editFilter)
  assert.equal(view.find({ type: 'Button', text: 'Delete filter' })?.disabled, true)
  await view.press({ type: 'Button', text: 'Cancel' })
  await view.unmount()

  const two = await showFilters(filtersStored([tasksFilter, boardFilter]))
  await two.view.press(editFilter)
  await two.view.press({ type: 'Button', text: 'Delete filter' })
  assert.ok(two.view.find({ type: 'Button', text: 'Confirm delete' }))
  await wait(CONFIRM_DELETE_MS + 200)
  await two.view.settled()
  assert.ok(two.view.find({ type: 'Button', text: 'Delete filter' }))
})

/** The panel on the web project with two stored filters, whose `tasks.load` lists the filter's task
 *  until `answerLater` sets the answer every later load gives, or, with null, lists it again. */
async function showAnsweringLater() {
  let later: TaskList | null = null
  const { view } = await showWith(
    { 'tasks.load': (input: LoadInput) => later ?? twgReady([twgTask('WEB-1')], { filterId: input.filterId ?? 'tasks' }) },
    filtersStored([tasksFilter, boardFilter])
  )
  return { view, answerLater: (answer: TaskList | null) => (later = answer) }
}

/** Renames the filter shown in its editor and saves it. */
async function saveRenamedFilter(view: TestPanel) {
  await view.press(editFilter)
  await view.type({ type: 'Input', label: 'Name' }, 'Open tasks', { replace: true })
  await view.press(saveButton)
}

test('after a filter Save, a load that fails for a reason naming no filter still opens Project settings by itself', async () => {
  const { view, answerLater } = await showAnsweringLater()
  await saveRenamedFilter(view)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  answerLater({ kind: 'error', project: web, message: 'twg failed.' })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.ok(view.find(settingsTitle))
})

test('after a filter Delete, a load that fails for a reason naming no filter still opens Project settings by itself', async () => {
  const { view, answerLater } = await showAnsweringLater()
  await view.press(editFilter)
  await view.press({ type: 'Button', text: 'Delete filter' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  answerLater({ kind: 'error', project: web, message: 'twg failed.' })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.ok(view.find(settingsTitle))
})

test('after a filter Save, a load answering that the project needs a tracker opens Project settings by itself', async () => {
  const { view, answerLater } = await showAnsweringLater()
  await saveRenamedFilter(view)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  answerLater({ kind: 'needs-config', project: web })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.ok(view.find(settingsTitle))
})

test('a load right after a filter Save that fails for a reason naming no filter opens Project settings by itself', async () => {
  const { view, answerLater } = await showAnsweringLater()
  await view.press(editFilter)
  answerLater({ kind: 'error', project: web, message: 'twg failed.' })
  await view.type({ type: 'Input', label: 'Name' }, 'Open tasks', { replace: true })
  await view.press(saveButton)
  assert.ok(view.find(settingsTitle))
})

test('Project settings closed with Done stay closed after a filter Save, also when a load fails', async () => {
  const { view, answerLater } = await showAnsweringLater()
  await view.press(gear)
  await view.press(done)
  await saveRenamedFilter(view)
  answerLater({ kind: 'error', project: web, message: 'twg failed.' })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(view.find(settingsTitle), null)
  assert.ok(view.find({ type: 'Callout', text: /twg failed\./ }))
})

test('Save in the filter editor that a failed query opened over Project settings goes back to Project settings', async () => {
  const { view, answerLater } = await showAnsweringLater()
  await view.press(gear)
  answerLater({ kind: 'error', project: web, message: 'Tasks: The JQL query is invalid.', filterId: 'tasks' })
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  await view.settled()
  assert.ok(view.find(filterTitle('Edit filter')))
  answerLater(null)
  await view.type({ type: 'Input', label: 'Name' }, 'Open tasks', { replace: true })
  await view.press(saveButton)
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.ok(view.find(settingsTitle))
})

test('a failed write of a filter keeps the editor open with the error and the draft', async () => {
  let failing = true
  let data: JsonValue = filtersStored([tasksFilter, boardFilter]).settings
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': twgReady([twgTask('WEB-1')], { filterId: 'tasks' }) },
    results: {
      'storage.get': () => ({ value: data }),
      'storage.set': (params: { key: string; value: JsonValue }) => {
        if (failing) throw hostError('quota_exceeded', 'Storage is full')
        data = params.value
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press(editFilter)
  await view.type({ type: 'Input', label: 'Name' }, 'Sprint', { replace: true })
  await view.press(saveButton)
  assert.ok(view.find(filterTitle('Edit filter')))
  assert.ok(view.find({ type: 'Callout', text: "Couldn't save the filter (quota_exceeded). Try again." }))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Sprint')
  failing = false
  await view.press(saveButton)
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Sprint', 'Board'])
})

test('a change of active project while the filter editor is open drops the draft, and closing the panel drops it too', async () => {
  let project = web
  const { view } = await showWith(
    { 'tasks.load': () => (project === web ? twgReady([twgTask('WEB-1')], { filterId: 'tasks' }) : ready([task('#9')], { project: api })) },
    filtersStored([tasksFilter])
  )
  await view.press(editFilter)
  project = api
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  await view.settled()
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.ok(view.find({ type: 'Link', text: '#9' }))
  await view.unmount()

  const again = await showFilters(filtersStored([tasksFilter]))
  await again.view.press(editFilter)
  await again.view.unmount()
  const reopened = await mount(panel, { host: again.host })
  assert.equal(reopened.find(filterTitle('Edit filter')), null)
  assert.ok(reopened.find(filterSelect))
})

/** `storage` with these global filters by tracker. */
const withGlobalFilters = (storage: { settings: { version: number; projects: Record<string, JsonValue> } }, filters: Record<string, StoredFilter[]>) => ({
  settings: { ...storage.settings, global: { filters } }
})

/** The stored global filters by tracker. */
const storedGlobalFilters = (host: MockHost) =>
  (host.data().storage.settings as { global?: { filters?: Record<string, StoredFilter[]> } } | undefined)?.global?.filters

const sprintGlobal = { id: 'g-sprint', name: 'Sprint', queries: ['project = {{jira_project}} AND sprint in openSprints()'] }
const triageGlobal = { id: 'g-triage', name: 'Triage', queries: ['is:open label:needs-triage'] }
const docs = { id: 'github:acme/docs', name: 'docs', repo: 'acme/docs' }

test("the filter row lists the project's own filters, then the global ones of its tracker, marked Global, and can show a global one", async () => {
  const storage = withGlobalFilters(filtersStored([tasksFilter, boardFilter]), { jira: [sprintGlobal], github: [triageGlobal] })
  const { view, host, inputs } = await showFilters(storage)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board', 'Sprint (Global)'])
  await view.select(filterSelect, 'g-sprint')
  // The load saves the filter shown first, and lists it: WEB-9, a filter not in FILTER_KEYS.
  assert.equal(inputs.length, 2)
  assert.deepEqual((storedProject(host) as StoredFilters).shownFilterId, { jira: 'g-sprint' })
  assert.ok(view.find({ type: 'Link', text: 'WEB-9' }))
  assert.equal(view.valueOf(filterSelect), 'g-sprint')
  await view.press(editFilter)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Sprint')
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('a Jira filter made global in one project is offered, marked Global, in every Jira project and in no GitHub project; editing it changes it in all, and deleting it removes it from all', async () => {
  let project = web
  const { view, host } = await showWith(
    {
      'tasks.load': () =>
        project === docs ? ready([task('#9')], { project: docs }) : twgReady([twgTask(project === web ? 'WEB-1' : 'API-1')], { project, filterId: 'tasks' })
    },
    {
      settings: {
        version: 1,
        projects: {
          [web.id]: { provider: 'jira-twg', providers: { 'jira-twg': { site: '', profile: '' } }, filters: { jira: [tasksFilter, boardFilter] } },
          [api.id]: { provider: 'jira-orca', providers: { 'jira-orca': { siteId: '' } }, filters: { jira: [mineFilter] } }
        }
      }
    }
  )
  const reload = async (next: typeof web) => {
    project = next
    await view.press({ type: 'IconButton', label: 'Reload tasks' })
  }
  await view.select(filterSelect, 'f-board')
  await view.press(editFilter)
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  await view.toggle(globalSwitch)
  // The move is stored at once, and the editor stays open on the filter, now global.
  assert.deepEqual((storedProject(host) as StoredFilters).filters, { jira: [tasksFilter] })
  assert.deepEqual(storedGlobalFilters(host), { jira: [boardFilter] })
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Board')
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board (Global)'])
  assert.equal(view.valueOf(filterSelect), 'f-board')

  await reload(api)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Mine', 'Board (Global)'])
  await view.select(filterSelect, 'f-board')
  await view.press(editFilter)
  await view.type({ type: 'Input', label: 'Name' }, 'Sprint board', { replace: true })
  await view.press(saveButton)
  assert.deepEqual(storedGlobalFilters(host), { jira: [{ ...boardFilter, name: 'Sprint board' }] })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Mine', 'Sprint board (Global)'])

  await reload(docs)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open'])

  await reload(web)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Sprint board (Global)'])
  assert.equal(view.valueOf(filterSelect), 'f-board')
  await view.press(editFilter)
  const { deleteBar } = editorParts(view)
  assert.ok(deleteBar)
  assert.ok(nodesIn(deleteBar, (node) => node.type === 'Text' && wordsOf(node) === 'Deletes it in every project.').length === 1)
  await view.press({ type: 'Button', text: 'Delete filter' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedGlobalFilters(host), { jira: [] })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks'])

  await reload(api)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Mine'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('an own filter says nothing about other projects in its Delete bar, and a global one is deleted while the project lists another', async () => {
  const { view } = await showFilters(withGlobalFilters(filtersStored([], 'g-sprint'), { jira: [sprintGlobal, { ...boardFilter, id: 'g-board' }] }))
  assert.deepEqual(optionLabels(view, 'Filter'), ['Sprint (Global)', 'Board (Global)'])
  await view.press(editFilter)
  assert.equal(view.find({ type: 'Button', text: 'Delete filter' })?.disabled, false)
  await view.press({ type: 'Button', text: 'Cancel' })
  await view.unmount()

  const own = await showFilters(filtersStored([tasksFilter, boardFilter]))
  await own.view.press(editFilter)
  assert.equal(own.view.find({ type: 'Text', text: 'Deletes it in every project.' }), null)
})

test('turning Global off asks first, then moves the filter to the active project only', async () => {
  const storage = withGlobalFilters(filtersStored([tasksFilter], 'f-board'), { jira: [boardFilter, sprintGlobal] })
  const { view, host } = await showFilters(storage)
  await view.press(editFilter)
  await view.toggle(globalSwitch)
  // A confirmation bar in place of the Delete bar; nothing is stored yet.
  const { deleteBar } = editorParts(view)
  assert.ok(deleteBar)
  assert.ok(nodesIn(deleteBar, (node) => node.type === 'Text' && wordsOf(node) === 'Other projects will stop offering it.').length === 1)
  assert.deepEqual(buttonsIn(deleteBar), ['Keep global', 'Confirm'])
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  assert.deepEqual(storedGlobalFilters(host), { jira: [boardFilter, sprintGlobal] })

  await view.press({ type: 'Button', text: 'Keep global' })
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.deepEqual(buttonsIn(editorParts(view).deleteBar!), ['Delete filter'])
  assert.deepEqual(storedGlobalFilters(host), { jira: [boardFilter, sprintGlobal] })

  await view.toggle(globalSwitch)
  await view.press({ type: 'Button', text: 'Confirm' })
  assert.deepEqual(storedGlobalFilters(host), { jira: [sprintGlobal] })
  assert.deepEqual((storedProject(host) as StoredFilters).filters, { jira: [tasksFilter, boardFilter] })
  assert.deepEqual((storedProject(host) as StoredFilters).shownFilterId, { jira: 'f-board' })
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board', 'Sprint (Global)'])
  assert.equal(view.valueOf(filterSelect), 'f-board')
})

test('a filter move whose name the destination group already has is refused with a message, and changes nothing', async () => {
  const storage = withGlobalFilters(filtersStored([tasksFilter, { ...mineFilter, name: 'Board' }], 'f-mine'), { jira: [{ ...boardFilter, id: 'g-board' }] })
  const { view, host } = await showFilters(storage)
  await view.press(editFilter)
  await view.toggle(globalSwitch)
  assert.ok(view.find({ type: 'Text', text: 'A global filter is already called "Board". Rename one of them first.' }))
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  assert.deepEqual(storedProject(host), storage.settings.projects['github:acme/web'])
  assert.deepEqual(storedGlobalFilters(host), { jira: [{ ...boardFilter, id: 'g-board' }] })
})

test('a failed filter move keeps the filter where it was, and the editor open with the error', async () => {
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': twgReady([twgTask('WEB-1')], { filterId: 'tasks' }) },
    storage: filtersStored([tasksFilter, boardFilter]),
    results: {
      'storage.set': () => {
        throw hostError('quota_exceeded', 'Storage is full')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press(editFilter)
  await view.toggle(globalSwitch)
  assert.ok(view.find({ type: 'Text', text: "Couldn't move the filter (quota_exceeded). Try again." }))
  assert.equal(view.find(globalSwitch)?.props.checked, false)
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board'])
})

test('a new filter with Global on is saved among the global ones, and a project that listed only its initial filter keeps it', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(newFilter)
  await view.toggle(globalSwitch)
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.equal(storedGlobalFilters(host), undefined)
  await view.type(queryField('Query'), 'label:bug', { replace: true })
  await view.press(saveButton)
  const [saved] = storedGlobalFilters(host)?.github ?? []
  assert.deepEqual([saved?.name, saved?.queries], ['Filter 2', ['label:bug']])
  assert.deepEqual(storedProject(host), {
    providers: {},
    filters: { github: [{ id: 'open', name: 'Open', queries: ['is:open'] }] },
    shownFilterId: { github: saved.id }
  })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open', 'Filter 2 (Global)'])
  assert.equal(view.valueOf(filterSelect), saved.id)
})

test("a global filter's name is checked against the global ones only", async () => {
  const storage = { settings: { version: 1, projects: {}, global: { filters: { github: [triageGlobal] } } } }
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, storage)
  await view.press(newFilter)
  await view.type({ type: 'Input', label: 'Name' }, 'Triage', { replace: true })
  assert.equal(view.find(saveButton)?.disabled, false)
  await view.toggle(globalSwitch)
  assert.ok(view.find({ type: 'Text', text: 'Another global filter is already called "Triage".' }))
  assert.equal(view.find(saveButton)?.disabled, true)
})

test('the initial filter made global takes a new id and stays the filter shown', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) })
  await view.press(editFilter)
  await view.toggle(globalSwitch)
  const [moved] = storedGlobalFilters(host)?.github ?? []
  assert.ok(moved)
  assert.notEqual(moved.id, 'open')
  assert.deepEqual([moved.name, moved.queries], ['Open', ['is:open']])
  assert.deepEqual(storedProject(host), { providers: {}, filters: { github: [] }, shownFilterId: { github: moved.id } })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open (Global)'])
  assert.equal(view.valueOf(filterSelect), moved.id)
})

const HINT = 'This filter names WEB. Use {{jira_project}} so each project lists its own tasks.'
const useVariable = { type: 'Button', text: 'Use {{jira_project}}' }

test("a global Jira filter that names the project's Jira project key shows a hint under the queries, whose button rewrites the draft", async () => {
  const boardGlobal = { id: 'g-board', name: 'Board', queries: ['project = web ORDER BY rank', 'labels = ui OR project=WEB'] }
  const project = { filters: { jira: [tasksFilter] }, shownFilterId: { jira: 'g-board' }, jiraProjectKey: 'WEB' }
  const { view, host } = await showFilters(withGlobalFilters(twgStored({ site: '', profile: '' }, project), { jira: [boardGlobal] }))
  await view.press(editFilter)
  assert.ok(view.find({ type: 'Text', text: HINT }))
  await view.press(useVariable)
  assert.deepEqual(queryFields(view).map(([, value]) => value), ['project = {{jira_project}} ORDER BY rank', 'labels = ui OR project={{jira_project}}'])
  assert.equal(view.find({ type: 'Text', text: HINT }), null)
  assert.equal(view.find(useVariable), null)
  // Only the draft changed; Save stores it.
  assert.deepEqual(storedGlobalFilters(host), { jira: [boardGlobal] })
  await view.press(saveButton)
  assert.deepEqual(storedGlobalFilters(host)?.jira?.[0]?.queries, ['project = {{jira_project}} ORDER BY rank', 'labels = ui OR project={{jira_project}}'])

  // An own filter naming the key shows no hint.
  await view.select(filterSelect, 'tasks')
  await view.press(editFilter)
  assert.equal(view.find({ type: 'Text', text: HINT }), null)
})

test("the hint doesn't show without a Jira project key, nor on GitHub", async () => {
  const boardGlobal = { id: 'g-board', name: 'Board', queries: ['project = WEB'] }
  const noKey = await showFilters(withGlobalFilters(filtersStored([], 'g-board'), { jira: [boardGlobal] }))
  await noKey.view.press(editFilter)
  assert.equal(noKey.view.find(useVariable), null)
  await noKey.view.unmount()

  const github = { settings: { version: 1, projects: { 'github:acme/web': { providers: {}, jiraProjectKey: 'WEB' } }, global: { filters: { github: [boardGlobal] } } } }
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, github)
  await view.select(filterSelect, 'g-board')
  await view.press(editFilter)
  assert.equal(view.find(globalSwitch)?.props.checked, true)
  assert.equal(view.find(useVariable), null)
})

/** The button that opens and closes "Filters", the header of its section. */
const filtersToggle = { type: 'Button', text: 'Filters' }

/** Whether `node` is the section "Filters": its first child is the header, a `Stack` that stretches
 *  the toggle across the width, as a Collapsible's header; then the summary while it is closed, or
 *  what it holds while it is open. Orca keeps the keys of controls only, so the toggle's key finds it. */
function isFiltersSection(node: TreeSnapshot | string): node is TreeSnapshot {
  if (typeof node === 'string') return false
  const [header] = node.children ?? []
  if (header === undefined || typeof header === 'string' || header.type !== 'Stack' || header.props?.align !== 'stretch') return false
  const [toggle, ...others] = header.children ?? []
  return typeof toggle !== 'string' && toggle?.key === 'filters-toggle' && others.length === 0
}

/** The types of the parts of "Filters": its header, then the summary or what it holds. */
function filtersParts(view: TestPanel): string[] {
  const [section] = nodesIn(view.tree(), isFiltersSection)
  assert.ok(section, 'no "Filters"')
  return (section.children ?? []).map((node) => (typeof node === 'string' ? 'text' : node.type))
}

/** The kinds and labels of the controls drawn in "Filters", its header first, in order. */
function controlsInFilters(view: TestPanel): string[] {
  const [section] = nodesIn(view.tree(), isFiltersSection)
  assert.ok(section, 'no "Filters"')
  const controls = nodesIn(section, (node) => ['Select', 'IconButton', 'Input', 'Button'].includes(node.type))
  return controls.map((node) => `${node.type} ${String(node.props?.label ?? wordsOf(node))}`)
}

/** Whether "Filters" is open, as its header's icon and tooltip say. */
function filtersOpen(view: TestPanel): boolean {
  const toggle = view.find(filtersToggle)
  assert.ok(toggle, 'no "Filters" header')
  const open = toggle.props.icon === 'collapse'
  assert.equal(toggle.props.tooltip, open ? 'Hide filters' : 'Show filters')
  if (!open) assert.equal(toggle.props.icon, 'expand')
  return open
}

test('"Filters", open at first, holds the filter row and Search tasks, with its hint and Search in Jira, flush under a header as wide as the panel; closed, it says the filter and the text under it', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter, boardFilter], 'f-board'))
  assert.equal(filtersOpen(view), true)
  assert.deepEqual(filtersParts(view), ['Stack', 'Stack'])
  assert.equal(view.find(filtersToggle)?.props.variant, 'ghost')
  assert.equal(view.find(filtersToggle)?.props.size, 'sm')
  // No Collapsible: it would indent what it holds.
  assert.equal(view.find({ type: 'Collapsible' }), null)
  await view.type(searchField, 'dark')
  assert.deepEqual(controlsInFilters(view), [
    'Button Filters',
    'Select Filter',
    'IconButton Edit filter',
    'IconButton New filter',
    'Input Search tasks',
    'Button Search in Jira'
  ])
  assert.equal(view.find({ type: 'Text', text: 'Board · "dark"' }), null)
  await view.press({ type: 'Button', text: 'Search in Jira' })
  // The tracker search's results row stays outside, so Clear search is at hand while it is closed.
  await view.press(filtersToggle)
  assert.equal(filtersOpen(view), false)
  assert.equal(view.find(filterSelect), null)
  assert.equal(view.find(searchField), null)
  assert.deepEqual(controlsInFilters(view), ['Button Filters'])
  assert.deepEqual(filtersParts(view), ['Stack', 'Text'])
  assert.equal(view.find({ type: 'Text', text: 'Board · "dark"' })?.props.muted, true)
  assert.ok(view.find({ type: 'Button', text: 'Clear search' }))
  await view.press({ type: 'Button', text: 'Clear search' })
  assert.ok(view.find({ type: 'Text', text: 'Board' }))
  await view.press(filtersToggle)
  assert.equal(filtersOpen(view), true)
  assert.equal(view.find({ type: 'Text', text: 'Board' }), null)
})

test('"Filters" stays as it was left through reloads while the panel is open, starts open in a panel opened again, and holds the filter row above a load error', async () => {
  const { view, host } = await showFilters(filtersStored([tasksFilter, boardFilter], 'f-board'))
  await view.press(filtersToggle)
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.equal(filtersOpen(view), false)
  assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
  await view.press(filtersToggle)
  await view.select(filterSelect, 'tasks')
  assert.equal(filtersOpen(view), true)
  await view.press(filtersToggle)
  await view.unmount()

  const reopened = await mount(panel, { host })
  assert.ok(reopened.find(filterSelect))
  await reopened.unmount()

  const failing = await showFilters(filtersStored([tasksFilter, { ...boardFilter, queries: [''] }], 'f-board'))
  await failing.view.press({ type: 'Button', text: 'Cancel' })
  assert.deepEqual(controlsInFilters(failing.view), ['Button Filters', 'Select Filter', 'IconButton Edit filter', 'IconButton New filter'])
  assert.ok(failing.view.find({ type: 'Callout' }))
  assert.deepEqual(afterFilters(failing.view), ['Separator', 'Callout'])
})

/** The types of the nodes drawn after "Filters", beside it. */
function afterFilters(view: TestPanel): string[] {
  const [parent] = nodesIn(view.tree(), (node) => (node.children ?? []).some(isFiltersSection))
  assert.ok(parent, 'no "Filters"')
  const siblings = parent.children ?? []
  return siblings.slice(siblings.findIndex(isFiltersSection) + 1).map((node) => (typeof node === 'string' ? 'text' : node.type))
}

test('a divider parts "Filters" from the list, open or closed, and from the results row of a tracker search', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter]))
  assert.deepEqual(afterFilters(view), ['Separator', 'Box'])
  await view.press(filtersToggle)
  assert.deepEqual(afterFilters(view), ['Separator', 'Box'])
  await view.press(filtersToggle)
  await view.type(searchField, 'dark', { submit: true })
  assert.ok(view.find({ type: 'Button', text: 'Clear search' }))
  assert.deepEqual(afterFilters(view), ['Separator', 'Box', 'Box'])
})

test('a change of active project while the choice of + on Jira is open drops it, and closing the panel drops it too', async () => {
  let project = web
  const { view } = await showWith(
    { 'tasks.load': () => (project === web ? twgReady([twgTask('WEB-1')], { filterId: 'tasks' }) : ready([task('#9')], { project: api })) },
    filtersStored([tasksFilter])
  )
  await view.press(newFilter)
  project = api
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  await view.settled()
  assert.equal(view.find(startFrom), null)
  assert.ok(view.find({ type: 'Link', text: '#9' }))
  // Back on the first project, the list shows: the choice was dropped, not hidden.
  project = web
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  await view.settled()
  assert.equal(view.find(startFrom), null)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  await view.unmount()

  const again = await showFilters(filtersStored([tasksFilter]))
  await again.view.press(newFilter)
  await again.view.unmount()
  const reopened = await mount(panel, { host: again.host })
  assert.equal(reopened.find(startFrom), null)
  assert.ok(reopened.find(filterSelect))
})

test('a truncated Jira list from several queries says the first 100 of each are shown, whatever the settings say since', async () => {
  const truncated = (queryCount: number) => ({
    'tasks.load': ready([task('WEB-1', { tracker: 'jira' })], { provider: 'jira-orca', truncated: true, queryCount }),
    'jira.sites': SITES
  })
  const several = await showWith(truncated(2), jiraStored('', { filters: { jira: [tasksFilter] } }))
  assert.ok(several.view.find({ type: 'Text', text: 'Showing the first 100 tasks of each query — narrow your JQL.' }))
  await several.view.unmount()

  const one = await showWith(truncated(1), jiraStored('', { filters: { jira: [boardFilter] } }))
  assert.ok(one.view.find({ type: 'Text', text: 'Showing the first 100 tasks — narrow your JQL.' }))
})

test('100 tracker search results from several queries say the first 100 of each are shown', async () => {
  const list = ready([task('WEB-1', { tracker: 'jira' })], { provider: 'jira-orca', queryCount: 2 })
  const { view } = await showSearching(list, () => ready([task('WEB-90', { tracker: 'jira' })], { provider: 'jira-orca', truncated: true, queryCount: 2 }))
  await view.type(searchField, 'dark')
  await view.submit(searchField)
  assert.ok(view.find({ type: 'Text', text: 'Showing the first 100 results of each query — refine your search' }))
})

test("a stored site that isn't connected any more stays selectable, and a site list failure is shown", async () => {
  const { view } = await showWith(
    { 'tasks.load': jiraReady(), 'jira.sites': { kind: 'error', message: 'orca failed: Orca is not running.' } },
    jiraStored('site-9')
  )
  await view.press(gear)
  assert.equal(view.valueOf({ type: 'Select', label: 'Site' }), 'site-9')
  assert.deepEqual(optionLabels(view, 'Site'), ['Default site', 'site-9'])
  assert.ok(view.find({ type: 'Text', text: /Orca is not running/ }))
})

test('a load failure that names no filter opens Project settings by itself on the tracker, and Done shows the error under the filter row', async () => {
  const { view } = await showWith(
    { 'tasks.load': { kind: 'error', project: web, message: "orca failed: Orca isn't connected to Jira." }, 'jira.sites': SITES },
    jiraStored('')
  )
  assert.equal(view.valueOf({ type: 'Select', label: 'Tracker' }), 'jira-orca')
  assert.equal(view.find(filterTitle('Edit filter')), null)
  await view.press(done)
  assert.ok(view.find({ type: 'Callout', text: /isn't connected to Jira/ }))
  assert.ok(view.find(filterSelect))
})

test('Project settings that opened by itself stays open once a load from it, or from the Prompt templates view opened from it, lists the tasks', async () => {
  let fixed = false
  const { view } = await showWith(
    { 'tasks.load': () => (fixed ? jiraReady([task('WEB-1', { tracker: 'jira' })]) : { kind: 'error', project: web, message: 'orca failed: Orca is not running.' }), 'jira.sites': SITES },
    jiraStored('')
  )
  fixed = true
  await view.select({ type: 'Select', label: 'Site' }, 'site-1')
  assert.ok(view.find(settingsTitle))
  await view.press(done)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  await view.unmount()

  fixed = false
  const second = await showWith({ 'tasks.load': () => (fixed ? jiraReady() : { kind: 'error', project: web, message: 'orca failed.' }), 'jira.sites': SITES })
  await second.view.press(manageTemplates)
  fixed = true
  await second.view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  await second.view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(second.view.find(settingsTitle))
})

/** The provider settings of the web project, as `twgStored` stores them. */
type StoredProviders = { providers: { 'jira-twg'?: { profile: string } } }

/** The panel with these stored settings and a `tasks.load` that answers from the web project's
 *  settings as stored when it is asked, and its count of loads. */
async function showFromStored(
  storage: Record<string, JsonValue> & { settings: { projects: { 'github:acme/web': StoredProviders } } },
  answer: (project: StoredProviders) => TaskList
) {
  let loads = 0
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith(
    {
      'tasks.load': () => {
        loads++
        // `host` is set once the panel has mounted, after the first load.
        return answer(host ? (storedProject(host) as StoredProviders) : storage.settings.projects['github:acme/web'])
      },
      'jira.sites': SITES
    },
    storage
  ))
  return { view, loads: () => loads }
}

test("Done after a change of twg's profile, a setting of the tracker, reloads the list once", async () => {
  const { view, loads } = await showFromStored(twgStored({ site: '', profile: 'work' }), (project) =>
    twgReady([twgTask(project.providers['jira-twg']?.profile === 'home' ? 'WEB-2' : 'WEB-1')])
  )
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  await view.press(gear)
  await view.type({ type: 'Input', label: 'Profile' }, 'home', { replace: true })
  assert.equal(loads(), 1)
  await view.press(done)
  assert.equal(loads(), 2)
  assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
})

test("changing the tracker lists the new tracker's tasks, and Done shows them without loading them again", async () => {
  let loads = 0
  const { view } = await showWith(
    { 'tasks.load': () => (++loads === 1 ? jiraReady([task('WEB-1', { tracker: 'jira' })]) : twgReady([twgTask('WEB-2')])), 'jira.sites': SITES },
    jiraStored('')
  )
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Tracker' }, 'jira-twg')
  await view.press(done)
  assert.equal(loads, 2)
  assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
  assert.equal(view.find({ type: 'Link', text: 'WEB-1' }), null)
})

test('Done after changing only the agent or the default template, or nothing, loads nothing', async () => {
  let loads = 0
  const { view } = await showWith({ 'tasks.load': () => (loads++, ready([task('#42')])) }, twoTemplates)
  await view.press(gear)
  await view.press(done)
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Agent' }, 'codex')
  await view.press(done)
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Default template' }, 't-impl')
  await view.press(done)
  assert.equal(loads, 1)
  assert.ok(view.find({ type: 'Link', text: '#42' }))
})

test('a failed query opens the filter editor by itself on its filter, with the error, not Project settings', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter, { ...boardFilter, queries: ['', ' '] }], 'f-board'))
  assert.ok(view.find(filterTitle('Edit filter')))
  assert.equal(view.find(settingsTitle), null)
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Board')
  assert.deepEqual(queryFields(view), [
    ['JQL', '', 3],
    ['JQL 2', ' ', 3]
  ])
  const error = view.find({ type: 'Callout', text: /^Couldn't load tasks / })
  assert.match(error?.text ?? '', /^Couldn't load tasks Board: Enter a JQL query/)
  // The error opens the form, above the name.
  const { form } = editorParts(view)
  assert.equal(elementsIn(form)[0]?.type, 'Callout')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('Save in the filter editor that opened on a failed query, with the query fixed, lists the tasks and shows the error no more', async () => {
  const { view, inputs } = await showFilters(filtersStored([tasksFilter, { ...boardFilter, queries: [''] }], 'f-board'))
  await view.type(queryField('JQL'), 'project = WEB')
  await view.press(saveButton)
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
  assert.equal(inputs.length, 2)
})

test('Cancel in the filter editor that opened on a failed query shows the error under the filter row, and another filter can be chosen', async () => {
  const { view, inputs } = await showFilters(filtersStored([tasksFilter, { ...boardFilter, queries: [''] }], 'f-board'))
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.equal(view.find(settingsTitle), null)
  assert.match(view.find({ type: 'Callout', text: /^Couldn't load tasks / })?.text ?? '', /^Couldn't load tasks Board: Enter a JQL query/)
  assert.equal(view.valueOf(filterSelect), 'f-board')
  await view.select(filterSelect, 'tasks')
  assert.equal(inputs.length, 2)
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  assert.equal(view.find({ type: 'Callout' }), null)
})

test('a failed query while the choice of + on Jira, the filter editor or the Prompt templates view is open leaves it open', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter, { ...boardFilter, queries: [''] }], 'f-board'))
  await view.press({ type: 'Button', text: 'Cancel' })
  await view.press(newFilter)
  await view.select(startFrom, 'board-order')
  await view.type(projectKeyField, 'WEB')
  const reload = () => view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  await reload()
  await view.settled()
  assert.equal(view.valueOf(startFrom), 'board-order')
  assert.equal(view.valueOf(projectKeyField), 'WEB')

  await view.press(continueButton)
  await view.type({ type: 'Input', label: 'Name' }, 'Sprint', { replace: true })
  await reload()
  await view.settled()
  assert.ok(view.find(filterTitle('New filter')))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Sprint')

  await view.press({ type: 'Button', text: 'Cancel' })
  await view.press(gear)
  await view.press(manageTemplates)
  await reload()
  await view.settled()
  assert.ok(view.find(templatesTitle))
})

test('after a site list failure or no connected site, reloading the tasks asks for the sites again', async () => {
  const answers = [{ kind: 'error' as const, message: 'orca failed: Orca is not running.' }, { kind: 'ready' as const, sites: [] }, SITES]
  let asked = 0
  const { view } = await showWith(
    { 'tasks.load': jiraReady(), 'jira.sites': () => answers[Math.min(asked++, answers.length - 1)] },
    jiraStored('')
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
})

test('choosing Jira (twg) shows its Site and Profile fields, no JQL, with the twg login hint', async () => {
  let loads = 0
  const { view, host } = await showWith(
    { 'tasks.load': () => (++loads === 1 ? ready([], { provider: 'jira-orca' }) : twgReady([])) },
    jiraStored('site-1')
  )
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Tracker' }, 'jira-twg')
  assert.equal(loads, 2)
  assert.equal(view.find({ type: 'Textarea' }), null)
  assert.equal(view.valueOf({ type: 'Input', label: 'Site' }), '')
  assert.equal(view.valueOf({ type: 'Input', label: 'Profile' }), 'work')
  assert.equal(view.find({ type: 'Select', label: 'Site' }), null)
  assert.ok(view.find({ type: 'Text', text: /twg login/ }))
  assert.equal((storedProject(host) as { provider: string }).provider, 'jira-twg')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test("the twg site and profile save themselves, keeping the other providers' settings, and Enter reloads", async () => {
  let loads = 0
  const { view, host } = await showWith({ 'tasks.load': () => (loads++, twgReady([])) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await view.type({ type: 'Input', label: 'Site' }, 'example')
  await view.type({ type: 'Input', label: 'Profile' }, 'work')
  await wait(800)
  assert.deepEqual(storedProject(host), { provider: 'jira-twg', providers: { 'jira-twg': { site: 'example', profile: 'work' }, 'jira-orca': { siteId: 'site-1' } } })
  for (const field of [{ type: 'Input', label: 'Site' }, { type: 'Input', label: 'Profile' }]) {
    const before = loads
    await view.submit(field)
    assert.equal(loads, before + 1)
  }
})

const jiraProjectKeyField = { type: 'Input', label: 'Jira project key' }

test('a Jira project\'s settings show the Jira project key, empty at first, with what it is for; a GitHub project\'s don\'t', async () => {
  const jira = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await jira.view.press(gear)
  assert.equal(jira.view.valueOf(jiraProjectKeyField), '')
  assert.ok(jira.view.find({ type: 'Text', text: /\{\{jira_project\}\}/ }))
  await jira.view.select({ type: 'Select', label: 'Tracker' }, 'jira-orca')
  assert.equal(jira.view.valueOf(jiraProjectKeyField), '')
  await jira.view.select({ type: 'Select', label: 'Tracker' }, 'github')
  assert.equal(jira.view.find(jiraProjectKeyField), null)
  await jira.view.unmount()

  const github = await showWith({ 'tasks.load': ready([task('#42')]) })
  await github.view.press(gear)
  assert.equal(github.view.find(jiraProjectKeyField), null)
})

test('the Jira project key saves itself trimmed and upper-cased, a panel opened again shows it, and Done lists the tasks again', async () => {
  let loads = 0
  const { view, host } = await showWith({ 'tasks.load': () => (loads++, twgReady([])) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await view.type(jiraProjectKeyField, ' web ')
  assert.equal(view.valueOf(jiraProjectKeyField), 'WEB')
  assert.equal(loads, 1)
  await wait(800)
  assert.equal((storedProject(host) as { jiraProjectKey?: string }).jiraProjectKey, 'WEB')
  await view.press(done)
  assert.equal(loads, 2)
  await view.unmount()
  const again = await mount(panel, { host })
  await again.press(gear)
  assert.equal(again.valueOf(jiraProjectKeyField), 'WEB')
})

const branchTemplateField = { type: 'Input', label: 'Branch template' }
const fallbackField = { type: 'Input', label: 'Fallback branch type' }
const exclusionField = { type: 'Input', label: 'Title exclusion pattern' }
const issueTypeField = (row: number) => ({ type: 'Input', label: `Issue type ${row}` })
const branchTypeField = (row: number) => ({ type: 'Input', label: `Branch type ${row}` })
const addBranchType = { type: 'Button', text: 'Add branch type' }
const CONVENTION = '{{branch_type}}/{{task_key}}__{{task_slug}}--AB'

type StoredBranch = { branchTemplate?: string; branchTypes?: { issueType: string; branchType: string }[]; branchTypeFallback?: string; titleExclusion?: string }
const storedBranch = (host: MockHost) => {
  const { branchTemplate, branchTypes, branchTypeFallback, titleExclusion } = (storedProject(host) ?? {}) as StoredBranch
  return { branchTemplate, branchTypes, branchTypeFallback, titleExclusion }
}

/** The texts of the Branch section's preview. */
const previewShown = (view: TestPanel) => view.findAll({ type: 'Text', text: /^(Preview|Branch:|Worktree:)/ }).map((node) => node.text)

const web12Tagged = (fields: Partial<Task> = {}) =>
  task('WEB-12', { tracker: 'jira', url: 'https://example.atlassian.net/browse/WEB-12', title: '[FE] | [Mobile][Widgets] Add dark mode', issueType: 'Bug', ...fields })

/** Fills the Branch section with the team convention: a Bug row and the fallback feature. */
async function typeConvention(view: TestPanel): Promise<void> {
  await view.type(branchTemplateField, CONVENTION)
  await view.press(addBranchType)
  await view.type(issueTypeField(1), 'Bug')
  await view.type(branchTypeField(1), 'bugfix')
  await view.type(fallbackField, 'feature')
}

test('Project settings have a Branch section, empty at first but for the initial title exclusion pattern, with its variables', async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  assert.ok(view.find({ type: 'Text', text: 'Branch' }))
  assert.equal(view.valueOf(branchTemplateField), '')
  assert.equal(view.find(issueTypeField(1)), null)
  assert.equal(view.valueOf(fallbackField), '')
  assert.equal(view.valueOf(exclusionField), '\\[[^\\]]*\\]')
  for (const name of ['task_key', 'task_slug', 'branch_type']) assert.ok(view.find({ type: 'Code', text: `{{${name}}}` }), name)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('the branch settings save themselves, without the title exclusion pattern while it is unchanged, and a panel opened again shows them', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([web12Tagged()]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await typeConvention(view)
  await wait(SAVE_DELAY_MS + 200)
  assert.deepEqual(storedBranch(host), {
    branchTemplate: CONVENTION,
    branchTypes: [{ issueType: 'Bug', branchType: 'bugfix' }],
    branchTypeFallback: 'feature',
    titleExclusion: undefined
  })
  await view.unmount()
  const again = await mount(panel, { host })
  await again.press(gear)
  assert.equal(again.valueOf(branchTemplateField), CONVENTION)
  assert.equal(again.valueOf(issueTypeField(1)), 'Bug')
  assert.equal(again.valueOf(branchTypeField(1)), 'bugfix')
  assert.equal(again.valueOf(fallbackField), 'feature')
})

test('a branch type row can be removed, and the rest are kept in order', async () => {
  const types = [{ issueType: 'Bug', branchType: 'bugfix' }, { issueType: 'Story', branchType: 'feature' }]
  const { view, host } = await showWith(
    { 'tasks.load': twgReady([]) },
    twgStored({ site: '', profile: '' }, { branchTemplate: CONVENTION, branchTypes: types, branchTypeFallback: 'chore' })
  )
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Remove branch type 1' })
  assert.equal(view.valueOf(issueTypeField(1)), 'Story')
  assert.equal(view.find(issueTypeField(2)), null)
  await wait(SAVE_DELAY_MS + 200)
  assert.deepEqual(storedBranch(host).branchTypes, [{ issueType: 'Story', branchType: 'feature' }])
})

test('an emptied title exclusion pattern is stored, and a changed one replaces the initial one', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await view.type(exclusionField, '', { replace: true })
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).titleExclusion, '')
  await view.type(exclusionField, '^wip:\\s*', { replace: true })
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).titleExclusion, '^wip:\\s*')
})

test('the Branch section refuses to save fixed text git cannot hold, saying why, keeps what it last saved, and saves once it is fixed', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }, { branchTemplate: 'feature/{{task_key}}' }))
  await view.press(gear)
  await view.type(branchTemplateField, ' x')
  assert.equal(view.valueOf(branchTemplateField), 'feature/{{task_key}} x')
  assert.ok(view.find({ type: 'Text', text: /^The branch template has a space or a control character, which git can't hold in a branch name\. Not saved/ }))
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).branchTemplate, 'feature/{{task_key}}')
  for (const [template, problem] of [
    ['feature~{{task_key}}', 'has "~"'],
    ['feature..{{task_key}}', 'has ".."'],
    ['x@{{{task_key}}', 'has "@{"'],
    ['.{{task_key}}', 'has a part that starts with "."'],
    ['{{task_key}}.lock', 'has a part that ends with ".lock"'],
    ['-{{task_key}}', 'starts with "-"']
  ]) {
    await view.type(branchTemplateField, template, { replace: true })
    assert.ok(view.find({ type: 'Text', text: new RegExp(`^The branch template ${problem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }), template)
  }
  await view.type(branchTemplateField, 'fix/{{task_key}}', { replace: true })
  assert.equal(view.find({ type: 'Text', text: /Not saved/ }), null)
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).branchTemplate, 'fix/{{task_key}}')
})

test('the Branch section refuses a pattern that is not a regular expression, and {{branch_type}} without a fallback', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await view.type(exclusionField, '[unclosed', { replace: true })
  assert.ok(view.find({ type: 'Text', text: /^The title exclusion pattern isn't a valid regular expression: .* Not saved/ }))
  await wait(SAVE_DELAY_MS + 200)
  assert.notEqual(storedBranch(host).titleExclusion, '[unclosed')
  await view.type(exclusionField, '', { replace: true })
  await view.type(branchTemplateField, '{{branch_type}}/{{task_key}}')
  assert.ok(view.find({ type: 'Text', text: /^The branch template uses \{\{branch_type\}\}: give the branch types a fallback\. Not saved/ }))
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).titleExclusion, '')
  assert.notEqual(storedBranch(host).branchTemplate, '{{branch_type}}/{{task_key}}')
  await view.type(fallbackField, 'feature')
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).branchTemplate, '{{branch_type}}/{{task_key}}')
})

/** The Stack a field of Project settings is drawn in, with what is said under it. */
function fieldGroup(view: TestPanel, label: string): TreeSnapshot {
  const [group] = nodesIn(view.tree(), (node) => node.type === 'Stack' && elementsIn(node).some((child) => child.type === 'Input' && child.props?.label === label))
  assert.ok(group, `no field ${label}`)
  return group
}

/** The labels of the Branch section's fields marked invalid. */
const invalidBranchFields = (view: TestPanel) =>
  [branchTemplateField, fallbackField, exclusionField].filter((field) => view.find(field)?.props.invalid === true).map((field) => field.label)

/** What the danger callouts of the bar under Project settings say. */
function barProblems(view: TestPanel): string[] {
  const bar = settingsBar(view)
  return bar ? nodesIn(bar, (node) => node.type === 'Callout' && node.props?.tone === 'danger').map(wordsOf) : []
}

test('a problem in the Branch section marks the field to fix, says why under it, and names that field in the bar under the view, which stays in view', async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  // What is typed, and in which field; then the field marked, why, and how the bar names the field.
  const cases: [typed: { type: string; label: string }, text: string, marked: string, problem: RegExp, named: string][] = [
    [branchTemplateField, 'a b', 'Branch template', /^The branch template has a space or a control character, .* Not saved until it is fixed\.$/, 'branch template'],
    [
      branchTemplateField,
      '{{branch_type}}/{{task_key}}',
      'Fallback branch type',
      /^The branch template uses \{\{branch_type\}\}: give the branch types a fallback\. Not saved until it is fixed\.$/,
      'fallback branch type'
    ],
    [exclusionField, '[unclosed', 'Title exclusion pattern', /^The title exclusion pattern isn't a valid regular expression: .* Not saved until it is fixed\.$/, 'title exclusion pattern']
  ]
  for (const [typed, text, marked, problem, named] of cases) {
    if (typed === exclusionField) await view.type(branchTemplateField, '', { replace: true })
    await view.type(typed, text, { replace: true })
    assert.deepEqual(invalidBranchFields(view), [marked], text)
    assert.equal(nodesIn(fieldGroup(view, marked), (node) => node.type === 'Text' && problem.test(wordsOf(node))).length, 1, text)
    assert.deepEqual(barProblems(view), [`Branch settings not saved until the ${named} is fixed.`], text)
  }
  await view.type(exclusionField, '', { replace: true })
  assert.deepEqual(invalidBranchFields(view), [])
  assert.equal(view.find({ type: 'Text', text: /Not saved/ }), null)
  assert.deepEqual(barProblems(view), [])
})

test('the preview shows the branch and the worktree name for the first loaded task', async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([web12Tagged(), web12Tagged({ key: 'WEB-13', issueType: 'Story' })]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: named by Orca', 'Worktree: web-12-add-dark-mode'])
  await typeConvention(view)
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: bugfix/WEB-12__add-dark-mode--AB', 'Worktree: web-12-add-dark-mode'])
  await view.type(exclusionField, '', { replace: true })
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: bugfix/WEB-12__fe-mobile-widgets-add--AB', 'Worktree: web-12-fe-mobile-widgets-add'])
})

test('with no task loaded, the preview shows an invented Story, WEB-12', async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await typeConvention(view)
  assert.deepEqual(previewShown(view), ['Preview for WEB-12 (an example)', 'Branch: feature/WEB-12__add-dark-mode--AB', 'Worktree: web-12-add-dark-mode'])
})

/** Whether a part of the bar under Project settings is the line with Kickoff's version. */
const isVersionLine = (part: TreeSnapshot) => part.props?.justify === 'center'

/** What each part of the bar under Project settings is, top to bottom. */
function barParts(view: TestPanel): string[] {
  const bar = settingsBar(view)
  assert.ok(bar)
  return elementsIn(bar).map((part) =>
    part.type === 'Callout' ? `${part.props?.tone} callout` : part.props?.border === true ? 'preview' : isVersionLine(part) ? 'version' : 'ask'
  )
}

/** The line with Kickoff's version at the bottom of the bar under Project settings, or null. */
function versionLine(view: TestPanel): TreeSnapshot | null {
  const bar = settingsBar(view)
  assert.ok(bar)
  return elementsIn(bar).find(isVersionLine) ?? null
}

const installed = { version: '0.6.0', development: false }

/** The preview in the bar under Project settings. */
function barPreview(view: TestPanel): TreeSnapshot {
  const bar = settingsBar(view)
  assert.ok(bar)
  const [preview] = elementsIn(bar).filter((part) => part.props?.border === true)
  assert.ok(preview, 'the bar holds the preview')
  return preview
}

test("the preview stays in view in the bar under Project settings, in a box between why the section isn't saved and the Global switch's ask", async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([web12Tagged()]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  assert.deepEqual(barParts(view), ['preview'])
  assertProps(barPreview(view), { border: true, radius: 'md', padding: 'sm' })
  assert.deepEqual(elementsIn(barPreview(view)).map(wordsOf), ['Preview for WEB-12', 'Branch: named by Orca', 'Worktree: web-12-add-dark-mode'])
  await view.type(branchTemplateField, 'a b')
  await view.toggle(branchGlobalSwitch)
  assert.deepEqual(barParts(view), ['danger callout', 'preview', 'ask'])
})

test("Project settings ends with Kickoff's version, in one centred, muted line under everything in the bar", async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([web12Tagged()]), 'about.load': installed }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  assert.deepEqual(barParts(view), ['preview', 'version'])
  const line = versionLine(view)
  assert.ok(line)
  assertProps(line, { direction: 'row', justify: 'center' })
  assert.deepEqual(elementsIn(line).map((part) => ({ type: part.type, size: part.props?.size, muted: part.props?.muted, words: wordsOf(part) })), [
    { type: 'Text', size: 'xs', muted: true, words: 'Kickoff 0.6.0' }
  ])
  await view.type(branchTemplateField, 'a b')
  await view.toggle(branchGlobalSwitch)
  assert.deepEqual(barParts(view), ['danger callout', 'preview', 'ask', 'version'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
})

test('the version line says when Kickoff is a development plugin', async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([]), 'about.load': { version: '0.7.0', development: true } }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  const line = versionLine(view)
  assert.ok(line)
  assert.equal(wordsOf(line), 'Kickoff 0.7.0 · development')
})

test('the version is asked for once, the first time Project settings opens, and kept while the panel is open', async () => {
  let asked = 0
  const { view } = await showWith(
    {
      'tasks.load': twgReady([]),
      'about.load': () => {
        asked++
        return installed
      }
    },
    twgStored({ site: '', profile: '' })
  )
  assert.equal(asked, 0)
  await view.press(gear)
  assert.equal(asked, 1)
  await view.press({ type: 'Button', text: 'Done' })
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  await view.press(gear)
  assert.equal(asked, 1)
  assert.equal(wordsOf(versionLine(view) ?? ''), 'Kickoff 0.6.0')
})

test('Project settings that open by themselves ask for the version too', async () => {
  let asked = 0
  const { view } = await showWith({
    'tasks.load': { kind: 'needs-config', project: notes },
    'about.load': () => {
      asked++
      return installed
    }
  })
  assert.ok(view.find({ type: 'Heading', text: 'Project settings' }))
  assert.equal(asked, 1)
  assert.equal(wordsOf(versionLine(view) ?? ''), 'Kickoff 0.6.0')
})

test('a failure with no project, which opens no Project settings, asks for no version', async () => {
  let asked = 0
  const { view } = await showWith({
    'tasks.load': { kind: 'error', project: null, message: 'orca failed: not running.' },
    'about.load': () => {
      asked++
      return installed
    }
  })
  assert.equal(view.find({ type: 'Heading', text: 'Project settings' }), null)
  assert.equal(asked, 0)
})

test('no version line shows while the worker is asked, nor when it answers null or not at all', async () => {
  const answer = held()
  const { view } = await showWith(
    {
      'tasks.load': twgReady([]),
      'about.load': async () => {
        await answer.released
        return installed
      }
    },
    twgStored({ site: '', profile: '' })
  )
  const opening = view.press(gear)
  await drawn(view, { type: 'Heading', text: 'Project settings' })
  assert.equal(versionLine(view), null)
  answer.release()
  await opening
  assert.ok(versionLine(view))
  await view.unmount()
  for (const about of [() => null, () => Promise.reject(hostError('timeout', 'No answer.'))]) {
    const next = await showWith({ 'tasks.load': twgReady([]), 'about.load': about }, twgStored({ site: '', profile: '' }))
    await next.view.press(gear)
    assert.equal(versionLine(next.view), null)
    assert.equal(next.view.find({ type: 'Text', text: /^Kickoff \d/ }), null)
    assert.deepEqual(next.view.errors, [])
    await next.view.unmount()
  }
})

test("the preview says, under a separator, when a Start of the task would be refused for its branch, unless the section's own problem already says why", async () => {
  const { view } = await showWith({ 'tasks.load': twgReady([web12Tagged()]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await typeConvention(view)
  await view.type(branchTypeField(1), 'bug fix', { replace: true })
  const parts = elementsIn(barPreview(view))
  assert.deepEqual(parts.map((part) => part.type), ['Text', 'Text', 'Text', 'Separator', 'Text'])
  assert.match(wordsOf(parts[4]), /^The branch for WEB-12, "bug fix\/WEB-12__add-dark-mode--AB", has a space/)
  assertProps(parts[4], { tone: 'warning' })
  await view.type(branchTemplateField, 'x {{branch_type}}', { replace: true })
  assert.deepEqual(barProblems(view), ['Branch settings not saved until the branch template is fixed.'])
  assert.deepEqual(elementsIn(barPreview(view)).map((part) => part.type), ['Text', 'Text', 'Text'])
  assert.equal(view.find({ type: 'Text', text: /^The branch for WEB-12/ }), null)
})

const branchGlobalSwitch = { type: 'Switch', label: 'Global' }
const branchGlobalOn = (view: TestPanel) => view.find(branchGlobalSwitch)?.props.checked
const GLOBAL_BRANCH_LINE = 'Global branch settings are used by every project without its own. Turn it off to give this project its own copy.'
const PUBLISH_ASK = 'Projects without their own branch settings will name branches this way.'
const ADOPT_ASK = "This project's own branch settings are discarded."
const COPIED_NOTE = 'This project now has its own copy of the global branch settings. Changes here change only this project.'
const GLOBAL_BRANCH_WARNING = 'Changes how every project that uses them names the branches and worktrees of its next Starts. Task worktrees already started keep their branches.'
const TEAM_BRANCH = { branchTemplate: 'team/{{branch_type}}/{{task_key}}', branchTypes: [{ issueType: 'Bug', branchType: 'fix' }], branchTypeFallback: 'feat' }

/** The web project on Jira (twg), with `project` added, and the global branch settings of a team. */
const globalBranchStored = (project: Record<string, JsonValue> = {}) => ({
  settings: { ...twgStored({ site: '', profile: '' }, project).settings, global: { branch: TEAM_BRANCH } }
})

const storedGlobalBranch = (host: MockHost) => (host.data().storage.settings as { global?: { branch?: unknown } } | undefined)?.global?.branch
const storedBranchMark = (host: MockHost) => (storedProject(host) as { branchSettingsUsed?: string } | undefined)?.branchSettingsUsed

/** What Project settings shows under the part that scrolls, or null when nothing is there. */
function settingsBar(view: TestPanel): TreeSnapshot | null {
  const frame = view.tree()
  assert.ok(frame && typeof frame !== 'string')
  assertProps(frame, { direction: 'column', height: '100%' })
  const parts = elementsIn(frame)
  const form = parts.findIndex((part) => part.props?.scroll === 'y')
  assert.ok(form >= 0, 'Project settings has a part that scrolls')
  return parts[form + 1] ?? null
}

/** The part of the bar under Project settings that asks before the Branch section's Global switch
 *  turns on, or warns while it is on, or null. */
function barGlobalPart(view: TestPanel): TreeSnapshot | null {
  const bar = settingsBar(view)
  assert.ok(bar)
  return (
    elementsIn(bar).find((part) => part.props?.border !== true && !(part.type === 'Callout' && part.props?.tone === 'danger') && !isVersionLine(part)) ?? null
  )
}

/** The warning in the bar under Project settings that the section edits the global branch settings,
 *  or null. */
function barWarning(view: TestPanel): TreeSnapshot | null {
  const bar = settingsBar(view)
  return bar ? (nodesIn(bar, (node) => node.type === 'Callout' && node.props?.tone === 'warning')[0] ?? null) : null
}

const textIn = (node: TreeSnapshot, text: string) => nodesIn(node, (inner) => inner.type === 'Text' && wordsOf(inner) === text).length === 1

test("with no global branch settings stored, the Branch section's Global switch is off and says what it does, and typing stores the project's own", async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  assert.equal(branchGlobalOn(view), false)
  assert.ok(view.find({ type: 'Text', text: GLOBAL_BRANCH_LINE }))
  assert.equal(barGlobalPart(view), null)
  await view.type(branchTemplateField, 'feature/{{task_key}}')
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).branchTemplate, 'feature/{{task_key}}')
  assert.equal(storedGlobalBranch(host), undefined)
  assert.equal(branchGlobalOn(view), false)
})

test('turning Global on with none stored asks first: Cancel changes nothing, and Make global makes the section the global branch settings, used by a project with none of its own but not by one with its own', async () => {
  let project: typeof web | typeof notes = web
  const jira = { provider: 'jira-twg', providers: { 'jira-twg': { site: '', profile: '' } } }
  const { view, host } = await showWith(
    { 'tasks.load': () => twgReady([web12Tagged()], { project }) },
    { settings: { version: 1, projects: { [web.id]: jira, [api.id]: jira, [notes.id]: { ...jira, branchTemplate: 'own/{{task_key}}' } } } }
  )
  await view.press(gear)
  await typeConvention(view)
  await view.toggle(branchGlobalSwitch)
  const bar = barGlobalPart(view)
  assert.ok(bar)
  assert.ok(textIn(bar, PUBLISH_ASK))
  assert.deepEqual(buttonsIn(bar), ['Cancel', 'Make global'])
  assert.equal(branchGlobalOn(view), true)
  assert.equal(storedGlobalBranch(host), undefined)
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(barGlobalPart(view), null)
  assert.equal(branchGlobalOn(view), false)
  assert.equal(storedGlobalBranch(host), undefined)

  await view.toggle(branchGlobalSwitch)
  await view.press({ type: 'Button', text: 'Make global' })
  assert.deepEqual(storedGlobalBranch(host), { branchTemplate: CONVENTION, branchTypes: [{ issueType: 'Bug', branchType: 'bugfix' }], branchTypeFallback: 'feature' })
  assert.deepEqual(storedBranch(host), { branchTemplate: undefined, branchTypes: undefined, branchTypeFallback: undefined, titleExclusion: undefined })
  assert.equal(storedBranchMark(host), 'global')
  assert.equal(branchGlobalOn(view), true)
  assert.equal(view.valueOf(branchTemplateField), CONVENTION)
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: bugfix/WEB-12__add-dark-mode--AB', 'Worktree: web-12-add-dark-mode'])

  project = api
  await view.press(done)
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  await view.press(gear)
  assert.equal(branchGlobalOn(view), true)
  assert.equal(view.valueOf(branchTemplateField), CONVENTION)
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: bugfix/WEB-12__add-dark-mode--AB', 'Worktree: web-12-add-dark-mode'])

  project = notes
  await view.press(done)
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  await view.press(gear)
  assert.equal(branchGlobalOn(view), false)
  assert.equal(view.valueOf(branchTemplateField), 'own/{{task_key}}')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('Make global waits for a Branch section git can hold, and the bar says so', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([]) }, twgStored({ site: '', profile: '' }))
  await view.press(gear)
  await view.type(branchTemplateField, 'a b')
  await view.toggle(branchGlobalSwitch)
  assert.equal(view.find({ type: 'Button', text: 'Make global' })?.props.disabled, true)
  assert.ok(textIn(barGlobalPart(view)!, 'Fix the branch settings to make them global.'))
  assert.equal(textIn(barGlobalPart(view)!, PUBLISH_ASK), false)
  await view.type(branchTemplateField, 'a-b', { replace: true })
  assert.notEqual(view.find({ type: 'Button', text: 'Make global' })?.props.disabled, true)
  assert.ok(textIn(barGlobalPart(view)!, PUBLISH_ASK))
  assert.deepEqual(barProblems(view), [])
  await view.press({ type: 'Button', text: 'Make global' })
  assert.deepEqual(storedGlobalBranch(host), { branchTemplate: 'a-b', branchTypes: [], branchTypeFallback: '' })
})

test('while the switch is on, the section shows and edits the global branch settings, under a warning that stays in view', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([web12Tagged()]) }, globalBranchStored())
  await view.press(gear)
  assert.equal(branchGlobalOn(view), true)
  assert.equal(view.valueOf(branchTemplateField), TEAM_BRANCH.branchTemplate)
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: team/fix/WEB-12', 'Worktree: web-12-add-dark-mode'])
  const bar = barWarning(view)
  assert.ok(bar)
  assertProps(bar, { tone: 'warning', title: 'Editing the global branch settings.' })
  assert.ok(textIn(bar, GLOBAL_BRANCH_WARNING))
  await view.type(fallbackField, 'feature', { replace: true })
  await view.type(issueTypeField(1), 'Story', { replace: true })
  assert.deepEqual(previewShown(view), ['Preview for WEB-12', 'Branch: team/feature/WEB-12', 'Worktree: web-12-add-dark-mode'])
  await wait(SAVE_DELAY_MS + 200)
  assert.deepEqual(storedGlobalBranch(host), { ...TEAM_BRANCH, branchTypes: [{ issueType: 'Story', branchType: 'fix' }], branchTypeFallback: 'feature' })
  assert.deepEqual(storedBranch(host), { branchTemplate: undefined, branchTypes: undefined, branchTypeFallback: undefined, titleExclusion: undefined })
})

test("turning Global on in a project with its own asks before dropping them: Keep own changes nothing, Use global drops them", async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([web12Tagged()]) }, globalBranchStored({ branchTemplate: 'mine/{{task_key}}' }))
  await view.press(gear)
  assert.equal(branchGlobalOn(view), false)
  assert.equal(barGlobalPart(view), null)
  await view.toggle(branchGlobalSwitch)
  const bar = barGlobalPart(view)
  assert.ok(bar)
  assert.ok(textIn(bar, ADOPT_ASK))
  assert.deepEqual(buttonsIn(bar), ['Keep own', 'Use global'])
  assert.equal(branchGlobalOn(view), true)
  await view.press({ type: 'Button', text: 'Keep own' })
  assert.equal(branchGlobalOn(view), false)
  assert.equal(storedBranch(host).branchTemplate, 'mine/{{task_key}}')

  await view.toggle(branchGlobalSwitch)
  await view.press({ type: 'Button', text: 'Use global' })
  assert.deepEqual(storedBranch(host), { branchTemplate: undefined, branchTypes: undefined, branchTypeFallback: undefined, titleExclusion: undefined })
  assert.equal(storedBranchMark(host), 'global')
  assert.deepEqual(storedGlobalBranch(host), TEAM_BRANCH)
  assert.equal(branchGlobalOn(view), true)
  assert.equal(view.valueOf(branchTemplateField), TEAM_BRANCH.branchTemplate)
  assert.ok(barWarning(view))
})

test('turning Global on in a project whose own equal the global ones switches without asking', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([]) }, globalBranchStored({ ...TEAM_BRANCH }))
  await view.press(gear)
  assert.equal(branchGlobalOn(view), false)
  await view.toggle(branchGlobalSwitch)
  assert.equal(branchGlobalOn(view), true)
  assert.equal(storedBranchMark(host), 'global')
  assert.ok(barWarning(view))
})

test('turning Global off gives the project a copy at once and says so: the preview stays, and later edits change only the project', async () => {
  const { view, host } = await showWith({ 'tasks.load': twgReady([web12Tagged()]) }, globalBranchStored())
  await view.press(gear)
  const before = previewShown(view)
  await view.toggle(branchGlobalSwitch)
  assert.equal(branchGlobalOn(view), false)
  assert.equal(barGlobalPart(view), null)
  assert.ok(view.find({ type: 'Text', text: COPIED_NOTE }))
  assert.deepEqual(storedBranch(host), { ...TEAM_BRANCH, titleExclusion: undefined })
  assert.equal(storedBranchMark(host), 'own')
  assert.deepEqual(previewShown(view), before)
  await view.type(branchTemplateField, 'x/{{task_key}}', { replace: true })
  await wait(SAVE_DELAY_MS + 200)
  assert.equal(storedBranch(host).branchTemplate, 'x/{{task_key}}')
  assert.deepEqual(storedGlobalBranch(host), TEAM_BRANCH)
})

/** A host with `data` stored, whose settings writes fail while `failing` says so. */
function branchHost(data: JsonValue, failing: () => boolean) {
  let stored = data
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests: { 'tasks.load': twgReady([web12Tagged()]) },
    results: {
      'storage.get': () => ({ value: stored }),
      'storage.set': (params: { key: string; value: JsonValue }) => {
        if (failing()) throw hostError('quota_exceeded', 'Storage is full')
        stored = params.value
        return { ok: true }
      }
    }
  })
  return { host, stored: () => stored }
}

test('a failed switch write shows why and changes nothing, and the next try writes it', async () => {
  let failing = true
  const { host, stored } = branchHost(globalBranchStored().settings, () => failing)
  const view = await mount(panel, { host })
  await view.press(gear)
  await view.toggle(branchGlobalSwitch)
  assert.ok(view.find({ type: 'Callout', text: "Couldn't give this project its own branch settings (quota_exceeded). Try again." }))
  assert.equal(branchGlobalOn(view), true)
  assert.deepEqual(stored(), globalBranchStored().settings)
  failing = false
  await view.toggle(branchGlobalSwitch)
  assert.equal(branchGlobalOn(view), false)
  assert.equal(view.find({ type: 'Callout', text: /^Couldn't/ }), null)

  failing = true
  await view.press({ type: 'IconButton', label: 'Remove branch type 1' })
  await view.toggle(branchGlobalSwitch)
  await view.press({ type: 'Button', text: 'Use global' })
  assert.ok(view.find({ type: 'Callout', text: "Couldn't use the global branch settings (quota_exceeded). Try again." }))
  assert.equal(branchGlobalOn(view), false)
  assert.equal(view.find(issueTypeField(1)), null)
})

test('a failed Make global leaves the project its own and no global ones', async () => {
  const { host, stored } = branchHost(twgStored({ site: '', profile: '' }, { branchTemplate: 'mine' }).settings, () => true)
  const view = await mount(panel, { host })
  await view.press(gear)
  await view.toggle(branchGlobalSwitch)
  await view.press({ type: 'Button', text: 'Make global' })
  assert.ok(view.find({ type: 'Callout', text: "Couldn't make these branch settings global (quota_exceeded). Try again." }))
  assert.equal(branchGlobalOn(view), false)
  assert.deepEqual(stored(), twgStored({ site: '', profile: '' }, { branchTemplate: 'mine' }).settings)
})

test('a filter that needs the Jira project key shows the message in the list, under the filter row, without opening Project settings', async () => {
  const message = 'This filter uses {{jira_project}}. Set the Jira project key in Project settings.'
  // The first load lists "Tasks", which needs the key; the next one "Mine", chosen after it.
  let loads = 0
  const { view } = await showFilters(filtersStored([tasksFilter, mineFilter]), {
    'tasks.load': () => (++loads === 1 ? { kind: 'error', project: web, message, needsJiraProjectKey: true } : twgReady([twgTask('WEB-3')], { filterId: 'f-mine' }))
  })
  assert.equal(view.find(settingsTitle), null)
  assert.equal(view.find(filterTitle('Edit filter')), null)
  assert.ok(view.find({ type: 'Callout', text: /Set the Jira project key in Project settings/ }))
  assert.ok(view.find(filterSelect))
  await view.select(filterSelect, 'f-mine')
  assert.ok(view.find({ type: 'Link', text: 'WEB-3' }))
})

test("Board order starts from the project's Jira project key and writes project = {{jira_project}} while the answer is that key", async () => {
  const { view } = await showFilters(twgStored({ site: '', profile: '' }, { filters: { jira: [tasksFilter] }, jiraProjectKey: 'WEB' }))
  const firstWords = () => queryFields(view).map(([, query]) => String(query).split(' AND ')[0])
  await view.press(newFilter)
  await view.select(startFrom, 'board-order')
  assert.equal(view.valueOf(projectKeyField), 'WEB')
  await view.type(projectKeyField, 'web', { replace: true })
  await view.press(continueButton)
  assert.deepEqual(firstWords(), ['project = {{jira_project}}', 'project = {{jira_project}}', 'project = {{jira_project}}'])

  await view.press({ type: 'Button', text: 'Cancel' })
  await view.press(newFilter)
  await view.select(startFrom, 'board-order')
  await view.type(projectKeyField, 'API', { replace: true })
  await view.press(continueButton)
  assert.deepEqual(firstWords(), ['project = API', 'project = API', 'project = API'])
})

test('switching between the two Jira providers keeps every filter, and the one shown', async () => {
  const { view, host } = await showFilters(
    jiraStored('', { filters: { jira: [tasksFilter, boardFilter] }, shownFilterId: { jira: 'f-board' } }) as ReturnType<typeof filtersStored>,
    { 'jira.sites': SITES }
  )
  for (const provider of ['jira-twg', 'jira-orca']) {
    await view.press(gear)
    await view.select({ type: 'Select', label: 'Tracker' }, provider)
    await view.press(done)
    assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board'])
    assert.equal(view.valueOf(filterSelect), 'f-board')
    assert.ok(view.find({ type: 'Link', text: 'WEB-2' }))
  }
  assert.deepEqual((storedProject(host) as StoredFilters).filters, { jira: [tasksFilter, boardFilter] })
})

test('a Jira project shows the filter row above the search field: the filter shown last, then ✎ and +', async () => {
  const { view } = await showFilters(filtersStored([tasksFilter, boardFilter, mineFilter], 'f-board'))
  assert.equal(view.valueOf(filterSelect), 'f-board')
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board', 'Mine'])
  assert.equal(view.find(filterSelect)?.props.labelHidden, true)
  assertProps(view.find(editFilter)!, { icon: 'edit', tooltip: 'Edit filter', size: 'sm', variant: 'ghost' })
  assertProps(view.find(newFilter)!, { icon: 'add', tooltip: 'New filter', size: 'sm', variant: 'ghost' })
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-2'])
  // The row, the select, then ✎ and +, comes before the field.
  const [row] = nodesIn(view.tree(), (node) => node.type === 'Box' && nodesIn(node, (inner) => inner.type === 'Select' && inner.props?.label === 'Filter').length > 0 && node.props?.direction === 'row')
  assertProps(row, { direction: 'row', align: 'center' })
  const order = nodesIn(view.tree(), (node) => (node.type === 'Select' && node.props?.label === 'Filter') || (node.type === 'Input' && node.props?.label === 'Search tasks') || node.type === 'IconButton')
    .map((node) => node.props?.label)
    .filter((label) => label !== 'Reload tasks' && label !== 'Prompt templates' && label !== 'Project settings' && !/^(Start |Run .* here$)/.test(String(label)))
  assert.deepEqual(order, ['Filter', 'Edit filter', 'New filter', 'Search tasks'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
})

test('a Jira project without stored filters shows the filter "Tasks", and a GitHub project the filter "Open"', async () => {
  const { view } = await showFilters(twgStored({ site: '', profile: '' }))
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks'])
  assert.equal(view.valueOf(filterSelect), 'tasks')
  await view.unmount()

  const github = await show(ready([task('#42')]))
  assert.deepEqual(optionLabels(github, 'Filter'), ['Open'])
  assert.equal(github.valueOf(filterSelect), 'open')
  assert.ok(github.find(editFilter))
  assert.ok(github.find(newFilter))
  assert.ok(github.find({ type: 'Link', text: '#42' }))
})

const openFilter = { id: 'open', name: 'Open', queries: ['is:open'] }
const triageFilter = { id: 'f-triage', name: 'Triage', queries: ['is:open label:needs-triage'] }

/** The key each GitHub filter lists in `showGithubFilters`, by filter id. */
const GITHUB_FILTER_KEYS: Record<string, string> = { open: '#1', 'f-triage': '#2' }

type StoredGithubFilters = { filters?: { github?: StoredFilter[]; jira?: StoredFilter[] }; shownFilterId?: { github?: string; jira?: string } }

/** Stored settings of the web project on GitHub with these filters, these Jira ones, and those
 *  shown last. */
const githubFiltersStored = (project: StoredGithubFilters) => ({ settings: { version: 1, projects: { 'github:acme/web': { providers: {}, ...project } } } })

/** The panel on the web project on GitHub with `storage`, whose `tasks.load` lists, as the worker
 *  does, the GitHub filter the request names, else the one stored as shown, else the first: one
 *  task each, `GITHUB_FILTER_KEYS`, or #9 for a filter not in it. */
async function showGithubFilters(storage: ReturnType<typeof githubFiltersStored>) {
  const inputs: LoadInput[] = []
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith(
    {
      'tasks.load': (input: LoadInput) => {
        inputs.push(input)
        const project = (host ? storedProject(host) : storage.settings.projects['github:acme/web']) as StoredGithubFilters
        const filters = project.filters?.github ?? [openFilter]
        const filter = filters.find((f) => f.id === input.filterId) ?? filters.find((f) => f.id === project.shownFilterId?.github) ?? filters[0]
        return ready([task(GITHUB_FILTER_KEYS[filter.id] ?? '#9')], { filterId: filter.id, queryCount: filter.queries.length })
      }
    },
    storage
  ))
  return { view, host, inputs }
}

test("choosing another GitHub filter stores it as GitHub's shown one, keeping Jira's, and lists its tasks", async () => {
  const { view, host, inputs } = await showGithubFilters(
    githubFiltersStored({ filters: { github: [openFilter, triageFilter], jira: [tasksFilter] }, shownFilterId: { jira: 'tasks' } })
  )
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open', 'Triage'])
  assert.ok(view.find({ type: 'Link', text: '#1' }))
  await view.select(filterSelect, 'f-triage')
  // As on Jira, the choice is stored before the load, which lists the filter shown.
  assert.equal(inputs.length, 2)
  assert.ok(view.find({ type: 'Link', text: '#2' }))
  assert.deepEqual((storedProject(host) as StoredGithubFilters).shownFilterId, { jira: 'tasks', github: 'f-triage' })
})

test('the GitHub filter editor names each query "Query", "Query 2"…, with Add query, and says that each is a GitHub search of open issues', async () => {
  const { view } = await showGithubFilters(githubFiltersStored({ filters: { github: [{ ...triageFilter, queries: ['label:bug', 'assignee:@me'] }] } }))
  await view.press(editFilter)
  assert.deepEqual(queryFields(view, 'Query'), [
    ['Query', 'label:bug', 3],
    ['Query 2', 'assignee:@me', 3]
  ])
  assert.ok(view.find(removeQuery('Query 2')))
  assert.ok(view.find({ type: 'Button', text: 'Add query' }))
  assert.equal(view.find(addJql), null)
  assert.ok(view.find({ type: 'Text', text: /GitHub issue search.*open issues only/ }))
  await view.press({ type: 'Button', text: 'Add query' })
  assert.equal(queryFields(view, 'Query').length, 3)
})

test('+ on GitHub offers the recipes Open and Assigned to me, which write the new filter\'s name and query, and Save stores it with GitHub\'s filters', async () => {
  const { view, host } = await showGithubFilters(githubFiltersStored({ filters: { jira: [tasksFilter] } }))
  await view.press(newFilter)
  assert.equal(view.find(queryField('Query'))?.props.placeholder, 'is:open')
  await view.press(recipe('Open'))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Open 2')
  assert.deepEqual(queryFields(view, 'Query'), [['Query', 'is:open', 3]])
  await view.press(recipe('Assigned to me'))
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Assigned to me')
  assert.deepEqual(queryFields(view, 'Query'), [['Query', 'is:open assignee:@me', 3]])
  await view.press(saveButton)
  const stored = storedProject(host) as StoredGithubFilters
  const added = stored.filters?.github?.[1]
  assert.ok(added)
  assert.deepEqual(stored.filters, { jira: [tasksFilter], github: [openFilter, added] })
  assert.deepEqual({ ...added, id: '' }, { id: '', name: 'Assigned to me', queries: ['is:open assignee:@me'] })
  assert.deepEqual(stored.shownFilterId, { github: added.id })
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open', 'Assigned to me'])
})

test("an existing GitHub filter offers no recipes, and Jira's editor none either: its recipes come before it, with +", async () => {
  const github = await showGithubFilters(githubFiltersStored({}))
  await github.view.press(editFilter)
  assert.equal(github.view.find(recipe('Open')), null)
  assert.equal(github.view.find({ type: 'Field', label: 'Start from a recipe' }), null)
  await github.view.press({ type: 'Button', text: 'Cancel' })
  await github.view.press(newFilter)
  assert.equal(github.view.find(startFrom), null)
  assert.ok(github.view.find({ type: 'Field', label: 'Start from a recipe' }))
  await github.view.unmount()
  const { view } = await showFilters(filtersStored([tasksFilter]))
  await newJiraFilter(view)
  assert.ok(view.find({ type: 'Input', label: 'Name' }))
  assert.equal(view.find({ type: 'Field', label: 'Start from a recipe' }), null)
})

test('changing the tracker from GitHub to Jira shows the filters of Jira, and back those of GitHub', async () => {
  const { view } = await showWith(
    { 'tasks.load': (input: LoadInput) => ready([task('#1')], { filterId: input.filterId ?? 'open' }), 'jira.sites': SITES },
    githubFiltersStored({ filters: { github: [openFilter, triageFilter], jira: [tasksFilter, boardFilter] }, shownFilterId: { github: 'f-triage', jira: 'f-board' } })
  )
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open', 'Triage'])
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Tracker' }, 'jira-orca')
  await view.press(done)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Tasks', 'Board'])
  assert.equal(view.valueOf(filterSelect), 'f-board')
  await view.press(gear)
  await view.select({ type: 'Select', label: 'Tracker' }, 'github')
  await view.press(done)
  assert.deepEqual(optionLabels(view, 'Filter'), ['Open', 'Triage'])
  assert.equal(view.valueOf(filterSelect), 'f-triage')
})

test('a truncated GitHub list from several queries says the first 100 issues of each are shown', async () => {
  const github = await show(ready([task('#1')], { truncated: true, queryCount: 2 }))
  assert.ok(github.find({ type: 'Text', text: 'Showing the first 100 issues of each query.' }))
})

test("choosing another filter stores it as shown before it loads that filter's tasks from the tracker, keeping the field's words", async () => {
  const { view, host, inputs } = await showFilters(filtersStored([tasksFilter, boardFilter, mineFilter]))
  const shownWhenAsked: unknown[] = []
  await view.type(searchField, 'web')
  await view.select(filterSelect, 'f-mine')
  shownWhenAsked.push((storedProject(host) as StoredFilters).shownFilterId)
  assert.deepEqual(inputs, [{}, {}])
  assert.deepEqual(shownWhenAsked, [{ jira: 'f-mine' }])
  assert.equal(view.valueOf(filterSelect), 'f-mine')
  assert.equal(view.valueOf(searchField), 'web')
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-3']), ['WEB-3'])

  // The filter shown already loads nothing.
  await view.select(filterSelect, 'f-mine')
  assert.equal(inputs.length, 2)
})

test('a panel opened again shows the filter shown there last', async () => {
  const { view, host } = await showFilters(filtersStored([tasksFilter, boardFilter]))
  await view.select(filterSelect, 'f-board')
  await view.unmount()
  const again = await mount(panel, { host })
  assert.equal(again.valueOf(filterSelect), 'f-board')
  assert.ok(again.find({ type: 'Link', text: 'WEB-2' }))
})

test('choosing another filter leaves the tracker search shown, and drops the answer of one under way', async () => {
  const search = held()
  let searches = 0
  // Every tracker search answers WEB-90, the second one once the test releases it.
  const { view: shown } = await showWith(
    {
      'tasks.load': async (input: LoadInput) => {
        if (input.query === undefined) return twgReady([twgTask('WEB-1')])
        if (++searches === 2) await search.released
        return twgReady([twgTask('WEB-90')])
      }
    },
    filtersStored([tasksFilter, boardFilter])
  )
  await shown.type(searchField, 'dark')
  await shown.submit(searchField)
  assert.ok(shown.find({ type: 'Text', text: /^Results in Jira/ }))
  await shown.select(filterSelect, 'f-board')
  assert.equal(shown.find({ type: 'Text', text: /^Results in/ }), null)
  assert.equal(shown.valueOf(searchField), 'dark')

  const searchAgain = shown.submit(searchField)
  await drawn(shown, { label: 'Searching Jira' })
  const choosing = shown.select(filterSelect, 'tasks')
  search.release()
  await Promise.all([searchAgain, choosing])
  await shown.settled()
  assert.equal(shown.find({ type: 'Text', text: /^Results in/ }), null)
  assert.equal(shown.find({ type: 'Link', text: 'WEB-90' }), null)
  assert.equal(shown.valueOf(searchField), 'dark')
})

test('"Load more" names the filter listed with its cursor', async () => {
  const inputs: LoadInput[] = []
  const { view } = await showWith(
    {
      'tasks.load': (input: LoadInput) => {
        inputs.push(input)
        return input.cursor ? twgReady([twgTask('WEB-3')], { filterId: 'f-board' }) : twgReady([twgTask('WEB-2')], { filterId: 'f-board', nextCursor: '1:c2' })
      }
    },
    filtersStored([tasksFilter, boardFilter], 'f-board')
  )
  await view.press({ type: 'Button', text: /· Load more$/ })
  assert.deepEqual(inputs, [{}, { filterId: 'f-board', cursor: '1:c2' }])
  assert.deepEqual(keysShown(view, ['WEB-2', 'WEB-3']), ['WEB-2', 'WEB-3'])
})

test('"Load more" answered for another filter loads the list again', async () => {
  let loads = 0
  const { view } = await showWith(
    {
      'tasks.load': (input: LoadInput) => {
        loads++
        if (input.cursor) return twgReady([twgTask('WEB-3')], { filterId: 'tasks' })
        return twgReady([twgTask(loads === 1 ? 'WEB-2' : 'WEB-1')], { filterId: loads === 1 ? 'f-board' : 'tasks', nextCursor: loads === 1 ? '1:c2' : null })
      }
    },
    filtersStored([tasksFilter, boardFilter], 'f-board')
  )
  await view.press({ type: 'Button', text: /· Load more$/ })
  await view.settled()
  assert.equal(loads, 3)
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1'])
})

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
    twgStored({ site: '', profile: '' })
  )
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1', 'WEB-2'])
  await view.press({ type: 'Button', text: /· Load more$/ })
  assert.deepEqual(cursors, [undefined, 'cursor-2'])
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1', 'WEB-2', 'WEB-3'])
  assert.equal(view.find({ type: 'Button', text: /· Load more$/ }), null)

  await view.press({ testId: 'start:WEB-3' })
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-2', 'WEB-3']), ['WEB-1', 'WEB-2', 'WEB-3'])
  assert.ok(view.find({ type: 'Link', text: 'web-3-task-web-3' }))
  assert.equal(cursors.length, 2)
  assert.deepEqual(view.errors, [])
})

test('"Load more" is a full-width outline button with the count of loaded tasks, which says "Loading…" while a page loads', async () => {
  const page = held()
  const { view } = await showWith(
    {
      'tasks.load': async ({ cursor }) => {
        if (!cursor) return twgReady([twgTask('WEB-1'), twgTask('WEB-2')], { nextCursor: 'cursor-2' })
        await page.released
        return twgReady([twgTask('WEB-3')], { nextCursor: 'cursor-3' })
      }
    },
    twgStored({ site: '', profile: '' })
  )
  const button = view.find({ type: 'Button', text: 'Showing 2 · Load more' })
  assert.ok(button)
  assert.equal(button.props.variant, 'outline')
  assert.equal(button.props.size, 'sm')
  assert.equal(button.disabled, false)
  const [holder] = nodesIn(view.tree(), (node) => node.type === 'Stack' && nodesIn(node, (inner) => inner.key === 'load-more').length > 0).reverse()
  assert.equal(holder.props?.align, 'stretch')

  const pressed = view.press(button)
  await drawn(view, { type: 'Button', text: 'Showing 2 · Loading…' })
  const loading = view.find({ type: 'Button', text: 'Showing 2 · Loading…' })
  page.release()
  await pressed
  assert.equal(loading?.disabled, true)
  assert.ok(view.find({ type: 'Button', text: 'Showing 3 · Load more' }))
  assert.deepEqual(view.warnings, [])
})

test('a "Load more" failure keeps the loaded tasks and says why', async () => {
  const { view } = await showWith(
    {
      'tasks.load': ({ cursor }) =>
        cursor ? { kind: 'error', project: web, message: 'twg failed: The cursor has expired.' } : twgReady([twgTask('WEB-1')], { nextCursor: 'cursor-2' })
    },
    twgStored({ site: '', profile: '' })
  )
  await view.press({ type: 'Button', text: /· Load more$/ })
  assert.ok(view.find({ type: 'Link', text: 'WEB-1' }))
  assert.ok(view.find({ type: 'Text', text: /The cursor has expired/ }))
  assert.ok(view.find({ type: 'Button', text: /· Load more$/ }))
})

test('100 tracker search results say to refine the search, not the list notice', async () => {
  for (const provider of ['github', 'jira-orca'] as const) {
    const { view } = await showSearching(ready([task('#1')], { provider, truncated: true }), () => ready([task('#90')], { provider, truncated: true }))
    await view.type(searchField, 'dark')
    await view.submit(searchField)
    assert.equal(view.find({ type: 'Text', text: 'Showing the first 100 results — refine your search' })?.props.muted, true)
    assert.equal(view.find({ type: 'Text', text: /repository's issues|narrow your JQL/ }), null)
    await view.press(clearSearch)
    assert.equal(view.find({ type: 'Text', text: /refine your search/ }), null)
    await view.unmount()
  }
})

test('"Load more" during a tracker search sends its words with the cursor and appends to its results', async () => {
  const inputs: LoadInput[] = []
  const { view } = await showWith(
    {
      'tasks.load': ({ cursor, query }) => {
        inputs.push({ cursor, query })
        if (query === undefined) return twgReady([twgTask('WEB-1')], { nextCursor: 'list-2' })
        return cursor ? twgReady([twgTask('WEB-91'), twgTask('WEB-92')]) : twgReady([twgTask('WEB-90'), twgTask('WEB-91')], { nextCursor: 'found-2' })
      }
    },
    twgStored({ site: '', profile: '' })
  )
  await view.type(searchField, 'dark')
  await view.submit(searchField)
  assert.ok(view.find({ type: 'Button', text: 'Showing 2 · Load more' }))
  await view.press({ type: 'Button', text: /· Load more$/ })
  assert.deepEqual(inputs.slice(1), [
    { cursor: undefined, query: 'dark' },
    { cursor: 'found-2', query: 'dark' }
  ])
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-90', 'WEB-91', 'WEB-92']), ['WEB-90', 'WEB-91', 'WEB-92'])
  assert.equal(view.find({ type: 'Button', text: /· Load more$/ }), null)

  await view.press(clearSearch)
  assert.ok(view.find({ type: 'Button', text: 'Showing 1 · Load more' }))
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-90']), ['WEB-1'])
})

test('Reload during a tracker search runs it again, and a Start keeps its results in place', async () => {
  let searches = 0
  const inputs: LoadInput[] = []
  const { view } = await showWith({
    'tasks.load': ({ query }) => {
      inputs.push({ query })
      return query === undefined ? ready([task('#1')]) : ready([task('#90'), task(`#${90 + ++searches}`)])
    },
    'task.start': { ok: true, underWay: false },
    'worktrees.load': { kind: 'ready', worktrees: { '#90': { worktreeId: 'r1::/src/web-90', name: 'issue-90-task-90', agent: 'claude' } } }
  })
  await view.type(searchField, 'dark')
  await view.submit(searchField)
  await view.press({ type: 'IconButton', label: 'Reload tasks' })
  assert.deepEqual(inputs, [{ query: undefined }, { query: 'dark' }, { query: 'dark' }])
  assert.deepEqual(keysShown(view, ['#1', '#90', '#91', '#92']), ['#90', '#92'])
  assert.ok(view.find({ type: 'Text', text: 'Results in GitHub for "dark"' }))

  await view.press({ testId: 'start:#90' })
  assert.deepEqual(keysShown(view, ['#1', '#90', '#92']), ['#90', '#92'])
  assert.ok(view.find({ type: 'Link', text: 'issue-90-task-90' }))
  assert.equal(inputs.length, 3)
  assert.deepEqual(view.errors, [])
})

test('a change of active project clears the tracker search and the field', async () => {
  let project = web
  const inputs: LoadInput[] = []
  const view = await show(({ query }: LoadInput) => {
    inputs.push({ query })
    return query === undefined ? ready([task(project === web ? '#1' : '#9')], { project }) : ready([task('#90')], { project })
  })
  await view.type(searchField, 'dark')
  await view.submit(searchField)
  project = api
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'api', terminals: [] } })
  await view.settled()
  assert.equal(view.find({ type: 'Text', text: /^Results in/ }), null)
  assert.equal(view.valueOf(searchField), '')
  assert.deepEqual(keysShown(view, ['#1', '#9', '#90']), ['#9'])
  assert.deepEqual(inputs, [{ query: undefined }, { query: 'dark' }, { query: 'dark' }, { query: undefined }])
})

test('a change of the tracker in Project settings clears the tracker search', async () => {
  const inputs: LoadInput[] = []
  const { view } = await showWith(
    {
      'tasks.load': ({ query }) => {
        inputs.push({ query })
        return query === undefined ? twgReady([twgTask('WEB-1')]) : twgReady([twgTask('WEB-90')])
      }
    },
    twgStored({ site: '', profile: '' })
  )
  await view.type(searchField, 'web')
  await view.submit(searchField)
  await view.press(gear)
  await view.type({ type: 'Input', label: 'Profile' }, 'work')
  await view.press(done)
  assert.equal(view.find({ type: 'Text', text: /^Results in/ }), null)
  assert.equal(view.valueOf(searchField), 'web')
  assert.deepEqual(keysShown(view, ['WEB-1', 'WEB-90']), ['WEB-1'])

  await view.submit(searchField)
  await view.press(gear)
  await view.submit({ type: 'Input', label: 'Profile' })
  await view.press(done)
  assert.equal(view.find({ type: 'Text', text: /^Results in/ }), null)
  // Done reloads the list after the first change; after Enter it is loaded already.
  assert.deepEqual(inputs, [{ query: undefined }, { query: 'web' }, { query: undefined }, { query: 'web' }, { query: undefined }])
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
    twgStored({ site: '', profile: '' })
  ))
  await view.press({ type: 'Button', text: /· Load more$/ })
  await view.settled()
  assert.ok(view.find({ type: 'Link', text: 'WEB-20' }))
  assert.equal(view.find({ type: 'Link', text: 'WEB-99' }), null)
})
