// The provider registry: one line per provider.
import type { RunCli } from '../cli'
import { chooseProvider, type ProjectRef, type ProjectSettings, type ProviderConfigs, type ProviderId } from '../protocol'
import { github } from './github'
import type { Provider, TaskPage } from './types'

type Registry = { [K in ProviderId]?: Provider<NonNullable<ProviderConfigs[K]>> }

const PROVIDERS: Registry = { github }

export type ListTasks = (run: RunCli, project: ProjectRef, settings: ProjectSettings, cursor?: string) => Promise<TaskPage>

/** Lists tasks with provider `id`, using its stored configuration or its defaults; null when
 *  this version has no such provider. */
export function taskLister<K extends ProviderId>(id: K): ListTasks | null {
  const provider: Provider<NonNullable<ProviderConfigs[K]>> | undefined = PROVIDERS[id]
  if (!provider) return null
  return (run, project, settings, cursor) => {
    // Choosing the provider again fills in its default configuration when none is stored.
    const config = chooseProvider(settings, id).providers[id] as NonNullable<ProviderConfigs[K]>
    return provider.list(run, project, config, cursor)
  }
}
