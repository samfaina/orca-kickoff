import { assert, test } from 'orca/testing'
import { filterQueries, type FilterQuery, type Task } from '../protocol'
import { decodeQueryCursor, encodeQueryCursor, pageAcrossQueries, type QueryPage } from './queries'

/** An invented task with key `key`. */
const task = (key: string): Task => ({
  tracker: 'jira',
  key,
  title: `Task ${key}`,
  url: `https://example.atlassian.net/browse/${key}`,
  description: '',
  status: 'To Do',
  statusCategory: 'todo',
  assignees: [],
  labels: []
})

/** `count` invented tasks of project `project`, numbered from `from`. */
const tasks = (project: string, count: number, from = 1) => Array.from({ length: count }, (_, i) => task(`${project}-${from + i}`))

/** The keys of a page's tasks, in order. */
const keys = (page: { tasks: { key: string }[] }) => page.tasks.map((each) => each.key)

/** A tool that answers each query with the page given for its text and cursor, as `<text>` or
 *  `<text> after <cursor>`; an Error makes that query fail. It records what it was asked. */
function tool(pages: Record<string, QueryPage | Error>) {
  const asked: { query: string; limit: number }[] = []
  const page = async (query: FilterQuery, after: string, limit: number): Promise<QueryPage> => {
    const name = after === '' ? query.text : `${query.text} after ${after}`
    asked.push({ query: name, limit })
    const answer = pages[name]
    if (answer === undefined) throw new Error(`unexpected query: ${name}`)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { page, asked }
}

/** A page of `items` with the tool's `nextCursor`, none by default. */
const answer = (items: Task[], nextCursor: string | null = null): QueryPage => ({ tasks: items, nextCursor })

/** A failure that names the query, so a test can tell which one failed. */
const named = (query: FilterQuery, error: unknown) => new Error(`query ${query.position}: ${String(error)}`)

test('several short queries fill one page, each asked for only the tasks the page still needs', async () => {
  const { page, asked } = tool({ now: answer(tasks('NOW', 2)), next: answer(tasks('NEXT', 1)), later: answer(tasks('LATER', 2)) })
  const result = await pageAcrossQueries(filterQueries(['now', 'next', 'later']), undefined, 5, page, named)
  assert.deepEqual(result, { tasks: [...tasks('NOW', 2), ...tasks('NEXT', 1), ...tasks('LATER', 2)], nextCursor: null, truncated: false })
  assert.deepEqual(asked, [
    { query: 'now', limit: 5 },
    { query: 'next', limit: 3 },
    { query: 'later', limit: 2 }
  ])
})

test("the panel's cursor is the query's index and the tool's cursor, and anything else starts from the first query", () => {
  assert.equal(encodeQueryCursor({ index: 0, after: 'cursor-2' }), '0:cursor-2')
  assert.equal(encodeQueryCursor({ index: 2, after: '' }), '2:')
  assert.deepEqual(decodeQueryCursor('1:abc:def==', 3), { index: 1, after: 'abc:def==' })
  assert.deepEqual(decodeQueryCursor('2:', 3), { index: 2, after: '' })
  const first = { index: 0, after: '' }
  for (const foreign of [undefined, '', 'cursor-2', ':abc', 'x:abc', '-1:abc', '1.5:abc', '3:abc', ' 1:abc']) {
    assert.deepEqual(decodeQueryCursor(foreign, 3), first, String(foreign))
  }
})

test('a query with a next page stops the load with its cursor, and the next load goes on from there into the next query', async () => {
  const { page, asked } = tool({
    web: answer(tasks('WEB', 2), 'w2'),
    'web after w2': answer(tasks('WEB', 1, 3)),
    ui: answer(tasks('UI', 2), 'u2'),
    'ui after u2': answer(tasks('UI', 1, 3))
  })
  const queries = filterQueries(['web', 'ui'])
  const pages = []
  let cursor: string | undefined
  do {
    const result = await pageAcrossQueries(queries, cursor, 5, page, named)
    pages.push({ keys: keys(result), nextCursor: result.nextCursor })
    cursor = result.nextCursor ?? undefined
  } while (cursor !== undefined)
  assert.deepEqual(pages, [
    { keys: ['WEB-1', 'WEB-2'], nextCursor: '0:w2' },
    { keys: ['WEB-3', 'UI-1', 'UI-2'], nextCursor: '1:u2' },
    { keys: ['UI-3'], nextCursor: null }
  ])
  assert.deepEqual(
    asked.map((each) => each.limit),
    [5, 5, 4, 5]
  )
})

test('a page that fills exactly at the end of a query points at the next query, and the next load starts it', async () => {
  const { page, asked } = tool({ web: answer(tasks('WEB', 3)), api: answer(tasks('API', 2)), ops: answer(tasks('OPS', 1)) })
  const queries = filterQueries(['web', 'api', 'ops'])
  const first = await pageAcrossQueries(queries, undefined, 5, page, named)
  assert.deepEqual([first.tasks.length, first.nextCursor], [5, '2:'])
  const second = await pageAcrossQueries(queries, '2:', 5, page, named)
  assert.deepEqual([keys(second), second.nextCursor], [['OPS-1'], null])
  assert.deepEqual(
    asked.map((each) => each.query),
    ['web', 'api', 'ops']
  )
})

test("the last query's end gives no cursor, even on a full page", async () => {
  const { page } = tool({ web: answer(tasks('WEB', 3)), api: answer(tasks('API', 2)) })
  const result = await pageAcrossQueries(filterQueries(['web', 'api']), undefined, 5, page, named)
  assert.deepEqual([result.tasks.length, result.nextCursor], [5, null])
})

test('a task that several queries list is on the page once, where it first appears', async () => {
  const { page } = tool({ web: answer([task('WEB-1'), task('WEB-2')]), ui: answer([task('WEB-2'), task('UI-1'), task('WEB-1')]) })
  const result = await pageAcrossQueries(filterQueries(['web', 'ui']), undefined, 5, page, named)
  assert.deepEqual(keys(result), ['WEB-1', 'WEB-2', 'UI-1'])
})

test('a cursor counts only the queries that run, so a blank query takes no index', async () => {
  const { page, asked } = tool({ ops: answer([task('OPS-1')], 'o2') })
  const result = await pageAcrossQueries(filterQueries(['web', ' ', 'ops']), '1:', 5, page, named)
  assert.deepEqual([keys(result), result.nextCursor], [['OPS-1'], '1:o2'])
  assert.deepEqual(
    asked.map((each) => each.query),
    ['ops']
  )
})

test('a cursor in a foreign shape starts from the first query', async () => {
  const { page, asked } = tool({ web: answer([task('WEB-1')], 'w2') })
  const result = await pageAcrossQueries(filterQueries(['web', 'ui']), 'cursor-from-before', 5, page, named)
  assert.equal(result.nextCursor, '0:w2')
  assert.deepEqual(
    asked.map((each) => each.query),
    ['web']
  )
})

test('a query that fails fails the list with the failure made for it, even after another listed tasks', async () => {
  const { page } = tool({ web: answer([task('WEB-1')]), broken: new Error('rejected') })
  await assert.rejects(pageAcrossQueries(filterQueries(['', 'web', 'broken']), undefined, 5, page, named), /^Error: query 3: Error: rejected$/)
})
