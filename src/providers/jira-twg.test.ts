import { assert, test } from 'orca/testing'
import type { RunCli } from '../cli'
import { jiraTwg } from './jira-twg'

const notes = { id: 'repo:r1', name: 'notes', repo: null }
const config = { jql: 'project = WEB', site: '', profile: '' }

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

/** A `twg jira workitem query --output json` answer, trimmed from a real one. */
const response = (issues: unknown[], pageInfo?: unknown) =>
  JSON.stringify({
    apiVersion: 'v2',
    command: 'jira.workitem.query',
    request: { jql: 'project = WEB', site: 'example.atlassian.net', maxResults: 50, fields: ['summary', 'status', 'assignee', 'labels', 'description'] },
    data: { issues },
    ...(pageInfo === undefined ? {} : { pageInfo }),
    meta: { resourceClass: 'entity', resourceType: 'jira.workitem' }
  })

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
  timeZone: 'Europe/Madrid',
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
      { type: 'paragraph', content: [{ type: 'text', text: 'La página de ajustes necesita un tema oscuro.' }] },
      {
        type: 'orderedList',
        attrs: { order: 1 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Colores' }] }] }]
      }
    ]
  }
  const { run, calls } = answering(
    response([
      issue('WEB-12', {
        expand: 'renderedFields',
        self: 'https://example.atlassian.net/rest/api/3/issue/10012',
        summary: 'Añadir modo oscuro a ajustes',
        assignee: ana,
        status: status('En curso', 'indeterminate'),
        labels: ['ui'],
        description
      }),
      issue('WEB-13', { status: status('Listo', 'done') }),
      issue('WEB-14', { description: null }),
      issue('WEB-15', { status: status('Raro', 'other') })
    ])
  )
  const page = await jiraTwg.list(run, notes, config)
  assert.equal(calls[0].tool, 'twg')
  assert.deepEqual(page.tasks[0], {
    tracker: 'jira',
    key: 'WEB-12',
    title: 'Añadir modo oscuro a ajustes',
    url: 'https://example.atlassian.net/browse/WEB-12',
    description: 'La página de ajustes necesita un tema oscuro.\n1. Colores',
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
  assert.deepEqual(page.tasks.map((task) => task.key), ['WEB-3'])
})

test('the arguments include --output json, and --site, --profile and --after only when set', async () => {
  const { run, calls } = answering(response([]))
  await jiraTwg.list(run, notes, config)
  await jiraTwg.list(run, notes, { jql: 'project = WEB', site: 'example', profile: 'work' }, 'cursor-2')
  await jiraTwg.list(run, notes, config, '')
  assert.deepEqual(calls[0], { tool: 'twg', args: BASE_ARGS })
  assert.deepEqual(calls[1].args, [...BASE_ARGS, '--site', 'example', '--profile', 'work', '--after', 'cursor-2'])
  assert.deepEqual(calls[2].args, BASE_ARGS)
})

test('the next cursor comes from pageInfo only when there is a next page', async () => {
  const more = await jiraTwg.list(answering(response([issue('WEB-1')], { hasNextPage: true, nextCursor: 'cursor-2' })).run, notes, config)
  assert.equal(more.nextCursor, 'cursor-2')
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
  await assert.rejects(jiraTwg.list(run, notes, { jql: ' ', site: '', profile: '' }), /Enter a JQL query/)
  assert.equal(calls.length, 0)
})
