import { assert, test } from 'orca/testing'
import { chooseProvider, projectProvider, projectSettings, readSettings, withProjectChanges } from './protocol'
import { defaultTemplate, projectTemplates } from './template'

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
    [web.id]: { providers: { 'jira-twg': { jql: ['project = WEB'], site: '', profile: '' } }, agent: 'codex' }
  })
})

test('a JQL stored as one string is read as a list of one, and saving the project writes the list', () => {
  const stored = {
    version: 1,
    projects: {
      [web.id]: {
        provider: 'jira-orca',
        providers: { 'jira-orca': { jql: 'project = WEB', siteId: '' }, 'jira-twg': { jql: 'project = OLD', site: '', profile: '' } }
      }
    }
  }
  const read = readSettings(stored)
  assert.deepEqual(read.projects[web.id].providers, {
    'jira-orca': { jql: ['project = WEB'], siteId: '' },
    'jira-twg': { jql: ['project = OLD'], site: '', profile: '' }
  })
  // What the panel writes: the stored settings as read, with its changes on top.
  const saved = JSON.parse(JSON.stringify(withProjectChanges(read, web.id, { agent: 'codex' })))
  assert.deepEqual(saved.projects[web.id].providers['jira-orca'].jql, ['project = WEB'])
  assert.deepEqual(saved.projects[web.id].providers['jira-twg'].jql, ['project = OLD'])
})

test('a list of JQL queries is kept in order, blank ones included, and anything else is dropped', () => {
  const providers = (orcaJql: unknown, twgJql: unknown) =>
    readSettings({
      version: 1,
      projects: { [web.id]: { providers: { 'jira-orca': { jql: orcaJql, siteId: '' }, 'jira-twg': { jql: twgJql, site: '', profile: '' } } } }
    }).projects[web.id].providers
  assert.deepEqual(providers(['project = WEB', '', 'project = API'], ['  ']), {
    'jira-orca': { jql: ['project = WEB', '', 'project = API'], siteId: '' },
    'jira-twg': { jql: ['  '], site: '', profile: '' }
  })
  assert.deepEqual(providers(['project = WEB', 7], null), {})
  assert.deepEqual(providers({ 0: 'project = WEB' }, 42), {})
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
  settings = { ...settings, providers: { ...settings.providers, 'jira-orca': { jql: ['project = WEB'], siteId: 'site-2' } } }
  settings = chooseProvider(settings, 'github')
  settings = chooseProvider(settings, 'jira-orca')
  assert.equal(settings.provider, 'jira-orca')
  assert.deepEqual(settings.providers['jira-orca'], { jql: ['project = WEB'], siteId: 'site-2' })
})

test('a Jira provider starts with the default JQL, or copies the whole list from the other Jira provider the first time', () => {
  const first = chooseProvider({ providers: {} }, 'jira-orca')
  assert.deepEqual(first.providers['jira-orca'], {
    jql: ['assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'],
    siteId: ''
  })

  const edited = { ...first, providers: { 'jira-orca': { jql: ['project = WEB', '', 'project = API'], siteId: 'site-2' } } }
  const other = chooseProvider(edited, 'jira-twg')
  assert.deepEqual(other.providers['jira-twg'], { jql: ['project = WEB', '', 'project = API'], site: '', profile: '' })

  const back = chooseProvider({ ...other, providers: { ...other.providers, 'jira-orca': { jql: ['project = API'], siteId: '' } } }, 'jira-twg')
  assert.deepEqual(back.providers['jira-twg'], { jql: ['project = WEB', '', 'project = API'], site: '', profile: '' })
})

test("project changes keep the other projects, fields and providers' configurations", () => {
  const settings = {
    version: 1 as const,
    projects: {
      [web.id]: { provider: 'jira-twg' as const, providers: { 'jira-twg': { jql: ['project = OLD'], site: '', profile: 'work' } }, agent: 'codex' },
      [notes.id]: { providers: {}, templates: [{ id: 'default', name: 'Default', text: '' }] }
    }
  }
  const changed = withProjectChanges(settings, web.id, { provider: 'jira-orca', providers: { 'jira-orca': { jql: ['project = WEB'], siteId: '' } } })
  assert.deepEqual(changed, {
    version: 1,
    projects: {
      [web.id]: {
        provider: 'jira-orca',
        providers: { 'jira-twg': { jql: ['project = OLD'], site: '', profile: 'work' }, 'jira-orca': { jql: ['project = WEB'], siteId: '' } },
        agent: 'codex'
      },
      [notes.id]: { providers: {}, templates: [{ id: 'default', name: 'Default', text: '' }] }
    }
  })
  assert.deepEqual(withProjectChanges(readSettings(null), 'repo:new', { agent: 'none' }).projects['repo:new'], { providers: {}, agent: 'none' })
})

/** The templates and default template of a project read from these stored settings. */
function readTemplates(project: unknown) {
  const settings = projectSettings(readSettings({ version: 1, projects: { [web.id]: project } }), web.id)
  return { templates: projectTemplates(settings), defaultId: defaultTemplate(settings).id }
}

const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }

test('no stored templates gives one template "Default" with INITIAL_TEMPLATE_TEXT', () => {
  assert.deepEqual(readTemplates({ providers: {} }), { templates: [initial], defaultId: 'default' })
  assert.deepEqual(readTemplates({ providers: {}, templates: [] }), { templates: [initial], defaultId: 'default' })
  assert.deepEqual(projectTemplates(projectSettings(readSettings(null), web.id)), [initial])
})

test('a template stored before several templates, also an empty one, is kept as "Default"', () => {
  assert.deepEqual(readTemplates({ providers: {}, template: 'Fix {{task_key}}' }), {
    templates: [{ id: 'default', name: 'Default', text: 'Fix {{task_key}}' }],
    defaultId: 'default'
  })
  assert.deepEqual(readTemplates({ providers: {}, template: '' }).templates, [{ id: 'default', name: 'Default', text: '' }])
  // Reading drops the earlier field, so saving the project writes `templates` alone.
  const read = readSettings({ version: 1, projects: { [web.id]: { providers: {}, template: 'Fix' } } })
  assert.deepEqual(read.projects[web.id], { providers: {}, templates: [{ id: 'default', name: 'Default', text: 'Fix' }] })
})

test('stored templates are kept in order, with their default template', () => {
  const templates = [
    { id: 't-impl', name: 'Implement', text: '/acme-skills:tdd {{task_url}}' },
    { id: 't-triage', name: 'Triage', text: '' }
  ]
  assert.deepEqual(readTemplates({ providers: {}, templates, defaultTemplateId: 't-triage', template: 'ignored' }), { templates, defaultId: 't-triage' })
})

test('an unknown or missing defaultTemplateId gives the first template as the default', () => {
  const templates = [
    { id: 't-impl', name: 'Implement', text: 'a' },
    { id: 't-triage', name: 'Triage', text: 'b' }
  ]
  assert.equal(readTemplates({ providers: {}, templates, defaultTemplateId: 't-gone' }).defaultId, 't-impl')
  assert.equal(readTemplates({ providers: {}, templates, defaultTemplateId: 7 }).defaultId, 't-impl')
  assert.equal(readTemplates({ providers: {}, templates }).defaultId, 't-impl')
})

test('templates of an unexpected shape are dropped, and with none left the "Default" template is used', () => {
  const triage = { id: 't-triage', name: 'Triage', text: 'b' }
  const stored = [
    'garbage',
    null,
    { id: 't-x', name: 'No text' },
    { id: '', name: 'No id', text: 'a' },
    { id: 't-y', name: '   ', text: 'a' },
    { id: 't-z', name: 3, text: 'a' },
    triage,
    // A second template with an id or a name already read.
    { id: 't-triage', name: 'Again', text: 'c' },
    { id: 't-other', name: ' TRIAGE ', text: 'c' }
  ]
  assert.deepEqual(readTemplates({ providers: {}, templates: stored }), { templates: [triage], defaultId: 't-triage' })
  assert.deepEqual(readTemplates({ providers: {}, templates: [{ id: 't-x' }] }), { templates: [initial], defaultId: 'default' })
  assert.deepEqual(readTemplates({ providers: {}, templates: 'none' }), { templates: [initial], defaultId: 'default' })
})
