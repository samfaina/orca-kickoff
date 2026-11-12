import { assert, test } from 'orca/testing'
import {
  activeProfileId,
  AGENT_UNREADABLE,
  defaultAgentFromSettings,
  orcaDataDir,
  readDefaultAgent,
  resolveAgent,
  type DefaultAgent,
  type OrcaStore
} from './agent'

const never = async (): Promise<DefaultAgent> => {
  throw new Error('the default agent should not be read')
}

test('"No agent" resolves to no agent without reading Orca', async () => {
  assert.deepEqual(await resolveAgent('none', never), { ok: true, agent: null })
})

test('a named agent resolves to itself without reading Orca', async () => {
  assert.deepEqual(await resolveAgent('codex', never), { ok: true, agent: 'codex' })
})

test("Orca default, also when unset, resolves through Orca's default agent", async () => {
  const claude = async (): Promise<DefaultAgent> => ({ kind: 'agent', agent: 'claude' })
  assert.deepEqual(await resolveAgent('orca-default', claude), { ok: true, agent: 'claude' })
  assert.deepEqual(await resolveAgent(undefined, claude), { ok: true, agent: 'claude' })
  assert.deepEqual(await resolveAgent(undefined, async () => ({ kind: 'none' })), { ok: true, agent: null })
})

test("an unreadable default agent fails Start with a message to pick one, never 'claude'", async () => {
  assert.deepEqual(await resolveAgent('orca-default', async () => ({ kind: 'unreadable' })), { ok: false, message: AGENT_UNREADABLE })
  assert.deepEqual(await resolveAgent('orca-default', never), { ok: false, message: AGENT_UNREADABLE })
  assert.equal(AGENT_UNREADABLE, "Couldn't read Orca's default agent — pick one in the panel.")
})

test('`blank` resolves to no agent', () => {
  assert.deepEqual(defaultAgentFromSettings({ defaultTuiAgent: 'blank', disabledTuiAgents: [] }), { kind: 'none' })
})

test('a preferred agent resolves to itself', () => {
  assert.deepEqual(defaultAgentFromSettings({ defaultTuiAgent: 'gemini', disabledTuiAgents: ['codex'] }), { kind: 'agent', agent: 'gemini' })
  assert.deepEqual(defaultAgentFromSettings({ defaultTuiAgent: 'gemini' }), { kind: 'agent', agent: 'gemini' })
})

test('a preferred agent listed in disabledTuiAgents is an error', () => {
  assert.deepEqual(defaultAgentFromSettings({ defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] }), { kind: 'unreadable' })
})

test('settings without a preferred agent are unreadable', () => {
  assert.deepEqual(defaultAgentFromSettings({}), { kind: 'unreadable' })
  assert.deepEqual(defaultAgentFromSettings({ defaultTuiAgent: '' }), { kind: 'unreadable' })
  assert.deepEqual(defaultAgentFromSettings(null), { kind: 'unreadable' })
})

test('the active profile comes from the index, then its backup, then local-default', () => {
  const index = JSON.stringify({ schemaVersion: 1, activeProfileId: 'work', profiles: [{ id: 'local-default' }, { id: 'work' }] })
  assert.equal(activeProfileId(index, null), 'work')
  assert.equal(activeProfileId('{ torn', index), 'work')
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: 'ghost', profiles: [{ id: 'work' }] }), null), 'local-default')
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: '../etc', profiles: [{ id: '../etc' }] }), null), 'local-default')
  assert.equal(activeProfileId(null, null), 'local-default')
})

const hash = 'a'.repeat(64)

test("Orca's data folder comes from the plugin's install path, which ends in .kickoff", () => {
  const windows = { platform: 'win32', env: {}, home: 'C:\\Users\\someone' }
  assert.equal(
    orcaDataDir(windows, `D:\\Data\\orca\\plugins\\local.kickoff\\${hash}\\src\\agent.ts`),
    'D:\\Data\\orca'
  )
  const linux = { platform: 'linux', env: {}, home: '/home/someone' }
  assert.equal(orcaDataDir(linux, `/home/someone/.config/orca/plugins/acme.kickoff/${hash}/src/agent.ts`), '/home/someone/.config/orca')
})

test("outside an install, Orca's data folder is the platform's default", () => {
  const dev = 'C:\\src\\orca-kickoff\\src\\agent.ts'
  assert.equal(orcaDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\someone' }, dev), 'C:\\Users\\someone\\AppData\\Roaming\\orca')
  assert.equal(orcaDataDir({ platform: 'win32', env: { APPDATA: 'E:\\Roaming' }, home: 'C:\\Users\\someone' }, null), 'E:\\Roaming\\orca')
  assert.equal(
    orcaDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\someone' }, `C:\\x\\plugins\\acme.other\\${hash}\\src\\agent.ts`),
    'C:\\Users\\someone\\AppData\\Roaming\\orca'
  )
  assert.equal(orcaDataDir({ platform: 'darwin', env: {}, home: '/Users/someone' }, null), '/Users/someone/Library/Application Support/orca')
  assert.equal(orcaDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/someone' }, null), '/cfg/orca')
  assert.equal(orcaDataDir({ platform: 'linux', env: {}, home: '/home/someone' }, null), '/home/someone/.config/orca')
})

/** A store holding these files, and these `settings` payloads by database path. */
function fakeStore(files: Record<string, string>, databases: Record<string, string | Error> = {}): OrcaStore & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readText(path) {
      reads.push(path)
      return files[path] ?? null
    },
    async readSettingsPayload(path) {
      reads.push(path)
      const payload = databases[path]
      if (payload instanceof Error) throw payload
      return payload ?? null
    }
  }
}

const data = 'D:\\Data\\orca'
const indexFile = `${data}\\orca-profile-index.json`
const workIndex = JSON.stringify({ activeProfileId: 'work', profiles: [{ id: 'work' }] })

test("the default agent is read from the active profile's profile-state.db", async () => {
  const store = fakeStore(
    { [indexFile]: workIndex },
    { [`${data}\\profiles\\work\\profile-state.db`]: JSON.stringify({ defaultTuiAgent: 'codex', disabledTuiAgents: [] }) }
  )
  assert.deepEqual(await readDefaultAgent(data, store), { kind: 'agent', agent: 'codex' })
})

test('without a readable profile-state.db, the default agent comes from orca-data.json', async () => {
  const store = fakeStore(
    { [indexFile]: workIndex, [`${data}\\profiles\\work\\orca-data.json`]: JSON.stringify({ settings: { defaultTuiAgent: 'blank' } }) },
    { [`${data}\\profiles\\work\\profile-state.db`]: new Error('SQLITE_CANTOPEN') }
  )
  assert.deepEqual(await readDefaultAgent(data, store), { kind: 'none' })
})

test('an unreadable store is an error, not claude', async () => {
  assert.deepEqual(await readDefaultAgent(data, fakeStore({})), { kind: 'unreadable' })
  const corrupt = fakeStore({ [`${data}\\profiles\\local-default\\orca-data.json`]: '{ not json' })
  assert.deepEqual(await readDefaultAgent(data, corrupt), { kind: 'unreadable' })
})
