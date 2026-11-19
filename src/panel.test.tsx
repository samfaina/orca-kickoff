import { afterEach, assert, hostError, mockHost, mount as mountUntracked, test, type MockHost, type MockRequests, type TestPanel, type TestQuery, type TreeSnapshot } from 'orca/testing'
import type { JsonValue } from 'orca'
import type { Task, TaskList, TaskWorktree } from './protocol'
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

test('Start is an outline play icon labelled with the task key, at the end of its row, and disabled without worktrees', async () => {
  const view = await show(ready([task('#42')]))
  const start = view.find({ type: 'IconButton', label: 'Start #42' })
  assert.ok(start)
  assert.equal(view.find({ testId: 'start:#42' })?.label, 'Start #42')
  assert.equal(start.props.icon, 'play')
  assert.equal(start.props.variant, 'outline')
  assert.equal(start.props.tone, undefined)
  assert.equal(start.props.tooltip, 'Start')
  assert.equal(start.disabled, false)
  const [, startRow] = elementsIn(cardOf(view, '#42'))
  assertProps(startRow, { direction: 'row', align: 'center', justify: 'end', gap: 'xs' })
  const [holder, ...others] = elementsIn(startRow)
  assertProps(holder, { shrink: false })
  assert.equal(holder.children?.length, 1)
  assert.deepEqual(others, [])
  assert.equal(view.find({ type: 'Button', text: 'Start' }), null)
  await view.unmount()

  const unread = await show(ready([task('#42')], { worktrees: null, worktreesError: 'orca failed.' }))
  assert.equal(unread.find({ type: 'IconButton', label: 'Start #42' })?.disabled, true)
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
  // Done looks like the template detail's Save.
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

/** The panel with these worker answers and stored values, and its host. */
async function showWith(requests: MockRequests, storage: Record<string, JsonValue> = {}) {
  const host = mockHost({ capabilities: ['storage:own', 'workspace:read'], requests, storage })
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

test('a project with a template stored before several templates shows it as "Default", unchanged', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, stored({ template: 'Fix {{task_key}}' }))
  await view.press(gear)
  assert.deepEqual(optionLabels(view, 'Default template'), ['Default'])
  await view.press({ type: 'IconButton', label: 'Edit template' })
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
  assert.deepEqual(starts, [{ projectId: 'github:acme/web', task: task('#42'), templateId: 'default' }])
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

test('with two templates, the template Select fills the Start row before the Start icon', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  const [, startRow] = elementsIn(cardOf(view, '#42'))
  const [select, start] = elementsIn(startRow)
  assertProps(select, { grow: true, minWidth: 0 })
  assert.deepEqual(nodesIn(select, (node) => node.type === 'Select').map((node) => node.props?.label), ['Template for #42'])
  assertProps(start, { shrink: false })
  assert.equal(nodesIn(start, (node) => node.key === 'start:#42').length, 1)
  assert.deepEqual(view.warnings, [])
})

test('with one template, cards show no template Select', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) })
  assert.equal(view.find(cardTemplate('#42')), null)
  assert.ok(view.find({ testId: 'start:#42' }))
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
  await view.press({ type: 'Button', text: 'Delete template' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  backInSettings()
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement', 'Review'])
})

test('the template detail\'s title says "Edit template" or "New template", after the project\'s name', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find({ type: 'Heading', text: 'Edit template' })?.props.level, 3)
  assert.equal(view.find({ type: 'Heading', text: 'web' }), null)

  await view.press({ type: 'Button', text: 'Cancel' })
  await view.press({ type: 'IconButton', label: 'New template' })
  assert.equal(view.find({ type: 'Text', text: 'web ·' })?.props.muted, true)
  assert.equal(view.find({ type: 'Heading', text: 'New template' })?.props.level, 3)
  assert.equal(view.find({ type: 'Heading', text: 'Edit template' }), null)
})

/** The parts of the template detail: its title row, its form, and its Delete bar when it has one. */
function detailParts(view: TestPanel) {
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

test('Cancel and Save are on the right of the title row, and only the form scrolls', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  const { frame, title, form } = detailParts(view)
  assert.deepEqual(nodesIn(title, (node) => node.type === 'Text' || node.type === 'Heading').map(wordsOf), ['web ·', 'Edit template'])
  assert.deepEqual(buttonsIn(title), ['Cancel', 'Save'])
  assertProps(buttonIn(title, 'Cancel'), { variant: 'ghost', size: 'sm' })
  assertProps(buttonIn(title, 'Save'), { variant: 'solid', size: 'sm' })
  assertProps(form, { direction: 'column', grow: true, minHeight: 0, maxHeight: '100%', scroll: 'y' })
  assert.deepEqual(
    nodesIn(frame, (node) => node.props?.scroll !== undefined),
    [form]
  )
  assert.equal(nodesIn(form, (node) => node.type === 'Input' && node.props?.label === 'Name').length, 1)
  assert.equal(nodesIn(form, (node) => node.type === 'Button').length, 0)
})

/** Finders take a Collapsible's `title` as its label. */
const variables = { type: 'Collapsible', label: 'Variables' }

test('the hint follows the text, and the closed Variables list gives each variable with what it gives', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  const { form } = detailParts(view)
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
      [['Code {{branch}}'], "{{branch}} The new worktree's name, such as web-12-add-dark-mode."]
    ]
  )
  assert.deepEqual(view.warnings, [])
})

test('the Variables list stays as it was left while the panel is open, and starts closed in a panel opened again', async () => {
  const first = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await first.view.press(gear)
  await first.view.press({ type: 'IconButton', label: 'Edit template' })
  await first.view.toggle(variables)
  await first.view.press({ type: 'Button', text: 'Cancel' })
  await first.view.press({ type: 'IconButton', label: 'New template' })
  assert.equal(first.view.find(variables)?.props.open, true)
  assert.ok(first.view.find({ type: 'Code', text: '{{branch}}' }))
  await first.view.unmount()

  const again = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await again.view.press(gear)
  await again.view.press({ type: 'IconButton', label: 'Edit template' })
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
  await view.press({ type: 'IconButton', label: 'Edit template' })
  const skill = detailParts(view).form.children?.at(-1)
  assert.ok(skill && typeof skill !== 'string')
  assert.equal(skill.type, 'Callout')
  assertProps(skill, { icon: 'info', title: 'Run a skill' })
  assert.match(wordsOf(skill), /^To run a Claude Code skill, start the template with its command, for example `\/tdd \{\{task_key\}\}`/)

  await view.press(saveButton)
  const parts = elementsIn(detailParts(view).form)
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
  await view.press({ type: 'IconButton', label: 'Edit template' })
  const { form, deleteBar } = detailParts(view)
  assert.ok(deleteBar)
  assertProps(deleteBar, { direction: 'row', justify: 'end' })
  assert.equal(deleteBar.props?.scroll, undefined)
  assert.deepEqual(buttonsIn(deleteBar), ['Delete template'])
  assert.equal(nodesIn(form, (node) => node.type === 'Button').length, 0)
  assertProps(buttonIn(deleteBar, 'Delete template'), { variant: 'ghost', tone: 'danger', icon: 'delete', size: 'sm' })

  await view.press({ type: 'Button', text: 'Delete template' })
  assert.deepEqual(buttonsIn(detailParts(view).deleteBar!), ['Confirm delete'])
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
})

test('a new template has no Delete bar', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  assert.equal(detailParts(view).deleteBar, undefined)
  assert.equal(view.find({ type: 'Button', text: /Delete/ }), null)
})

test('the template detail opened from Project settings that opened by itself goes back to it', async () => {
  const { view } = await showWith({ 'tasks.load': { kind: 'error', project: web, message: 'gh failed.' } }, twoTemplates)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.ok(view.find(settingsTitle))
})

test('"New template" opens the detail with an empty name and the initial text; Save adds it at the end and goes back to Project settings', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  assert.ok(view.find({ type: 'Heading', text: 'New template' }))
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
})

test('Delete needs a second click, and deleting the default template makes the first remaining one the default', async () => {
  const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Delete template' })
  assert.ok(view.find({ type: 'Button', text: 'Confirm delete' }))
  assert.deepEqual(storedProject(host), twoTemplates.settings.projects['github:acme/web'])
  await view.press({ type: 'Button', text: 'Confirm delete' })
  assert.deepEqual(storedProject(host), { providers: {}, templates: [implement], defaultTemplateId: 't-impl' })
  assert.ok(view.find(settingsTitle))
  assert.deepEqual(optionLabels(view, 'Default template'), ['Implement'])
  assert.equal(view.valueOf({ type: 'Select', label: 'Default template' }), 't-impl')
})

test('Delete turns back after a few seconds without the second click', async () => {
  await withTimeouts(CONFIRM_DELETE_MS, async ({ fire }) => {
    const { view, host } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
    await view.press(gear)
    await view.press({ type: 'IconButton', label: 'Edit template' })
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
  await view.press({ type: 'IconButton', label: 'Edit template' })
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
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await view.press({ type: 'Button', text: 'Delete template' })
  await view.press({ type: 'Button', text: 'Confirm delete' })
  await view.press(done)
  assert.equal(view.valueOf(cardTemplate('#42')), 't-impl')
  await view.press({ testId: 'start:#42' })
  assert.deepEqual(starts.map((start) => start.templateId), ['t-impl'])
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
})

test('a reload of the same project keeps the detail open with its draft', async () => {
  const { view } = await showWith({ 'tasks.load': ready([task('#42')]) }, twoTemplates)
  await view.press(gear)
  await view.press({ type: 'IconButton', label: 'New template' })
  await view.type({ type: 'Input', label: 'Name' }, 'Review')
  await view.emit('workspace.changed', { context: { branch: 'main', displayName: 'web', terminals: [] } })
  assert.equal(view.valueOf({ type: 'Input', label: 'Name' }), 'Review')
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
})

/** A host with the two templates stored and these worker answers. Each settings write calls
 *  `write` first and lands once it ends: a promise it answers holds the write, a throw fails it.
 *  `project()` gives the web project's stored settings. */
function settingsHost(requests: MockRequests, write: () => void | Promise<void>) {
  let data: JsonValue = twoTemplates.settings
  const host = mockHost({
    capabilities: ['storage:own', 'workspace:read'],
    requests,
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

/** The panel on the web project with `storage`, whose `tasks.load` lists, as the worker does, the
 *  filter the request names, else the one stored as shown when it is asked, else the first: one
 *  task each, `FILTER_KEYS`, or WEB-9 for a filter not in it. It answers an error naming the filter
 *  instead for a filter whose queries are all blank. Also its host and the inputs `tasks.load` was
 *  asked with. */
async function showFilters(storage: ReturnType<typeof filtersStored>, requests: MockRequests = {}) {
  const inputs: LoadInput[] = []
  let host: MockHost | null = null
  let view: TestPanel
  ;({ view, host } = await showWith(
    {
      'tasks.load': (input: LoadInput) => {
        inputs.push(input)
        // `host` is set once the panel has mounted, after the first load.
        const project = (host ? storedProject(host) : storage.settings.projects['github:acme/web']) as StoredFilters
        const filters = project.filters?.jira ?? [{ id: 'tasks', name: 'Tasks', queries: ['assignee = currentUser()'] }]
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
  // As the template detail: Cancel and Save in the title row, Delete in a bar of its own.
  const { title, deleteBar } = detailParts(view)
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
  const { title } = detailParts(view)
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
  assert.equal(detailParts(view).deleteBar, undefined)
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

test('Project settings that opened by itself stays open once a load from it, or from its template detail, lists the tasks', async () => {
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
  await second.view.press({ type: 'IconButton', label: 'Edit template' })
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
  const { form } = detailParts(view)
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

test('a failed query while the choice of + on Jira, the filter editor or the template detail is open leaves it open', async () => {
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
  await view.press({ type: 'IconButton', label: 'Edit template' })
  await reload()
  await view.settled()
  assert.ok(view.find({ type: 'Heading', text: 'Edit template' }))
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
    .filter((label) => label !== 'Reload tasks' && label !== 'Project settings' && !String(label).startsWith('Start'))
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
