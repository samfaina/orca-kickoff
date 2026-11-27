// Worktree names and branches for tasks, and reading a task key back from a name. The name is only
// a readable label and a fallback link (ADR-0002): Orca's own link on the worktree comes first. The
// branch comes from the branch template of the branch settings the project uses, when they have one
// (src/branch-settings.ts). No Node imports, so the panel can use it too.
import type { BranchSettings, ProjectSettings, Task, TrackerId } from './protocol'
import { fillTemplate, usesVariable } from './template'

const MAX_TITLE_WORDS = 4

/** Accents folded (NFD, marks stripped), lower-cased, every run of anything but `a-z0-9` turned
 *  into one `-`, and `-` trimmed at the ends. */
export function titleWords(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The title exclusion pattern of branch settings, a project's or the global ones, until they store
 *  one: bracketed tags such as `[FE]`. A constant, stored only once changed. */
export const INITIAL_TITLE_EXCLUSION = '\\[[^\\]]*\\]'

/** The flags the title exclusion pattern runs with: every match, ignoring case, Unicode. */
const TITLE_EXCLUSION_FLAGS = 'giu'

/** The title exclusion pattern as a regular expression, or the reason it isn't one. */
function titleExclusionRegExp(pattern: string): { ok: true; regExp: RegExp } | { ok: false; message: string } {
  try {
    return { ok: true, regExp: new RegExp(pattern, TITLE_EXCLUSION_FLAGS) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** `title` with every match of the title exclusion `pattern` removed, each replaced by a space so
 *  the words on either side stay apart (`Fix[FE]login` → `Fix login`). An empty pattern, or one
 *  that isn't a valid regular expression, removes nothing; when what is left has no words, the
 *  whole title is kept, so a title of tags only keeps its words. */
export function cleanTitle(title: string, pattern: string): string {
  if (pattern === '') return title
  const compiled = titleExclusionRegExp(pattern)
  if (!compiled.ok) return title
  const cleaned = title.replace(compiled.regExp, ' ')
  return titleWords(cleaned) === '' ? title : cleaned
}

/** Up to four words of the cleaned title, as `titleWords` gives them: `{{task_slug}}` in a branch
 *  template, and the words of a worktree name. '' when the title has none. */
export function taskSlug(title: string, pattern: string): string {
  return titleWords(cleanTitle(title, pattern)).split('-').filter((word) => word !== '').slice(0, MAX_TITLE_WORDS).join('-')
}

/** The title exclusion pattern of `settings`, the branch settings a project uses: the stored one,
 *  else the initial one. */
export function titleExclusion(settings: Pick<ProjectSettings, 'titleExclusion'>): string {
  return settings.titleExclusion ?? INITIAL_TITLE_EXCLUSION
}

/** `<prefix>-<up to four words of the title, cleaned by the title exclusion pattern>`, that of
 *  `settings`, the branch settings the project uses:
 *  `issue-42-add-dark-mode` on GitHub, `web-12-anadir-modo-oscuro-a` on Jira. */
export function worktreeName(task: Pick<Task, 'tracker' | 'key' | 'title'>, settings: Pick<ProjectSettings, 'titleExclusion'>): string {
  const prefix = task.tracker === 'github' ? `issue-${githubIssueNumber(task.key)}` : task.key.toLowerCase()
  const slug = taskSlug(task.title, titleExclusion(settings))
  return slug === '' ? prefix : `${prefix}-${slug}`
}

/** Whether `text` is empty once trimmed. */
const isBlank = (text: string | undefined) => (text ?? '').trim() === ''

/** The variables a branch template can use. */
export const BRANCH_VARIABLES = ['task_key', 'task_slug', 'branch_type'] as const

type BranchVariable = (typeof BRANCH_VARIABLES)[number]

/** What each branch variable gives, as the Branch section describes it. */
export const BRANCH_VARIABLE_DESCRIPTIONS: Record<BranchVariable, string> = {
  task_key: 'The task key, such as WEB-12, or 42 on GitHub (no #).',
  task_slug: 'Up to four words of the title, without what the title exclusion pattern removes: add-dark-mode.',
  branch_type: "The task's branch type, from the table below."
}

/** The task's branch type: the text of the first row whose issue type is the task's, trimmed and
 *  ignoring case, else the fallback, trimmed. A row with a blank issue type or branch type counts
 *  as none. GitHub tasks have no issue type, so they get the fallback. */
export function branchType(settings: Pick<ProjectSettings, 'branchTypes' | 'branchTypeFallback'>, issueType: string | undefined): string {
  const wanted = issueType?.trim().toLowerCase() ?? ''
  for (const row of settings.branchTypes ?? []) {
    const type = row.issueType.trim()
    const branch = row.branchType.trim()
    if (type !== '' && branch !== '' && type.toLowerCase() === wanted) return branch
  }
  return (settings.branchTypeFallback ?? '').trim()
}

type BranchTask = Pick<Task, 'tracker' | 'key' | 'title' | 'issueType'>

/** The git branch the branch template of `settings` gives `task`, or null when they have none (a
 *  blank template): then Orca names the branch. Unknown variables are left as they are. */
export function filledBranch(settings: BranchSettings, task: BranchTask): string | null {
  const template = settings.branchTemplate ?? ''
  if (isBlank(template)) return null
  return fillTemplate(template, {
    task_key: task.tracker === 'github' ? githubIssueNumber(task.key) : task.key,
    task_slug: taskSlug(task.title, titleExclusion(settings)),
    branch_type: branchType(settings, task.issueType)
  } satisfies Record<BranchVariable, string>)
}

/** Characters git never holds in a branch name, besides spaces and control characters. */
const GIT_FORBIDDEN = /[~^:?*[\\]/

/** Why git can't hold `name` as a branch name, as a phrase that follows the name ("has "~""), or
 *  null when it can. The rules of `git check-ref-format --branch`, with Orca's own refusal of a
 *  leading `-` (`docs/reference.md`, `orca worktree create`). */
export function gitBranchProblem(name: string): string | null {
  if (name === '') return 'is empty'
  if (name === '@') return 'is "@"'
  if (/[\s\x00-\x1f\x7f]/.test(name)) return 'has a space or a control character'
  const forbidden = GIT_FORBIDDEN.exec(name)
  if (forbidden) return `has "${forbidden[0]}"`
  if (name.includes('..')) return 'has ".."'
  if (name.includes('@{')) return 'has "@{"'
  if (name.startsWith('-')) return 'starts with "-"'
  if (name.endsWith('/')) return 'ends with "/"'
  if (name.endsWith('.')) return 'ends with "."'
  const parts = name.split('/')
  if (parts.some((part) => part === '')) return 'has an empty part'
  if (parts.some((part) => part.startsWith('.'))) return 'has a part that starts with "."'
  if (parts.some((part) => part.endsWith('.lock'))) return 'has a part that ends with ".lock"'
  return null
}

/** What stands for each variable when the fixed text of a branch template is checked: a letter,
 *  which git holds anywhere. */
const SAMPLE_VALUE = 'a'

/** Why the Branch section can't be saved, and the field to fix for it. */
export type BranchSettingsProblem = { field: 'branchTemplate' | 'branchTypeFallback' | 'titleExclusion'; message: string }

/** Why the Branch section can't be saved, the project's own branch settings or the global ones, or
 *  null when it can: fixed text in the branch template that git can't hold in a branch name, a
 *  title exclusion pattern that isn't a valid regular expression, or a template that uses
 *  `{{branch_type}}` while the fallback is empty, which the fallback fixes. */
export function branchSettingsProblem(settings: BranchSettings): BranchSettingsProblem | null {
  const template = settings.branchTemplate ?? ''
  if (!isBlank(template)) {
    const sample = fillTemplate(template, Object.fromEntries(BRANCH_VARIABLES.map((name) => [name, SAMPLE_VALUE])))
    const problem = gitBranchProblem(sample)
    if (problem) return { field: 'branchTemplate', message: `The branch template ${problem}, which git can't hold in a branch name.` }
  }
  const compiled = titleExclusionRegExp(titleExclusion(settings))
  if (!compiled.ok) return { field: 'titleExclusion', message: `The title exclusion pattern isn't a valid regular expression: ${compiled.message}` }
  if (usesVariable(template, 'branch_type') && isBlank(settings.branchTypeFallback)) {
    return { field: 'branchTypeFallback', message: 'The branch template uses {{branch_type}}: give the branch types a fallback.' }
  }
  return null
}

/** The branch a Start of `task` passes, null when `settings` have no branch template, and why a
 *  Start refuses it, null when git holds it. Orca would refuse such a branch only once the create
 *  runs, so a Start checks it first, and the Branch section's preview says so. */
export function startBranch(settings: BranchSettings, task: BranchTask): { branch: string | null; problem: string | null } {
  const branch = filledBranch(settings, task)
  const problem = branch === null ? null : gitBranchProblem(branch)
  if (branch === null || problem === null) return { branch, problem: null }
  return {
    branch,
    problem: `The branch for ${task.key}, "${branch}", ${problem}, which git can't hold in a branch name. Change the branch template or the branch types in Project settings.`
  }
}

/** `42` for the GitHub task key `#42`. */
export function githubIssueNumber(key: string): string {
  return key.replace(/^#/, '')
}

const GITHUB_NAME = /^issue-(\d+)(?:-|$)/
/** Orca's Jira key pattern (`/^[A-Za-z][A-Za-z0-9_]*-\d+$/`), at the start of a name. */
const JIRA_NAME = /^([a-z][a-z0-9_]*-\d+)(?:-|$)/i

/** The task key a worktree name starts with, or null. It follows the project's tracker, because
 *  `issue-42-...` also matches the Jira pattern. */
export function taskKeyFromWorktreeName(name: string, tracker: TrackerId): string | null {
  if (tracker === 'github') {
    const match = GITHUB_NAME.exec(name)
    return match ? `#${match[1]}` : null
  }
  const match = JIRA_NAME.exec(name)
  return match ? match[1].toUpperCase() : null
}
