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
  withTemplateMoved,
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
    '{{task_key}}|{{ task_title }}|{{task_url}}|{{  task_description}}|{{task_status }}|{{tracker}}|{{repo}}|{{branch}}|{{ jira_project }}'
  assert.deepEqual(buildPrompt(template, task, web, branch, 'WEB'), {
    ok: true,
    prompt:
      'WEB-12|Add dark mode to settings|https://example.atlassian.net/browse/WEB-12|Users want a dark theme.|To Do|jira|acme/web|web-12-add-dark-mode-to|WEB'
  })
})

test('a project without a Jira project key leaves jira_project empty', () => {
  assert.deepEqual(buildPrompt('[{{jira_project}}]', task, web, branch, ''), { ok: true, prompt: '[]' })
})

test('jira_project is a template variable, last, with what it gives', () => {
  assert.equal(TEMPLATE_VARIABLES.at(-1), 'jira_project')
  assert.equal(TEMPLATE_VARIABLE_DESCRIPTIONS.jira_project, "The project's Jira project key, such as WEB, set in Project settings. Empty when it has none.")
})

test('an unknown variable is left as it is', () => {
  assert.deepEqual(buildPrompt('{{task_key}} {{ assignee }}', task, web, branch, ''), { ok: true, prompt: 'WEB-12 {{ assignee }}' })
})

test('a task without a status leaves task_status empty', () => {
  assert.deepEqual(buildPrompt('[{{task_status}}]', { ...task, status: null }, web, branch, ''), { ok: true, prompt: '[]' })
})

test('a project without a repo uses its name for {{repo}}', () => {
  const notes: ProjectRef = { id: 'repo:r2', name: 'notes', repo: null }
  assert.deepEqual(buildPrompt('{{repo}}', task, notes, branch, ''), { ok: true, prompt: 'notes' })
})

test('a long description is cut to 4000 characters with …', () => {
  const result = buildPrompt('{{task_description}}', { ...task, description: 'x'.repeat(5000) }, web, branch, '')
  assert.ok(result.ok)
  assert.equal(result.prompt.length, 4000)
  assert.equal(result.prompt, `${'x'.repeat(3999)}…`)
})

test('an empty template gives the task URL', () => {
  assert.deepEqual(buildPrompt('', task, web, branch, ''), { ok: true, prompt: 'https://example.atlassian.net/browse/WEB-12' })
})

test('INITIAL_TEMPLATE_TEXT is the key and URL of the task', () => {
  assert.equal(INITIAL_TEMPLATE_TEXT, 'Complete {{task_key}}: {{task_url}}')
  assert.deepEqual(buildPrompt(INITIAL_TEMPLATE_TEXT, task, web, branch, ''), {
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
  const result = buildPrompt('y'.repeat(30_001), task, web, branch, '')
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /30[ ,]?000/)
  assert.deepEqual(buildPrompt('y'.repeat(30_000), task, web, branch, ''), { ok: true, prompt: 'y'.repeat(30_000) })
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

test('saving a new template adds it at the end, trimmed, keeps the default template and the global ones', () => {
  const settings = { templates: [implement, triage], defaultTemplateId: 't-triage' }
  assert.deepEqual(withTemplateSaved(settings, [plan], { id: 't-new', name: '  Fix ', text: 'Fix {{branch}}' }, false), {
    project: { templates: [implement, triage, { id: 't-new', name: 'Fix', text: 'Fix {{branch}}' }], defaultTemplateId: 't-triage' },
    global: { templates: [plan] }
  })
})

test('saving a template keeps its place, and saving the initial template stores it', () => {
  const settings = { templates: [implement, triage] }
  assert.deepEqual(withTemplateSaved(settings, [], { ...implement, name: 'Build' }, false).project, {
    templates: [{ ...implement, name: 'Build' }, triage],
    defaultTemplateId: 't-impl'
  })
  assert.deepEqual(withTemplateSaved({}, [], { id: 'default', name: 'Default', text: 'Fix {{task_key}}' }, false).project, {
    templates: [{ id: 'default', name: 'Default', text: 'Fix {{task_key}}' }],
    defaultTemplateId: 'default'
  })
})

test('saving a global template keeps its place among the global ones, or adds it at the end, and keeps the project and its default template', () => {
  const settings = { templates: [implement], defaultTemplateId: 't-review' }
  assert.deepEqual(withTemplateSaved(settings, [review, plan], { ...review, name: ' Look ', text: 'x' }, true), {
    project: { templates: [implement], defaultTemplateId: 't-review' },
    global: { templates: [{ ...review, name: 'Look', text: 'x' }, plan] }
  })
  assert.deepEqual(withTemplateSaved(settings, [review], { id: 't-new', name: 'Fix', text: '' }, true).global, {
    templates: [review, { id: 't-new', name: 'Fix', text: '' }]
  })
})

test('the first global template, saved in a project that lists only "Default", stores "Default" in the project, which keeps it', () => {
  const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }
  assert.deepEqual(withTemplateSaved({}, [], review, true), {
    project: { templates: [initial], defaultTemplateId: 'default' },
    global: { templates: [review] }
  })
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

test('making a template global moves it, with its id, to the end of the global ones, and the default template keeps pointing at it', () => {
  const settings = { templates: [implement, triage] }
  assert.deepEqual(withTemplateMoved(settings, [review], 't-impl', true, 't-fresh'), {
    ok: true,
    id: 't-impl',
    write: {
      project: { templates: [triage], defaultTemplateId: 't-impl' },
      global: { templates: [review, implement] }
    }
  })
  assert.deepEqual(withTemplateMoved({ ...settings, defaultTemplateId: 't-triage' }, [], 't-impl', true, 't-fresh'), {
    ok: true,
    id: 't-impl',
    write: { project: { templates: [triage], defaultTemplateId: 't-triage' }, global: { templates: [implement] } }
  })
})

test('the initial template made global gets a new id, since other projects have an own template with its id, and the default template follows it', () => {
  const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }
  assert.deepEqual(withTemplateMoved({}, [], 'default', true, 't-fresh'), {
    ok: true,
    id: 't-fresh',
    write: { project: { templates: [], defaultTemplateId: 't-fresh' }, global: { templates: [{ ...initial, id: 't-fresh' }] } }
  })
  assert.deepEqual(withTemplateMoved({ templates: [{ ...initial, text: 'x' }, triage], defaultTemplateId: 't-triage' }, [], 'default', true, 't-fresh'), {
    ok: true,
    id: 't-fresh',
    write: { project: { templates: [triage], defaultTemplateId: 't-triage' }, global: { templates: [{ ...initial, id: 't-fresh', text: 'x' }] } }
  })
})

test('turning Global off moves a global template to the end of the active project, keeping its id and the default template', () => {
  assert.deepEqual(withTemplateMoved({ templates: [implement], defaultTemplateId: 't-review' }, [review, plan], 't-review', false, 't-fresh'), {
    ok: true,
    id: 't-review',
    write: { project: { templates: [implement, review], defaultTemplateId: 't-review' }, global: { templates: [plan] } }
  })
  assert.deepEqual(withTemplateMoved({}, [review], 't-review', false, 't-fresh'), {
    ok: true,
    id: 't-review',
    write: { project: { templates: [review], defaultTemplateId: 't-review' }, global: { templates: [] } }
  })
})

test('a move whose name the destination group already has, ignoring case, is refused with a message', () => {
  const settings = { templates: [implement, { id: 't-own-review', name: 'review', text: '' }] }
  assert.deepEqual(withTemplateMoved(settings, [{ ...review, name: 'IMPLEMENT' }], 't-impl', true, 't-fresh'), {
    ok: false,
    message: 'A global template is already called "IMPLEMENT". Rename one of them first.'
  })
  assert.deepEqual(withTemplateMoved(settings, [review], 't-review', false, 't-fresh'), {
    ok: false,
    message: 'This project already has a template called "review". Rename one of them first.'
  })
})

test('a move of a template no longer in its group is refused with a message', () => {
  assert.deepEqual(withTemplateMoved({ templates: [implement] }, [review], 't-review', true, 't-fresh'), {
    ok: false,
    message: 'The template is no longer in this project. Go back to Project settings and open it again.'
  })
  assert.deepEqual(withTemplateMoved({ templates: [implement] }, [review], 't-impl', false, 't-fresh'), {
    ok: false,
    message: 'The template is no longer global. Go back to Project settings and open it again.'
  })
})
