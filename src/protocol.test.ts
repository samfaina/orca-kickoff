import { assert, test } from 'orca/testing'
import {
  chooseProvider,
  filterAsRun,
  globalFilters,
  globalTemplates,
  projectProvider,
  projectSettings,
  queryCount,
  readSettings,
  withGlobalChanges,
  withProjectChanges
} from './protocol'
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
        providers: { 'jira-orca': { siteId: 7 }, 'jira-twg': { site: '', profile: '' } },
        shownFilterId: { jira: 3 },
        template: 42,
        agent: 'codex'
      },
      [notes.id]: 'garbage'
    }
  })
  assert.deepEqual(settings.projects, {
    [web.id]: { providers: { 'jira-twg': { site: '', profile: '' } }, agent: 'codex' }
  })
})

/** The project read from `project` as stored. */
const readProject = (project: unknown) => projectSettings(readSettings({ version: 1, projects: { [web.id]: project } }), web.id)

/** The one filter that settings stored before filters read as. */
const tasksFilter = (queries: string[]) => ({ jira: [{ id: 'tasks', name: 'Tasks', queries }] })

test('settings stored before filters read as one filter "Tasks" with the JQL queries of the Jira provider chosen, and saving writes it without the JQL', () => {
  const stored = {
    provider: 'jira-twg',
    providers: { 'jira-orca': { jql: 'project = OLD', siteId: 'site-2' }, 'jira-twg': { jql: ['project = WEB', '', 'labels = ui'], site: '', profile: 'work' } }
  }
  const read = readProject(stored)
  assert.deepEqual(read, {
    provider: 'jira-twg',
    providers: { 'jira-orca': { siteId: 'site-2' }, 'jira-twg': { site: '', profile: 'work' } },
    filters: tasksFilter(['project = WEB', '', 'labels = ui'])
  })
  // What the panel writes: the stored settings as read, with its changes on top.
  const saved = JSON.parse(JSON.stringify(withProjectChanges({ version: 1, projects: { [web.id]: read } }, web.id, { agent: 'codex' })))
  assert.deepEqual(saved.projects[web.id], { ...read, agent: 'codex' })
})

test("a GitHub project's stored filters and the one shown are read apart from Jira's, and those of an unexpected shape are dropped", () => {
  const triage = { id: 'f-triage', name: 'Triage', queries: ['is:open label:needs-triage', ''] }
  const read = readProject({
    provider: 'github',
    providers: { github: {} },
    filters: { github: [triage, { id: 'f-x', name: 'No queries' }, { id: 'f-y', name: ' triage ', queries: [] }], jira: [{ id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }] },
    shownFilterId: { github: 'f-triage', jira: 'tasks' }
  })
  assert.deepEqual(read, {
    provider: 'github',
    providers: { github: {} },
    filters: { github: [triage], jira: [{ id: 'tasks', name: 'Tasks', queries: ['project = WEB'] }] },
    shownFilterId: { github: 'f-triage', jira: 'tasks' }
  })
  assert.deepEqual(readProject({ providers: {}, filters: { github: 'none' }, shownFilterId: { github: 3 } }), { providers: {} })
})

test("without a Jira provider chosen, settings stored before filters take Jira (Orca connection)'s JQL, else Jira (twg)'s, one string as a list of one", () => {
  const both = { 'jira-orca': { jql: 'project = WEB', siteId: '' }, 'jira-twg': { jql: ['project = OLD'], site: '', profile: '' } }
  assert.deepEqual(readProject({ provider: 'github', providers: both }).filters, tasksFilter(['project = WEB']))
  assert.deepEqual(readProject({ providers: both }).filters, tasksFilter(['project = WEB']))
  assert.deepEqual(readProject({ provider: 'jira-orca', providers: { 'jira-twg': both['jira-twg'] } }).filters, tasksFilter(['project = OLD']))
  // JQL of an unexpected shape is skipped.
  assert.deepEqual(readProject({ providers: { ...both, 'jira-orca': { jql: ['project = WEB', 7], siteId: '' } } }).filters, tasksFilter(['project = OLD']))
  assert.equal(readProject({ providers: { 'jira-orca': { jql: { 0: 'project = WEB' }, siteId: '' } } }).filters, undefined)
  assert.equal(readProject({ provider: 'github', providers: {} }).filters, undefined)
})

const board = { id: 'f-board', name: 'Board', queries: ['project = WEB ORDER BY rank', ''] }
const mine = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }

test('stored filters are kept in order, blank queries included, with the one shown last, and the JQL stored before filters is ignored', () => {
  const read = readProject({
    provider: 'jira-orca',
    providers: { 'jira-orca': { jql: ['project = OLD'], siteId: '' } },
    filters: { jira: [board, mine] },
    shownFilterId: { jira: 'f-mine' }
  })
  assert.deepEqual(read, {
    provider: 'jira-orca',
    providers: { 'jira-orca': { siteId: '' } },
    filters: { jira: [board, mine] },
    shownFilterId: { jira: 'f-mine' }
  })
})

test('filters of an unexpected shape are dropped, names trimmed, and with none left the JQL stored before filters is read', () => {
  const stored = [
    'garbage',
    null,
    { id: 'f-x', name: 'No queries' },
    { id: 'f-y', name: 'Bad queries', queries: ['project = WEB', 7] },
    { id: '', name: 'No id', queries: [] },
    { id: 'f-z', name: '  ', queries: [] },
    { ...board, name: ' Board ' },
    // A second filter with an id or a name already read.
    { id: 'f-board', name: 'Again', queries: [] },
    { id: 'f-other', name: 'BOARD', queries: [] }
  ]
  assert.deepEqual(readProject({ providers: {}, filters: { jira: stored } }).filters, { jira: [board] })
  const old = { 'jira-orca': { jql: ['project = OLD'], siteId: '' } }
  assert.deepEqual(readProject({ providers: old, filters: { jira: [{ id: 'f-x' }] } }).filters, tasksFilter(['project = OLD']))
  assert.deepEqual(readProject({ providers: old, filters: 'none' }).filters, tasksFilter(['project = OLD']))
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
  settings = { ...settings, providers: { ...settings.providers, 'jira-orca': { siteId: 'site-2' } } }
  settings = chooseProvider(settings, 'github')
  settings = chooseProvider(settings, 'jira-orca')
  assert.equal(settings.provider, 'jira-orca')
  assert.deepEqual(settings.providers['jira-orca'], { siteId: 'site-2' })
})

test("a Jira provider starts with its tool's defaults, and switching between the two Jira providers keeps every filter", () => {
  const first = chooseProvider({ providers: {} }, 'jira-orca')
  assert.deepEqual(first.providers, { 'jira-orca': { siteId: '' } })
  const filters = { filters: { jira: [board, mine] }, shownFilterId: { jira: 'f-mine' } }
  const other = chooseProvider({ ...first, ...filters }, 'jira-twg')
  assert.deepEqual(other, { provider: 'jira-twg', providers: { 'jira-orca': { siteId: '' }, 'jira-twg': { site: '', profile: '' } }, ...filters })
  assert.deepEqual(chooseProvider(other, 'jira-orca'), { ...other, provider: 'jira-orca' })
})

test('the Jira project key is read trimmed and upper-cased; a blank one, or one of another shape, is no key', () => {
  assert.equal(readProject({ providers: {}, jiraProjectKey: ' web ' }).jiraProjectKey, 'WEB')
  assert.deepEqual(readProject({ providers: {}, jiraProjectKey: '   ' }), { providers: {} })
  assert.deepEqual(readProject({ providers: {}, jiraProjectKey: 12 }), { providers: {} })
  assert.deepEqual(readProject({ providers: {} }), { providers: {} })
})

test('on Jira, each {{jira_project}} of a filter\'s queries runs as the Jira project key, also with spaces inside the braces', () => {
  const sprint = { id: 'f-sprint', name: 'Sprint', queries: ['project = {{jira_project}} ORDER BY Rank', '', 'project in ({{ jira_project }}, API) AND key != {{jira_project}}-1'] }
  assert.deepEqual(filterAsRun(sprint, 'jira', 'WEB'), {
    ok: true,
    filter: { ...sprint, queries: ['project = WEB ORDER BY Rank', '', 'project in (WEB, API) AND key != WEB-1'] }
  })
  // Other variables are not JQL variables, and stay as written.
  const other = { ...sprint, queries: ['project = WEB AND summary ~ "{{task_key}}"'] }
  assert.deepEqual(filterAsRun(other, 'jira', 'WEB'), { ok: true, filter: other })
})

test('a filter naming {{jira_project}} in a project without a Jira project key runs none of its queries; one without the variable runs', () => {
  const sprint = { id: 'f-sprint', name: 'Sprint', queries: ['assignee = currentUser()', 'project = {{jira_project}}'] }
  const message = 'This filter uses {{jira_project}}. Set the Jira project key in Project settings.'
  assert.deepEqual(filterAsRun(sprint, 'jira', ''), { ok: false, message })
  assert.deepEqual(filterAsRun(mine, 'jira', ''), { ok: true, filter: mine })
})

test('on GitHub, a search runs as written: {{jira_project}} has no meaning there', () => {
  const triage = { id: 'f-triage', name: 'Triage', queries: ['is:open label:{{jira_project}}'] }
  assert.deepEqual(filterAsRun(triage, 'github', 'WEB'), { ok: true, filter: triage })
  assert.deepEqual(filterAsRun(triage, 'github', ''), { ok: true, filter: triage })
})

test("a list runs the non-blank queries of its filter, on Jira and on GitHub", () => {
  const triage = { id: 'f-triage', name: 'Triage', queries: ['is:open label:needs-triage', '', 'is:open assignee:@me'] }
  const settings = { providers: {}, filters: { jira: [mine, { ...board, queries: ['project = WEB', '  ', 'labels = ui'] }], github: [triage] } }
  assert.equal(queryCount(settings, 'jira-twg', [], 'f-board'), 2)
  assert.equal(queryCount(settings, 'jira-orca', []), 1)
  assert.equal(queryCount({ providers: {} }, 'jira-orca', []), 1)
  assert.equal(queryCount({ providers: {}, filters: { jira: [{ ...mine, queries: [''] }] } }, 'jira-orca', []), 0)
  assert.equal(queryCount(settings, 'github', []), 2)
  assert.equal(queryCount({ providers: {} }, 'github', []), 1)
})

test("project changes keep the other projects, fields and providers' configurations", () => {
  const settings = {
    version: 1 as const,
    projects: {
      [web.id]: { provider: 'jira-twg' as const, providers: { 'jira-twg': { site: '', profile: 'work' } }, agent: 'codex' },
      [notes.id]: { providers: {}, templates: [{ id: 'default', name: 'Default', text: '' }] }
    }
  }
  const changed = withProjectChanges(settings, web.id, { provider: 'jira-orca', providers: { 'jira-orca': { siteId: '' } } })
  assert.deepEqual(changed, {
    version: 1,
    projects: {
      [web.id]: {
        provider: 'jira-orca',
        providers: { 'jira-twg': { site: '', profile: 'work' }, 'jira-orca': { siteId: '' } },
        agent: 'codex'
      },
      [notes.id]: { providers: {}, templates: [{ id: 'default', name: 'Default', text: '' }] }
    }
  })
  assert.deepEqual(withProjectChanges(readSettings(null), 'repo:new', { agent: 'none' }).projects['repo:new'], { providers: {}, agent: 'none' })
})

/** The templates and default template of a project read from these stored settings, with no global
 *  templates. */
function readTemplates(project: unknown) {
  const settings = projectSettings(readSettings({ version: 1, projects: { [web.id]: project } }), web.id)
  const templates = projectTemplates(settings, []).map(({ global, ...template }) => (assert.equal(global, false), template))
  return { templates, defaultId: defaultTemplate(settings, []).id }
}

const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }

test('no stored templates gives one template "Default" with INITIAL_TEMPLATE_TEXT', () => {
  assert.deepEqual(readTemplates({ providers: {} }), { templates: [initial], defaultId: 'default' })
  assert.deepEqual(readTemplates({ providers: {}, templates: [] }), { templates: [initial], defaultId: 'default' })
  assert.deepEqual(projectTemplates(projectSettings(readSettings(null), web.id), []), [{ ...initial, global: false }])
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

test('settings stored before global templates read the same, with no global templates', () => {
  const stored = {
    version: 1,
    projects: { [web.id]: { providers: {}, templates: [{ id: 't-impl', name: 'Implement', text: 'a' }], defaultTemplateId: 't-impl' } }
  }
  const settings = readSettings(stored)
  assert.deepEqual(settings, stored)
  assert.deepEqual(globalTemplates(settings), [])
})

test('global templates are read apart from every project, in order, and those of an unexpected shape are dropped', () => {
  const review = { id: 't-review', name: 'Review', text: 'Review {{branch}}' }
  const settings = readSettings({
    version: 1,
    projects: { [web.id]: { providers: {} } },
    global: {
      templates: [
        review,
        { id: 't-x', name: 'No text' },
        { id: 't-review', name: 'Again', text: 'c' },
        { id: 't-other', name: ' review ', text: 'c' },
        { id: 't-plan', name: '  Plan ', text: '' }
      ],
      unknown: true
    }
  })
  assert.deepEqual(settings.global, { templates: [review, { id: 't-plan', name: 'Plan', text: '' }] })
  assert.deepEqual(globalTemplates(settings), [review, { id: 't-plan', name: 'Plan', text: '' }])
  assert.deepEqual(settings.projects[web.id], { providers: {} })
  assert.deepEqual(readSettings({ version: 1, projects: {}, global: 'corrupt' }), { version: 1, projects: {} })
  assert.deepEqual(readSettings({ version: 1, projects: {}, global: { templates: [] } }), { version: 1, projects: {} })
})

test('settings stored before global filters read the same, with no global filter on either tracker', () => {
  const stored = { version: 1, projects: { [web.id]: { providers: {}, filters: { jira: [board] } } }, global: { templates: [{ id: 't-plan', name: 'Plan', text: '' }] } }
  const settings = readSettings(stored)
  assert.deepEqual(settings, stored)
  assert.deepEqual(globalFilters(settings, 'jira'), [])
  assert.deepEqual(globalFilters(settings, 'github'), [])
})

test('global filters are read by tracker, apart from every project, in order, and those of an unexpected shape are dropped', () => {
  const sprint = { id: 'g-sprint', name: 'Sprint', queries: ['project = {{jira_project}}', ''] }
  const triage = { id: 'g-triage', name: 'Triage', queries: ['is:open label:needs-triage'] }
  const settings = readSettings({
    version: 1,
    projects: { [web.id]: { providers: {} } },
    global: {
      filters: {
        jira: [sprint, { id: 'g-x', name: 'No queries' }, { id: 'g-sprint', name: 'Again', queries: [] }, { id: 'g-other', name: ' SPRINT ', queries: [] }, { ...mine, name: ' Mine ' }],
        github: [triage],
        linear: [mine]
      }
    }
  })
  assert.deepEqual(settings.global, { filters: { jira: [sprint, mine], github: [triage] } })
  assert.deepEqual(globalFilters(settings, 'jira'), [sprint, mine])
  assert.deepEqual(globalFilters(settings, 'github'), [triage])
  assert.deepEqual(readSettings({ version: 1, projects: {}, global: { filters: { jira: 'none', github: [] } } }), { version: 1, projects: {} })
  const both = readSettings({ version: 1, projects: {}, global: { templates: [{ id: 't-plan', name: 'Plan', text: '' }], filters: { github: [triage] } } })
  assert.deepEqual(both.global, { templates: [{ id: 't-plan', name: 'Plan', text: '' }], filters: { github: [triage] } })
})

test('a list runs the non-blank queries of the filter it names, own or global, on its tracker', () => {
  const sprint = { id: 'g-sprint', name: 'Sprint', queries: ['project = {{jira_project}}', 'labels = ui', ''] }
  const settings = { providers: {}, filters: { jira: [mine] }, shownFilterId: { jira: 'g-sprint' } }
  assert.equal(queryCount(settings, 'jira-orca', [sprint], 'g-sprint'), 2)
  assert.equal(queryCount(settings, 'jira-orca', [sprint]), 2)
  assert.equal(queryCount(settings, 'jira-orca', [], 'g-sprint'), 1)
})

test('global changes keep every project, and project changes keep the global templates', () => {
  const review = { id: 't-review', name: 'Review', text: '' }
  const settings = { version: 1 as const, projects: { [web.id]: { providers: {}, agent: 'codex' } }, global: { templates: [review] } }
  assert.deepEqual(withGlobalChanges(settings, { templates: [] }), { version: 1, projects: { [web.id]: { providers: {}, agent: 'codex' } }, global: { templates: [] } })
  assert.deepEqual(withProjectChanges(settings, web.id, { agent: 'none' }).global, { templates: [review] })
  assert.deepEqual(withGlobalChanges(readSettings(null), { templates: [review] }), { version: 1, projects: {}, global: { templates: [review] } })
})
