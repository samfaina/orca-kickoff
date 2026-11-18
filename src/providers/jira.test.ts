import { assert, test } from 'orca/testing'
import { isJiraTaskKey, jiraSearchJql, requireJql, splitJql } from './jira'

test('the queries to run are the non-blank ones, trimmed, each with its position in the settings', () => {
  assert.deepEqual(requireJql(['  project = WEB ', '', '   ', 'project = API']), [
    { jql: 'project = WEB', position: 1 },
    { jql: 'project = API', position: 4 }
  ])
})

test('each line break in a query becomes a space', () => {
  assert.deepEqual(requireJql(['project = WEB\nAND labels = ui\r\nORDER BY rank\r', '\n\r\n']), [
    { jql: 'project = WEB AND labels = ui ORDER BY rank', position: 1 }
  ])
})

test('with no query, or only blank ones, the list asks for one', () => {
  assert.throws(() => requireJql([]), /Enter a JQL query to list Jira tasks, for example: assignee = currentUser\(\)/)
  assert.throws(() => requireJql(['', ' \n ']), /Enter a JQL query to list Jira tasks/)
})

test("a tracker search keeps the JQL's conditions in parentheses, matches word prefixes and keeps ORDER BY outside", () => {
  assert.equal(
    jiraSearchJql('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', 'dark mode'),
    '(assignee = currentUser() AND statusCategory != Done) AND (text ~ "dark* mode*") ORDER BY updated DESC'
  )
})

test('a JQL without ORDER BY is wrapped whole', () => {
  assert.equal(jiraSearchJql('project = WEB OR labels = ui', ' login  '), '(project = WEB OR labels = ui) AND (text ~ "login*")')
})

test('ORDER BY is split whatever its case, but not inside a quoted string', () => {
  assert.deepEqual(splitJql('project = WEB order  by created'), { conditions: 'project = WEB', orderBy: 'order  by created' })
  assert.deepEqual(splitJql('summary ~ "order by" AND labels = \'ORDER BY\''), {
    conditions: 'summary ~ "order by" AND labels = \'ORDER BY\'',
    orderBy: null
  })
  assert.deepEqual(splitJql('summary ~ "say \\"order by\\"" ORDER BY rank'), { conditions: 'summary ~ "say \\"order by\\""', orderBy: 'ORDER BY rank' })
  assert.deepEqual(splitJql('reorder = 1 AND borderBy = 2'), { conditions: 'reorder = 1 AND borderBy = 2', orderBy: null })
})

test('a JQL that is only ORDER BY searches every task in that order', () => {
  assert.equal(jiraSearchJql('ORDER BY updated DESC', 'dark'), '(text ~ "dark*") ORDER BY updated DESC')
})

test('a word shaped like a task key also matches that key, in upper case, and no other word does', () => {
  assert.equal(jiraSearchJql('project = WEB', 'web-12 abc'), '(project = WEB) AND (text ~ "web-12* abc*" OR key = "WEB-12")')
  assert.equal(jiraSearchJql('project = WEB', 'WEB-12 api_v2-3'), '(project = WEB) AND (text ~ "WEB-12* api_v2-3*" OR key = "WEB-12" OR key = "API_V2-3")')
  assert.equal(jiraSearchJql('project = WEB', 'abc'), '(project = WEB) AND (text ~ "abc*")')
})

test('a task key starts with a letter and ends in a dash and digits', () => {
  assert.deepEqual(
    ['WEB-12', 'web-12', 'A1_B-7', 'WEB-', '12-3', 'WEB12', '-12', 'WEB-12a', 'WE B-1', 'WEB-1-2'].map(isJiraTaskKey),
    [true, true, true, false, false, false, false, false, false, false]
  )
})

test('" and \\ in a word are escaped inside the JQL string', () => {
  assert.equal(jiraSearchJql('project = WEB', 'say"hi c:\\temp\\'), '(project = WEB) AND (text ~ "say\\"hi* c:\\\\temp\\\\*")')
})

test('a blank tracker search leaves the JQL as it is', () => {
  assert.equal(jiraSearchJql('project = WEB ORDER BY rank', '  '), 'project = WEB ORDER BY rank')
  assert.equal(jiraSearchJql('project = WEB ORDER BY rank'), 'project = WEB ORDER BY rank')
})
