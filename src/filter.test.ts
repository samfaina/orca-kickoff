import { assert, test } from 'orca/testing'
import { filterNameProblem, newFilterName, withFilterDeleted, withFilterSaved } from './filter'
import { listedFilter, projectFilters } from './protocol'

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
const tasks = { id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }
const board = { id: 'f-board', name: 'Board', queries: ['project = WEB ORDER BY rank', ''] }
const mine = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }

test('a Jira project without filters has one, "Tasks", with the default JQL', () => {
  const initial = { id: 'tasks', name: 'Tasks', queries: [DEFAULT_JQL] }
  assert.deepEqual(projectFilters({}), [initial])
  assert.deepEqual(projectFilters({ filters: {} }), [initial])
  assert.deepEqual(projectFilters({ filters: { jira: [] } }), [initial])
  assert.deepEqual(projectFilters({ filters: { jira: [board, mine] } }), [board, mine])
})

test('the filter listed is the one asked for, else the one shown last, else the first', () => {
  const settings = { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-mine' } }
  assert.deepEqual(listedFilter(settings, 'f-board'), board)
  assert.deepEqual(listedFilter(settings), mine)
  assert.deepEqual(listedFilter(settings, 'f-gone'), mine)
  assert.deepEqual(listedFilter({ filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-gone' } }), tasks)
  assert.deepEqual(listedFilter({ filters: { jira: [tasks, board] } }), tasks)
})

test('a new filter is named "Filter 2", "Filter 3"…, the first name no filter has, ignoring case', () => {
  assert.equal(newFilterName([tasks]), 'Filter 2')
  assert.equal(newFilterName([tasks, { ...board, name: 'filter 2' }]), 'Filter 3')
  assert.equal(newFilterName([tasks, { ...board, name: 'Filter 3' }]), 'Filter 2')
  assert.equal(newFilterName([{ ...tasks, name: 'Filter 2' }, { ...board, name: ' FILTER 3 ' }, { ...mine, name: 'Filter 5' }]), 'Filter 4')
})

test("a filter's name is trimmed, not empty, and unique in the project ignoring case", () => {
  const filters = [tasks, board]
  assert.equal(filterNameProblem(filters, '  ', 'f-new'), 'Give the filter a name.')
  assert.equal(filterNameProblem(filters, ' board ', 'f-new'), 'Another filter is already called "Board".')
  assert.equal(filterNameProblem(filters, 'BOARD', 'f-board'), null)
  assert.equal(filterNameProblem(filters, 'Sprint', 'f-new'), null)
})

test('saving a filter trims its name, keeps its place or adds it at the end, keeps blank queries, and shows it', () => {
  const settings = { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'tasks' } }
  assert.deepEqual(withFilterSaved(settings, { id: 'f-board', name: ' Sprint board ', queries: ['', 'sprint in openSprints()'] }), {
    filters: { jira: [tasks, { id: 'f-board', name: 'Sprint board', queries: ['', 'sprint in openSprints()'] }] },
    shownFilterId: { jira: 'f-board' }
  })
  assert.deepEqual(withFilterSaved(settings, { ...mine, name: 'Mine ' }), {
    filters: { jira: [tasks, board, mine] },
    shownFilterId: { jira: 'f-mine' }
  })
})

test('saving a filter of a project that stored none keeps the initial "Tasks" filter before it', () => {
  assert.deepEqual(withFilterSaved({}, mine), {
    filters: { jira: [{ id: 'tasks', name: 'Tasks', queries: [DEFAULT_JQL] }, mine] },
    shownFilterId: { jira: 'f-mine' }
  })
})

test('deleting a filter keeps the one shown, or shows the first remaining when it was the one shown, and the last one stays', () => {
  const settings = { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterDeleted(settings, 'f-mine'), { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-board' } })
  assert.deepEqual(withFilterDeleted(settings, 'f-board'), { filters: { jira: [tasks, mine] }, shownFilterId: { jira: 'tasks' } })
  assert.deepEqual(withFilterDeleted({ filters: { jira: [board, mine] } }, 'f-board'), { filters: { jira: [mine] }, shownFilterId: { jira: 'f-mine' } })
  assert.equal(withFilterDeleted({ filters: { jira: [board] } }, 'f-board'), null)
  assert.equal(withFilterDeleted({}, 'tasks'), null)
})
