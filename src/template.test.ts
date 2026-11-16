import { assert, test } from 'orca/testing'
import type { ProjectRef, Task } from './protocol'
import { buildPrompt, defaultTemplate, INITIAL_TEMPLATE_TEXT, projectTemplates, templateNameProblem, withTemplateDeleted, withTemplateSaved } from './template'

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
    '{{task_key}}|{{ task_title }}|{{task_url}}|{{  task_description}}|{{task_status }}|{{tracker}}|{{repo}}|{{branch}}'
  assert.deepEqual(buildPrompt(template, task, web, branch), {
    ok: true,
    prompt:
      'WEB-12|Add dark mode to settings|https://example.atlassian.net/browse/WEB-12|Users want a dark theme.|To Do|jira|acme/web|web-12-add-dark-mode-to'
  })
})

test('an unknown variable is left as it is', () => {
  assert.deepEqual(buildPrompt('{{task_key}} {{ assignee }}', task, web, branch), { ok: true, prompt: 'WEB-12 {{ assignee }}' })
})

test('a task without a status leaves task_status empty', () => {
  assert.deepEqual(buildPrompt('[{{task_status}}]', { ...task, status: null }, web, branch), { ok: true, prompt: '[]' })
})

test('a project without a repo uses its name for {{repo}}', () => {
  const notes: ProjectRef = { id: 'repo:r2', name: 'notes', repo: null }
  assert.deepEqual(buildPrompt('{{repo}}', task, notes, branch), { ok: true, prompt: 'notes' })
})

test('a long description is cut to 4000 characters with …', () => {
  const result = buildPrompt('{{task_description}}', { ...task, description: 'x'.repeat(5000) }, web, branch)
  assert.ok(result.ok)
  assert.equal(result.prompt.length, 4000)
  assert.equal(result.prompt, `${'x'.repeat(3999)}…`)
})

test('an empty template gives the task URL', () => {
  assert.deepEqual(buildPrompt('', task, web, branch), { ok: true, prompt: 'https://example.atlassian.net/browse/WEB-12' })
})

test('INITIAL_TEMPLATE_TEXT is the key and URL of the task', () => {
  assert.equal(INITIAL_TEMPLATE_TEXT, 'Complete {{task_key}}: {{task_url}}')
  assert.deepEqual(buildPrompt(INITIAL_TEMPLATE_TEXT, task, web, branch), {
    ok: true,
    prompt: 'Complete WEB-12: https://example.atlassian.net/browse/WEB-12'
  })
})

test('a project without stored templates has one, "Default", with INITIAL_TEMPLATE_TEXT, and it is the default', () => {
  const initial = { id: 'default', name: 'Default', text: 'Complete {{task_key}}: {{task_url}}' }
  assert.deepEqual(projectTemplates({}), [initial])
  assert.deepEqual(projectTemplates({ templates: [] }), [initial])
  assert.deepEqual(defaultTemplate({}), initial)
})

test('a prompt over 30 000 characters is refused with a clear message', () => {
  const result = buildPrompt('y'.repeat(30_001), task, web, branch)
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.match(result.message, /30[ ,]?000/)
  assert.deepEqual(buildPrompt('y'.repeat(30_000), task, web, branch), { ok: true, prompt: 'y'.repeat(30_000) })
})

const implement = { id: 't-impl', name: 'Implement', text: '/acme-skills:tdd {{task_url}}' }
const triage = { id: 't-triage', name: 'Triage', text: 'Triage {{task_key}}' }

test('the default template is the one defaultTemplateId names, or the first when it is unknown or missing', () => {
  const templates = [implement, triage]
  assert.deepEqual(defaultTemplate({ templates, defaultTemplateId: 't-triage' }), triage)
  assert.deepEqual(defaultTemplate({ templates, defaultTemplateId: 't-gone' }), implement)
  assert.deepEqual(defaultTemplate({ templates }), implement)
  assert.deepEqual(projectTemplates({ templates }), [implement, triage])
})

test('a template name is valid when, trimmed, it is not empty and no other template of the project has it ignoring case', () => {
  const templates = [implement, triage]
  assert.equal(templateNameProblem(templates, 'Review', null), null)
  assert.equal(templateNameProblem(templates, '  Review  ', null), null)
  assert.equal(templateNameProblem(templates, '', null), 'Give the template a name.')
  assert.equal(templateNameProblem(templates, '   ', null), 'Give the template a name.')
  assert.equal(templateNameProblem(templates, ' triage ', null), 'Another template is already called "Triage".')
  assert.equal(templateNameProblem(templates, 'TRIAGE', 't-impl'), 'Another template is already called "Triage".')
  // Renaming a template to its own name in another case.
  assert.equal(templateNameProblem(templates, 'IMPLEMENT', 't-impl'), null)
})

test('saving a new template adds it at the end, trimmed, and keeps the default template', () => {
  const settings = { templates: [implement, triage], defaultTemplateId: 't-triage' }
  assert.deepEqual(withTemplateSaved(settings, { id: 't-review', name: '  Review ', text: 'Review {{branch}}' }), {
    templates: [implement, triage, { id: 't-review', name: 'Review', text: 'Review {{branch}}' }],
    defaultTemplateId: 't-triage'
  })
})

test('saving a template keeps its place, and saving the initial template stores it', () => {
  const settings = { templates: [implement, triage] }
  assert.deepEqual(withTemplateSaved(settings, { ...implement, name: 'Build' }), {
    templates: [{ ...implement, name: 'Build' }, triage],
    defaultTemplateId: 't-impl'
  })
  assert.deepEqual(withTemplateSaved({}, { id: 'default', name: 'Default', text: 'Fix {{task_key}}' }), {
    templates: [{ id: 'default', name: 'Default', text: 'Fix {{task_key}}' }],
    defaultTemplateId: 'default'
  })
})

test('deleting the default template makes the first remaining one the default, and the only template stays', () => {
  const settings = { templates: [implement, triage, { id: 't-review', name: 'Review', text: '' }], defaultTemplateId: 't-impl' }
  assert.deepEqual(withTemplateDeleted(settings, 't-impl'), {
    templates: [triage, { id: 't-review', name: 'Review', text: '' }],
    defaultTemplateId: 't-triage'
  })
  assert.deepEqual(withTemplateDeleted({ ...settings, defaultTemplateId: 't-review' }, 't-triage'), {
    templates: [implement, { id: 't-review', name: 'Review', text: '' }],
    defaultTemplateId: 't-review'
  })
  assert.equal(withTemplateDeleted({ templates: [implement] }, 't-impl'), null)
  assert.equal(withTemplateDeleted({}, 'default'), null)
})
