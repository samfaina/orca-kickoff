import { assert, test } from 'orca/testing'
import { agentInstalledArgs, parseAvailableAgents, resolveAgent } from './agent'
import type { AgentsResult } from './protocol'

/** `orca agent installed --json` as Orca 1.4.271 answers (docs/reference.md). */
const installed = (agents: unknown[]) => JSON.stringify({ id: 'req-1', ok: true, result: { agents }, _meta: { runtimeId: 'rt-1' } })

test('orca agent installed asks for the agents of the host of the worktree named by its id', () => {
  assert.deepEqual(agentInstalledArgs('r1::/src/web'), ['agent', 'installed', '--worktree', 'id:r1::/src/web', '--json'])
})

test('the available agents are read from orca agent installed, in its order, with the one marked default', () => {
  const stdout = installed([
    { id: 'claude', name: 'Claude', default: true },
    { id: 'codex', name: 'Codex', default: false },
    { id: 'copilot', name: 'GitHub Copilot', default: false }
  ])
  assert.deepEqual(parseAvailableAgents(stdout), {
    kind: 'ready',
    agents: [
      { id: 'claude', name: 'Claude', default: true },
      { id: 'codex', name: 'Codex', default: false },
      { id: 'copilot', name: 'GitHub Copilot', default: false }
    ]
  })
})

test('with no agent Orca can start, the list is empty', () => {
  assert.deepEqual(parseAvailableAgents(installed([])), { kind: 'ready', agents: [] })
})

test("an error answer is a failure with Orca's message", () => {
  const stdout = JSON.stringify({ id: 'local', ok: false, error: { code: 'incompatible_runtime', message: 'The paired runtime is too old.' } })
  assert.deepEqual(parseAvailableAgents(stdout), { kind: 'error', message: 'orca failed: The paired runtime is too old.' })
})

test('output that is not JSON, or not of the expected shape, is a failure', () => {
  const unreadable = { kind: 'error', message: "orca returned output Kickoff couldn't read. Update orca and try again." }
  assert.deepEqual(parseAvailableAgents('Unknown command: agent installed'), unreadable)
  assert.deepEqual(parseAvailableAgents(JSON.stringify({ ok: true, result: {} })), unreadable)
})

const agents = (defaultId: string | null): AgentsResult => ({
  kind: 'ready',
  agents: [
    { id: 'claude', name: 'Claude', default: defaultId === 'claude' },
    { id: 'gemini', name: 'Gemini', default: defaultId === 'gemini' }
  ]
})

const unreadable: AgentsResult = { kind: 'error', message: 'orca failed: Orca is not running.' }

test('"No agent" resolves to no agent, whatever the list says', () => {
  assert.deepEqual(resolveAgent('none', agents('claude')), { ok: true, agent: null })
  assert.deepEqual(resolveAgent('none', unreadable), { ok: true, agent: null })
})

test('"Orca default", also when unset, resolves to the agent marked default', () => {
  assert.deepEqual(resolveAgent('orca-default', agents('gemini')), { ok: true, agent: 'gemini' })
  assert.deepEqual(resolveAgent(undefined, agents('claude')), { ok: true, agent: 'claude' })
})

test('"Orca default" with no agent marked default fails with a message to choose one, never guessing', () => {
  const failure = { ok: false, message: "Orca has no default agent: choose one on the task's card or in Project settings." }
  assert.deepEqual(resolveAgent('orca-default', agents(null)), failure)
  assert.deepEqual(resolveAgent(undefined, { kind: 'ready', agents: [] }), failure)
})

test('"Orca default" with a list that can\'t be read fails with a message and the reason', () => {
  assert.deepEqual(resolveAgent('orca-default', unreadable), {
    ok: false,
    message: "Couldn't read Orca's default agent: choose an agent in Project settings. orca failed: Orca is not running."
  })
})

test('an available agent resolves to itself', () => {
  assert.deepEqual(resolveAgent('gemini', agents('claude')), { ok: true, agent: 'gemini' })
})

test("an agent the list doesn't have fails with a message naming it", () => {
  assert.deepEqual(resolveAgent('codex', agents('claude')), {
    ok: false,
    message: "codex isn't available in Orca: choose another agent on the task's card or in Project settings."
  })
})

test("a named agent with a list that can't be read is passed to Orca as it is", () => {
  assert.deepEqual(resolveAgent('codex', unreadable), { ok: true, agent: 'codex' })
})
