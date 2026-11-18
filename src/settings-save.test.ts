import { assert, test } from 'orca/testing'
import { SAVE_DELAY_MS, settingsSaver } from './settings-save'

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every promise callback that is ready run. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A storage error, as Orca gives one. */
const quotaExceeded = () => Object.assign(new Error('Storage is full'), { code: 'quota_exceeded' })

type Stored = { version: 1; projects: Record<string, Record<string, unknown>> }

/** Storage the test drives: each write lands at once, unless `holdWrites()` holds the next ones
 *  until the test settles them, or `failWrites` fails them. `log` says when each read and write
 *  happens. */
function fakeStorage() {
  let data: Stored | null = null
  const log: string[] = []
  const held: { settle: () => void; fail: (error: unknown) => void }[] = []
  let holding = false
  const storage = {
    failWrites: false,
    log,
    /** The stored settings of `projectId`. */
    project: (projectId: string) => data?.projects[projectId],
    holdWrites: () => {
      holding = true
    },
    /** Lands the oldest held write. */
    release: () => held.shift()?.settle(),
    /** Fails the oldest held write. */
    failHeld: (error: unknown) => held.shift()?.fail(error),
    held: () => held.length,
    get: async (key: string) => {
      log.push(`get ${key}`)
      return data
    },
    set: (key: string, value: unknown): Promise<void> => {
      log.push(`set ${key}`)
      const land = () => {
        data = value as Stored
      }
      if (storage.failWrites) return Promise.reject(quotaExceeded())
      if (!holding) {
        land()
        return Promise.resolve()
      }
      const write = deferred()
      held.push({ settle: () => (land(), write.resolve()), fail: write.reject })
      return write.promise
    }
  }
  return storage
}

/** Timers the test fires by hand. */
function fakeTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 1
  return {
    setTimeout: (run: () => void, ms: number) => {
      pending.set(next, { run, ms })
      return next++
    },
    clearTimeout: (handle: unknown) => {
      pending.delete(handle as number)
    },
    /** The delays of the timers still pending. */
    delays: () => [...pending.values()].map((timer) => timer.ms),
    /** Runs every pending timer. */
    fire: () => {
      const runs = [...pending.values()]
      pending.clear()
      for (const timer of runs) timer.run()
    }
  }
}

/** A saver over fake storage and timers, with what it reported to the panel. */
function setup() {
  const storage = fakeStorage()
  const timers = fakeTimers()
  const reports: string[] = []
  const saver = settingsSaver({
    storage,
    timers,
    onSaved: () => reports.push('saved'),
    onTimedSaveFailed: (error) => reports.push(`timed save failed: ${(error as { code: string }).code}`)
  })
  return { saver, storage, timers, reports }
}

/** Waits until the saver has nothing more to do on its own. */
async function settle(): Promise<void> {
  for (let turns = 0; turns < 10; turns++) await turn()
}

test('a change saves itself once its timer of SAVE_DELAY_MS fires', async () => {
  const { saver, storage, timers } = setup()
  saver.change('github:acme/web', { agent: 'codex' })
  assert.deepEqual(timers.delays(), [SAVE_DELAY_MS])
  assert.equal(storage.project('github:acme/web'), undefined)
  timers.fire()
  await settle()
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
})

test("a later change restarts the timer, and the save writes both changes of the project, the later on top, keeping the providers either changed", async () => {
  const { saver, storage, timers } = setup()
  saver.change('github:acme/web', { agent: 'codex', providers: { 'jira-twg': { jql: ['project = WEB'], site: '', profile: '' } } })
  saver.change('github:acme/web', { agent: 'claude', providers: { 'jira-orca': { jql: ['project = API'], siteId: '' } } })
  assert.deepEqual(timers.delays(), [SAVE_DELAY_MS])
  timers.fire()
  await settle()
  assert.deepEqual(storage.project('github:acme/web'), {
    providers: { 'jira-twg': { jql: ['project = WEB'], site: '', profile: '' }, 'jira-orca': { jql: ['project = API'], siteId: '' } },
    agent: 'claude'
  })
})

test('a failed timed save keeps its changes pending under the ones made meanwhile, and rejects nowhere', async () => {
  const { saver, storage, timers, reports } = setup()
  storage.holdWrites()
  saver.change('github:acme/web', { agent: 'codex', defaultTemplateId: 't-triage' })
  timers.fire()
  await settle()
  assert.equal(storage.held(), 1)
  saver.change('github:acme/web', { agent: 'claude' })
  storage.failHeld(quotaExceeded())
  await settle()
  assert.deepEqual(reports, ['timed save failed: quota_exceeded'])
  timers.fire()
  await settle()
  storage.release()
  await settle()
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, agent: 'claude', defaultTemplateId: 't-triage' })
  assert.deepEqual(reports, ['timed save failed: quota_exceeded', 'saved'])
})

test('Save now saves every pending change at once and cancels the timer', async () => {
  const { saver, storage, timers, reports } = setup()
  saver.change('github:acme/web', { agent: 'codex' })
  saver.change('github:acme/api', { agent: 'none' })
  await saver.saveNow()
  assert.deepEqual(timers.delays(), [])
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
  assert.equal(storage.project('github:acme/api')?.agent, 'none')
  assert.deepEqual(storage.log, ['get settings', 'set settings'])
  assert.deepEqual(reports, ['saved'])
})

test('a failed Save now rejects with the failure, reports no timed save, and keeps the changes for the next save', async () => {
  const { saver, storage, reports } = setup()
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  await assert.rejects(saver.saveNow(), /Storage is full/)
  assert.deepEqual(reports, [])
  storage.failWrites = false
  await saver.saveNow()
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
})

test("two saves asked for at once write one after the other, and neither loses the other's change", async () => {
  const { saver, storage, timers } = setup()
  storage.holdWrites()
  saver.change('github:acme/web', { agent: 'codex' })
  timers.fire()
  await settle()
  saver.change('github:acme/web', { defaultTemplateId: 't-impl' })
  const now = saver.saveNow()
  await settle()
  assert.deepEqual(storage.log, ['get settings', 'set settings'])
  storage.release()
  await settle()
  assert.deepEqual(storage.log, ['get settings', 'set settings', 'get settings', 'set settings'])
  storage.release()
  await now
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, agent: 'codex', defaultTemplateId: 't-impl' })
})

test('a template write saves the pending changes first, then computes its change from the settings with them, in one turn of the queue', async () => {
  const { saver, storage, reports } = setup()
  saver.change('github:acme/web', { defaultTemplateId: 't-impl' })
  storage.holdWrites()
  const seen: unknown[] = []
  const writing = saver.writeProject('github:acme/web', (project) => {
    seen.push(project.defaultTemplateId)
    return { agent: 'codex' }
  })
  await settle()
  // A save asked for while the template write runs waits for both of its writes.
  saver.change('github:acme/web', { agent: 'none' })
  const after = saver.saveNow()
  storage.release()
  await settle()
  storage.release()
  assert.deepEqual(await writing, { agent: 'codex' })
  await settle()
  assert.deepEqual(storage.log, ['get settings', 'set settings', 'get settings', 'set settings', 'get settings', 'set settings'])
  assert.deepEqual(seen, ['t-impl'])
  storage.release()
  await after
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, defaultTemplateId: 't-impl', agent: 'none' })
  assert.deepEqual(reports, ['saved', 'saved'])
})

test('a template write whose save of the pending changes fails rejects, writes no template change, and keeps them pending', async () => {
  const { saver, storage } = setup()
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  let computed = false
  await assert.rejects(
    saver.writeProject('github:acme/web', () => {
      computed = true
      return { defaultTemplateId: 't-impl' }
    }),
    /Storage is full/
  )
  assert.equal(computed, false)
  storage.failWrites = false
  await saver.saveNow()
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, agent: 'codex' })
})

test('a template write whose change is none writes nothing more', async () => {
  const { saver, storage } = setup()
  assert.equal(await saver.writeProject('github:acme/web', () => null), null)
  assert.deepEqual(storage.log, ['get settings'])
})

test('a failed save after a template write that changed nothing still keeps its changes pending', async () => {
  const { saver, storage } = setup()
  await saver.writeProject('github:acme/web', () => null)
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  await assert.rejects(saver.saveNow(), /Storage is full/)
  storage.failWrites = false
  await saver.saveNow()
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
})

test('unload saves the pending changes once and cancels the timer', async () => {
  const { saver, storage, timers } = setup()
  saver.change('github:acme/web', { agent: 'codex' })
  saver.unload()
  assert.deepEqual(timers.delays(), [])
  await settle()
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
  assert.deepEqual(storage.log, ['get settings', 'set settings'])
})

test('a failed unload save drops its changes, reports nothing, and rejects nowhere', async () => {
  const { saver, storage, reports } = setup()
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  saver.unload()
  await settle()
  assert.deepEqual(storage.log, ['get settings', 'set settings'])
  assert.deepEqual(reports, [])
  storage.failWrites = false
  await saver.saveNow()
  assert.deepEqual(storage.log, ['get settings', 'set settings'])
  assert.equal(storage.project('github:acme/web'), undefined)
})

test("a change in project B after a failed save of project A keeps A's changes, and the next save writes both", async () => {
  const { saver, storage, timers, reports } = setup()
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  timers.fire()
  await settle()
  assert.deepEqual(reports, ['timed save failed: quota_exceeded'])
  storage.failWrites = false
  saver.change('github:acme/api', { defaultTemplateId: 't-impl' })
  timers.fire()
  await settle()
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
  assert.equal(storage.project('github:acme/api')?.defaultTemplateId, 't-impl')
  assert.deepEqual(reports, ['timed save failed: quota_exceeded', 'saved'])
})
