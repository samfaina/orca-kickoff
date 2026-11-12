// Prompt templates: `{{name}}` filled from the task, the project and the worktree name. No Node
// imports, so the panel can use the constants too.
import type { ProjectRef, Task } from './protocol'

/** The template of a project that hasn't set one. A constant, never stored. */
export const DEFAULT_TEMPLATE = 'Complete {{task_key}}: {{task_url}}'

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

/** The prompt for `task`. An undefined template is DEFAULT_TEMPLATE; an empty one gives the task
 *  URL. A prompt over MAX_PROMPT characters is refused. */
export function buildPrompt(template: string | undefined, task: Task, project: ProjectRef, branch: string): PromptResult {
  const source = template ?? DEFAULT_TEMPLATE
  const prompt = source === '' ? task.url : fillTemplate(source, templateVariables(task, project, branch))
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
