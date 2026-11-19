// What every provider implements. Adding one takes a `ProviderConfigs` entry (src/protocol.ts), a
// provider file, a line in the registry (./index.ts) and its settings in the panel.
import type { RunCli } from '../cli'
import type { Filter, ProjectRef, ProviderId, Task, TrackerId } from '../protocol'

export type TaskPage = { tasks: Task[]; nextCursor: string | null; truncated: boolean }

/** Which page to list. `filter`: the filter whose tasks to list, which a Jira provider needs; GitHub
 *  has no filters yet. `query` makes it a tracker search: the user's plain words, never tracker
 *  syntax. A cursor belongs to the list of the filter, or the tracker search with the same words,
 *  that listed the page before it. */
export type PageRequest = { filter?: Filter; cursor?: string; query?: string }

export interface Provider<Config> {
  id: ProviderId
  tracker: TrackerId
  label: string
  /** One page of open tasks: of the whole list, or of those that match `request.query` when it
   *  has words. Rejects with a message the panel can show. `run` is injected so providers can be
   *  tested without running anything. */
  list(run: RunCli, project: ProjectRef, config: Config, request?: PageRequest): Promise<TaskPage>
}

/** The words of a tracker search, split on whitespace. A blank query has none. */
export function searchWords(query = ''): string[] {
  return query.split(/\s+/).filter((word) => word !== '')
}
