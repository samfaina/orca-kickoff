// What every provider shares in listing a filter: the rule that a blank query never runs, the
// failure the person fixes in the filter editor, and how the tasks of a filter's queries make one
// list.
import { CliError } from '../cli'
import { appendTasks, filterQueries, type Filter, type FilterQuery, type Task } from '../protocol'

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

/** The tasks of each query's page, in query order, each task once, where it first appears. */
export function mergeQueryTasks(pages: readonly Task[][]): Task[] {
  return pages.reduce<Task[]>((tasks, page) => appendTasks(tasks, page), [])
}
