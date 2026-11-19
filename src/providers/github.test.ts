import { assert, test } from 'orca/testing'
import { CliError, type RunCli } from '../cli'
import { github } from './github'
import { FilterError } from './queries'

const web = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

function answering(stdout: string | ((args: string[]) => string | Promise<string>)): { run: RunCli; calls: { tool: string; args: string[] }[] } {
  const calls: { tool: string; args: string[] }[] = []
  const run: RunCli = async (tool, args) => {
    calls.push({ tool, args })
    return typeof stdout === 'string' ? stdout : stdout(args)
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

/** A filter with these GitHub searches. */
const filter = (...queries: string[]) => ({ id: 'f-triage', name: 'Triage', queries })
/** The initial filter of a GitHub project. */
const open = { filter: { id: 'open', name: 'Open', queries: ['is:open'] } }

const LIST_ARGS = ['issue', 'list', '--repo', 'acme/web', '--state', 'open', '--limit', '100', '--json', 'number,title,url,body,labels,assignees']

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
  const page = await github.list(run, web, {}, open)
  assert.deepEqual(calls, [{ tool: 'gh', args: [...LIST_ARGS, '--search', '(is:open) is:open'] }])
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

test("a filter's GitHub search narrows the open issues: in parentheses, then is:open, so a query can't list closed ones", async () => {
  const { run, calls } = answering('[]')
  await github.list(run, web, {}, { filter: filter('label:bug OR label:ui') })
  await github.list(run, web, {}, { filter: filter(' is:closed\nassignee:@me ') })
  assert.deepEqual(calls.map((call) => call.args), [
    [...LIST_ARGS, '--search', '(label:bug OR label:ui) is:open'],
    [...LIST_ARGS, '--search', '(is:closed assignee:@me) is:open']
  ])
})

test("several GitHub searches list the first one's issues, then those of the next that it didn't list, each in gh's order", async () => {
  const { run, calls } = answering((args) => {
    const search = args[args.length - 1]
    return JSON.stringify(search.startsWith('(label:bug)') ? [issue(3), issue(1)] : [issue(2), issue(3), issue(4)])
  })
  const page = await github.list(run, web, {}, { filter: filter('label:bug', '  ', 'assignee:@me') })
  assert.deepEqual(calls.map((call) => call.args.slice(-1)), [['(label:bug) is:open'], ['(assignee:@me) is:open']])
  assert.deepEqual(page.tasks.map((task) => task.key), ['#3', '#1', '#2', '#4'])
  assert.equal(page.truncated, false)
})

test('any GitHub search answering 100 issues truncates the list', async () => {
  const { run } = answering((args) =>
    JSON.stringify(args[args.length - 1].startsWith('(label:bug)') ? [issue(1)] : Array.from({ length: 100 }, (_, index) => issue(index + 10)))
  )
  const page = await github.list(run, web, {}, { filter: filter('label:bug', 'assignee:@me') })
  assert.equal(page.tasks.length, 101)
  assert.equal(page.truncated, true)
})

test('a filter with no GitHub search, or only blank ones, asks for one by its name without running gh, and so does a list without a filter', async () => {
  const { run, calls } = answering('[]')
  await assert.rejects(
    github.list(run, web, {}, { filter: filter('', ' \n ') }),
    (error: unknown) =>
      error instanceof FilterError && error.filterId === 'f-triage' && error.message === 'Triage: Enter a GitHub search to list issues, for example: is:open'
  )
  await assert.rejects(github.list(run, web, {}, { filter: filter(), query: 'dark' }), (error: unknown) => error instanceof FilterError)
  await assert.rejects(github.list(run, web, {}), (error: unknown) => !(error instanceof FilterError) && /^Enter a GitHub search/.test(String((error as Error).message)))
  assert.equal(calls.length, 0)
})

const PR_REFUSED = 'gh failed: cannot use pull request search qualifiers with `gh issue list`; use `gh pr list` instead'

/** gh answering each search: its refusal for one with `is:pr`, `[]` for those of `label:bug`, and
 *  `other` as a failure for the rest. */
const refusing = (other: string): RunCli => async (_tool, args) => {
  const search = args[args.length - 1]
  if (search.includes('is:pr')) throw new CliError(PR_REFUSED)
  if (search.startsWith('(label:bug)')) return '[]'
  throw new CliError(other)
}

test("a query gh refuses fails the list naming its filter and position, the first in the filter's order, and the answer names the filter", async () => {
  await assert.rejects(
    github.list(refusing('gh failed: other'), web, {}, { filter: filter('label:bug', '', 'is:pr', 'assignee:@me') }),
    (error: unknown) => error instanceof FilterError && error.filterId === 'f-triage' && error.message === `Triage: Query 3 failed: ${PR_REFUSED}`
  )
})

test("a tracker search in a filter whose query gh refuses names the filter too, since its words can't cause the refusal", async () => {
  await assert.rejects(
    github.list(refusing('gh failed: other'), web, {}, { filter: filter('is:pr'), query: 'dark' }),
    (error: unknown) => error instanceof FilterError && error.message === `Triage: Query 1 failed: ${PR_REFUSED}`
  )
})

test("any other gh failure keeps gh's message and names no filter", async () => {
  const noLogin = 'gh failed: To get started with GitHub CLI, please run:  gh auth login'
  await assert.rejects(
    github.list(refusing(noLogin), web, {}, { filter: filter('label:bug', 'assignee:@me') }),
    (error: unknown) => error instanceof CliError && !(error instanceof FilterError) && error.message === noLogin
  )
})

test("a tracker search adds each word quoted, without its quotes, and #42 as a bare number, after each of the filter's searches", async () => {
  const { run, calls } = answering('[]')
  await github.list(run, web, {}, { filter: filter('label:bug', 'assignee:@me'), query: ' fix  "login" #42 ' })
  assert.deepEqual(calls.map((call) => call.args), [
    [...LIST_ARGS, '--search', '(label:bug) is:open "fix" "login" "42"'],
    [...LIST_ARGS, '--search', '(assignee:@me) is:open "fix" "login" "42"']
  ])
})

test('a qualifier typed in a tracker search is searched as text, its colons as spaces, so gh neither refuses it nor lists closed issues', async () => {
  const { run, calls } = answering('[]')
  await github.list(run, web, {}, { ...open, query: 'is:closed IS:PR type:pull-request : a::b' })
  assert.deepEqual(calls[0].args.slice(-2), ['--search', '(is:open) is:open "is closed" "IS PR" "type pull-request" "a b"'])
})

test("a blank tracker search, or one of quotes only, lists the filter's whole list", async () => {
  const { run, calls } = answering('[]')
  await github.list(run, web, {}, { ...open, query: '   ' })
  await github.list(run, web, {}, { ...open, query: ' "" ' })
  const whole = [...LIST_ARGS, '--search', '(is:open) is:open']
  assert.deepEqual(calls.map((call) => call.args), [whole, whole])
})

test('100 tracker search results mean they are truncated', async () => {
  const { run } = answering(JSON.stringify(Array.from({ length: 100 }, (_, index) => issue(index + 1))))
  const page = await github.list(run, web, {}, { ...open, query: 'dark' })
  assert.equal(page.truncated, true)
  assert.equal(page.nextCursor, null)
})

test('an issue without title or URL is dropped', async () => {
  const { run } = answering(JSON.stringify([issue(1, { title: '' }), issue(2, { url: undefined }), issue(3, { body: null })]))
  const page = await github.list(run, web, {}, open)
  assert.deepEqual(page.tasks.map((task) => [task.key, task.description]), [['#3', '']])
})

test('100 issues mean the list is truncated', async () => {
  const { run } = answering(JSON.stringify(Array.from({ length: 100 }, (_, index) => issue(index + 1))))
  const page = await github.list(run, web, {}, open)
  assert.equal(page.tasks.length, 100)
  assert.equal(page.truncated, true)
})

test('100 issues from gh mean the list is truncated even when some are dropped', async () => {
  const issues = Array.from({ length: 100 }, (_, index) => issue(index + 1, index === 0 ? { title: '' } : {}))
  const page = await github.list(answering(JSON.stringify(issues)).run, web, {}, open)
  assert.equal(page.tasks.length, 99)
  assert.equal(page.truncated, true)
})

test('a GitHub Enterprise repository is passed as host/owner/name', async () => {
  const { run, calls } = answering('[]')
  await github.list(run, { id: 'github:github.acme.example/platform/billing', name: 'billing', repo: 'github.acme.example/platform/billing' }, {}, open)
  assert.equal(calls[0].args[3], 'github.acme.example/platform/billing')
})

test('a project without a GitHub repository fails without running gh, suggesting another tracker', async () => {
  const { run, calls } = answering('[]')
  await assert.rejects(github.list(run, { id: 'repo:r1', name: 'notes', repo: null }, {}, open), /no GitHub repository.*Jira/)
  assert.equal(calls.length, 0)
})

test("output that isn't a JSON list fails with a readable message", async () => {
  const { run } = answering('{"message":"unexpected"}')
  await assert.rejects(github.list(run, web, {}, open), /gh returned output Kickoff couldn't read/)
})
