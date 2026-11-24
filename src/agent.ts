// The agent a Start or a Run here launches: the one chosen on the task's card, else the project's
// agent choice, checked against the agents Orca can start, which `orca agent installed` lists
// (ADR-0004). Pure: the worker runs the command.
import { unreadableOutput } from './cli'
import { isRecord } from './json'
import { orcaResult } from './orca'
import { orcaDefaultAgent, type AgentChoice, type AgentsResult } from './protocol'

/** `orca agent installed`: the agents Orca can start on the host of the worktree `selector` names,
 *  such as `active` or `id:<worktree id>`. */
export function agentInstalledArgs(selector: string): string[] {
  return ['agent', 'installed', '--worktree', selector, '--json']
}

/** The available agents from `orca agent installed --json`, or the failure an error answer or
 *  output of another shape gives. An agent without an id is dropped; one without a name is named
 *  by its id. */
export function parseAvailableAgents(stdout: string): AgentsResult {
  try {
    const result = orcaResult(stdout)
    if (!isRecord(result) || !Array.isArray(result.agents)) throw unreadableOutput('orca')
    return {
      kind: 'ready',
      agents: result.agents.flatMap((agent) => {
        if (!isRecord(agent) || typeof agent.id !== 'string' || agent.id === '') return []
        const name = typeof agent.name === 'string' && agent.name !== '' ? agent.name : agent.id
        return [{ id: agent.id, name, default: agent.default === true }]
      })
    }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/** The agent to launch, `null` for none. */
export type AgentResolution = { ok: true; agent: string | null } | { ok: false; message: string }

/** The agent chosen for a task, on its card or as the project's agent choice, as an agent id,
 *  given the available agents or why they couldn't be read. "No agent" is none. "Orca default",
 *  also when unset, is the agent marked default, and fails when none is or the list can't be read:
 *  Kickoff doesn't guess Orca's fallback. A named agent the list doesn't have fails before Orca is
 *  asked; with no list it goes to Orca as it is, which refuses an unknown id itself. The messages
 *  name both places an agent is chosen, except when the list can't be read: the card then offers
 *  no agent `Select`. */
export function resolveAgent(choice: AgentChoice | undefined, available: AgentsResult): AgentResolution {
  if (choice === 'none') return { ok: true, agent: null }
  if (choice === undefined || choice === 'orca-default') {
    if (available.kind === 'error') {
      return { ok: false, message: `Couldn't read Orca's default agent: choose an agent in Project settings. ${available.message}` }
    }
    const orcaDefault = orcaDefaultAgent(available.agents)
    return orcaDefault ? { ok: true, agent: orcaDefault.id } : { ok: false, message: "Orca has no default agent: choose one on the task's card or in Project settings." }
  }
  if (available.kind === 'ready' && !available.agents.some((agent) => agent.id === choice)) {
    return { ok: false, message: `${choice} isn't available in Orca: choose another agent on the task's card or in Project settings.` }
  }
  return { ok: true, agent: choice }
}
