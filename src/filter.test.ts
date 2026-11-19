import { assert, test } from 'orca/testing'
import { filterNameProblem, filterRecipes, newFilterName, recipeFilterName, withFilterDeleted, withFilterSaved } from './filter'
import { listedFilter, projectFilters } from './protocol'

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
const tasks = { id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }
const board = { id: 'f-board', name: 'Board', queries: ['project = WEB ORDER BY rank', ''] }
const mine = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }

test('a Jira project without filters has one, "Tasks", with the default JQL', () => {
  const initial = { id: 'tasks', name: 'Tasks', queries: [DEFAULT_JQL] }
  assert.deepEqual(projectFilters({}, 'jira'), [initial])
  assert.deepEqual(projectFilters({ filters: {} }, 'jira'), [initial])
  assert.deepEqual(projectFilters({ filters: { jira: [] } }, 'jira'), [initial])
  assert.deepEqual(projectFilters({ filters: { jira: [board, mine] } }, 'jira'), [board, mine])
})

const open = { id: 'open', name: 'Open', queries: ['is:open'] }
const triaging = { id: 'f-triage', name: 'Triage', queries: ['is:open label:needs-triage'] }

test('a GitHub project without filters has one, "Open", with is:open, and keeps its filters apart from Jira\'s', () => {
  assert.deepEqual(projectFilters({}, 'github'), [open])
  assert.deepEqual(projectFilters({ filters: { jira: [board] } }, 'github'), [open])
  assert.deepEqual(projectFilters({ filters: { github: [] } }, 'github'), [open])
  assert.deepEqual(projectFilters({ filters: { github: [triaging], jira: [board] } }, 'github'), [triaging])
  assert.deepEqual(projectFilters({ filters: { github: [triaging] } }, 'jira'), [{ id: 'tasks', name: 'Tasks', queries: [DEFAULT_JQL] }])
})

test('the filter listed is the one asked for, else the one shown last, else the first', () => {
  const settings = { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-mine' } }
  assert.deepEqual(listedFilter(settings, 'jira', 'f-board'), board)
  assert.deepEqual(listedFilter(settings, 'jira'), mine)
  assert.deepEqual(listedFilter(settings, 'jira', 'f-gone'), mine)
  assert.deepEqual(listedFilter({ filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-gone' } }, 'jira'), tasks)
  assert.deepEqual(listedFilter({ filters: { jira: [tasks, board] } }, 'jira'), tasks)
})

test("on GitHub, the filter listed is the one asked for, else GitHub's one shown last, else the first", () => {
  const settings = { filters: { github: [open, triaging], jira: [tasks, board] }, shownFilterId: { github: 'f-triage', jira: 'f-board' } }
  assert.deepEqual(listedFilter(settings, 'github', 'open'), open)
  assert.deepEqual(listedFilter(settings, 'github'), triaging)
  assert.deepEqual(listedFilter(settings, 'github', 'f-board'), triaging)
  assert.deepEqual(listedFilter({ ...settings, shownFilterId: { jira: 'f-triage' } }, 'github'), open)
})

test('a new filter is named "Filter 2", "Filter 3"…, the first name no filter has, ignoring case', () => {
  assert.equal(newFilterName([tasks]), 'Filter 2')
  assert.equal(newFilterName([tasks, { ...board, name: 'filter 2' }]), 'Filter 3')
  assert.equal(newFilterName([tasks, { ...board, name: 'Filter 3' }]), 'Filter 2')
  assert.equal(newFilterName([{ ...tasks, name: 'Filter 2' }, { ...board, name: ' FILTER 3 ' }, { ...mine, name: 'Filter 5' }]), 'Filter 4')
})

test('GitHub offers the recipes Open and Assigned to me, and Jira none yet', () => {
  assert.deepEqual(filterRecipes('github'), [
    { name: 'Open', queries: ['is:open'] },
    { name: 'Assigned to me', queries: ['is:open assignee:@me'] }
  ])
  assert.deepEqual(filterRecipes('jira'), [])
})

test("a recipe's filter is named after it, or after it with the first free number, ignoring case", () => {
  assert.equal(recipeFilterName([open, triaging], 'Assigned to me'), 'Assigned to me')
  assert.equal(recipeFilterName([open, triaging], 'Open'), 'Open 2')
  assert.equal(recipeFilterName([open, { ...triaging, name: ' open 2 ' }, { ...mine, name: 'Open 4' }], 'Open'), 'Open 3')
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
  assert.deepEqual(withFilterSaved(settings, 'jira', { id: 'f-board', name: ' Sprint board ', queries: ['', 'sprint in openSprints()'] }), {
    filters: { jira: [tasks, { id: 'f-board', name: 'Sprint board', queries: ['', 'sprint in openSprints()'] }] },
    shownFilterId: { jira: 'f-board' }
  })
  assert.deepEqual(withFilterSaved(settings, 'jira', { ...mine, name: 'Mine ' }), {
    filters: { jira: [tasks, board, mine] },
    shownFilterId: { jira: 'f-mine' }
  })
})

test('saving a filter of a project that stored none keeps the initial "Tasks" filter before it', () => {
  assert.deepEqual(withFilterSaved({}, 'jira', mine), {
    filters: { jira: [{ id: 'tasks', name: 'Tasks', queries: [DEFAULT_JQL] }, mine] },
    shownFilterId: { jira: 'f-mine' }
  })
})

test('deleting a filter keeps the one shown, or shows the first remaining when it was the one shown, and the last one stays', () => {
  const settings = { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterDeleted(settings, 'jira', 'f-mine'), { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-board' } })
  assert.deepEqual(withFilterDeleted(settings, 'jira', 'f-board'), { filters: { jira: [tasks, mine] }, shownFilterId: { jira: 'tasks' } })
  assert.deepEqual(withFilterDeleted({ filters: { jira: [board, mine] } }, 'jira', 'f-board'), { filters: { jira: [mine] }, shownFilterId: { jira: 'f-mine' } })
  assert.equal(withFilterDeleted({ filters: { jira: [board] } }, 'jira', 'f-board'), null)
  assert.equal(withFilterDeleted({}, 'jira', 'tasks'), null)
})

test("saving or deleting a GitHub filter changes GitHub's filters and the one shown, keeping Jira's", () => {
  const jira = { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterSaved(jira, 'github', triaging), {
    filters: { jira: [tasks, board], github: [open, triaging] },
    shownFilterId: { jira: 'f-board', github: 'f-triage' }
  })
  const both = { filters: { ...jira.filters, github: [open, triaging] }, shownFilterId: { ...jira.shownFilterId, github: 'f-triage' } }
  assert.deepEqual(withFilterDeleted(both, 'github', 'f-triage'), {
    filters: { jira: [tasks, board], github: [open] },
    shownFilterId: { jira: 'f-board', github: 'open' }
  })
  assert.deepEqual(withFilterSaved(both, 'jira', mine), {
    filters: { jira: [tasks, board, mine], github: [open, triaging] },
    shownFilterId: { jira: 'f-mine', github: 'f-triage' }
  })
  assert.equal(withFilterDeleted(jira, 'github', 'open'), null)
})
