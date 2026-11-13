import { assert, test } from 'orca/testing'
import { chooseProvider, projectProvider, projectSettings, readSettings, withProjectChanges } from './protocol'

const web = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }
const notes = { id: 'repo:r1', name: 'notes', repo: null }

test('missing or unexpected settings give the defaults', () => {
  const defaults = { version: 1, projects: {} }
  assert.deepEqual(readSettings(null), defaults)
  assert.deepEqual(readSettings('corrupt'), defaults)
  assert.deepEqual(readSettings([]), defaults)
  assert.deepEqual(readSettings({ version: 2, projects: { [web.id]: { provider: 'github', providers: {} } } }), defaults)
  assert.deepEqual(readSettings({ version: 1, projects: 'none' }), defaults)
})

test('unexpected fields of a project are dropped and the rest is kept', () => {
  const settings = readSettings({
    version: 1,
    projects: {
      [web.id]: {
        provider: 'linear',
        providers: { 'jira-orca': { jql: 'project = WEB', siteId: 7 }, 'jira-twg': { jql: 'project = WEB', site: '', profile: '' } },
        template: 42,
        agent: 'codex'
      },
      [notes.id]: 'garbage'
    }
  })
  assert.deepEqual(settings.projects, {
    [web.id]: { providers: { 'jira-twg': { jql: 'project = WEB', site: '', profile: '' } }, agent: 'codex' }
  })
})

test('a project without settings uses GitHub when it has a repository, and no provider otherwise', () => {
  const settings = readSettings(null)
  assert.equal(projectProvider(projectSettings(settings, web.id), web), 'github')
  assert.equal(projectProvider(projectSettings(settings, notes.id), notes), null)
})

test('a chosen provider wins over the default', () => {
  const chosen = chooseProvider(projectSettings(readSettings(null), web.id), 'jira-twg')
  assert.equal(projectProvider(chosen, web), 'jira-twg')
})

test("each provider's configuration survives switching away and back", () => {
  let settings = chooseProvider({ providers: {} }, 'jira-orca')
  settings = { ...settings, providers: { ...settings.providers, 'jira-orca': { jql: 'project = WEB', siteId: 'site-2' } } }
  settings = chooseProvider(settings, 'github')
  settings = chooseProvider(settings, 'jira-orca')
  assert.equal(settings.provider, 'jira-orca')
  assert.deepEqual(settings.providers['jira-orca'], { jql: 'project = WEB', siteId: 'site-2' })
})

test('a Jira provider starts with the default JQL, or copies it from the other Jira provider the first time', () => {
  const first = chooseProvider({ providers: {} }, 'jira-orca')
  assert.deepEqual(first.providers['jira-orca'], {
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    siteId: ''
  })

  const edited = { ...first, providers: { 'jira-orca': { jql: 'project = WEB', siteId: 'site-2' } } }
  const other = chooseProvider(edited, 'jira-twg')
  assert.deepEqual(other.providers['jira-twg'], { jql: 'project = WEB', site: '', profile: '' })

  const back = chooseProvider({ ...other, providers: { ...other.providers, 'jira-orca': { jql: 'project = API', siteId: '' } } }, 'jira-twg')
  assert.deepEqual(back.providers['jira-twg'], { jql: 'project = WEB', site: '', profile: '' })
})

test("project changes keep the other projects, fields and providers' configurations", () => {
  const settings = {
    version: 1 as const,
    projects: {
      [web.id]: { provider: 'jira-twg' as const, providers: { 'jira-twg': { jql: 'project = OLD', site: '', profile: 'work' } }, agent: 'codex' },
      [notes.id]: { providers: {}, template: '' }
    }
  }
  const changed = withProjectChanges(settings, web.id, { provider: 'jira-orca', providers: { 'jira-orca': { jql: 'project = WEB', siteId: '' } } })
  assert.deepEqual(changed, {
    version: 1,
    projects: {
      [web.id]: {
        provider: 'jira-orca',
        providers: { 'jira-twg': { jql: 'project = OLD', site: '', profile: 'work' }, 'jira-orca': { jql: 'project = WEB', siteId: '' } },
        agent: 'codex'
      },
      [notes.id]: { providers: {}, template: '' }
    }
  })
  assert.deepEqual(withProjectChanges(readSettings(null), 'repo:new', { agent: 'none' }).projects['repo:new'], { providers: {}, agent: 'none' })
})
