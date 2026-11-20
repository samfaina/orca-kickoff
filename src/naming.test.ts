import { assert, test } from 'orca/testing'
import {
  branchSettingsProblem,
  branchType,
  cleanTitle,
  filledBranch,
  gitBranchProblem,
  INITIAL_TITLE_EXCLUSION,
  taskKeyFromWorktreeName,
  taskSlug,
  titleWords,
  worktreeName
} from './naming'

test('title words fold accents, lower-case and join with dashes', () => {
  assert.equal(titleWords('Añadir sesión rápida'), 'anadir-sesion-rapida')
  assert.equal(titleWords('  Fix: the "login" bug!  '), 'fix-the-login-bug')
})

test('a Jira worktree name is the lower-cased key and up to four words of the title', () => {
  assert.equal(worktreeName({ tracker: 'jira', key: 'WEB-12', title: 'Añadir modo oscuro a ajustes' }, INITIAL_TITLE_EXCLUSION), 'web-12-anadir-modo-oscuro-a')
})

test('a GitHub worktree name starts with issue-<n>', () => {
  assert.equal(worktreeName({ tracker: 'github', key: '#42', title: 'Add dark mode' }, INITIAL_TITLE_EXCLUSION), 'issue-42-add-dark-mode')
})

test('a title with no usable words gives just the prefix', () => {
  assert.equal(worktreeName({ tracker: 'github', key: '#7', title: '¿¡!?' }, INITIAL_TITLE_EXCLUSION), 'issue-7')
})

const TAGGED = '[FE] | [Mobile][Widgets] Add dark mode'

test('the initial title exclusion pattern removes bracketed tags anywhere in the title', () => {
  assert.equal(INITIAL_TITLE_EXCLUSION, '\\[[^\\]]*\\]')
  assert.equal(cleanTitle(TAGGED, INITIAL_TITLE_EXCLUSION), ' |  Add dark mode')
  assert.equal(cleanTitle('Add [WIP] dark mode [FE]', INITIAL_TITLE_EXCLUSION), 'Add  dark mode ')
  assert.equal(taskSlug(TAGGED, INITIAL_TITLE_EXCLUSION), 'add-dark-mode')
})

test('an empty title exclusion pattern removes nothing, and a changed one replaces the initial one', () => {
  assert.equal(taskSlug(TAGGED, ''), 'fe-mobile-widgets-add')
  assert.equal(taskSlug('WIP: [FE] Add dark mode', '^wip:\\s*'), 'fe-add-dark-mode')
})

test('the pattern matches every occurrence, ignoring case', () => {
  assert.equal(taskSlug('Fix TODO in todo list', 'todo'), 'fix-in-list')
})

test('a title the pattern leaves without words keeps its own words', () => {
  assert.equal(taskSlug('[FE] [Mobile]', INITIAL_TITLE_EXCLUSION), 'fe-mobile')
  assert.equal(worktreeName({ tracker: 'jira', key: 'WEB-3', title: '[FE] [Mobile]' }, INITIAL_TITLE_EXCLUSION), 'web-3-fe-mobile')
})

test('the slug has up to four words of the cleaned title', () => {
  assert.equal(taskSlug('Añadir modo oscuro a los ajustes', ''), 'anadir-modo-oscuro-a')
  assert.equal(taskSlug('¿¡!?', ''), '')
})

test('the worktree name uses the cleaned title', () => {
  assert.equal(worktreeName({ tracker: 'jira', key: 'WEB-12', title: TAGGED }, INITIAL_TITLE_EXCLUSION), 'web-12-add-dark-mode')
  assert.equal(worktreeName({ tracker: 'jira', key: 'WEB-12', title: TAGGED }, ''), 'web-12-fe-mobile-widgets-add')
})

test('a pattern that is not a valid regular expression removes nothing', () => {
  assert.equal(taskSlug(TAGGED, '[unclosed'), 'fe-mobile-widgets-add')
})

const CONVENTION = '{{branch_type}}/{{task_key}}__{{task_slug}}--AB'
const branchSettings = { branchTemplate: CONVENTION, branchTypes: [{ issueType: 'Bug', branchType: 'bugfix' }], branchTypeFallback: 'feature' }
const jiraTask = (issueType?: string) => ({ tracker: 'jira' as const, key: 'WEB-12', title: TAGGED, ...(issueType ? { issueType } : {}) })

test('a branch template fills the task key, the slug and the branch type', () => {
  assert.equal(filledBranch(branchSettings, jiraTask('Bug')), 'bugfix/WEB-12__add-dark-mode--AB')
  assert.equal(filledBranch(branchSettings, jiraTask('Story')), 'feature/WEB-12__add-dark-mode--AB')
})

test('on GitHub the task key has no # and the branch type is the fallback', () => {
  assert.equal(filledBranch(branchSettings, { tracker: 'github', key: '#42', title: 'Add dark mode' }), 'feature/42__add-dark-mode--AB')
})

test('an empty branch template gives no branch', () => {
  assert.equal(filledBranch({}, jiraTask('Bug')), null)
  assert.equal(filledBranch({ ...branchSettings, branchTemplate: '' }, jiraTask('Bug')), null)
  assert.equal(filledBranch({ ...branchSettings, branchTemplate: '  ' }, jiraTask('Bug')), null)
})

test('the branch slug uses the title exclusion pattern', () => {
  assert.equal(filledBranch({ ...branchSettings, titleExclusion: '' }, jiraTask('Bug')), 'bugfix/WEB-12__fe-mobile-widgets-add--AB')
})

test("a branch type is matched by the task's issue type, trimmed and ignoring case", () => {
  const types = [{ issueType: ' bug ', branchType: ' bugfix ' }, { issueType: 'Story', branchType: 'feature' }]
  assert.equal(branchType({ branchTypes: types, branchTypeFallback: 'chore' }, 'BUG'), 'bugfix')
  assert.equal(branchType({ branchTypes: types, branchTypeFallback: 'chore' }, 'story'), 'feature')
})

test('a type not in the table, a task with no type and a row left blank get the fallback', () => {
  const types = [{ issueType: '', branchType: 'none' }, { issueType: 'Task', branchType: '' }]
  assert.equal(branchType({ branchTypes: types, branchTypeFallback: ' chore ' }, 'Epic'), 'chore')
  assert.equal(branchType({ branchTypes: types, branchTypeFallback: 'chore' }, undefined), 'chore')
  assert.equal(branchType({ branchTypes: types, branchTypeFallback: 'chore' }, 'Task'), 'chore')
  assert.equal(branchType({}, 'Bug'), '')
})

test('git branch names: what git holds passes', () => {
  for (const name of ['feature/WEB-12__add-dark-mode--AB', 'fix-1', 'a.b/c_d', 'release/1.2']) assert.equal(gitBranchProblem(name), null, name)
})

test('git branch names: what git refuses is named', () => {
  const cases: [string, string][] = [
    ['add dark', 'has a space or a control character'],
    ['tab\there', 'has a space or a control character'],
    ['a~b', 'has "~"'],
    ['a^b', 'has "^"'],
    ['a:b', 'has ":"'],
    ['a?b', 'has "?"'],
    ['a*b', 'has "*"'],
    ['a[b', 'has "["'],
    ['a\\b', 'has "\\"'],
    ['a..b', 'has ".."'],
    ['a@{b', 'has "@{"'],
    ['feature/.hidden', 'has a part that starts with "."'],
    ['.hidden', 'has a part that starts with "."'],
    ['feature/x.lock', 'has a part that ends with ".lock"'],
    ['x.lock/y', 'has a part that ends with ".lock"'],
    ['-x', 'starts with "-"'],
    ['', 'is empty'],
    ['@', 'is "@"'],
    ['x/', 'ends with "/"'],
    ['x.', 'ends with "."'],
    ['a//b', 'has an empty part'],
    ['/a', 'has an empty part']
  ]
  for (const [name, problem] of cases) assert.equal(gitBranchProblem(name), problem, name)
})

test('saving the branch settings refuses fixed text git cannot hold in the template', () => {
  const problem = (branchTemplate: string) => branchSettingsProblem({ ...branchSettings, branchTemplate })
  assert.equal(problem(CONVENTION), null)
  assert.equal(problem('{{ task_key }}/{{task_slug}}'), null)
  assert.equal(problem(''), null)
  assert.equal(problem('feature/{{task_key}} {{task_slug}}'), "The branch template has a space or a control character, which git can't hold in a branch name.")
  assert.equal(problem('feature~{{task_key}}'), 'The branch template has "~", which git can\'t hold in a branch name.')
  assert.equal(problem('feature..{{task_key}}'), 'The branch template has "..", which git can\'t hold in a branch name.')
  assert.equal(problem('@{{{task_key}}'), 'The branch template has "@{", which git can\'t hold in a branch name.')
  assert.equal(problem('.{{task_key}}'), 'The branch template has a part that starts with ".", which git can\'t hold in a branch name.')
  assert.equal(problem('{{task_key}}.lock'), 'The branch template has a part that ends with ".lock", which git can\'t hold in a branch name.')
  assert.equal(problem('-{{task_key}}'), 'The branch template starts with "-", which git can\'t hold in a branch name.')
})

test('saving the branch settings refuses a title exclusion pattern that is not a regular expression', () => {
  const problem = branchSettingsProblem({ ...branchSettings, titleExclusion: '[unclosed' })
  assert.ok(problem?.startsWith("The title exclusion pattern isn't a valid regular expression: "), problem ?? '')
  assert.equal(branchSettingsProblem({ titleExclusion: '[unclosed' }) !== null, true)
  assert.equal(branchSettingsProblem({ titleExclusion: '' }), null)
})

test('saving the branch settings refuses {{branch_type}} while the fallback is empty', () => {
  const message = 'The branch template uses {{branch_type}}: give the branch types a fallback.'
  assert.equal(branchSettingsProblem({ ...branchSettings, branchTypeFallback: '' }), message)
  assert.equal(branchSettingsProblem({ ...branchSettings, branchTypeFallback: '  ' }), message)
  assert.equal(branchSettingsProblem({ branchTemplate: 'x/{{ branch_type }}' }), message)
  assert.equal(branchSettingsProblem({ branchTemplate: 'feature/{{task_key}}' }), null)
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
