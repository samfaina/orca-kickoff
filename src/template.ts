// Prompt templates: `{{name}}` filled from the task, the project and the branch (a Start's
// filled-in branch template, else its worktree name; a Run here's current branch). No Node
// imports, so the panel can use the constants too.
import type { ProjectRef, ProjectSettings, PromptTemplate, Task } from './protocol'

/** The text of the template a project lists before it stores any of its own while there is no
 *  global template, and of each new template. A constant, never stored. */
export const INITIAL_TEMPLATE_TEXT = 'Complete {{task_key}}: {{task_url}}'

/** The id and name of the template a project lists before it stores any of its own while there is
 *  no global template. A template stored with the earlier `template` field becomes this one too.
 *  Many projects store an own template with this id, so the initial template made global takes a
 *  new one. */
export const INITIAL_TEMPLATE_ID = 'default'
export const INITIAL_TEMPLATE_NAME = 'Default'

/** The part of a project's settings that holds its own templates and its default template. */
export type TemplateSettings = Pick<ProjectSettings, 'templates' | 'defaultTemplateId'>

/** A template as a project lists it: one of its own, or a global one (`global`). */
export type ListedTemplate = PromptTemplate & { global: boolean }

/** What a write of templates stores, always both parts: the active project's own templates with
 *  its default template, and the global templates. A move between the two groups changes both in
 *  one write. */
export type TemplateWrite = {
  project: Required<TemplateSettings>
  global: { templates: PromptTemplate[] }
}

/** The initial template: what a project lists while it has no template of its own and there is no
 *  global one. */
function initialTemplate(): PromptTemplate {
  return { id: INITIAL_TEMPLATE_ID, name: INITIAL_TEMPLATE_NAME, text: INITIAL_TEMPLATE_TEXT }
}

/** A project's own templates, in their order: the stored ones; with none stored, the initial one
 *  while there is no global template, else none. */
export function ownTemplates(settings: TemplateSettings, global: readonly PromptTemplate[]): PromptTemplate[] {
  const { templates } = settings
  if (templates && templates.length > 0) return templates
  return global.length === 0 ? [initialTemplate()] : []
}

/** The templates a project lists, in order: its own, then the global ones, each group in its order.
 *  A global template whose id one of the project's own has is left out, so an id names one template. */
export function projectTemplates(settings: TemplateSettings, global: readonly PromptTemplate[]): ListedTemplate[] {
  const own = ownTemplates(settings, global)
  const ids = new Set(own.map((template) => template.id))
  return [
    ...own.map((template) => ({ ...template, global: false })),
    ...global.filter((template) => !ids.has(template.id)).map((template) => ({ ...template, global: true }))
  ]
}

/** A project's default template, own or global: the one `defaultTemplateId` names, else the first
 *  it lists. */
export function defaultTemplate(settings: TemplateSettings, global: readonly PromptTemplate[]): ListedTemplate {
  const templates = projectTemplates(settings, global)
  return templates.find((template) => template.id === settings.defaultTemplateId) ?? templates[0]
}

/** The template `id` names among the project's own and the global ones, as stored, or undefined. */
export function findTemplate(settings: TemplateSettings, global: readonly PromptTemplate[], id: string): ListedTemplate | undefined {
  return projectTemplates(settings, global).find((template) => template.id === id)
}

/** Whether a task launched with `template` gets a Start, in a new worktree, rather than a Run here:
 *  its New worktree switch, on unless it stores `newWorktree: false`. */
export function launchesNewWorktree(template: PromptTemplate): boolean {
  return template.newWorktree !== false
}

/** `templates` with `template` in its place when one has its id, else at the end. */
function withReplaced(templates: readonly PromptTemplate[], template: PromptTemplate): PromptTemplate[] {
  const known = templates.some((candidate) => candidate.id === template.id)
  return known ? templates.map((candidate) => (candidate.id === template.id ? template : candidate)) : [...templates, template]
}

/** How a Save stores a template: among the global ones (`isGlobal`) or the project's own, whether
 *  it becomes the project's default template (`isDefault`), and the id it takes when it is the
 *  initial template made global (`freshId`). */
export type TemplateSaveOptions = { isGlobal: boolean; isDefault: boolean; freshId: string }

/** A Save of a template: the template's id after it, and what it stores, or why it is refused. */
export type TemplateSave = { ok: true; id: string; write: TemplateWrite } | { ok: false; message: string }

/** `template` saved, its name trimmed and its New worktree setting as given, among the project's
 *  own templates or, when `isGlobal`, the global ones, in one write: in its place when that group has it, else at the end, also when
 *  neither group holds it any more, as after another project deleted it. A template the other group
 *  holds moves, with its id, to the end of this one, so the project's default template
 *  and the template chosen for a task keep pointing at it, except the initial template's id, which
 *  other projects give to an own template of theirs: made global, it takes `freshId`. A name the
 *  destination group already has, ignoring case, refuses the move. With `isDefault` the template
 *  becomes the project's default template; else the default template stays, following the template
 *  when it is the one saved. Other projects whose default template a global template was, once it
 *  is no longer global, fall back to their first. The project stores what it lists of its own, so
 *  the initial template, listed before the first global one is saved, stays. */
export function withTemplateSaved(
  settings: TemplateSettings,
  global: readonly PromptTemplate[],
  template: PromptTemplate,
  { isGlobal, isDefault, freshId }: TemplateSaveOptions
): TemplateSave {
  const name = template.name.trim()
  const own = ownTemplates(settings, global)
  const to = isGlobal ? global : own
  const from = isGlobal ? own : global
  const moves = !to.some((candidate) => candidate.id === template.id) && from.some((candidate) => candidate.id === template.id)
  if (moves) {
    const clash = to.find((candidate) => sameTemplateName(candidate.name, name))
    if (clash) {
      const where = isGlobal ? `A global template is already called "${clash.name}".` : `This project already has a template called "${clash.name}".`
      return { ok: false, message: `${where} Rename one of them first.` }
    }
  }
  const id = moves && isGlobal && template.id === INITIAL_TEMPLATE_ID ? freshId : template.id
  const saved = { ...template, id, name }
  const rest = (templates: readonly PromptTemplate[]) => (moves ? templates.filter((candidate) => candidate.id !== template.id) : [...templates])
  const current = defaultTemplate(settings, global).id
  return {
    ok: true,
    id,
    write: {
      project: { templates: isGlobal ? rest(own) : withReplaced(own, saved), defaultTemplateId: isDefault || current === template.id ? id : current },
      global: { templates: isGlobal ? withReplaced(global, saved) : rest(global) }
    }
  }
}

/** The project's own templates and the global ones without the one `id` names, or null when the
 *  project would list no other: it always has a template. A global template is deleted in every
 *  project. Deleting the default template makes the first remaining one the default. */
export function withTemplateDeleted(settings: TemplateSettings, global: readonly PromptTemplate[], id: string): TemplateWrite | null {
  const stored = ownTemplates(settings, global)
  const isOwn = stored.some((template) => template.id === id)
  const own = stored.filter((template) => template.id !== id)
  const remaining = isOwn ? [...global] : global.filter((template) => template.id !== id)
  if (own.length === 0 && remaining.length === 0) return null
  const current = defaultTemplate(settings, global).id
  const first = projectTemplates({ templates: own }, remaining)[0].id
  return { project: { templates: own, defaultTemplateId: current === id ? first : current }, global: { templates: remaining } }
}

/** Whether two template names are the same, trimmed and ignoring case. */
export function sameTemplateName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Why `name` can't be the name of the template `id` among the listed `templates` of its group, the
 *  global ones when `isGlobal`, else the project's own, or null when it can. The template's own
 *  name, in any case, is fine, and so is the name of a template of the other group. */
export function templateNameProblem(templates: readonly ListedTemplate[], name: string, id: string, isGlobal: boolean): string | null {
  if (name.trim() === '') return 'Give the template a name.'
  const other = templates.find((template) => template.global === isGlobal && template.id !== id && sameTemplateName(template.name, name))
  if (!other) return null
  return isGlobal ? `Another global template is already called "${other.name}".` : `Another template is already called "${other.name}".`
}

/** Why a Start or a Run here launches nothing when the template chosen for the task is gone: it
 *  never falls back to another. */
export const TEMPLATE_GONE = 'The prompt template you chose no longer exists — pick another one.'

/** `{{task_description}}` is cut to this many characters, `…` included. */
export const MAX_DESCRIPTION = 4000

/** The Windows command line holds about 32 000 characters, and the prompt is one argument. */
export const MAX_PROMPT = 30_000

/** The variable that names the project's Jira project key, as `{{jira_project}}`: in templates, and
 *  the only one in JQL queries. */
export const JIRA_PROJECT_VARIABLE = 'jira_project'

/** The variables a template can use, in the order the panel lists them. */
export const TEMPLATE_VARIABLES = [
  'task_key',
  'task_title',
  'task_url',
  'task_description',
  'task_status',
  'tracker',
  'repo',
  'branch',
  JIRA_PROJECT_VARIABLE
] as const

type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

/** What each variable gives, as the Prompt templates view describes it. Every variable needs one. */
export const TEMPLATE_VARIABLE_DESCRIPTIONS: Record<TemplateVariable, string> = {
  task_key: 'The task key, such as WEB-12 or #42.',
  task_title: "The task's title.",
  task_url: "The task's link in the tracker.",
  task_description: `The task's description as plain text, cut to ${MAX_DESCRIPTION} characters.`,
  task_status: 'The status as the tracker shows it, such as "In Progress". "Open" on GitHub.',
  tracker: '"github" or "jira".',
  repo: "The project's repository (owner/name) when Orca knows it, else the project's name.",
  branch:
    "The new worktree's git branch from the branch template the project uses, its own or the global one, such as feature/WEB-12__add-dark-mode. Without a branch template, the worktree's name, such as web-12-add-dark-mode. It doesn't include a -2 Orca may add. In a Run here, the current branch of the worktree selected in Orca, or nothing when it has none.",
  [JIRA_PROJECT_VARIABLE]: "The project's Jira project key, such as WEB, set in Project settings. Empty when it has none."
}

export type PromptResult = { ok: true; prompt: string } | { ok: false; message: string }

/** The prompt for `task` from a template's text, in a project whose Jira project key is
 *  `jiraProjectKey` ('' for none), with `branch` as `{{branch}}`: a Start's filled-in branch
 *  template, else its worktree name, or a Run here's current branch. An empty text gives the task
 *  URL. A prompt over MAX_PROMPT characters is refused. */
export function buildPrompt(text: string, task: Task, project: ProjectRef, branch: string, jiraProjectKey: string): PromptResult {
  const prompt = text === '' ? task.url : fillTemplate(text, templateVariables(task, project, branch, jiraProjectKey))
  if (prompt.length > MAX_PROMPT) {
    return {
      ok: false,
      message: `The prompt for ${task.key} is ${prompt.length} characters long, over the limit of ${MAX_PROMPT}. Shorten the prompt template, for example by leaving out {{task_description}}.`
    }
  }
  return { ok: true, prompt }
}

function templateVariables(task: Task, project: ProjectRef, branch: string, jiraProjectKey: string): Record<TemplateVariable, string> {
  return {
    task_key: task.key,
    task_title: task.title,
    task_url: task.url,
    task_description: cut(task.description, MAX_DESCRIPTION),
    task_status: task.status ?? '',
    tracker: task.tracker,
    repo: project.repo ?? project.name,
    branch,
    [JIRA_PROJECT_VARIABLE]: jiraProjectKey
  }
}

/** A `{{ name }}`, spaces inside the braces allowed, with the name as its group. */
const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

/** Replaces each `{{ name }}` with its value; an unknown name is left as it is. JQL queries name
 *  the Jira project key the same way. */
export function fillTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(VARIABLE, (whole, name: string) => (Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : whole))
}

/** Whether `text` holds `{{ name }}`, spaces inside the braces allowed. */
export function usesVariable(text: string, name: string): boolean {
  return [...text.matchAll(VARIABLE)].some((match) => match[1] === name)
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
