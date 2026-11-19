import { assert, test } from 'orca/testing'
import type { RunCli } from '../cli'
import { jiraOrca, JIRA_CONNECTION_ARGS, parseJiraSites } from './jira-orca'

const notes = { id: 'repo:r1', name: 'notes', repo: null }
const config = { siteId: '' }

/** The request for the first page of the filter "Board" with these JQL queries. */
const board = (...queries: string[]) => ({ filter: { id: 'f-board', name: 'Board', queries } })
const onWeb = board('project = WEB')

const wrap = (result: unknown) => JSON.stringify({ id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt-1' } })

function answering(stdout: string): { run: RunCli; calls: { tool: string; args: string[] }[] } {
  const calls: { tool: string; args: string[] }[] = []
  const run: RunCli = async (tool, args) => {
    calls.push({ tool, args })
    return stdout
  }
  return { run, calls }
}

/** A run that answers each `orca jira search` with the output given for its JQL. */
function answeringByJql(outputs: Record<string, string>): { run: RunCli; jqls: string[] } {
  const jqls: string[] = []
  const run: RunCli = async (_tool, args) => {
    const jql = args[2]
    jqls.push(jql)
    const stdout = outputs[jql]
    if (stdout === undefined) throw new Error(`unexpected JQL: ${jql}`)
    return stdout
  }
  return { run, jqls }
}

const invalidJql = (message: string) => JSON.stringify({ ok: false, error: { code: 'runtime_error', message } })

const issue = (key: string, fields: Record<string, unknown> = {}) => ({
  id: '10012',
  key,
  siteId: 'site-1',
  title: `Task ${key}`,
  description: '',
  url: `https://example.atlassian.net/browse/${key}`,
  status: { id: '10000', name: 'To Do', categoryKey: 'new', categoryName: 'To Do', colorName: 'blue-gray' },
  labels: [],
  project: { key: 'WEB', name: 'Web' },
  issueType: { name: 'Task' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...fields
})

test("orca jira search output becomes tasks, with the status category rather than the translated name", async () => {
  const { run, calls } = answering(
    wrap([
      issue('WEB-12', {
        title: 'Añadir modo oscuro a ajustes',
        description: 'La página de ajustes necesita un tema oscuro.',
        status: { id: '3', name: 'En curso', categoryKey: 'indeterminate', categoryName: 'En curso', colorName: 'yellow' },
        labels: ['ui'],
        assignee: { accountId: 'acc-1', displayName: 'Ana Example' }
      }),
      issue('WEB-13', { status: { id: '1', name: 'Listo', categoryKey: 'done', categoryName: 'Listo', colorName: 'green' } }),
      issue('WEB-14'),
      issue('WEB-15', { status: { id: '9', name: 'Raro', categoryKey: 'undefined' } })
    ])
  )
  const page = await jiraOrca.list(run, notes, config, onWeb)
  assert.deepEqual(calls, [{ tool: 'orca', args: ['jira', 'search', 'project = WEB', '--limit', '100', '--json'] }])
  assert.deepEqual(page.tasks[0], {
    tracker: 'jira',
    key: 'WEB-12',
    title: 'Añadir modo oscuro a ajustes',
    url: 'https://example.atlassian.net/browse/WEB-12',
    description: 'La página de ajustes necesita un tema oscuro.',
    status: 'En curso',
    statusCategory: 'in_progress',
    assignees: ['Ana Example'],
    labels: ['ui']
  })
  assert.deepEqual(page.tasks.map((task) => task.statusCategory), ['in_progress', 'done', 'todo', null])
  assert.equal(page.nextCursor, null)
  assert.equal(page.truncated, false)
})

test('a task without an assignee has no assignees', async () => {
  const page = await jiraOrca.list(answering(wrap([issue('WEB-14')])).run, notes, config, onWeb)
  assert.deepEqual(page.tasks[0].assignees, [])
})

test('an item without key or URL is dropped', async () => {
  const items = [issue('WEB-1', { key: undefined }), issue('WEB-2', { url: '' }), issue('WEB-3', { description: null })]
  const page = await jiraOrca.list(answering(wrap(items)).run, notes, config, onWeb)
  assert.deepEqual(page.tasks.map((task) => [task.key, task.description]), [['WEB-3', '']])
})

test('100 results mean the list is truncated, even when some are dropped', async () => {
  const items = Array.from({ length: 100 }, (_, index) => issue(`WEB-${index + 1}`, index === 0 ? { key: '' } : {}))
  const page = await jiraOrca.list(answering(wrap(items)).run, notes, config, onWeb)
  assert.equal(page.tasks.length, 99)
  assert.equal(page.truncated, true)
})

test('the arguments carry --site only when a site is set', async () => {
  const { run, calls } = answering(wrap([]))
  await jiraOrca.list(run, notes, { siteId: 'site-2' }, onWeb)
  await jiraOrca.list(run, notes, { siteId: '' }, onWeb)
  assert.deepEqual(calls[0].args, ['jira', 'search', 'project = WEB', '--limit', '100', '--json', '--site', 'site-2'])
  assert.equal(calls[1].args.includes('--site'), false)
})

test('a tracker search runs the JQL narrowed to the words, with the same limit and site', async () => {
  const { run, calls } = answering(wrap([]))
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
  await jiraOrca.list(run, notes, { siteId: 'site-2' }, { ...board(jql), query: 'dark web-12' })
  assert.deepEqual(calls[0].args, [
    'jira',
    'search',
    '(assignee = currentUser() AND statusCategory != Done) AND (text ~ "dark* web-12*" OR key = "WEB-12") ORDER BY updated DESC',
    '--limit',
    '100',
    '--json',
    '--site',
    'site-2'
  ])
})

test('100 tracker search results mean they are truncated', async () => {
  const items = Array.from({ length: 100 }, (_, index) => issue(`WEB-${index + 1}`))
  const page = await jiraOrca.list(answering(wrap(items)).run, notes, config, { ...onWeb, query: 'dark' })
  assert.equal(page.truncated, true)
  assert.equal(page.nextCursor, null)
})

test("a blank JQL doesn't run a tracker search either", async () => {
  const { run, calls } = answering(wrap([]))
  await assert.rejects(jiraOrca.list(run, notes, config, { ...board('  '), query: 'dark' }), /Enter a JQL query/)
  assert.equal(calls.length, 0)
})

test("a filter whose queries are all blank doesn't run the CLI and asks for one, naming the filter", async () => {
  const { run, calls } = answering(wrap([]))
  await assert.rejects(jiraOrca.list(run, notes, config, board('  ', '\n', '')), /^Error: Board: Enter a JQL query/)
  await assert.rejects(jiraOrca.list(run, notes, config), /Enter a JQL query/)
  assert.equal(calls.length, 0)
})

test("several queries list the first one's tasks, then those of the next that it didn't list, each in Jira's order", async () => {
  const { run, jqls } = answeringByJql({
    'project = WEB': wrap([issue('WEB-3'), issue('WEB-1'), issue('WEB-2')]),
    'labels = ui': wrap([issue('API-9'), issue('WEB-1'), issue('API-4'), issue('WEB-3')])
  })
  const page = await jiraOrca.list(run, notes, config, board('project = WEB', 'labels = ui'))
  assert.deepEqual(jqls, ['project = WEB', 'labels = ui'])
  assert.deepEqual(page.tasks.map((task) => task.key), ['WEB-3', 'WEB-1', 'WEB-2', 'API-9', 'API-4'])
  assert.equal(page.nextCursor, null)
  assert.equal(page.truncated, false)
})

test('blank queries are skipped, and line breaks in a query reach Orca as spaces', async () => {
  const { run, jqls } = answeringByJql({ 'project = WEB AND labels = ui ORDER BY rank': wrap([issue('WEB-1')]), 'project = API': wrap([]) })
  const page = await jiraOrca.list(run, notes, config, board('', 'project = WEB\nAND labels = ui\r\nORDER BY rank', '  ', 'project = API'))
  assert.deepEqual(jqls, ['project = WEB AND labels = ui ORDER BY rank', 'project = API'])
  assert.deepEqual(page.tasks.map((task) => task.key), ['WEB-1'])
})

test('a tracker search narrows each query and keeps their order', async () => {
  const { run, jqls } = answeringByJql({
    '(project = WEB) AND (text ~ "dark*") ORDER BY rank': wrap([issue('WEB-2')]),
    '(labels = ui) AND (text ~ "dark*")': wrap([issue('API-1'), issue('WEB-2')])
  })
  const page = await jiraOrca.list(run, notes, config, { ...board('project = WEB ORDER BY rank', 'labels = ui'), query: 'dark' })
  assert.deepEqual(jqls, ['(project = WEB) AND (text ~ "dark*") ORDER BY rank', '(labels = ui) AND (text ~ "dark*")'])
  assert.deepEqual(page.tasks.map((task) => task.key), ['WEB-2', 'API-1'])
})

test('the list is truncated when any query answers 100 tasks', async () => {
  const hundred = wrap(Array.from({ length: 100 }, (_, index) => issue(`API-${index + 1}`)))
  const both = board('project = WEB', 'project = API')
  const second = await jiraOrca.list(answeringByJql({ 'project = WEB': wrap([issue('WEB-1')]), 'project = API': hundred }).run, notes, config, both)
  assert.equal(second.truncated, true)
  assert.equal(second.tasks.length, 101)
  const neither = await jiraOrca.list(
    answeringByJql({ 'project = WEB': wrap([issue('WEB-1')]), 'project = API': wrap([issue('API-1')]) }).run,
    notes,
    config,
    both
  )
  assert.equal(neither.truncated, false)
})

test('a failing query fails the list, naming its filter and its position in the filter, blank rows included', async () => {
  const outputs = { 'project = WEB': wrap([issue('WEB-1')]), 'project = (': invalidJql('Error 400: La consulta JQL no es válida.') }
  await assert.rejects(
    jiraOrca.list(answeringByJql(outputs).run, notes, config, board('project = WEB', '', 'project = (')),
    (error: unknown) => error instanceof Error && error.message === 'Board: JQL query 3 failed: orca failed: Error 400: La consulta JQL no es válida.'
  )
})

test('with several failing queries, the first of them is reported', async () => {
  const outputs = { 'project = WEB': wrap([]), 'bad = 1': invalidJql('Error 400: one'), 'bad = 2': invalidJql('Error 400: two') }
  await assert.rejects(
    jiraOrca.list(answeringByJql(outputs).run, notes, config, board('project = WEB', 'bad = 1', 'bad = 2')),
    (error: unknown) => error instanceof Error && error.message === 'Board: JQL query 2 failed: orca failed: Error 400: one'
  )
})

test('a filter with one query left once blank ones are skipped names that query too', async () => {
  await assert.rejects(
    jiraOrca.list(answeringByJql({ 'project = (': invalidJql('Error 400: bad') }).run, notes, config, board('', 'project = (')),
    (error: unknown) => error instanceof Error && error.message === 'Board: JQL query 2 failed: orca failed: Error 400: bad'
  )
})

test("an error answer gives Orca's message, and output that isn't a list is unreadable", async () => {
  const invalid = JSON.stringify({ ok: false, error: { code: 'runtime_error', message: 'Error 400: La consulta JQL no es válida.' } })
  await assert.rejects(jiraOrca.list(answering(invalid).run, notes, config, onWeb), /orca failed: Error 400: La consulta JQL no es válida\./)
  await assert.rejects(jiraOrca.list(answering(wrap({ issues: [] })).run, notes, config, onWeb), /orca returned output Kickoff couldn't read/)
})

test('the site list has ids and display names, never email', () => {
  const stdout = wrap({
    connected: true,
    sites: [
      { id: 'site-1', siteUrl: 'https://example.atlassian.net', displayName: 'Example', authType: 'cloud', email: 'ana@example.com', apiBaseUrl: 'https://api.example.com' },
      { id: 'site-2', siteUrl: 'https://jira.example.com', authType: 'server', email: 'ana@example.com' },
      { siteUrl: 'https://no-id.example.com', displayName: 'No id' }
    ],
    activeSiteId: 'site-1',
    selectedSiteId: 'site-1',
    viewer: { email: 'ana@example.com', displayName: 'Ana Example' }
  })
  assert.deepEqual(JIRA_CONNECTION_ARGS, ['jira', 'connection', '--json'])
  assert.deepEqual(parseJiraSites(stdout), [
    { id: 'site-1', name: 'Example' },
    { id: 'site-2', name: 'https://jira.example.com' }
  ])
  assert.ok(!JSON.stringify(parseJiraSites(stdout)).includes('@'))
})

test('without a Jira connection the site list is empty', () => {
  assert.deepEqual(parseJiraSites(wrap({ connected: false, sites: [] })), [])
})
