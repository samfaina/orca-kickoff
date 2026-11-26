// What every provider shares in listing a filter: the rule that a blank query never runs, the
// failure the person fixes in the filter editor, and how the tasks of a filter's queries make one
// list: all at once for a tool with no cursor, or a page filled across them, with a cursor per
// query, for a tool with one.
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

/** What a list throws when the tool failed with `error` on `query`, such as a `FilterError` when
 *  the tracker rejected the query, or `error` itself. */
export type QueryFailure = (query: FilterQuery, error: unknown) => unknown

/** The only page of a filter whose tool has no cursor: `search` runs every query at once, and their
 *  tasks are joined in query order, truncated when any query's are. The first query that failed,
 *  in the filter's order, fails the list with `failure(query, error)`. */
export async function searchEveryQuery(
  queries: readonly FilterQuery[],
  search: (query: FilterQuery) => Promise<{ tasks: Task[]; truncated: boolean }>,
  failure: QueryFailure
): Promise<TaskPage> {
  const searches = await Promise.allSettled(queries.map(search))
  const pages = searches.map((outcome, index) => {
    if (outcome.status === 'rejected') throw failure(queries[index], outcome.reason)
    return outcome.value
  })
  return { tasks: mergeQueryTasks(pages.map((page) => page.tasks)), nextCursor: null, truncated: pages.some((page) => page.truncated) }
}

/** Where a page of a filter whose tool has a cursor starts: `index` counts the queries that run
 *  (the non-blank ones) from 0, and `after` is the tool's cursor in that query, '' for its first
 *  page. */
export type QueryPosition = { index: number; after: string }

/** The cursor the panel gets for a position, `<index>:<tool cursor>`. It stays opaque to the panel. */
export function encodeQueryCursor({ index, after }: QueryPosition): string {
  return `${index}:${after}`
}

/** The position of a cursor from `encodeQueryCursor`, among `count` queries. A cursor of any other
 *  shape, or past the last query, starts from the first query. */
export function decodeQueryCursor(cursor: string | undefined, count: number): QueryPosition {
  const match = /^(0|[1-9]\d*):([\s\S]*)$/.exec(cursor ?? '')
  const index = match ? Number(match[1]) : -1
  return match && index < count ? { index, after: match[2] } : { index: 0, after: '' }
}

/** One page of a query from a tool with a cursor, and the tool's cursor for the next one, null
 *  when the query has no more. */
export type QueryPage = { tasks: Task[]; nextCursor: string | null }

/** One page of up to `limit` tasks of a filter whose tool has a cursor, from where `cursor` (from
 *  `encodeQueryCursor`) points, in query order: each query is read to its end before the next.
 *  `queries` are those `requireQueries` gives, so there is at least one. `readPage(query, after,
 *  limit)` asks the tool for at most `limit` tasks of `query` after its cursor `after`. When a
 *  query ends before the page is full, the same load goes on with the next one, asking only for
 *  the tasks the page still needs. The load stops at the first query with a next page, or once
 *  the page is full, with a cursor to go on from there; the last query's end gives none. A task
 *  several queries list is on the page once, where it first appears, so a page can show fewer
 *  than `limit`. A query that fails fails the list with `failure(query, error)`. */
export async function pageAcrossQueries(
  queries: readonly FilterQuery[],
  cursor: string | undefined,
  limit: number,
  readPage: (query: FilterQuery, after: string, limit: number) => Promise<QueryPage>,
  failure: QueryFailure
): Promise<TaskPage> {
  let { index, after } = decodeQueryCursor(cursor, queries.length)
  let tasks: Task[] = []
  for (;;) {
    const query = queries[index]
    const answer = await readPage(query, after, limit - tasks.length).catch((error: unknown) => {
      throw failure(query, error)
    })
    tasks = appendTasks(tasks, answer.tasks)
    if (answer.nextCursor !== null) return { tasks, nextCursor: encodeQueryCursor({ index, after: answer.nextCursor }), truncated: false }
    if (index === queries.length - 1) return { tasks, nextCursor: null, truncated: false }
    if (tasks.length >= limit) return { tasks, nextCursor: encodeQueryCursor({ index: index + 1, after: '' }), truncated: false }
    index++
    after = ''
  }
}

/** The tasks of each query's page, in query order, each task once, where it first appears. */
function mergeQueryTasks(pages: readonly Task[][]): Task[] {
  return pages.reduce<Task[]>((tasks, page) => appendTasks(tasks, page), [])
}
