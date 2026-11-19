// Editing filters: the rules that keep a project's filters valid, and naming new ones. Only Jira has
// filters so far; which filters a project has, and which one lists, is in src/protocol.ts. No Node
// imports, so the panel can use them too.
import { listedFilter, projectFilters, type Filter, type FilterSettings } from './protocol'

/** What saving or deleting a filter changes in a project's settings. */
export type FilterChanges = Required<FilterSettings>

/** The project's filters with `filter` saved, its name trimmed: in its place when the project has
 *  it, else at the end. The saved filter is the one shown. */
export function withFilterSaved(settings: FilterSettings, filter: Filter): FilterChanges {
  const saved = { ...filter, name: filter.name.trim() }
  const filters = projectFilters(settings)
  const known = filters.some((candidate) => candidate.id === saved.id)
  return {
    filters: { jira: known ? filters.map((candidate) => (candidate.id === saved.id ? saved : candidate)) : [...filters, saved] },
    shownFilterId: { jira: saved.id }
  }
}

/** The project's filters without the one `id` names, or null when it is the only one: a Jira
 *  project always has a filter. Deleting the filter shown shows the first remaining one. */
export function withFilterDeleted(settings: FilterSettings, id: string): FilterChanges | null {
  const filters = projectFilters(settings).filter((filter) => filter.id !== id)
  if (filters.length === 0) return null
  const shown = listedFilter(settings).id
  return { filters: { jira: filters }, shownFilterId: { jira: shown === id ? filters[0].id : shown } }
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
  for (let number = 2; ; number++) {
    const name = `Filter ${number}`
    if (!filters.some((filter) => sameFilterName(filter.name, name))) return name
  }
}
