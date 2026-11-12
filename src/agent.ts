// The agent a Start launches: the project's agent choice, and Orca's default agent read, read-only,
// from Orca's private profile store (ADR-0003). Reading the store goes through `OrcaStore`, so
// everything else here is pure.
//
// Finding Orca's data folder from the plugin's install path and the active profile from
// `orca-profile-index.json` are adapted from src/settings.ts of rr235/orca-task-launcher,
// Copyright (c) 2026 rr235, MIT License (see LICENSE).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { CliEnvironment } from './cli'
import { isRecord, parseJson } from './json'
import type { AgentChoice } from './protocol'

export const AGENT_UNREADABLE = "Couldn't read Orca's default agent — pick one in the panel."

/** Orca's default agent: an agent id, `blank` (no agent), or not known. */
export type DefaultAgent = { kind: 'agent'; agent: string } | { kind: 'none' } | { kind: 'unreadable' }

/** The agent to launch, `null` for none. */
export type AgentResolution = { ok: true; agent: string | null } | { ok: false; message: string }

/** The project's agent choice as an agent id. "Orca default" (also when unset) reads Orca's
 *  default agent; when that can't be read, Start fails instead of guessing. */
export async function resolveAgent(
  choice: AgentChoice | undefined,
  readDefault: () => Promise<DefaultAgent>
): Promise<AgentResolution> {
  if (choice === 'none') return { ok: true, agent: null }
  if (choice !== undefined && choice !== 'orca-default') return { ok: true, agent: choice }
  let found: DefaultAgent
  try {
    found = await readDefault()
  } catch {
    found = { kind: 'unreadable' }
  }
  if (found.kind === 'agent') return { ok: true, agent: found.agent }
  if (found.kind === 'none') return { ok: true, agent: null }
  return { ok: false, message: AGENT_UNREADABLE }
}

/** Orca's rule on its `settings` document: `blank` is no agent, and a preferred agent counts
 *  unless it is disabled. Orca would then pick the first installed agent, which Kickoff can't
 *  see, so anything else is unreadable. */
export function defaultAgentFromSettings(settings: unknown): DefaultAgent {
  if (!isRecord(settings)) return { kind: 'unreadable' }
  const preferred = settings.defaultTuiAgent
  if (preferred === 'blank') return { kind: 'none' }
  if (typeof preferred !== 'string' || preferred === '') return { kind: 'unreadable' }
  const disabled = Array.isArray(settings.disabledTuiAgents) ? settings.disabledTuiAgents : []
  if (disabled.includes(preferred)) return { kind: 'unreadable' }
  return { kind: 'agent', agent: preferred }
}

const DEFAULT_PROFILE = 'local-default'
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** `activeProfileId` of the profile index, or of its backup, when it is a safe id listed in
 *  `profiles[]`; else Orca's default profile. */
export function activeProfileId(index: string | null, backup: string | null): string {
  for (const raw of [index, backup]) {
    const parsed = raw === null ? undefined : parseJson(raw)
    if (!isRecord(parsed)) continue
    const id = parsed.activeProfileId
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : []
    if (typeof id === 'string' && PROFILE_ID.test(id) && profiles.some((profile) => isRecord(profile) && profile.id === id)) {
      return id
    }
  }
  return DEFAULT_PROFILE
}

const PLUGIN_ID = 'kickoff'
const CONTENT_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/

/** Orca's data folder. An installed plugin lives at `<data>/plugins/<publisher>.kickoff/<hash>/...`,
 *  which works even though Orca removes `APPDATA` and `XDG_CONFIG_HOME` from the worker. Anywhere
 *  else (a development folder) the platform's default is used. */
export function orcaDataDir({ platform, env, home }: CliEnvironment, moduleFile: string | null): string {
  const windows = platform === 'win32'
  if (moduleFile) {
    const parts = moduleFile.split(windows ? /[\\/]/ : /\//)
    for (let i = parts.length - 2; i >= 2; i--) {
      if (parts[i - 1].endsWith(`.${PLUGIN_ID}`) && parts[i - 2] === 'plugins' && CONTENT_HASH.test(parts[i])) {
        return parts.slice(0, i - 2).join(windows ? '\\' : '/')
      }
    }
  }
  if (windows) return `${env.APPDATA || `${home}\\AppData\\Roaming`}\\orca`
  if (platform === 'darwin') return `${home}/Library/Application Support/orca`
  return `${env.XDG_CONFIG_HOME || `${home}/.config`}/orca`
}

/** Read access to Orca's data folder. Both reads give null, or throw, when they can't read. */
export type OrcaStore = {
  readText(path: string): Promise<string | null>
  /** `payload` of the `settings` document in a `profile-state.db`. */
  readSettingsPayload(databasePath: string): Promise<string | null>
}

/** Orca's default agent from the active profile's `profile-state.db`, else its older
 *  `orca-data.json`. */
export async function readDefaultAgent(dataDir: string, store: OrcaStore): Promise<DefaultAgent> {
  const join = (...parts: string[]) => [dataDir, ...parts].join(dataDir.includes('\\') ? '\\' : '/')
  const index = join('orca-profile-index.json')
  const profile = activeProfileId(await readOrNull(() => store.readText(index)), await readOrNull(() => store.readText(`${index}.bak`)))
  const payload = await readOrNull(() => store.readSettingsPayload(join('profiles', profile, 'profile-state.db')))
  const settings = payload === null ? undefined : parseJson(payload)
  if (isRecord(settings)) return defaultAgentFromSettings(settings)
  const legacy = await readOrNull(() => store.readText(join('profiles', profile, 'orca-data.json')))
  const data = legacy === null ? undefined : parseJson(legacy)
  return defaultAgentFromSettings(isRecord(data) ? data.settings : undefined)
}

async function readOrNull(read: () => Promise<string | null>): Promise<string | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

type SqliteModule = {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { get(): unknown }
    close(): void
  }
}

const SETTINGS_QUERY = "SELECT payload FROM profile_state_documents WHERE domain = 'settings'"

/** The real store: files with `node:fs`, the database read-only with Node's built-in `node:sqlite`. */
export const systemOrcaStore: OrcaStore = {
  async readText(path) {
    return readFile(path, 'utf8')
  },
  async readSettingsPayload(path) {
    const { DatabaseSync } = (await import('node:sqlite' as string)) as SqliteModule
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row = db.prepare(SETTINGS_QUERY).get()
      return isRecord(row) && typeof row.payload === 'string' ? row.payload : null
    } finally {
      db.close()
    }
  }
}

/** Reads Orca's default agent on this machine. */
export function systemDefaultAgentReader(): () => Promise<DefaultAgent> {
  return () => {
    let moduleFile: string | null = null
    try {
      moduleFile = fileURLToPath(import.meta.url)
    } catch {
      // Not loaded from a file: use the platform's default folder.
    }
    const dataDir = orcaDataDir({ platform: process.platform, env: process.env, home: homedir() }, moduleFile)
    return readDefaultAgent(dataDir, systemOrcaStore)
  }
}
