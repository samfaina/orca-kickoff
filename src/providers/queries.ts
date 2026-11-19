// What every provider shares in listing a filter: the rule that a blank query never runs, the
// failure the person fixes in the filter editor, and how the tasks of a filter's queries make one
// list.
import { CliError } from '../cli'
import { appendTasks, filterQueries, type Filter, type FilterQuery, type Task } from '../protocol'
import type { TaskPage } from './types'

/** A failure that the queries of the filter `filterId` cause, which the person fixes in the filter
 *  editor: one of them that the tracker rejected, or none to run. */
export class FilterError extends CliError {
  readonly filterId: string

  constructor(message: string, filterId: string) {
    super(message)
    this.filterId = filterId
  }
}

/** The filter to list and its queries to run (see `filterQueries`). With no filter, or none of its
 *  queries that isn't blank, it throws `ask`, after the filter's name, so the tool never runs
 *  without one. */
export function requireQueries(filter: Filter | undefined, ask: string): { filter: Filter; queries: FilterQuery[] } {
  const queries = filterQueries(filter?.queries ?? [])
  if (filter && queries.length > 0) return { filter, queries }
  throw filter ? new FilterError(`${filter.name}: ${ask}`, filter.id) : new CliError(ask)
}

/** The only page of a filter whose tool has no cursor: `search` runs every query at once, and their
 *  tasks are joined in query order, truncated when any query's are. The first query that failed,
 *  in the filter's order, fails the list with `failure(query, error)`. */
export async function searchEveryQuery(
  queries: readonly FilterQuery[],
  search: (query: FilterQuery) => Promise<{ tasks: Task[]; truncated: boolean }>,
  failure: (query: FilterQuery, error: unknown) => unknown
): Promise<TaskPage> {
  const searches = await Promise.allSettled(queries.map(search))
  const pages = searches.map((outcome, index) => {
    if (outcome.status === 'rejected') throw failure(queries[index], outcome.reason)
    return outcome.value
  })
  return { tasks: mergeQueryTasks(pages.map((page) => page.tasks)), nextCursor: null, truncated: pages.some((page) => page.truncated) }
}

/** The tasks of each query's page, in query order, each task once, where it first appears. */
function mergeQueryTasks(pages: readonly Task[][]): Task[] {
  return pages.reduce<Task[]>((tasks, page) => appendTasks(tasks, page), [])
}
