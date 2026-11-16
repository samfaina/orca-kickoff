// Prompt templates: `{{name}}` filled from the task, the project and the worktree name. No Node
// imports, so the panel can use the constants too.
import type { ProjectRef, ProjectSettings, PromptTemplate, Task } from './protocol'

/** The text of the template a project has before it stores any, and of each new template. A
 *  constant, never stored. */
export const INITIAL_TEMPLATE_TEXT = 'Complete {{task_key}}: {{task_url}}'

/** The id and name of the template a project has before it stores any. A template stored with
 *  the earlier `template` field becomes this one too. */
export const INITIAL_TEMPLATE_ID = 'default'
export const INITIAL_TEMPLATE_NAME = 'Default'

/** The part of a project's settings that holds its templates. */
export type TemplateSettings = Pick<ProjectSettings, 'templates' | 'defaultTemplateId'>

/** What saving or deleting a template changes in a project's settings. */
export type TemplateChanges = Required<TemplateSettings>

/** A project's templates, in their order: the stored ones, or the initial one when none is stored. */
export function projectTemplates(settings: TemplateSettings): PromptTemplate[] {
  const { templates } = settings
  if (templates && templates.length > 0) return templates
  return [{ id: INITIAL_TEMPLATE_ID, name: INITIAL_TEMPLATE_NAME, text: INITIAL_TEMPLATE_TEXT }]
}

/** A project's default template: the one `defaultTemplateId` names, else the first. */
export function defaultTemplate(settings: TemplateSettings): PromptTemplate {
  const templates = projectTemplates(settings)
  return templates.find((template) => template.id === settings.defaultTemplateId) ?? templates[0]
}

/** The project's templates with `template` saved, its name trimmed: in its place when the project
 *  has it, else at the end. The default template stays the same. */
export function withTemplateSaved(settings: TemplateSettings, template: PromptTemplate): TemplateChanges {
  const saved = { ...template, name: template.name.trim() }
  const templates = projectTemplates(settings)
  const known = templates.some((candidate) => candidate.id === saved.id)
  return {
    templates: known ? templates.map((candidate) => (candidate.id === saved.id ? saved : candidate)) : [...templates, saved],
    defaultTemplateId: defaultTemplate(settings).id
  }
}

/** The project's templates without the one `id` names, or null when it is the only one: a project
 *  always has a template. Deleting the default template makes the first remaining one the default. */
export function withTemplateDeleted(settings: TemplateSettings, id: string): TemplateChanges | null {
  const templates = projectTemplates(settings).filter((template) => template.id !== id)
  if (templates.length === 0) return null
  const current = defaultTemplate(settings).id
  return { templates, defaultTemplateId: current === id ? templates[0].id : current }
}

/** Whether two template names are the same, trimmed and ignoring case. */
export function sameTemplateName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Why `name` can't be the name of the template `id` among `templates`, or null when it can. The
 *  template's own name, in any case, is fine. */
export function templateNameProblem(templates: readonly PromptTemplate[], name: string, id: string): string | null {
  if (name.trim() === '') return 'Give the template a name.'
  const other = templates.find((template) => template.id !== id && sameTemplateName(template.name, name))
  return other ? `Another template is already called "${other.name}".` : null
}

/** `{{task_description}}` is cut to this many characters, `…` included. */
export const MAX_DESCRIPTION = 4000

/** The Windows command line holds about 32 000 characters, and the prompt is one argument. */
export const MAX_PROMPT = 30_000

/** The variables a template can use, in the order the panel lists them. */
export const TEMPLATE_VARIABLES = [
  'task_key',
  'task_title',
  'task_url',
  'task_description',
  'task_status',
  'tracker',
  'repo',
  'branch'
] as const

type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

export type PromptResult = { ok: true; prompt: string } | { ok: false; message: string }

/** The prompt for `task` from a template's text. An empty text gives the task URL. A prompt over
 *  MAX_PROMPT characters is refused. */
export function buildPrompt(text: string, task: Task, project: ProjectRef, branch: string): PromptResult {
  const prompt = text === '' ? task.url : fillTemplate(text, templateVariables(task, project, branch))
  if (prompt.length > MAX_PROMPT) {
    return {
      ok: false,
      message: `The prompt for ${task.key} is ${prompt.length} characters long, over the limit of ${MAX_PROMPT}. Shorten the prompt template, for example by leaving out {{task_description}}.`
    }
  }
  return { ok: true, prompt }
}

function templateVariables(task: Task, project: ProjectRef, branch: string): Record<TemplateVariable, string> {
  return {
    task_key: task.key,
    task_title: task.title,
    task_url: task.url,
    task_description: cut(task.description, MAX_DESCRIPTION),
    task_status: task.status ?? '',
    tracker: task.tracker,
    repo: project.repo ?? project.name,
    branch
  }
}

/** Replaces each `{{ name }}` with its value; an unknown name is left as it is. */
function fillTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : whole
  )
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
