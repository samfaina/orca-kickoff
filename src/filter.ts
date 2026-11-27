// Editing filters: the rules that keep a project's filters and the global ones valid, naming new
// ones, and the hint to name the Jira project key as `{{jira_project}}`. Each tracker has filters of
// its own; which filters a project lists, and which one lists, is in src/protocol.ts. No Node
// imports, so the panel can use them too.
import {
  DEFAULT_GITHUB_QUERY,
  isInitialFilterId,
  listedFilter,
  ownFilters,
  projectFilters,
  type Filter,
  type FilterSettings,
  type GlobalChanges,
  type GlobalSettings,
  type ListedFilter,
  type ProjectChanges,
  type TrackerId
} from './protocol'
import { JIRA_PROJECT_VARIABLE } from './template'

/** What a write of filters changes in a project's settings: every tracker's filters and the one
 *  each shows, since a change replaces them whole. */
export type FilterChanges = Required<FilterSettings>

/** What a write of filters on one tracker stores, always both parts: the active project's own
 *  filters with the one each tracker shows, and the global filters of that tracker. A move between
 *  the two groups changes both in one write. */
export type FilterWrite = { project: FilterChanges; global: Filter[] }

/** `filters` with `filter` in its place when one has its id, else at the end. */
function withReplaced(filters: readonly Filter[], filter: Filter): Filter[] {
  const known = filters.some((candidate) => candidate.id === filter.id)
  return known ? filters.map((candidate) => (candidate.id === filter.id ? filter : candidate)) : [...filters, filter]
}

/** `filter` saved on `tracker`, its name trimmed, among the project's own filters or, when
 *  `isGlobal`, among `global`, the global filters of `tracker`: in its place when that group has it,
 *  else at the end. The saved filter is the one shown. The project stores what it lists of its own,
 *  so the initial filter, listed before the first global one is saved, stays. */
export function withFilterSaved(settings: FilterSettings, tracker: TrackerId, global: readonly Filter[], filter: Filter, isGlobal: boolean): FilterWrite {
  const saved = { ...filter, name: filter.name.trim() }
  const own = ownFilters(settings, tracker, global)
  return {
    project: withTrackerFilters(settings, tracker, isGlobal ? own : withReplaced(own, saved), saved.id),
    global: isGlobal ? withReplaced(global, saved) : [...global]
  }
}

/** The project's own filters on `tracker` and `global`, its global ones, without the one `id`
 *  names, or null when the project would list no other there: it always has a filter. A global
 *  filter is deleted in every project. Deleting the filter shown shows the first remaining one. */
export function withFilterDeleted(settings: FilterSettings, tracker: TrackerId, global: readonly Filter[], id: string): FilterWrite | null {
  const stored = ownFilters(settings, tracker, global)
  const isOwn = stored.some((filter) => filter.id === id)
  const own = stored.filter((filter) => filter.id !== id)
  const remaining = isOwn ? [...global] : global.filter((filter) => filter.id !== id)
  if (own.length === 0 && remaining.length === 0) return null
  const shown = listedFilter(settings, tracker, global).id
  const first = projectFilters({ filters: { [tracker]: own } }, tracker, remaining)[0].id
  return { project: withTrackerFilters(settings, tracker, own, shown === id ? first : shown), global: remaining }
}

/** A move between the project's own filters and the global ones: the filter's id after it, and
 *  what it stores, or why it is refused. */
export type FilterMove = { ok: true; id: string; write: FilterWrite } | { ok: false; message: string }

/** The filter `id` names on `tracker` moved, as stored, to the end of `global`, the global filters
 *  of `tracker` (`toGlobal`), or of the project's own. It keeps its id, so the filter shown keeps
 *  pointing at it, except the initial filter's id, which other projects give to an own filter of
 *  theirs: made global, it takes `freshId`, and the filter shown follows it. Other projects that
 *  showed it, once it is no longer global, fall back to their first. A name the destination group
 *  already has, ignoring case, refuses the move. */
export function withFilterMoved(
  settings: FilterSettings,
  tracker: TrackerId,
  global: readonly Filter[],
  id: string,
  toGlobal: boolean,
  freshId: string
): FilterMove {
  const own = ownFilters(settings, tracker, global)
  const from = toGlobal ? own : global
  const to = toGlobal ? global : own
  const filter = from.find((candidate) => candidate.id === id)
  if (!filter) {
    const where = toGlobal ? 'in this project' : 'global'
    return { ok: false, message: `The filter is no longer ${where}. Go back to the list and open it again.` }
  }
  const clash = to.find((candidate) => sameFilterName(candidate.name, filter.name))
  if (clash) {
    const where = toGlobal ? `A global filter is already called "${clash.name}".` : `This project already has a filter called "${clash.name}".`
    return { ok: false, message: `${where} Rename one of them first.` }
  }
  const movedId = toGlobal && isInitialFilterId(tracker, id) ? freshId : id
  const moved = { ...filter, id: movedId }
  const shown = listedFilter(settings, tracker, global).id
  const rest = from.filter((candidate) => candidate.id !== id)
  return {
    ok: true,
    id: movedId,
    write: {
      project: withTrackerFilters(settings, tracker, toGlobal ? rest : [...own, moved], shown === id ? movedId : shown),
      global: toGlobal ? [...global, moved] : rest
    }
  }
}

/** What the settings saver writes for `write`, a write of filters on `tracker`: the project's
 *  changes, and the global filters with `tracker`'s replaced, keeping, from `stored`, the global
 *  ones of the other trackers. */
export function filterWriteChanges(stored: GlobalSettings, tracker: TrackerId, write: FilterWrite): { project: ProjectChanges; global: GlobalChanges } {
  return { project: write.project, global: { filters: { ...stored.filters, [tracker]: write.global } } }
}

/** `settings`' filters with `tracker`'s replaced by `filters`, and `shownId` shown on it. */
function withTrackerFilters(settings: FilterSettings, tracker: TrackerId, filters: Filter[], shownId: string): FilterChanges {
  return { filters: { ...settings.filters, [tracker]: filters }, shownFilterId: { ...settings.shownFilterId, [tracker]: shownId } }
}

/** Whether two filter names are the same, trimmed and ignoring case. */
export function sameFilterName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Why `name` can't be the name of the filter `id` among the listed `filters` of its group, the
 *  global ones when `isGlobal`, else the project's own, or null when it can. The filter's own name,
 *  in any case, is fine, and so is the name of a filter of the other group. */
export function filterNameProblem(filters: readonly ListedFilter[], name: string, id: string, isGlobal: boolean): string | null {
  if (name.trim() === '') return 'Give the filter a name.'
  const other = filters.find((filter) => filter.global === isGlobal && filter.id !== id && sameFilterName(filter.name, name))
  if (!other) return null
  return isGlobal ? `Another global filter is already called "${other.name}".` : `Another filter is already called "${other.name}".`
}

/** The name of a new filter: "Filter 2", "Filter 3"…, the first that no filter has. */
export function newFilterName(filters: readonly Filter[]): string {
  return firstFreeName(filters, 'Filter', 2)
}

/** A ready-made kind of filter: the name and queries of a new filter, for the person to change
 *  before saving it. */
export type FilterRecipe = { name: string; queries: string[] }

const RECIPES: Record<TrackerId, readonly FilterRecipe[]> = {
  github: [
    { name: 'Open', queries: [DEFAULT_GITHUB_QUERY] },
    { name: 'Assigned to me', queries: ['is:open assignee:@me'] }
  ],
  jira: [],
  linear: []
}

/** The recipes the filter editor offers a new filter on `tracker`: GitHub's. Jira's JQL recipes come
 *  before the editor, with + (`src/jql-recipe.ts`). The panel doesn't edit Linear filters yet. */
export function filterRecipes(tracker: TrackerId): FilterRecipe[] {
  return RECIPES[tracker].map((recipe) => ({ name: recipe.name, queries: [...recipe.queries] }))
}

/** The name of a new filter from the recipe `name`: that name, or "<name> 2", "<name> 3"…, the
 *  first that no filter has. */
export function recipeFilterName(filters: readonly Filter[], name: string): string {
  return filters.some((filter) => sameFilterName(filter.name, name)) ? firstFreeName(filters, name, 2) : name
}

/** "<base> <n>" with the first `n`, from `from`, that no filter's name has. */
function firstFreeName(filters: readonly Filter[], base: string, from: number): string {
  for (let number = from; ; number++) {
    const name = `${base} ${number}`
    if (!filters.some((filter) => sameFilterName(filter.name, name))) return name
  }
}

/** Each `project = KEY` naming `key`, spaces around `=` optional, the field and the key ignoring
 *  case, with `project =` and its spacing as the first group. A key that only starts with `key`,
 *  such as WEBAPP for WEB, doesn't match, nor does any other JQL form, such as `project in (KEY)`. */
function projectKeyPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(\\bproject\\s*=\\s*)${escaped}(?![A-Za-z0-9_])`, 'gi')
}

/** Whether `query` names the Jira project key `key` literally, as `project = KEY`: what the hint
 *  of a global Jira filter looks for. No key ('') is never named. */
export function namesJiraProject(query: string, key: string): boolean {
  return key !== '' && projectKeyPattern(key).test(query)
}

/** `query` with the key of each `project = KEY` naming `key` replaced by `{{jira_project}}`, the
 *  rest as written, so a global filter lists each project's own tasks. */
export function withJiraProjectVariable(query: string, key: string): string {
  if (key === '') return query
  return query.replace(projectKeyPattern(key), (_whole, field: string) => `${field}{{${JIRA_PROJECT_VARIABLE}}}`)
}
