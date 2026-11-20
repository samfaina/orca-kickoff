import { assert, test } from 'orca/testing'
import { filterWriteChanges, withFilterMoved, withFilterSaved } from './filter'
import type { GlobalSettings, ProjectSettings } from './protocol'
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

type Stored = { version: 1; projects: Record<string, Record<string, unknown>>; global?: Record<string, unknown> }

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
    /** What is stored for no project. */
    global: () => data?.global,
    /** Stores `value` as if an earlier panel had saved it. */
    seed: (value: Stored) => {
      data = value
    },
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
  saver.change('github:acme/web', { agent: 'codex', providers: { 'jira-twg': { site: '', profile: 'work' } } })
  saver.change('github:acme/web', { agent: 'claude', providers: { 'jira-orca': { siteId: 'site-2' } } })
  assert.deepEqual(timers.delays(), [SAVE_DELAY_MS])
  timers.fire()
  await settle()
  assert.deepEqual(storage.project('github:acme/web'), {
    providers: { 'jira-twg': { site: '', profile: 'work' }, 'jira-orca': { siteId: 'site-2' } },
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

test("a write of a project's changes saves the pending changes first, then computes its change from the settings with them, in one turn of the queue", async () => {
  const { saver, storage, reports } = setup()
  saver.change('github:acme/web', { defaultTemplateId: 't-impl' })
  storage.holdWrites()
  const seen: unknown[] = []
  const writing = saver.writeProjectAndGlobal('github:acme/web', (project) => {
    seen.push(project.defaultTemplateId)
    return { answer: 'written', project: { agent: 'codex' } }
  })
  await settle()
  // A save asked for while the project's write runs waits for both of its writes.
  saver.change('github:acme/web', { agent: 'none' })
  const after = saver.saveNow()
  storage.release()
  await settle()
  storage.release()
  assert.equal(await writing, 'written')
  await settle()
  assert.deepEqual(storage.log, ['get settings', 'set settings', 'get settings', 'set settings', 'get settings', 'set settings'])
  assert.deepEqual(seen, ['t-impl'])
  storage.release()
  await after
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, defaultTemplateId: 't-impl', agent: 'none' })
  assert.deepEqual(reports, ['saved', 'saved'])
})

test("a write of a project's changes whose save of the pending changes fails rejects, writes no change of its own, and keeps them pending", async () => {
  const { saver, storage } = setup()
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  let computed = false
  await assert.rejects(
    saver.writeProjectAndGlobal('github:acme/web', () => {
      computed = true
      return { answer: null, project: { defaultTemplateId: 't-impl' } }
    }),
    /Storage is full/
  )
  assert.equal(computed, false)
  storage.failWrites = false
  await saver.saveNow()
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, agent: 'codex' })
})

test("a failed save after a write that changed nothing still keeps its changes pending", async () => {
  const { saver, storage } = setup()
  await saver.writeProjectAndGlobal('github:acme/web', () => ({ answer: null }))
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  await assert.rejects(saver.saveNow(), /Storage is full/)
  storage.failWrites = false
  await saver.saveNow()
  assert.equal(storage.project('github:acme/web')?.agent, 'codex')
})

const implement = { id: 't-impl', name: 'Implement', text: 'a' }
const review = { id: 't-review', name: 'Review', text: 'b' }

/** Moves Implement from the project to the global templates, as the panel's Global switch does. */
const moveImplement = (project: ProjectSettings, global: GlobalSettings) => ({
  answer: 'moved',
  project: { templates: (project.templates ?? []).filter((template) => template.id !== implement.id) },
  global: { templates: [...(global.templates ?? []), implement] }
})

test("a write of a project's changes and global ones saves the pending changes first, then writes both, computed from the settings as stored, in one write", async () => {
  const { saver, storage, reports } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/web': { providers: {}, templates: [implement] } }, global: { templates: [review] } })
  saver.change('github:acme/web', { agent: 'codex' })
  const seen: unknown[] = []
  const answer = await saver.writeProjectAndGlobal('github:acme/web', (project, global) => {
    seen.push(project.agent, global.templates)
    return moveImplement(project, global)
  })
  assert.equal(answer, 'moved')
  assert.deepEqual(seen, ['codex', [review]])
  assert.deepEqual(storage.log, ['get settings', 'set settings', 'get settings', 'set settings'])
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, templates: [], agent: 'codex' })
  assert.deepEqual(storage.global(), { templates: [review, implement] })
  assert.deepEqual(reports, ['saved'])
})

test('a write of global changes alone keeps every project as stored', async () => {
  const { saver, storage } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/api': { providers: {}, agent: 'none' } }, global: { templates: [review] } })
  await saver.writeProjectAndGlobal('github:acme/web', () => ({ answer: null, global: { templates: [] } }))
  assert.deepEqual(storage.project('github:acme/api'), { providers: {}, agent: 'none' })
  assert.equal(storage.project('github:acme/web'), undefined)
  assert.deepEqual(storage.global(), { templates: [] })
})

test('a move whose write fails rejects and leaves the template where it was, in the project and not global', async () => {
  const { saver, storage } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/web': { providers: {}, templates: [implement] } }, global: { templates: [review] } })
  saver.change('github:acme/web', { agent: 'codex' })
  storage.holdWrites()
  const moving = saver.writeProjectAndGlobal('github:acme/web', moveImplement)
  await settle()
  // The save of the pending changes lands; the move's own write fails.
  storage.release()
  await settle()
  storage.failHeld(quotaExceeded())
  await assert.rejects(moving, /Storage is full/)
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, templates: [implement], agent: 'codex' })
  assert.deepEqual(storage.global(), { templates: [review] })
})

test('a move whose save of the pending changes fails computes nothing, leaves the template where it was, and keeps the changes pending', async () => {
  const { saver, storage } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/web': { providers: {}, templates: [implement] } }, global: { templates: [review] } })
  storage.failWrites = true
  saver.change('github:acme/web', { agent: 'codex' })
  let computed = false
  await assert.rejects(
    saver.writeProjectAndGlobal('github:acme/web', (project, global) => {
      computed = true
      return moveImplement(project, global)
    }),
    /Storage is full/
  )
  assert.equal(computed, false)
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, templates: [implement] })
  assert.deepEqual(storage.global(), { templates: [review] })
  storage.failWrites = false
  await saver.saveNow()
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, templates: [implement], agent: 'codex' })
  assert.deepEqual(storage.global(), { templates: [review] })
})

const board = { id: 'f-board', name: 'Board', queries: ['project = {{jira_project}} ORDER BY rank'] }
const mine = { id: 'f-mine', name: 'Mine', queries: ['assignee = currentUser()'] }
const triage = { id: 'g-triage', name: 'Triage', queries: ['is:open label:needs-triage'] }

/** Moves Board between the project's own Jira filters and the global ones, as the filter editor's
 *  Global switch does. */
const moveBoard = (toGlobal: boolean) => (project: ProjectSettings, global: GlobalSettings) => {
  const move = withFilterMoved(project, 'jira', global.filters?.jira ?? [], board.id, toGlobal, 'g-fresh')
  return move.ok ? { answer: move.id, ...filterWriteChanges(global, 'jira', move.write) } : { answer: move.message }
}

test("a filter move is one write of the project's filters and the global ones, computed from the settings as stored, keeping the global templates and the other tracker's global filters", async () => {
  const { saver, storage } = setup()
  storage.seed({
    version: 1,
    projects: { 'github:acme/web': { providers: {}, filters: { jira: [board, mine] }, shownFilterId: { jira: 'f-board' } } },
    global: { templates: [review], filters: { github: [triage] } }
  })
  saver.change('github:acme/web', { agent: 'codex' })
  assert.equal(await saver.writeProjectAndGlobal('github:acme/web', moveBoard(true)), 'f-board')
  assert.deepEqual(storage.log, ['get settings', 'set settings', 'get settings', 'set settings'])
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, filters: { jira: [mine] }, shownFilterId: { jira: 'f-board' }, agent: 'codex' })
  assert.deepEqual(storage.global(), { templates: [review], filters: { github: [triage], jira: [board] } })

  assert.equal(await saver.writeProjectAndGlobal('github:acme/web', moveBoard(false)), 'f-board')
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, filters: { jira: [mine, board] }, shownFilterId: { jira: 'f-board' }, agent: 'codex' })
  assert.deepEqual(storage.global(), { templates: [review], filters: { github: [triage], jira: [] } })
})

test('a filter move whose write fails rejects and leaves the filter where it was, in the project and not global', async () => {
  const { saver, storage } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/web': { providers: {}, filters: { jira: [board, mine] } } }, global: { filters: { github: [triage] } } })
  saver.change('github:acme/web', { shownFilterId: { jira: 'f-mine' } })
  storage.holdWrites()
  const moving = saver.writeProjectAndGlobal('github:acme/web', moveBoard(true))
  await settle()
  // The save of the pending changes lands; the move's own write fails.
  storage.release()
  await settle()
  storage.failHeld(quotaExceeded())
  await assert.rejects(moving, /Storage is full/)
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, filters: { jira: [board, mine] }, shownFilterId: { jira: 'f-mine' } })
  assert.deepEqual(storage.global(), { filters: { github: [triage] } })
})

test('a filter move whose save of the pending changes fails computes nothing, leaves the filter where it was, and keeps the change pending', async () => {
  const { saver, storage } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/web': { providers: {}, filters: { jira: [board, mine] } } } })
  storage.failWrites = true
  saver.change('github:acme/web', { shownFilterId: { jira: 'f-mine' } })
  let computed = false
  const move = moveBoard(true)
  await assert.rejects(
    saver.writeProjectAndGlobal('github:acme/web', (project, global) => {
      computed = true
      return move(project, global)
    }),
    /Storage is full/
  )
  assert.equal(computed, false)
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, filters: { jira: [board, mine] } })
  assert.equal(storage.global(), undefined)
  storage.failWrites = false
  await saver.saveNow()
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, filters: { jira: [board, mine] }, shownFilterId: { jira: 'f-mine' } })
  assert.equal(storage.global(), undefined)
})

test('a global filter saved from one project keeps the filter another project chose to show, still pending', async () => {
  const { saver, storage } = setup()
  storage.seed({ version: 1, projects: { 'github:acme/api': { providers: {} } }, global: { filters: { jira: [board] } } })
  saver.change('github:acme/api', { shownFilterId: { jira: 'f-board' } })
  await saver.writeProjectAndGlobal('github:acme/web', (project, global) => {
    const write = withFilterSaved(project, 'jira', global.filters?.jira ?? [], { ...board, name: 'Sprint board' }, true)
    return { answer: null, ...filterWriteChanges(global, 'jira', write) }
  })
  assert.deepEqual(storage.project('github:acme/api'), { providers: {}, shownFilterId: { jira: 'f-board' } })
  assert.deepEqual(storage.global(), { filters: { jira: [{ ...board, name: 'Sprint board' }] } })
})

test('a write whose compute gives no changes writes nothing more, and answers its answer', async () => {
  const { saver, storage } = setup()
  assert.equal(await saver.writeProjectAndGlobal('github:acme/web', () => ({ answer: 'refused' })), 'refused')
  assert.deepEqual(storage.log, ['get settings'])
})

test("a timed save, and a write of a project's changes alone, keep the global templates and filters", async () => {
  const { saver, storage, timers } = setup()
  storage.seed({ version: 1, projects: {}, global: { templates: [review], filters: { github: [triage] } } })
  saver.change('github:acme/web', { agent: 'codex' })
  timers.fire()
  await settle()
  await saver.writeProjectAndGlobal('github:acme/web', () => ({ answer: null, project: { defaultTemplateId: 't-review' } }))
  assert.deepEqual(storage.project('github:acme/web'), { providers: {}, agent: 'codex', defaultTemplateId: 't-review' })
  assert.deepEqual(storage.global(), { templates: [review], filters: { github: [triage] } })
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
