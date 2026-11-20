import { assert, test } from 'orca/testing'
import { jqlRecipe } from './jql-recipe'

test('Board order writes the open sprints, the future sprints and the rest, in board order', () => {
  assert.deepEqual(jqlRecipe({ recipe: 'board-order', projectKey: 'WEB', assignees: 'mine-or-unassigned', leaveOut: 'Done, Closed, To validate' }), {
    name: 'Board order',
    queries: [
      'project = WEB AND sprint in openSprints() AND (assignee IS EMPTY OR assignee = currentUser()) AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Rank ASC',
      'project = WEB AND sprint in futureSprints() AND (assignee IS EMPTY OR assignee = currentUser()) AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Sprint ASC, Rank ASC',
      'project = WEB AND (sprint IS EMPTY OR sprint NOT IN (openSprints(), futureSprints())) AND (assignee IS EMPTY OR assignee = currentUser()) AND status NOT IN ("Done", "Closed", "To validate") ORDER BY Rank ASC'
    ]
  })
})

test("Board order's whose tasks: mine adds assignee = currentUser(), anyone adds no assignee condition", () => {
  const firstQuery = (assignees: 'mine' | 'anyone') => jqlRecipe({ recipe: 'board-order', projectKey: 'API', assignees, leaveOut: 'Done' })?.queries[0]
  assert.equal(firstQuery('mine'), 'project = API AND sprint in openSprints() AND assignee = currentUser() AND status NOT IN ("Done") ORDER BY Rank ASC')
  assert.equal(firstQuery('anyone'), 'project = API AND sprint in openSprints() AND status NOT IN ("Done") ORDER BY Rank ASC')
})

test('the statuses to leave out are trimmed, blank ones dropped, and quoted, their quotes and backslashes escaped; with none left, no status condition', () => {
  const firstQuery = (leaveOut: string) => jqlRecipe({ recipe: 'board-order', projectKey: 'WEB', assignees: 'anyone', leaveOut })?.queries[0]
  // The statuses typed are: Done, "Won't do" with its quotes, and a\b.
  assert.equal(firstQuery(' Done ,, "Won\'t do" ,a\\b, '), String.raw`project = WEB AND sprint in openSprints() AND status NOT IN ("Done", "\"Won't do\"", "a\\b") ORDER BY Rank ASC`)
  assert.equal(firstQuery(''), 'project = WEB AND sprint in openSprints() ORDER BY Rank ASC')
  assert.equal(firstQuery(' , ,'), 'project = WEB AND sprint in openSprints() ORDER BY Rank ASC')
})

test('My open tasks writes one query: the tasks assigned to the person, without the statuses left out, last updated first', () => {
  assert.deepEqual(jqlRecipe({ recipe: 'my-open-tasks', leaveOut: 'Done, Closed, To validate' }), {
    name: 'My open tasks',
    queries: ['assignee = currentUser() AND status NOT IN ("Done", "Closed", "To validate") ORDER BY updated DESC']
  })
  assert.deepEqual(jqlRecipe({ recipe: 'my-open-tasks', leaveOut: ' ' })?.queries, ['assignee = currentUser() ORDER BY updated DESC'])
})

test("Board order writes project = {{jira_project}} while its answer is the project's Jira project key, ignoring case, and any other key as typed", () => {
  const firstQuery = (projectKey: string, jiraProjectKey: string) =>
    jqlRecipe({ recipe: 'board-order', projectKey, assignees: 'anyone', leaveOut: '' }, jiraProjectKey)?.queries[0]
  assert.equal(firstQuery('WEB', 'WEB'), 'project = {{jira_project}} AND sprint in openSprints() ORDER BY Rank ASC')
  assert.equal(firstQuery(' web ', 'WEB'), 'project = {{jira_project}} AND sprint in openSprints() ORDER BY Rank ASC')
  assert.equal(firstQuery('API', 'WEB'), 'project = API AND sprint in openSprints() ORDER BY Rank ASC')
  assert.equal(firstQuery('WEB', ''), 'project = WEB AND sprint in openSprints() ORDER BY Rank ASC')
  const queries = jqlRecipe({ recipe: 'board-order', projectKey: 'WEB', assignees: 'anyone', leaveOut: '' }, 'WEB')?.queries ?? []
  assert.equal(queries.length, 3)
  assert.ok(queries.every((query) => query.startsWith('project = {{jira_project}} AND ')))
})

test("Board order trims the project key and writes nothing without one", () => {
  const boardOrder = (projectKey: string) => jqlRecipe({ recipe: 'board-order', projectKey, assignees: 'anyone', leaveOut: '' })
  assert.equal(boardOrder('  WEB ')?.queries[0], 'project = WEB AND sprint in openSprints() ORDER BY Rank ASC')
  assert.equal(boardOrder(''), null)
  assert.equal(boardOrder('   '), null)
})
