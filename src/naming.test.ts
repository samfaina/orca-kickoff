import { assert, test } from 'orca/testing'
import { taskKeyFromWorktreeName, titleWords, worktreeName } from './naming'

test('title words fold accents, lower-case and join with dashes', () => {
  assert.equal(titleWords('Añadir sesión rápida'), 'anadir-sesion-rapida')
  assert.equal(titleWords('  Fix: the "login" bug!  '), 'fix-the-login-bug')
})

test('a Jira worktree name is the lower-cased key and up to four words of the title', () => {
  assert.equal(worktreeName({ tracker: 'jira', key: 'WEB-12', title: 'Añadir modo oscuro a ajustes' }), 'web-12-anadir-modo-oscuro-a')
})

test('a GitHub worktree name starts with issue-<n>', () => {
  assert.equal(worktreeName({ tracker: 'github', key: '#42', title: 'Add dark mode' }), 'issue-42-add-dark-mode')
})

test('a title with no usable words gives just the prefix', () => {
  assert.equal(worktreeName({ tracker: 'github', key: '#7', title: '¿¡!?' }), 'issue-7')
})

test('a Jira worktree name reads back as its key', () => {
  assert.equal(taskKeyFromWorktreeName('web-12-anadir-modo', 'jira'), 'WEB-12')
  assert.equal(taskKeyFromWorktreeName('web-12', 'jira'), 'WEB-12')
  assert.equal(taskKeyFromWorktreeName('data_ops-3-fix', 'jira'), 'DATA_OPS-3')
})

test('a GitHub worktree name reads back as #<n>', () => {
  assert.equal(taskKeyFromWorktreeName('issue-42-add-dark-mode', 'github'), '#42')
})

test('names that are not task names read as null', () => {
  assert.equal(taskKeyFromWorktreeName('main', 'jira'), null)
  assert.equal(taskKeyFromWorktreeName('web-12-x', 'github'), null)
  assert.equal(taskKeyFromWorktreeName('issue-42x', 'github'), null)
})
