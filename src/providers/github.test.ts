import { assert, test } from 'orca/testing'
import type { RunCli } from '../cli'
import { github } from './github'

const web = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

function answering(stdout: string): { run: RunCli; calls: { tool: string; args: string[] }[] } {
  const calls: { tool: string; args: string[] }[] = []
  const run: RunCli = async (tool, args) => {
    calls.push({ tool, args })
    return stdout
  }
  return { run, calls }
}

const issue = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/acme/web/issues/${number}`,
  body: '',
  labels: [],
  assignees: [],
  ...fields
})

test("gh's open issues become tasks keyed #n, with the body as description", async () => {
  const { run, calls } = answering(
    JSON.stringify([
      issue(42, {
        title: 'Add dark mode',
        body: 'The settings page needs a dark theme.',
        labels: [{ id: 'L1', name: 'ui', description: '', color: 'ededed' }],
        assignees: [{ id: 'U1', login: 'octocat', name: 'Octo Cat', databaseId: 1 }]
      })
    ])
  )
  const page = await github.list(run, web, {})
  assert.deepEqual(calls, [
    {
      tool: 'gh',
      args: ['issue', 'list', '--repo', 'acme/web', '--state', 'open', '--limit', '100', '--json', 'number,title,url,body,labels,assignees']
    }
  ])
  assert.deepEqual(page, {
    tasks: [
      {
        tracker: 'github',
        key: '#42',
        title: 'Add dark mode',
        url: 'https://github.com/acme/web/issues/42',
        description: 'The settings page needs a dark theme.',
        status: 'Open',
        statusCategory: 'todo',
        assignees: ['octocat'],
        labels: ['ui']
      }
    ],
    nextCursor: null,
    truncated: false
  })
})

test('an issue without title or URL is dropped', async () => {
  const { run } = answering(JSON.stringify([issue(1, { title: '' }), issue(2, { url: undefined }), issue(3, { body: null })]))
  const page = await github.list(run, web, {})
  assert.deepEqual(page.tasks.map((task) => [task.key, task.description]), [['#3', '']])
})

test('100 issues mean the list is truncated', async () => {
  const { run } = answering(JSON.stringify(Array.from({ length: 100 }, (_, index) => issue(index + 1))))
  const page = await github.list(run, web, {})
  assert.equal(page.tasks.length, 100)
  assert.equal(page.truncated, true)
})

test('100 issues from gh mean the list is truncated even when some are dropped', async () => {
  const issues = Array.from({ length: 100 }, (_, index) => issue(index + 1, index === 0 ? { title: '' } : {}))
  const page = await github.list(answering(JSON.stringify(issues)).run, web, {})
  assert.equal(page.tasks.length, 99)
  assert.equal(page.truncated, true)
})

test('a GitHub Enterprise repository is passed as host/owner/name', async () => {
  const { run, calls } = answering('[]')
  await github.list(run, { id: 'github:github.acme.example/platform/billing', name: 'billing', repo: 'github.acme.example/platform/billing' }, {})
  assert.equal(calls[0].args[3], 'github.acme.example/platform/billing')
})

test('a project without a GitHub repository fails without running gh, suggesting another tracker', async () => {
  const { run, calls } = answering('[]')
  await assert.rejects(github.list(run, { id: 'repo:r1', name: 'notes', repo: null }, {}), /no GitHub repository.*Jira/)
  assert.equal(calls.length, 0)
})

test("output that isn't a JSON list fails with a readable message", async () => {
  const { run } = answering('{"message":"unexpected"}')
  await assert.rejects(github.list(run, web, {}), /gh returned output Kickoff couldn't read/)
})
