// The provider registry: one line per provider.
import type { RunCli } from '../cli'
import { providerConfig, type ProjectRef, type ProjectSettings, type ProviderConfigs, type ProviderId } from '../protocol'
import { github } from './github'
import { jiraOrca } from './jira-orca'
import { jiraTwg } from './jira-twg'
import type { Provider, TaskPage } from './types'

type Registry = { [K in ProviderId]: Provider<Required<ProviderConfigs>[K]> }

const PROVIDERS: Registry = { github, 'jira-orca': jiraOrca, 'jira-twg': jiraTwg }

export type ListTasks = (run: RunCli, project: ProjectRef, settings: ProjectSettings, cursor?: string) => Promise<TaskPage>

/** Lists tasks with provider `id`, using its stored configuration or its defaults. */
export function taskLister<K extends ProviderId>(id: K): ListTasks {
  const provider: Registry[K] = PROVIDERS[id]
  return (run, project, settings, cursor) => provider.list(run, project, providerConfig(settings, id), cursor)
}
