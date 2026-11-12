import { assert, test } from 'orca/testing'
import type { ProjectRef, Task } from './protocol'
import { buildPrompt, DEFAULT_TEMPLATE } from './template'

const web: ProjectRef = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

const task: Task = {
  tracker: 'jira',
  key: 'WEB-12',
  title: 'Add dark mode to settings',
  url: 'https://example.atlassian.net/browse/WEB-12',
  description: 'Users want a dark theme.',
  status: 'To Do',
  statusCategory: 'todo',
  assignees: [],
  labels: []
}

const branch = 'web-12-add-dark-mode-to'

test('every variable is filled, also with spaces inside the braces', () => {
  const template =
    '{{task_key}}|{{ task_title }}|{{task_url}}|{{  task_description}}|{{task_status }}|{{tracker}}|{{repo}}|{{branch}}'
  assert.deepEqual(buildPrompt(template, task, web, branch), {
    ok: true,
    prompt:
      'WEB-12|Add dark mode to settings|https://example.atlassian.net/browse/WEB-12|Users want a dark theme.|To Do|jira|acme/web|web-12-add-dark-mode-to'
  })
})

test('an unknown variable is left as it is', () => {
  assert.deepEqual(buildPrompt('{{task_key}} {{ assignee }}', task, web, branch), { ok: true, prompt: 'WEB-12 {{ assignee }}' })
})

test('a task without a status leaves task_status empty', () => {
  assert.deepEqual(buildPrompt('[{{task_status}}]', { ...task, status: null }, web, branch), { ok: true, prompt: '[]' })
})

test('a project without a repo uses its name for {{repo}}', () => {
  const notes: ProjectRef = { id: 'repo:r2', name: 'notes', repo: null }
  assert.deepEqual(buildPrompt('{{repo}}', task, notes, branch), { ok: true, prompt: 'notes' })
})

test('a long description is cut to 4000 characters with …', () => {
  const result = buildPrompt('{{task_description}}', { ...task, description: 'x'.repeat(5000) }, web, branch)
  assert.ok(result.ok)
  assert.equal(result.prompt.length, 4000)
  assert.equal(result.prompt, `${'x'.repeat(3999)}…`)
})

test('an empty template gives the task URL', () => {
  assert.deepEqual(buildPrompt('', task, web, branch), { ok: true, prompt: 'https://example.atlassian.net/browse/WEB-12' })
  assert.deepEqual(buildPrompt('  \n', task, web, branch), { ok: true, prompt: 'https://example.atlassian.net/browse/WEB-12' })
})

test('an undefined template uses DEFAULT_TEMPLATE', () => {
  assert.equal(DEFAULT_TEMPLATE, 'Complete {{task_key}}: {{task_url}}')
  assert.deepEqual(buildPrompt(undefined, task, web, branch), {
    ok: true,
    prompt: 'Complete WEB-12: https://example.atlassian.net/browse/WEB-12'
  })
})

test('a prompt over 30 000 characters is refused with a clear message', () => {
  const result = buildPrompt('y'.repeat(30_001), task, web, branch)
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /30[ ,]?000/)
  assert.deepEqual(buildPrompt('y'.repeat(30_000), task, web, branch), { ok: true, prompt: 'y'.repeat(30_000) })
})
