// Which branch settings a project uses, its own or the global ones, and what turning the Branch
// section's Global switch on or off writes. Pure: the settings saver writes what these give, from
// the settings as stored. No Node imports, so the panel can use it too.
import { titleExclusion } from './naming'
import type { BranchSettings, GlobalChanges, ProjectChanges, ProjectSettings } from './protocol'

/** The fields of the branch settings, as a project and the global ones store them. */
const BRANCH_FIELDS = ['branchTemplate', 'branchTypes', 'branchTypeFallback', 'titleExclusion'] as const satisfies readonly (keyof BranchSettings)[]

/** The project's own branch settings: the fields it stores, as stored. */
export function ownBranchSettings(project: ProjectSettings): BranchSettings {
  return Object.fromEntries(BRANCH_FIELDS.flatMap((field) => (project[field] === undefined ? [] : [[field, project[field]]])))
}

/** Whether the project uses `global`, the global branch settings, undefined while none are stored:
 *  as its mark says, or, without one, when it stores no branch field of its own. With none stored,
 *  every project uses its own, so typing in the Branch section never makes global ones. It is also
 *  whether the Branch section's Global switch shows on. */
export function usesGlobalBranchSettings(project: ProjectSettings, global: BranchSettings | undefined): boolean {
  if (global === undefined) return false
  if (project.branchSettingsUsed !== undefined) return project.branchSettingsUsed === 'global'
  return BRANCH_FIELDS.every((field) => project[field] === undefined)
}

/** The branch settings the project uses: `global`, the global ones, or its own. Its own may be
 *  none, which name branches as before branch settings: Orca names the branch, there are no branch
 *  types, and the title exclusion pattern is the initial one. */
export function projectBranchSettings(project: ProjectSettings, global: BranchSettings | undefined): BranchSettings {
  return usesGlobalBranchSettings(project, global) && global ? global : ownBranchSettings(project)
}

/** Whether `a` and `b` name every branch and worktree alike: the same fields, as typed, a field left
 *  unset counting as it starts. */
export function sameBranchSettings(a: BranchSettings, b: BranchSettings): boolean {
  const rows = (settings: BranchSettings) => (settings.branchTypes ?? []).map((row) => [row.issueType, row.branchType])
  return (
    (a.branchTemplate ?? '') === (b.branchTemplate ?? '') &&
    JSON.stringify(rows(a)) === JSON.stringify(rows(b)) &&
    (a.branchTypeFallback ?? '') === (b.branchTypeFallback ?? '') &&
    titleExclusion(a) === titleExclusion(b)
  )
}

/** What turning the Global switch on or off writes: the project's changes, and the global ones
 *  when they change too, both in one write. */
export type BranchSwitchWrite = { project: ProjectChanges; global?: GlobalChanges }

/** What turning the Global switch to `on` writes for `project`, with `global`, the global branch
 *  settings, as stored, or null when the project already uses what `on` asks for.
 *  - On, with none stored: the project's own become the global ones (publish).
 *  - On, with some stored: the global ones stay as they are (adopt).
 *  Either way the project drops its own branch fields and is marked as using the global ones.
 *  - Off: the project gets a copy of the global ones as its own, marked as its own, so its
 *  branches don't change. */
export function withBranchSwitched(project: ProjectSettings, global: BranchSettings | undefined, on: boolean): BranchSwitchWrite | null {
  if (usesGlobalBranchSettings(project, global) === on) return null
  if (on) {
    const dropped: ProjectChanges = Object.fromEntries(BRANCH_FIELDS.map((field) => [field, undefined]))
    const write: BranchSwitchWrite = { project: { ...dropped, branchSettingsUsed: 'global' } }

    if (global === undefined) write.global = { branch: ownBranchSettings(project) }
    return write
  }
  // Off is only asked while the project uses the global ones, so they are stored.
  const copy = global ?? {}
  return {
    project: {
      branchTemplate: copy.branchTemplate,
      branchTypes: copy.branchTypes?.map((row) => ({ ...row })),
      branchTypeFallback: copy.branchTypeFallback,
      titleExclusion: copy.titleExclusion,
      branchSettingsUsed: 'own'
    }
  }
}
