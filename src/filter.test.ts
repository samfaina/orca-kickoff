import { assert, test } from 'orca/testing'
import {
  filterNameProblem,
  filterRecipes,
  filterWriteChanges,
  namesJiraProject,
  newFilterName,
  recipeFilterName,
  withFilterDeleted,
  withFilterMoved,
  withFilterSaved,
  withJiraProjectVariable
} from './filter'
import { listedFilter, projectFilters } from './protocol'

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
const tasks = { id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }
const board = { id: 'f-board', name: 'Board', queries: ['project = WEB ORDER BY rank', ''] }
const mine = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }
const initialTasks = { id: 'tasks', name: 'Tasks', queries: [DEFAULT_JQL] }

const open = { id: 'open', name: 'Open', queries: ['is:open'] }
const triaging = { id: 'f-triage', name: 'Triage', queries: ['is:open label:needs-triage'] }

/** A filter as a project lists it: one of its own, or a global one. */
const own = <F extends object>(filter: F) => ({ ...filter, global: false })
const shared = <F extends object>(filter: F) => ({ ...filter, global: true })

const sprint = { id: 'g-sprint', name: 'Sprint', queries: ['project = {{jira_project}} AND sprint in openSprints()'] }
const bugs = { id: 'g-bugs', name: 'Bugs', queries: ['type = Bug'] }

test('a Jira project without filters has one, "Tasks", with the default JQL', () => {
  assert.deepEqual(projectFilters({}, 'jira', []), [own(initialTasks)])
  assert.deepEqual(projectFilters({ filters: {} }, 'jira', []), [own(initialTasks)])
  assert.deepEqual(projectFilters({ filters: { jira: [] } }, 'jira', []), [own(initialTasks)])
  assert.deepEqual(projectFilters({ filters: { jira: [board, mine] } }, 'jira', []), [own(board), own(mine)])
})

test('a GitHub project without filters has one, "Open", with is:open, and keeps its filters apart from Jira\'s', () => {
  assert.deepEqual(projectFilters({}, 'github', []), [own(open)])
  assert.deepEqual(projectFilters({ filters: { jira: [board] } }, 'github', []), [own(open)])
  assert.deepEqual(projectFilters({ filters: { github: [] } }, 'github', []), [own(open)])
  assert.deepEqual(projectFilters({ filters: { github: [triaging], jira: [board] } }, 'github', []), [own(triaging)])
  assert.deepEqual(projectFilters({ filters: { github: [triaging] } }, 'jira', []), [own(initialTasks)])
})

test('a project lists its own filters on the tracker first, then the global ones, each in its order, the global ones marked', () => {
  assert.deepEqual(projectFilters({ filters: { jira: [board, mine] } }, 'jira', [sprint, bugs]), [own(board), own(mine), shared(sprint), shared(bugs)])
  assert.deepEqual(projectFilters({ filters: { github: [triaging] } }, 'github', [open]), [own(triaging), shared(open)])
})

test('the initial filter is listed only while the project has none of its own on the tracker and there is no global one', () => {
  assert.deepEqual(projectFilters({}, 'jira', [sprint]), [shared(sprint)])
  assert.deepEqual(projectFilters({ filters: { jira: [] } }, 'jira', [sprint]), [shared(sprint)])
  assert.deepEqual(projectFilters({}, 'github', [triaging]), [shared(triaging)])
})

test("a global filter whose id one of the project's own has is left out, so an id names one filter", () => {
  assert.deepEqual(projectFilters({ filters: { jira: [tasks, board] } }, 'jira', [{ ...sprint, id: 'f-board' }, bugs]), [own(tasks), own(board), shared(bugs)])
})

test('the filter listed is the one asked for, else the one shown last, else the first', () => {
  const settings = { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-mine' } }
  assert.deepEqual(listedFilter(settings, 'jira', [], 'f-board'), own(board))
  assert.deepEqual(listedFilter(settings, 'jira', []), own(mine))
  assert.deepEqual(listedFilter(settings, 'jira', [], 'f-gone'), own(mine))
  assert.deepEqual(listedFilter({ filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-gone' } }, 'jira', []), own(tasks))
  assert.deepEqual(listedFilter({ filters: { jira: [tasks, board] } }, 'jira', []), own(tasks))
})

test('the filter listed can be a global one, asked for or shown last; one no longer global falls back to the first', () => {
  const settings = { filters: { jira: [board] }, shownFilterId: { jira: 'g-sprint' } }
  assert.deepEqual(listedFilter(settings, 'jira', [sprint, bugs], 'g-bugs'), shared(bugs))
  assert.deepEqual(listedFilter(settings, 'jira', [sprint, bugs]), shared(sprint))
  assert.deepEqual(listedFilter(settings, 'jira', [bugs]), own(board))
  assert.deepEqual(listedFilter({ shownFilterId: { jira: 'g-sprint' } }, 'jira', []), own(initialTasks))
})

test("on GitHub, the filter listed is the one asked for, else GitHub's one shown last, else the first", () => {
  const settings = { filters: { github: [open, triaging], jira: [tasks, board] }, shownFilterId: { github: 'f-triage', jira: 'f-board' } }
  assert.deepEqual(listedFilter(settings, 'github', [], 'open'), own(open))
  assert.deepEqual(listedFilter(settings, 'github', []), own(triaging))
  assert.deepEqual(listedFilter(settings, 'github', [], 'f-board'), own(triaging))
  assert.deepEqual(listedFilter({ ...settings, shownFilterId: { jira: 'f-triage' } }, 'github', []), own(open))
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

test("a filter's name is trimmed, not empty, and unique among the project's own ignoring case", () => {
  const filters = [own(tasks), own(board)]
  assert.equal(filterNameProblem(filters, '  ', 'f-new', false), 'Give the filter a name.')
  assert.equal(filterNameProblem(filters, ' board ', 'f-new', false), 'Another filter is already called "Board".')
  assert.equal(filterNameProblem(filters, 'BOARD', 'f-board', false), null)
  assert.equal(filterNameProblem(filters, 'Sprint', 'f-new', false), null)
})

test("a global filter's name is unique among the global ones, and an own filter and a global one may share a name", () => {
  const filters = [own(board), shared(sprint)]
  assert.equal(filterNameProblem(filters, 'Board', 'g-new', true), null)
  assert.equal(filterNameProblem(filters, ' sprint ', 'g-new', true), 'Another global filter is already called "Sprint".')
  assert.equal(filterNameProblem(filters, 'Sprint', 'g-sprint', true), null)
  assert.equal(filterNameProblem(filters, 'Sprint', 'f-new', false), null)
  assert.equal(filterNameProblem(filters, '', 'g-new', true), 'Give the filter a name.')
})

test('saving a filter trims its name, keeps its place or adds it at the end, keeps blank queries, and shows it', () => {
  const settings = { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'tasks' } }
  assert.deepEqual(withFilterSaved(settings, 'jira', [], { id: 'f-board', name: ' Sprint board ', queries: ['', 'sprint in openSprints()'] }, false), {
    project: { filters: { jira: [tasks, { id: 'f-board', name: 'Sprint board', queries: ['', 'sprint in openSprints()'] }] }, shownFilterId: { jira: 'f-board' } },
    global: []
  })
  assert.deepEqual(withFilterSaved(settings, 'jira', [sprint], { ...mine, name: 'Mine ' }, false), {
    project: { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-mine' } },
    global: [sprint]
  })
})

test('saving a filter of a project that stored none keeps the initial "Tasks" filter before it', () => {
  assert.deepEqual(withFilterSaved({}, 'jira', [], mine, false), {
    project: { filters: { jira: [initialTasks, mine] }, shownFilterId: { jira: 'f-mine' } },
    global: []
  })
})

test("saving a global filter keeps its place among the global ones or adds it at the end, keeps the project's own, and shows it", () => {
  const settings = { filters: { jira: [board] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterSaved(settings, 'jira', [sprint, bugs], { ...sprint, name: ' Open sprints ', queries: ['sprint in openSprints()', ''] }, true), {
    project: { filters: { jira: [board] }, shownFilterId: { jira: 'g-sprint' } },
    global: [{ id: 'g-sprint', name: 'Open sprints', queries: ['sprint in openSprints()', ''] }, bugs]
  })
  assert.deepEqual(withFilterSaved(settings, 'jira', [sprint], bugs, true), {
    project: { filters: { jira: [board] }, shownFilterId: { jira: 'g-bugs' } },
    global: [sprint, bugs]
  })
})

test('the first global filter saved in a project that listed only the initial filter stores it as its own, so the project keeps it', () => {
  assert.deepEqual(withFilterSaved({}, 'jira', [], sprint, true), {
    project: { filters: { jira: [initialTasks] }, shownFilterId: { jira: 'g-sprint' } },
    global: [sprint]
  })
  assert.deepEqual(withFilterSaved({}, 'jira', [bugs], sprint, true), {
    project: { filters: { jira: [] }, shownFilterId: { jira: 'g-sprint' } },
    global: [bugs, sprint]
  })
})

test('deleting a filter keeps the one shown, or shows the first remaining when it was the one shown, and the last one stays', () => {
  const settings = { filters: { jira: [tasks, board, mine] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterDeleted(settings, 'jira', [], 'f-mine'), { project: { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-board' } }, global: [] })
  assert.deepEqual(withFilterDeleted(settings, 'jira', [], 'f-board'), { project: { filters: { jira: [tasks, mine] }, shownFilterId: { jira: 'tasks' } }, global: [] })
  assert.deepEqual(withFilterDeleted({ filters: { jira: [board, mine] } }, 'jira', [], 'f-board'), {
    project: { filters: { jira: [mine] }, shownFilterId: { jira: 'f-mine' } },
    global: []
  })
  assert.equal(withFilterDeleted({ filters: { jira: [board] } }, 'jira', [], 'f-board'), null)
  assert.equal(withFilterDeleted({}, 'jira', [], 'tasks'), null)
})

test('a global filter is deleted from the global ones; a filter can be deleted while the project lists another, own or global', () => {
  const settings = { filters: { jira: [board] }, shownFilterId: { jira: 'g-sprint' } }
  assert.deepEqual(withFilterDeleted(settings, 'jira', [sprint, bugs], 'g-sprint'), {
    project: { filters: { jira: [board] }, shownFilterId: { jira: 'f-board' } },
    global: [bugs]
  })
  assert.deepEqual(withFilterDeleted(settings, 'jira', [sprint], 'f-board'), {
    project: { filters: { jira: [] }, shownFilterId: { jira: 'g-sprint' } },
    global: [sprint]
  })
  assert.deepEqual(withFilterDeleted({ shownFilterId: { jira: 'g-sprint' } }, 'jira', [sprint, bugs], 'g-sprint'), {
    project: { filters: { jira: [] }, shownFilterId: { jira: 'g-bugs' } },
    global: [bugs]
  })
  assert.equal(withFilterDeleted({}, 'jira', [sprint], 'g-sprint'), null)
})

test("saving or deleting a GitHub filter changes GitHub's filters and the one shown, keeping Jira's", () => {
  const jira = { filters: { jira: [tasks, board] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterSaved(jira, 'github', [], triaging, false).project, {
    filters: { jira: [tasks, board], github: [open, triaging] },
    shownFilterId: { jira: 'f-board', github: 'f-triage' }
  })
  const both = { filters: { ...jira.filters, github: [open, triaging] }, shownFilterId: { ...jira.shownFilterId, github: 'f-triage' } }
  assert.deepEqual(withFilterDeleted(both, 'github', [], 'f-triage')?.project, {
    filters: { jira: [tasks, board], github: [open] },
    shownFilterId: { jira: 'f-board', github: 'open' }
  })
  assert.deepEqual(withFilterSaved(both, 'jira', [], mine, false).project, {
    filters: { jira: [tasks, board, mine], github: [open, triaging] },
    shownFilterId: { jira: 'f-mine', github: 'f-triage' }
  })
  assert.equal(withFilterDeleted(jira, 'github', [], 'open'), null)
})

test('turning Global on moves the filter, as stored, to the end of the global ones, keeping its id and the filter shown', () => {
  const settings = { filters: { jira: [board, mine] }, shownFilterId: { jira: 'f-board' } }
  assert.deepEqual(withFilterMoved(settings, 'jira', [sprint], 'f-board', true, 'g-fresh'), {
    ok: true,
    id: 'f-board',
    write: { project: { filters: { jira: [mine] }, shownFilterId: { jira: 'f-board' } }, global: [sprint, board] }
  })
  assert.deepEqual(withFilterMoved(settings, 'jira', [], 'f-mine', true, 'g-fresh'), {
    ok: true,
    id: 'f-mine',
    write: { project: { filters: { jira: [board] }, shownFilterId: { jira: 'f-board' } }, global: [mine] }
  })
})

test("the initial filter made global takes a fresh id, since other projects store an own filter with its id, and the filter shown follows it", () => {
  assert.deepEqual(withFilterMoved({}, 'jira', [], 'tasks', true, 'g-fresh'), {
    ok: true,
    id: 'g-fresh',
    write: { project: { filters: { jira: [] }, shownFilterId: { jira: 'g-fresh' } }, global: [{ ...initialTasks, id: 'g-fresh' }] }
  })
  assert.deepEqual(withFilterMoved({ filters: { github: [open, triaging] }, shownFilterId: { github: 'f-triage' } }, 'github', [], 'open', true, 'g-fresh'), {
    ok: true,
    id: 'g-fresh',
    write: { project: { filters: { github: [triaging] }, shownFilterId: { github: 'f-triage' } }, global: [{ ...open, id: 'g-fresh' }] }
  })
})

test('turning Global off moves the filter to the end of the project\'s own, keeping its id and the filter shown', () => {
  const settings = { filters: { jira: [board] }, shownFilterId: { jira: 'g-sprint' } }
  assert.deepEqual(withFilterMoved(settings, 'jira', [sprint, bugs], 'g-sprint', false, 'g-fresh'), {
    ok: true,
    id: 'g-sprint',
    write: { project: { filters: { jira: [board, sprint] }, shownFilterId: { jira: 'g-sprint' } }, global: [bugs] }
  })
  assert.deepEqual(withFilterMoved({}, 'jira', [sprint], 'g-sprint', false, 'g-fresh'), {
    ok: true,
    id: 'g-sprint',
    write: { project: { filters: { jira: [sprint] }, shownFilterId: { jira: 'g-sprint' } }, global: [] }
  })
})

test('a move whose name the destination group has, ignoring case, or of a filter no longer where it was, is refused', () => {
  const settings = { filters: { jira: [board, { ...mine, name: 'sprint' }] } }
  assert.deepEqual(withFilterMoved(settings, 'jira', [sprint], 'f-mine', true, 'g-fresh'), {
    ok: false,
    message: 'A global filter is already called "Sprint". Rename one of them first.'
  })
  assert.deepEqual(withFilterMoved({ filters: { jira: [{ ...board, name: 'SPRINT' }] } }, 'jira', [sprint], 'g-sprint', false, 'g-fresh'), {
    ok: false,
    message: 'This project already has a filter called "SPRINT". Rename one of them first.'
  })
  assert.equal(withFilterMoved(settings, 'jira', [sprint], 'g-gone', false, 'g-fresh').ok, false)
  assert.equal(withFilterMoved(settings, 'jira', [sprint], 'g-sprint', true, 'g-fresh').ok, false)
})

test("a write's global filters replace those of its tracker, keeping the other tracker's and the global templates", () => {
  const write = { project: { filters: { jira: [board] }, shownFilterId: { jira: 'f-board' } }, global: [sprint] }
  const stored = { templates: [{ id: 't-plan', name: 'Plan', text: '' }], filters: { jira: [bugs], github: [triaging] } }
  assert.deepEqual(filterWriteChanges(stored, 'jira', write), { project: write.project, global: { filters: { jira: [sprint], github: [triaging] } } })
  assert.deepEqual(filterWriteChanges({}, 'github', { ...write, global: [open] }), { project: write.project, global: { filters: { github: [open] } } })
})

test('a query names a Jira project key as `project = KEY`, spaces around = optional, the key and the field ignoring case', () => {
  assert.equal(namesJiraProject('project = WEB ORDER BY rank', 'WEB'), true)
  assert.equal(namesJiraProject('project=web AND sprint in openSprints()', 'WEB'), true)
  assert.equal(namesJiraProject('assignee = currentUser() AND Project  =  Web', 'WEB'), true)
  assert.equal(namesJiraProject('project in (WEB, API)', 'WEB'), false)
  assert.equal(namesJiraProject('project = WEBAPP', 'WEB'), false)
  assert.equal(namesJiraProject('project = API', 'WEB'), false)
  assert.equal(namesJiraProject('subproject = WEB', 'WEB'), false)
  assert.equal(namesJiraProject('project = {{jira_project}}', 'WEB'), false)
  assert.equal(namesJiraProject('project = WEB', ''), false)
})

test('the key in each `project = KEY` is replaced by {{jira_project}}, keeping the rest as written', () => {
  assert.equal(withJiraProjectVariable('project = WEB ORDER BY rank', 'WEB'), 'project = {{jira_project}} ORDER BY rank')
  assert.equal(withJiraProjectVariable('Project=web OR project  =  WEB', 'WEB'), 'Project={{jira_project}} OR project  =  {{jira_project}}')
  assert.equal(withJiraProjectVariable('project = WEBAPP OR project in (WEB)', 'WEB'), 'project = WEBAPP OR project in (WEB)')
  assert.equal(withJiraProjectVariable('project = WEB_2', 'WEB'), 'project = WEB_2')
})
