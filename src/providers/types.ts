// What every provider implements. Adding one takes a `ProviderConfigs` entry (src/protocol.ts), a
// provider file, a line in the registry (./index.ts) and its settings in the panel.
import type { RunCli } from '../cli'
import type { ProjectRef, ProviderId, Task, TrackerId } from '../protocol'

export type TaskPage = { tasks: Task[]; nextCursor: string | null; truncated: boolean }

export interface Provider<Config> {
  id: ProviderId
  tracker: TrackerId
  label: string
  /** One page of open tasks. Rejects with a message the panel can show. `run` is injected so
   *  providers can be tested without running anything. */
  list(run: RunCli, project: ProjectRef, config: Config, cursor?: string): Promise<TaskPage>
}
