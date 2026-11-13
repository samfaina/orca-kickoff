import { assert, test } from 'orca/testing'
import type { RunCli } from '../cli'
import { jiraOrca, JIRA_CONNECTION_ARGS, parseJiraSites } from './jira-orca'

const notes = { id: 'repo:r1', name: 'notes', repo: null }
const config = { jql: 'project = WEB', siteId: '' }

const wrap = (result: unknown) => JSON.stringify({ id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt-1' } })

function answering(stdout: string): { run: RunCli; calls: { tool: string; args: string[] }[] } {
  const calls: { tool: string; args: string[] }[] = []
  const run: RunCli = async (tool, args) => {
    calls.push({ tool, args })
    return stdout
  }
  return { run, calls }
}

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
  const page = await jiraOrca.list(run, notes, config)
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
  const page = await jiraOrca.list(answering(wrap([issue('WEB-14')])).run, notes, config)
  assert.deepEqual(page.tasks[0].assignees, [])
})

test('an item without key or URL is dropped', async () => {
  const items = [issue('WEB-1', { key: undefined }), issue('WEB-2', { url: '' }), issue('WEB-3', { description: null })]
  const page = await jiraOrca.list(answering(wrap(items)).run, notes, config)
  assert.deepEqual(page.tasks.map((task) => [task.key, task.description]), [['WEB-3', '']])
})

test('100 results mean the list is truncated, even when some are dropped', async () => {
  const items = Array.from({ length: 100 }, (_, index) => issue(`WEB-${index + 1}`, index === 0 ? { key: '' } : {}))
  const page = await jiraOrca.list(answering(wrap(items)).run, notes, config)
  assert.equal(page.tasks.length, 99)
  assert.equal(page.truncated, true)
})

test('the arguments carry --site only when a site is set', async () => {
  const { run, calls } = answering(wrap([]))
  await jiraOrca.list(run, notes, { jql: 'project = WEB', siteId: 'site-2' })
  await jiraOrca.list(run, notes, { jql: 'project = WEB', siteId: '' })
  assert.deepEqual(calls[0].args, ['jira', 'search', 'project = WEB', '--limit', '100', '--json', '--site', 'site-2'])
  assert.equal(calls[1].args.includes('--site'), false)
})

test("a blank JQL doesn't run the CLI and asks for one", async () => {
  const { run, calls } = answering(wrap([]))
  await assert.rejects(jiraOrca.list(run, notes, { jql: '  ', siteId: '' }), /Enter a JQL query/)
  assert.equal(calls.length, 0)
})

test("an error answer gives Orca's message, and output that isn't a list is unreadable", async () => {
  const invalid = JSON.stringify({ ok: false, error: { code: 'runtime_error', message: 'Error 400: La consulta JQL no es válida.' } })
  await assert.rejects(jiraOrca.list(answering(invalid).run, notes, config), /orca failed: Error 400: La consulta JQL no es válida\./)
  await assert.rejects(jiraOrca.list(answering(wrap({ issues: [] })).run, notes, config), /orca returned output Kickoff couldn't read/)
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
