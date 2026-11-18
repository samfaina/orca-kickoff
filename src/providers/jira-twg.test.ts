import { assert, test } from 'orca/testing'
import { CliError, type RunCli } from '../cli'
import { decodeTwgCursor, encodeTwgCursor, jiraTwg, jiraTwgArgs } from './jira-twg'

const notes = { id: 'repo:r1', name: 'notes', repo: null }
const config = { jql: ['project = WEB'], site: '', profile: '' }

function answering(...stdouts: string[]): { run: RunCli; calls: { tool: string; args: string[] }[] } {
  const calls: { tool: string; args: string[] }[] = []
  const run: RunCli = async (tool, args) => {
    calls.push({ tool, args })
    return stdouts[Math.min(calls.length - 1, stdouts.length - 1)]
  }
  return { run, calls }
}

const issue = (key: string, fields: Record<string, unknown> = {}) => ({
  id: '10012',
  key,
  summary: `Task ${key}`,
  assignee: null,
  status: { name: 'To Do', statusCategory: { id: 2, key: 'new', name: 'To Do' } },
  labels: [],
  url: `https://example.atlassian.net/browse/${key}`,
  ...fields
})

/** A `twg jira workitem query --output json` answer: a real one's shape, trimmed, with invented values. */
const response = (issues: unknown[], pageInfo?: unknown) =>
  JSON.stringify({
    apiVersion: 'v2',
    command: 'jira.workitem.query',
    request: { jql: 'project = WEB', site: 'example.atlassian.net', maxResults: 50, fields: ['summary', 'status', 'assignee', 'labels', 'description'] },
    data: { issues },
    ...(pageInfo === undefined ? {} : { pageInfo }),
    meta: { resourceClass: 'entity', resourceType: 'jira.workitem' }
  })

/** The keys of a page's tasks, in order. */
const keys = (page: { tasks: { key: string }[] }) => page.tasks.map((task) => task.key)

const BASE_ARGS = [
  'jira',
  'workitem',
  'query',
  '--jql',
  'project = WEB',
  '--fields',
  'summary,status,assignee,labels,description',
  '--limit',
  '50',
  '--output',
  'json',
  '--api-version',
  'v2'
]

/** A user object as twg returns it (Jira REST v3), with invented values. */
const ana = {
  self: 'https://example.atlassian.net/rest/api/3/user?accountId=acc-1',
  accountId: 'acc-1',
  emailAddress: 'ana@example.com',
  displayName: 'Ana Example',
  active: true,
  timeZone: 'UTC',
  accountType: 'atlassian'
}

const status = (name: string, key: string) => ({
  self: 'https://example.atlassian.net/rest/api/3/status/3',
  description: '',
  name,
  id: '3',
  statusCategory: { self: 'https://example.atlassian.net/rest/api/3/statuscategory/4', id: 4, key, colorName: 'yellow', name }
})

test('a trimmed real response becomes tasks, with the status category rather than the translated name', async () => {
  const description = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'The settings page needs a dark theme.' }] },
      {
        type: 'orderedList',
        attrs: { order: 1 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Colors' }] }] }]
      }
    ]
  }
  const { run, calls } = answering(
    response([
      issue('WEB-12', {
        expand: 'renderedFields',
        self: 'https://example.atlassian.net/rest/api/3/issue/10012',
        summary: 'Add dark mode to settings',
        assignee: ana,
        status: status('En curso', 'indeterminate'),
        labels: ['ui'],
        description
      }),
      issue('WEB-13', { status: status('Listo', 'done') }),
      issue('WEB-14', { description: null }),
      issue('WEB-15', { status: status('Odd', 'other') })
    ])
  )
  const page = await jiraTwg.list(run, notes, config)
  assert.equal(calls[0].tool, 'twg')
  assert.deepEqual(page.tasks[0], {
    tracker: 'jira',
    key: 'WEB-12',
    title: 'Add dark mode to settings',
    url: 'https://example.atlassian.net/browse/WEB-12',
    description: 'The settings page needs a dark theme.\n1. Colors',
    status: 'En curso',
    statusCategory: 'in_progress',
    assignees: ['Ana Example'],
    labels: ['ui']
  })
  assert.deepEqual(page.tasks.map((task) => task.statusCategory), ['in_progress', 'done', 'todo', null])
  assert.equal(page.tasks[2].description, '')
  assert.ok(!JSON.stringify(page).includes('@'))
})

test('assignee: null gives no assignees, and a named assignee gives one', async () => {
  const page = await jiraTwg.list(answering(response([issue('WEB-1'), issue('WEB-2', { assignee: ana })])).run, notes, config)
  assert.deepEqual(page.tasks.map((task) => task.assignees), [[], ['Ana Example']])
})

test('an item without key or URL is dropped', async () => {
  const items = [issue('WEB-1', { key: undefined }), issue('WEB-2', { url: '' }), issue('WEB-3')]
  const page = await jiraTwg.list(answering(response(items)).run, notes, config)
  assert.deepEqual(keys(page), ['WEB-3'])
})

test('the arguments include --output json, and --site, --profile and --after only when set', async () => {
  const { run, calls } = answering(response([]))
  await jiraTwg.list(run, notes, config)
  await jiraTwg.list(run, notes, { jql: ['project = WEB'], site: ' example ', profile: 'work' }, { cursor: '0:cursor-2' })
  await jiraTwg.list(run, notes, { jql: ['project = WEB'], site: '  ', profile: ' ' }, { cursor: '' })
  assert.deepEqual(calls[0], { tool: 'twg', args: BASE_ARGS })
  assert.deepEqual(calls[1].args, [...BASE_ARGS, '--site', 'example', '--profile', 'work', '--after', 'cursor-2'])
  assert.deepEqual(calls[2].args, BASE_ARGS)
  assert.deepEqual(jiraTwgArgs({ jql: [], site: 'example', profile: '' }, 'project = API', 'c-9'), [
    ...BASE_ARGS.map((arg) => (arg === 'project = WEB' ? 'project = API' : arg)),
    '--site',
    'example',
    '--after',
    'c-9'
  ])
})

test('a tracker search runs the JQL narrowed to the words, and its next page sends the words again with the cursor', async () => {
  const { run, calls } = answering(response([issue('WEB-1')], { hasNextPage: true, nextCursor: 'cursor-2' }))
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  const narrowed = '(assignee = currentUser() AND statusCategory != Done) AND (text ~ "dark* web-12*" OR key = "WEB-12") ORDER BY updated DESC'
  const first = await jiraTwg.list(run, notes, { jql: [jql], site: '', profile: '' }, { query: 'dark web-12' })
  assert.equal(first.nextCursor, '0:cursor-2')
  await jiraTwg.list(run, notes, { jql: [jql], site: '', profile: '' }, { query: 'dark web-12', cursor: '0:cursor-2' })
  const withJql = BASE_ARGS.map((arg) => (arg === 'project = WEB' ? narrowed : arg))
  assert.deepEqual(calls[0].args, withJql)
  assert.deepEqual(calls[1].args, [...withJql, '--after', 'cursor-2'])
})

test("a blank JQL doesn't run a tracker search either", async () => {
  const { run, calls } = answering(response([]))
  await assert.rejects(jiraTwg.list(run, notes, { jql: [' '], site: '', profile: '' }, { query: 'dark' }), /Enter a JQL query/)
  assert.equal(calls.length, 0)
})

test("the panel's cursor is the query's index and twg's cursor, and anything else starts from the first query", () => {
  assert.equal(encodeTwgCursor({ index: 0, after: 'cursor-2' }), '0:cursor-2')
  assert.equal(encodeTwgCursor({ index: 2, after: '' }), '2:')
  assert.deepEqual(decodeTwgCursor('1:abc:def==', 3), { index: 1, after: 'abc:def==' })
  assert.deepEqual(decodeTwgCursor('2:', 3), { index: 2, after: '' })
  const first = { index: 0, after: '' }
  for (const foreign of [undefined, '', 'cursor-2', ':abc', 'x:abc', '-1:abc', '1.5:abc', '3:abc', ' 1:abc']) {
    assert.deepEqual(decodeTwgCursor(foreign, 3), first, String(foreign))
  }
})

/** A run that answers each twg query with the output given for its JQL and `--after` cursor, as
 *  `<jql>` or `<jql> after <cursor>`; an Error makes that query fail. */
function answeringByJql(outputs: Record<string, string | Error>): { run: RunCli; queries: string[]; limits: number[] } {
  const queries: string[] = []
  const limits: number[] = []
  const run: RunCli = async (_tool, args) => {
    const jql = args[args.indexOf('--jql') + 1]
    const after = args.includes('--after') ? args[args.indexOf('--after') + 1] : ''
    const query = after === '' ? jql : `${jql} after ${after}`
    queries.push(query)
    limits.push(Number(args[args.indexOf('--limit') + 1]))
    const output = outputs[query]
    if (output === undefined) throw new Error(`unexpected query: ${query}`)
    if (output instanceof Error) throw output
    return output
  }
  return { run, queries, limits }
}

const several = (...jql: string[]) => ({ jql, site: '', profile: '' })

/** `count` invented issues of project `project`, numbered from `from`. */
const issues = (project: string, count: number, from = 1) => Array.from({ length: count }, (_, i) => issue(`${project}-${from + i}`))

test('several short queries fill one page, each asked for only the tasks the page still needs', async () => {
  const { run, queries, limits } = answeringByJql({
    'sprint in openSprints()': response(issues('NOW', 3)),
    'sprint in futureSprints()': response(issues('NEXT', 2), { hasNextPage: false }),
    'sprint is EMPTY': response(issues('LATER', 5))
  })
  const page = await jiraTwg.list(run, notes, several('sprint in openSprints()', 'sprint in futureSprints()', 'sprint is EMPTY'))
  assert.deepEqual(keys(page), ['NOW-1', 'NOW-2', 'NOW-3', 'NEXT-1', 'NEXT-2', 'LATER-1', 'LATER-2', 'LATER-3', 'LATER-4', 'LATER-5'])
  assert.equal(page.nextCursor, null)
  assert.deepEqual(queries, ['sprint in openSprints()', 'sprint in futureSprints()', 'sprint is EMPTY'])
  assert.deepEqual(limits, [50, 47, 45])
})

test('a query with a next page stops the load with its cursor, and the next load goes on from there into the next query', async () => {
  const { run, queries, limits } = answeringByJql({
    'project = WEB': response([issue('WEB-3'), issue('WEB-1')], { hasNextPage: true, nextCursor: 'w2' }),
    'project = WEB after w2': response([issue('WEB-2')], { hasNextPage: false }),
    'labels = ui': response([issue('API-9'), issue('API-4')], { hasNextPage: true, nextCursor: 'u2' }),
    'labels = ui after u2': response([issue('API-5')])
  })
  const config = several('project = WEB', 'labels = ui')
  const pages = []
  let cursor: string | undefined
  do {
    const page = await jiraTwg.list(run, notes, config, { cursor })
    pages.push({ keys: keys(page), nextCursor: page.nextCursor })
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  assert.deepEqual(pages, [
    { keys: ['WEB-3', 'WEB-1'], nextCursor: '0:w2' },
    { keys: ['WEB-2', 'API-9', 'API-4'], nextCursor: '1:u2' },
    { keys: ['API-5'], nextCursor: null }
  ])
  assert.deepEqual(queries, ['project = WEB', 'project = WEB after w2', 'labels = ui', 'labels = ui after u2'])
  assert.deepEqual(limits, [50, 50, 49, 50])
})

test('a page that fills exactly at the end of a query points at the next query, and the next load starts it', async () => {
  const { run, queries, limits } = answeringByJql({
    'project = WEB': response(issues('WEB', 30)),
    'project = API': response(issues('API', 20), { hasNextPage: false }),
    'project = OPS': response(issues('OPS', 4))
  })
  const config = several('project = WEB', 'project = API', 'project = OPS')
  const first = await jiraTwg.list(run, notes, config)
  assert.deepEqual([first.tasks.length, first.nextCursor], [50, '2:'])
  const second = await jiraTwg.list(run, notes, config, { cursor: '2:' })
  assert.deepEqual([keys(second), second.nextCursor], [['OPS-1', 'OPS-2', 'OPS-3', 'OPS-4'], null])
  assert.deepEqual(queries, ['project = WEB', 'project = API', 'project = OPS'])
  assert.deepEqual(limits, [50, 20, 50])
})

test("the last query's end gives no cursor, even on a full page", async () => {
  const { run } = answeringByJql({ 'project = WEB': response(issues('WEB', 30)), 'project = API': response(issues('API', 20)) })
  const page = await jiraTwg.list(run, notes, several('project = WEB', 'project = API'))
  assert.deepEqual([page.tasks.length, page.nextCursor], [50, null])
})

test('a task that several queries list is on the page once, where it first appears', async () => {
  const { run } = answeringByJql({
    'project = WEB': response([issue('WEB-1'), issue('WEB-2')]),
    'labels = ui': response([issue('WEB-2'), issue('UI-1'), issue('WEB-1')])
  })
  const page = await jiraTwg.list(run, notes, several('project = WEB', 'labels = ui'))
  assert.deepEqual(keys(page), ['WEB-1', 'WEB-2', 'UI-1'])
})

test('a query with no tasks adds nothing, and the load goes on with the next one', async () => {
  const { run, queries } = answeringByJql({
    'project = WEB': response([issue('WEB-1')]),
    'project = API': response([]),
    'project = OPS': response([], { hasNextPage: false }),
    'labels = ui': response([issue('UI-1')], { hasNextPage: true, nextCursor: 'u2' })
  })
  const page = await jiraTwg.list(run, notes, several('project = WEB', 'project = API', '', 'project = OPS', 'labels = ui'))
  assert.deepEqual([keys(page), page.nextCursor], [['WEB-1', 'UI-1'], '3:u2'])
  assert.deepEqual(queries, ['project = WEB', 'project = API', 'project = OPS', 'labels = ui'])
})

test('when the last queries have no tasks, the load answers an empty last page', async () => {
  const { run, queries } = answeringByJql({ 'project = API': response([]), 'project = OPS': response([]) })
  const page = await jiraTwg.list(run, notes, several('project = WEB', 'project = API', 'project = OPS'), { cursor: '1:' })
  assert.deepEqual([page.tasks, page.nextCursor], [[], null])
  assert.deepEqual(queries, ['project = API', 'project = OPS'])
})

test('a cursor in a foreign shape starts from the first query', async () => {
  const { run, queries } = answeringByJql({ 'project = WEB': response([issue('WEB-1')], { hasNextPage: true, nextCursor: 'w2' }) })
  const page = await jiraTwg.list(run, notes, several('project = WEB', 'labels = ui'), { cursor: 'cursor-from-before' })
  assert.equal(page.nextCursor, '0:w2')
  assert.deepEqual(queries, ['project = WEB'])
})

test('a tracker search narrows each query, and fills its page across them as the list does', async () => {
  const { run, queries, limits } = answeringByJql({
    '(project = WEB) AND (text ~ "dark*") ORDER BY rank': response([issue('WEB-2')]),
    '(labels = ui) AND (text ~ "dark*")': response([issue('UI-1')], { hasNextPage: true, nextCursor: 'u2' }),
    '(labels = ui) AND (text ~ "dark*") after u2': response([issue('UI-2')])
  })
  const config = several('project = WEB ORDER BY rank', 'labels = ui')
  const first = await jiraTwg.list(run, notes, config, { query: 'dark' })
  assert.deepEqual([keys(first), first.nextCursor], [['WEB-2', 'UI-1'], '1:u2'])
  const second = await jiraTwg.list(run, notes, config, { query: 'dark', cursor: '1:u2' })
  assert.deepEqual([keys(second), second.nextCursor], [['UI-2'], null])
  assert.deepEqual(queries, [
    '(project = WEB) AND (text ~ "dark*") ORDER BY rank',
    '(labels = ui) AND (text ~ "dark*")',
    '(labels = ui) AND (text ~ "dark*") after u2'
  ])
  assert.deepEqual(limits, [50, 49, 50])
})

test('line breaks in a query reach twg as spaces', async () => {
  const { run, queries } = answeringByJql({ 'project = WEB AND labels = ui': response([]) })
  await jiraTwg.list(run, notes, several('project = WEB\r\nAND labels = ui'))
  assert.deepEqual(queries, ['project = WEB AND labels = ui'])
})

test('with several queries, a failing one fails the list with its position in the settings, even after another listed tasks', async () => {
  const failure = new CliError('twg failed: The JQL is not valid.')
  const { run } = answeringByJql({ 'project = WEB': response([issue('WEB-1')]), 'project = (': failure })
  await assert.rejects(
    jiraTwg.list(run, notes, several('', 'project = WEB', 'project = (')),
    (error: unknown) => error instanceof CliError && error.message === 'JQL query 3 failed: twg failed: The JQL is not valid.'
  )
  const alone = answeringByJql({ 'project = (': failure })
  await assert.rejects(jiraTwg.list(alone.run, notes, several('project = (', ' ')), (error: unknown) => error === failure)
})

test('the next cursor comes from pageInfo only when there is a next page', async () => {
  const more = await jiraTwg.list(answering(response([issue('WEB-1')], { hasNextPage: true, nextCursor: 'cursor-2' })).run, notes, config)
  assert.equal(more.nextCursor, '0:cursor-2')
  const last = await jiraTwg.list(answering(response([issue('WEB-1')], { hasNextPage: false, nextCursor: 'cursor-3' })).run, notes, config)
  assert.equal(last.nextCursor, null)
  const missing = await jiraTwg.list(answering(response([issue('WEB-1')])).run, notes, config)
  assert.equal(missing.nextCursor, null)
  assert.equal(missing.truncated, false)
})

test('a response without data.issues is an error, not an empty list', async () => {
  await assert.rejects(jiraTwg.list(answering(JSON.stringify({ apiVersion: 'v2', meta: {} })).run, notes, config), /twg returned output Kickoff couldn't read/)
  await assert.rejects(jiraTwg.list(answering(JSON.stringify({ data: {} })).run, notes, config), /twg returned output Kickoff couldn't read/)
  await assert.rejects(jiraTwg.list(answering('not json').run, notes, config), /twg returned output Kickoff couldn't read/)
})

test("a blank JQL doesn't run twg and asks for one", async () => {
  const { run, calls } = answering(response([]))
  await assert.rejects(jiraTwg.list(run, notes, { jql: [' ', ''], site: '', profile: '' }), /Enter a JQL query/)
  assert.equal(calls.length, 0)
})
