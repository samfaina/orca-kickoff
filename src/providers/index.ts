// The provider registry: one line per provider.
import type { RunCli } from '../cli'
import { providerConfig, type ProjectRef, type ProjectSettings, type ProviderConfigs, type ProviderId } from '../protocol'
import { github } from './github'
import type { Provider, TaskPage } from './types'

type Registry = { [K in ProviderId]?: Provider<Required<ProviderConfigs>[K]> }

const PROVIDERS: Registry = { github }

export type ListTasks = (run: RunCli, project: ProjectRef, settings: ProjectSettings, cursor?: string) => Promise<TaskPage>

/** Lists tasks with provider `id`, using its stored configuration or its defaults; null when
 *  this version has no such provider. */
export function taskLister<K extends ProviderId>(id: K): ListTasks | null {
  const provider: Registry[K] = PROVIDERS[id]
  if (!provider) return null
  return (run, project, settings, cursor) => provider.list(run, project, providerConfig(settings, id), cursor)
}
