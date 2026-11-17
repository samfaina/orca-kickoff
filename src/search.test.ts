import { assert, test } from 'orca/testing'
import type { Task } from './protocol'
import { matchesSearch } from './search'

const task: Task = {
  tracker: 'jira',
  key: 'WEB-12',
  title: 'Add dark mode to settings',
  url: 'https://example.atlassian.net/browse/WEB-12',
  description: 'Mentions login, which only the description holds.',
  status: 'In Progress',
  statusCategory: 'in_progress',
  assignees: ['Ada Example'],
  labels: ['ui', 'good first issue']
}

test('a task matches a query its key contains', () => {
  assert.equal(matchesSearch(task, 'WEB-1'), true)
  assert.equal(matchesSearch(task, 'WEB-13'), false)
})

test('a task matches a query its title or one of its labels contains, not only its description or status', () => {
  assert.equal(matchesSearch(task, 'dark mode'), true)
  assert.equal(matchesSearch(task, 'first'), true)
  assert.equal(matchesSearch(task, 'login'), false)
  assert.equal(matchesSearch(task, 'Progress'), false)
})

test('the match ignores case', () => {
  assert.equal(matchesSearch(task, 'web-12'), true)
  assert.equal(matchesSearch(task, 'DARK'), true)
  assert.equal(matchesSearch(task, 'UI'), true)
})

test('the query is trimmed, and an empty or blank query matches every task', () => {
  assert.equal(matchesSearch(task, '  dark  '), true)
  assert.equal(matchesSearch(task, ' dark  settings '), false)
  assert.equal(matchesSearch(task, ''), true)
  assert.equal(matchesSearch(task, '   '), true)
  assert.equal(matchesSearch({ ...task, labels: [] }, ''), true)
})
