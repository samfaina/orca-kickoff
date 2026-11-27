import { assert, test } from 'orca/testing'
import type { ProjectRef, Task } from './protocol'
import {
  buildPrompt,
  defaultTemplate,
  INITIAL_TEMPLATE_TEXT,
  ownTemplates,
  projectTemplates,
  TEMPLATE_VARIABLE_DESCRIPTIONS,
  TEMPLATE_VARIABLES,
  templateNameProblem,
  withTemplateDeleted,
  withTemplateSaved
} from './template'

const web: ProjectRef = { id: 'github:acme/web', name: 'web', repo: 'acme/web' }

const task: Task = {
  tracker: 'jira',
  key: 'WEB-12',
  title: 'Add dark mode to settings',
  url: 'https://example.atlassian.net/browse/WEB-12',
  description: 'Users want a dark theme.',
  status: 'To Do',
  statusCategory: 'todo',
  assignees: [],
  labels: []
}

const branch = 'web-12-add-dark-mode-to'

test('every variable is filled, also with spaces inside the braces', () => {
  const template =
    '{{task_key}}|{{ task_title }}|{{task_url}}|{{  task_description}}|{{task_status }}|{{tracker}}|{{repo}}|{{branch}}|{{ jira_project }}|{{linear_team}}'
  assert.deepEqual(buildPrompt(template, task, web, branch, { jiraProjectKey: 'WEB', linearTeamKey: 'ENG' }), {
    ok: true,
    prompt:
      'WEB-12|Add dark mode to settings|https://example.atlassian.net/browse/WEB-12|Users want a dark theme.|To Do|jira|acme/web|web-12-add-dark-mode-to|WEB|ENG'
  })
})

test('a project without a Jira project key leaves jira_project empty, and one without a Linear team key linear_team', () => {
  assert.deepEqual(buildPrompt('[{{jira_project}}]', task, web, branch, { linearTeamKey: 'ENG' }), { ok: true, prompt: '[]' })
  assert.deepEqual(buildPrompt('[{{linear_team}}]', task, web, branch, { jiraProjectKey: 'WEB' }), { ok: true, prompt: '[]' })
})

test('jira_project and linear_team are template variables, last, with what they give', () => {
  assert.deepEqual(TEMPLATE_VARIABLES.slice(-2), ['jira_project', 'linear_team'])
  assert.equal(TEMPLATE_VARIABLE_DESCRIPTIONS.jira_project, "The project's Jira project key, such as WEB, set in Project settings. Empty when it has none.")
  assert.equal(TEMPLATE_VARIABLE_DESCRIPTIONS.linear_team, "The project's Linear team key, such as ENG, set in Project settings. Empty when it has none.")
})

test('an unknown variable is left as it is', () => {
  assert.deepEqual(buildPrompt('{{task_key}} {{ assignee }}', task, web, branch, {}), { ok: true, prompt: 'WEB-12 {{ assignee }}' })
})

test('a task without a status leaves task_status empty', () => {
  assert.deepEqual(buildPrompt('[{{task_status}}]', { ...task, status: null }, web, branch, {}), { ok: true, prompt: '[]' })
})

test('a project without a repo uses its name for {{repo}}', () => {
  const notes: ProjectRef = { id: 'repo:r2', name: 'notes', repo: null }
  assert.deepEqual(buildPrompt('{{repo}}', task, notes, branch, {}), { ok: true, prompt: 'notes' })
})

test('a long description is cut to 4000 characters with …', () => {
  const result = buildPrompt('{{task_description}}', { ...task, description: 'x'.repeat(5000) }, web, branch, {})
  assert.ok(result.ok)
  assert.equal(result.prompt.length, 4000)
  assert.equal(result.prompt, `${'x'.repeat(3999)}…`)
})

test('an empty template gives the task URL', () => {
  assert.deepEqual(buildPrompt('', task, web, branch, {}), { ok: true, prompt: 'https://example.atlassian.net/browse/WEB-12' })
})

test('INITIAL_TEMPLATE_TEXT is the key and URL of the task', () => {
  assert.equal(INITIAL_TEMPLATE_TEXT, 'Complete {{task_key}}: {{task_url}}')
  assert.deepEqual(buildPrompt(INITIAL_TEMPLATE_TEXT, task, web, branch, {}), {
    ok: true,
    prompt: 'Complete WEB-12: https://example.atlassian.net/browse/WEB-12'
  })
})

test('a project without stored templates, and with no global ones, has one, "Default", with INITIAL_TEMPLATE_TEXT, and it is the default', () => {
  const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}', global: false }
  assert.deepEqual(projectTemplates({}, []), [initial])
  assert.deepEqual(projectTemplates({ templates: [] }, []), [initial])
  assert.deepEqual(defaultTemplate({}, []), initial)
})

test('a prompt over 30 000 characters is refused with a clear message', () => {
  const result = buildPrompt('y'.repeat(30_001), task, web, branch, {})
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /30[ ,]?000/)
  assert.deepEqual(buildPrompt('y'.repeat(30_000), task, web, branch, {}), { ok: true, prompt: 'y'.repeat(30_000) })
})

const implement = { id: 't-impl', name: 'Implement', text: '/acme-skills:tdd {{task_url}}' }
const triage = { id: 't-triage', name: 'Triage', text: 'Triage {{task_key}}' }
const review = { id: 't-review', name: 'Review', text: 'Review {{branch}}' }
const plan = { id: 't-plan', name: 'Plan', text: 'Plan {{task_key}}' }

/** A template as a project lists it: its own, or global. */
const own = <T extends object>(template: T) => ({ ...template, global: false })
const global = <T extends object>(template: T) => ({ ...template, global: true })

test('the default template is the one defaultTemplateId names, or the first when it is unknown or missing', () => {
  const templates = [implement, triage]
  assert.deepEqual(defaultTemplate({ templates, defaultTemplateId: 't-triage' }, []), own(triage))
  assert.deepEqual(defaultTemplate({ templates, defaultTemplateId: 't-gone' }, []), own(implement))
  assert.deepEqual(defaultTemplate({ templates }, []), own(implement))
  assert.deepEqual(projectTemplates({ templates }, []), [own(implement), own(triage)])
})

test("a project lists its own templates first, then the global ones, each group in its order, and a global one can be the default template", () => {
  const settings = { templates: [implement, triage], defaultTemplateId: 't-review' }
  assert.deepEqual(projectTemplates(settings, [review, plan]), [own(implement), own(triage), global(review), global(plan)])
  assert.deepEqual(defaultTemplate(settings, [review, plan]), global(review))
  assert.deepEqual(defaultTemplate({ ...settings, defaultTemplateId: 't-gone' }, [review, plan]), own(implement))
})

test('"Default" is listed only while the project has no template of its own and there is no global one', () => {
  assert.deepEqual(projectTemplates({}, [review, plan]), [global(review), global(plan)])
  assert.deepEqual(projectTemplates({ templates: [] }, [review]), [global(review)])
  assert.deepEqual(defaultTemplate({}, [review, plan]), global(review))
  assert.deepEqual(ownTemplates({}, [review]), [])
  assert.deepEqual(ownTemplates({}, []), [{ id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }])
})

test('an own template and a global one with the same name are both listed; a global one whose id an own one has is not', () => {
  const ownReview = { id: 't-own-review', name: 'Review', text: '' }
  assert.deepEqual(projectTemplates({ templates: [ownReview] }, [review]), [own(ownReview), global(review)])
  assert.deepEqual(projectTemplates({ templates: [implement] }, [{ ...implement, name: 'Other' }, review]), [own(implement), global(review)])
})

test('a template name is valid when, trimmed, it is not empty and no other template of its group has it ignoring case', () => {
  const templates = [own(implement), own(triage), global(review)]
  assert.equal(templateNameProblem(templates, 'Plan', 't-new', false), null)
  assert.equal(templateNameProblem(templates, '  Plan  ', 't-new', false), null)
  assert.equal(templateNameProblem(templates, '', 't-new', false), 'Give the template a name.')
  assert.equal(templateNameProblem(templates, '   ', 't-new', true), 'Give the template a name.')
  assert.equal(templateNameProblem(templates, ' triage ', 't-new', false), 'Another template is already called "Triage".')
  assert.equal(templateNameProblem(templates, 'TRIAGE', 't-impl', false), 'Another template is already called "Triage".')
  // Renaming a template to its own name in another case.
  assert.equal(templateNameProblem(templates, 'IMPLEMENT', 't-impl', false), null)
  // An own template and a global one may share a name.
  assert.equal(templateNameProblem(templates, 'review', 't-new', false), null)
  assert.equal(templateNameProblem(templates, 'Triage', 't-new', true), null)
  assert.equal(templateNameProblem(templates, 'REVIEW', 't-new', true), 'Another global template is already called "Review".')
})

/** How a Save stores a template: own or global, and whether it becomes the default template. */
const asOwn = { isGlobal: false, isDefault: false, freshId: 't-fresh' }
const asGlobal = { ...asOwn, isGlobal: true }

/** The write of a Save that succeeds. */
function savedWrite(save: ReturnType<typeof withTemplateSaved>) {
  assert.ok(save.ok, save.ok ? '' : save.message)
  return save.write
}

test('saving a new template adds it at the end, trimmed, keeps the default template and the global ones', () => {
  const settings = { templates: [implement, triage], defaultTemplateId: 't-triage' }
  assert.deepEqual(withTemplateSaved(settings, [plan], { id: 't-new', name: '  Fix ', text: 'Fix {{branch}}' }, asOwn), {
    ok: true,
    id: 't-new',
    write: {
      project: { templates: [implement, triage, { id: 't-new', name: 'Fix', text: 'Fix {{branch}}' }], defaultTemplateId: 't-triage' },
      global: { templates: [plan] }
    }
  })
})

test('saving a template keeps its place, and saving the initial template stores it', () => {
  const settings = { templates: [implement, triage] }
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [], { ...implement, name: 'Build' }, asOwn)).project, {
    templates: [{ ...implement, name: 'Build' }, triage],
    defaultTemplateId: 't-impl'
  })
  assert.deepEqual(savedWrite(withTemplateSaved({}, [], { id: 'default', name: 'Default', text: 'Fix {{task_key}}' }, asOwn)).project, {
    templates: [{ id: 'default', name: 'Default', text: 'Fix {{task_key}}' }],
    defaultTemplateId: 'default'
  })
})

test('saving a global template keeps its place among the global ones, or adds it at the end, and keeps the project and its default template', () => {
  const settings = { templates: [implement], defaultTemplateId: 't-review' }
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review, plan], { ...review, name: ' Look ', text: 'x' }, asGlobal)), {
    project: { templates: [implement], defaultTemplateId: 't-review' },
    global: { templates: [{ ...review, name: 'Look', text: 'x' }, plan] }
  })
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review], { id: 't-new', name: 'Fix', text: '' }, asGlobal)).global, {
    templates: [review, { id: 't-new', name: 'Fix', text: '' }]
  })
})

test('the first global template, saved in a project that lists only "Default", stores "Default" in the project, which keeps it', () => {
  const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }
  assert.deepEqual(savedWrite(withTemplateSaved({}, [], review, asGlobal)), {
    project: { templates: [initial], defaultTemplateId: 'default' },
    global: { templates: [review] }
  })
})

test('saving a template as the default template makes it the default, own or global, new or stored', () => {
  const settings = { templates: [implement, triage], defaultTemplateId: 't-triage' }
  const asDefault = { ...asOwn, isDefault: true }
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review], implement, asDefault)).project, {
    templates: [implement, triage],
    defaultTemplateId: 't-impl'
  })
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review], review, { ...asDefault, isGlobal: true })), {
    project: { templates: [implement, triage], defaultTemplateId: 't-review' },
    global: { templates: [review] }
  })
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review], { id: 't-new', name: 'Fix', text: '' }, asDefault)).project, {
    templates: [implement, triage, { id: 't-new', name: 'Fix', text: '' }],
    defaultTemplateId: 't-new'
  })
  // Not the default: the default template stays, also when it is the one saved.
  assert.equal(savedWrite(withTemplateSaved(settings, [review], triage, asOwn)).project.defaultTemplateId, 't-triage')
})

test('deleting the default template makes the first remaining one the default, and the only template stays', () => {
  const settings = { templates: [implement, triage, plan], defaultTemplateId: 't-impl' }
  assert.deepEqual(withTemplateDeleted(settings, [], 't-impl')?.project, { templates: [triage, plan], defaultTemplateId: 't-triage' })
  assert.deepEqual(withTemplateDeleted({ ...settings, defaultTemplateId: 't-plan' }, [], 't-triage')?.project, {
    templates: [implement, plan],
    defaultTemplateId: 't-plan'
  })
  assert.equal(withTemplateDeleted({ templates: [implement] }, [], 't-impl'), null)
  assert.equal(withTemplateDeleted({}, [], 'default'), null)
})

test("a project's last own template can be deleted while it lists a global one, which becomes the default", () => {
  assert.deepEqual(withTemplateDeleted({ templates: [implement], defaultTemplateId: 't-impl' }, [review], 't-impl'), {
    project: { templates: [], defaultTemplateId: 't-review' },
    global: { templates: [review] }
  })
})

test('deleting a global template removes it from the global ones, while the project still lists another', () => {
  const settings = { templates: [implement], defaultTemplateId: 't-review' }
  assert.deepEqual(withTemplateDeleted(settings, [review, plan], 't-review'), {
    project: { templates: [implement], defaultTemplateId: 't-impl' },
    global: { templates: [plan] }
  })
  assert.deepEqual(withTemplateDeleted({}, [review, plan], 't-plan'), {
    project: { templates: [], defaultTemplateId: 't-review' },
    global: { templates: [review] }
  })
  // The project's only template.
  assert.equal(withTemplateDeleted({}, [review], 't-review'), null)
  assert.equal(withTemplateDeleted({ templates: [] }, [review], 't-review'), null)
})

test('saving an own template as global moves it, with its id, name and text as saved, to the end of the global ones, and the default template keeps pointing at it', () => {
  const settings = { templates: [implement, triage] }
  const edited = { ...implement, name: ' Build ', text: 'Build {{task_key}}' }
  assert.deepEqual(withTemplateSaved(settings, [review], edited, asGlobal), {
    ok: true,
    id: 't-impl',
    write: {
      project: { templates: [triage], defaultTemplateId: 't-impl' },
      global: { templates: [review, { ...implement, name: 'Build', text: 'Build {{task_key}}' }] }
    }
  })
  assert.deepEqual(withTemplateSaved({ ...settings, defaultTemplateId: 't-triage' }, [], implement, asGlobal), {
    ok: true,
    id: 't-impl',
    write: { project: { templates: [triage], defaultTemplateId: 't-triage' }, global: { templates: [implement] } }
  })
})

test('a template moved and made the default template in the same Save is the default after it', () => {
  const settings = { templates: [implement, triage], defaultTemplateId: 't-triage' }
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review], implement, { ...asGlobal, isDefault: true })), {
    project: { templates: [triage], defaultTemplateId: 't-impl' },
    global: { templates: [review, implement] }
  })
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [review], review, { ...asOwn, isDefault: true })), {
    project: { templates: [implement, triage, review], defaultTemplateId: 't-review' },
    global: { templates: [] }
  })
})

test('the initial template made global gets a new id, since other projects have an own template with its id, and the default template follows it', () => {
  const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }
  assert.deepEqual(withTemplateSaved({}, [], initial, asGlobal), {
    ok: true,
    id: 't-fresh',
    write: { project: { templates: [], defaultTemplateId: 't-fresh' }, global: { templates: [{ ...initial, id: 't-fresh' }] } }
  })
  const settings = { templates: [{ ...initial, text: 'x' }, triage], defaultTemplateId: 't-triage' }
  assert.deepEqual(withTemplateSaved(settings, [], { ...initial, text: 'x' }, asGlobal), {
    ok: true,
    id: 't-fresh',
    write: { project: { templates: [triage], defaultTemplateId: 't-triage' }, global: { templates: [{ ...initial, id: 't-fresh', text: 'x' }] } }
  })
  assert.deepEqual(savedWrite(withTemplateSaved(settings, [], { ...initial, text: 'x' }, { ...asGlobal, isDefault: true })).project, {
    templates: [triage],
    defaultTemplateId: 't-fresh'
  })
})

test('saving a global template as own moves it to the end of the active project, keeping its id and the default template', () => {
  assert.deepEqual(withTemplateSaved({ templates: [implement], defaultTemplateId: 't-review' }, [review, plan], review, asOwn), {
    ok: true,
    id: 't-review',
    write: { project: { templates: [implement, review], defaultTemplateId: 't-review' }, global: { templates: [plan] } }
  })
  assert.deepEqual(withTemplateSaved({}, [review], { ...review, text: '' }, asOwn), {
    ok: true,
    id: 't-review',
    write: { project: { templates: [{ ...review, text: '' }], defaultTemplateId: 't-review' }, global: { templates: [] } }
  })
})

test('a move whose name, as saved, the destination group already has, ignoring case, is refused with a message', () => {
  const settings = { templates: [implement, { id: 't-own-review', name: 'review', text: '' }] }
  assert.deepEqual(withTemplateSaved(settings, [{ ...review, name: 'IMPLEMENT' }], implement, asGlobal), {
    ok: false,
    message: 'A global template is already called "IMPLEMENT". Rename one of them first.'
  })
  assert.deepEqual(withTemplateSaved(settings, [review], review, asOwn), {
    ok: false,
    message: 'This project already has a template called "review". Rename one of them first.'
  })
  // The name it is saved with, not the one stored.
  assert.deepEqual(withTemplateSaved(settings, [plan], { ...implement, name: ' plan ' }, asGlobal), {
    ok: false,
    message: 'A global template is already called "Plan". Rename one of them first.'
  })
  assert.equal(withTemplateSaved(settings, [{ ...review, name: 'IMPLEMENT' }], { ...implement, name: 'Build' }, asGlobal).ok, true)
})
