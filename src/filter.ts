// Editing filters: the rules that keep a project's filters valid, and naming new ones. Each tracker
// has filters of its own; which filters a project has, and which one lists, is in src/protocol.ts.
// No Node imports, so the panel can use them too.
import { DEFAULT_GITHUB_QUERY, listedFilter, projectFilters, type Filter, type FilterSettings, type TrackerId } from './protocol'

/** What saving or deleting a filter changes in a project's settings: every tracker's filters and
 *  the one each shows, since a change replaces them whole. */
export type FilterChanges = Required<FilterSettings>

/** The project's filters with `filter` saved on `tracker`, its name trimmed: in its place when the
 *  project has it, else at the end. The saved filter is the one shown. */
export function withFilterSaved(settings: FilterSettings, tracker: TrackerId, filter: Filter): FilterChanges {
  const saved = { ...filter, name: filter.name.trim() }
  const filters = projectFilters(settings, tracker)
  const known = filters.some((candidate) => candidate.id === saved.id)
  return withTrackerFilters(settings, tracker, known ? filters.map((candidate) => (candidate.id === saved.id ? saved : candidate)) : [...filters, saved], saved.id)
}

/** The project's filters on `tracker` without the one `id` names, or null when it is the only one:
 *  a project always has a filter. Deleting the filter shown shows the first remaining one. */
export function withFilterDeleted(settings: FilterSettings, tracker: TrackerId, id: string): FilterChanges | null {
  const filters = projectFilters(settings, tracker).filter((filter) => filter.id !== id)
  if (filters.length === 0) return null
  const shown = listedFilter(settings, tracker).id
  return withTrackerFilters(settings, tracker, filters, shown === id ? filters[0].id : shown)
}

/** `settings`' filters with `tracker`'s replaced by `filters`, and `shownId` shown on it. */
function withTrackerFilters(settings: FilterSettings, tracker: TrackerId, filters: Filter[], shownId: string): FilterChanges {
  return { filters: { ...settings.filters, [tracker]: filters }, shownFilterId: { ...settings.shownFilterId, [tracker]: shownId } }
}

/** Whether two filter names are the same, trimmed and ignoring case. */
export function sameFilterName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** Why `name` can't be the name of the filter `id` among `filters`, or null when it can. The
 *  filter's own name, in any case, is fine. */
export function filterNameProblem(filters: readonly Filter[], name: string, id: string): string | null {
  if (name.trim() === '') return 'Give the filter a name.'
  const other = filters.find((filter) => filter.id !== id && sameFilterName(filter.name, name))
  return other ? `Another filter is already called "${other.name}".` : null
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
  jira: []
}

/** The recipes the filter editor offers a new filter on `tracker`: GitHub's. Jira's JQL recipes come
 *  before the editor, with + (`src/jql-recipe.ts`). */
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
