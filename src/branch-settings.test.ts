import { assert, test } from 'orca/testing'
import { projectBranchSettings, sameBranchSettings, usesGlobalBranchSettings, withBranchSwitched } from './branch-settings'
import { filledBranch, worktreeName } from './naming'
import type { BranchSettings, ProjectSettings, Task } from './protocol'

const team: BranchSettings = { branchTemplate: '{{branch_type}}/{{task_key}}', branchTypes: [{ issueType: 'Bug', branchType: 'bugfix' }], branchTypeFallback: 'feature' }
const own: BranchSettings = { branchTemplate: 'mine/{{task_key}}', titleExclusion: '' }
const bare: ProjectSettings = { providers: {}, agent: 'codex' }
const task: Pick<Task, 'tracker' | 'key' | 'title' | 'issueType'> = { tracker: 'jira', key: 'WEB-12', title: '[FE] Add dark mode', issueType: 'Bug' }

test('a project with none of its own branch settings uses the global ones, and one with any of its own uses its own', () => {
  assert.equal(usesGlobalBranchSettings(bare, team), true)
  assert.deepEqual(projectBranchSettings(bare, team), team)
  // A project that touched the Branch section stores at least an empty template.
  const touched = { ...bare, branchTemplate: '' }
  assert.equal(usesGlobalBranchSettings(touched, team), false)
  assert.deepEqual(projectBranchSettings(touched, team), { branchTemplate: '' })
  assert.deepEqual(projectBranchSettings({ ...bare, ...own }, team), own)
})

test('with no global branch settings stored, every project uses its own, and one with none names branches as before', () => {
  assert.equal(usesGlobalBranchSettings(bare, undefined), false)
  assert.deepEqual(projectBranchSettings(bare, undefined), {})
  assert.equal(filledBranch(projectBranchSettings(bare, undefined), task), null)
  assert.equal(worktreeName(task, projectBranchSettings(bare, undefined)), 'web-12-add-dark-mode')
  // Even marked global, a project uses its own while there are none.
  assert.equal(usesGlobalBranchSettings({ ...bare, branchSettingsUsed: 'global' }, undefined), false)
})

test("a project's mark says which branch settings it uses, whatever it stores", () => {
  assert.equal(usesGlobalBranchSettings({ ...bare, ...own, branchSettingsUsed: 'global' }, team), true)
  assert.deepEqual(projectBranchSettings({ ...bare, ...own, branchSettingsUsed: 'global' }, team), team)
  assert.equal(usesGlobalBranchSettings({ ...bare, branchSettingsUsed: 'own' }, team), false)
  assert.deepEqual(projectBranchSettings({ ...bare, branchSettingsUsed: 'own' }, team), {})
})

test('branch settings are the same when they name every branch alike, unset fields counting as they start', () => {
  assert.equal(sameBranchSettings({}, { branchTemplate: '', branchTypes: [], branchTypeFallback: '', titleExclusion: '\\[[^\\]]*\\]' }), true)
  assert.equal(sameBranchSettings(team, { ...team, branchTypes: [{ issueType: 'Bug', branchType: 'bugfix' }] }), true)
  assert.equal(sameBranchSettings(team, { ...team, branchTypes: [{ issueType: 'bug', branchType: 'bugfix' }] }), false)
  assert.equal(sameBranchSettings(team, { ...team, branchTypeFallback: 'chore' }), false)
  assert.equal(sameBranchSettings({}, { titleExclusion: '' }), false)
})

test('turning Global on with none stored makes the project\'s own the global ones, and the project then uses them', () => {
  const project = { ...bare, ...own }
  assert.deepEqual(withBranchSwitched(project, undefined, true), {
    project: { branchTemplate: undefined, branchTypes: undefined, branchTypeFallback: undefined, titleExclusion: undefined, branchSettingsUsed: 'global' },
    global: { branch: own }
  })
  // A project with none of its own makes the initial ones global.
  assert.deepEqual(withBranchSwitched(bare, undefined, true)?.global, { branch: {} })
})

test('turning Global on with global ones stored drops the project\'s own, and leaves the global ones as they are', () => {
  assert.deepEqual(withBranchSwitched({ ...bare, ...own }, team, true), {
    project: { branchTemplate: undefined, branchTypes: undefined, branchTypeFallback: undefined, titleExclusion: undefined, branchSettingsUsed: 'global' }
  })
})

test('turning Global off gives the project a copy of the global ones as its own, which names every branch alike', () => {
  const write = withBranchSwitched(bare, team, false)
  assert.deepEqual(write, {
    project: { branchTemplate: team.branchTemplate, branchTypes: team.branchTypes, branchTypeFallback: 'feature', titleExclusion: undefined, branchSettingsUsed: 'own' }
  })
  const after = { ...bare, ...write?.project }
  assert.equal(usesGlobalBranchSettings(after, team), false)
  assert.equal(sameBranchSettings(projectBranchSettings(after, team), team), true)
  // The copy is the project's own: a change to the global ones doesn't reach it.
  assert.deepEqual(projectBranchSettings(after, { branchTemplate: 'other' }), projectBranchSettings(after, team))
})

test('turning Global to what the project already uses writes nothing', () => {
  assert.equal(withBranchSwitched(bare, team, true), null)
  assert.equal(withBranchSwitched({ ...bare, ...own }, team, false), null)
  assert.equal(withBranchSwitched(bare, undefined, false), null)
})
