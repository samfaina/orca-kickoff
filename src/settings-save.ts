// Saving Project settings and what belongs to no project, the global prompt templates, filters and
// branch settings: the changes not saved yet, per project and to the global branch settings, and
// every read-modify-write of the settings in storage, one at a time. No Orca API: the panel gives
// it storage and timers, so the tests can hold a read, a write or a timer and settle it by hand.
import {
  globalSettings,
  projectSettings,
  readSettings,
  SETTINGS_KEY,
  withGlobalChanges,
  withProjectChanges,
  type BranchSettings,
  type GlobalChanges,
  type GlobalSettings,
  type ProjectChanges,
  type ProjectSettings,
  type Settings
} from './protocol'
import { serialQueue } from './queue'

/** Project settings save themselves this long after the last change. */
export const SAVE_DELAY_MS = 600

/** The storage the settings are kept in. */
export type SettingsStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: Settings): Promise<unknown>
}

/** The timers the timed save runs on. */
export type SaveTimers = {
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type SettingsSaverOptions = {
  storage: SettingsStorage
  timers: SaveTimers
  /** A save of pending changes succeeded, by any path. */
  onSaved: () => void
  /** The timed save failed; its changes stay pending. */
  onTimedSaveFailed: (error: unknown) => void
}

/** `earlier` changes with `later` ones on top, keeping the providers either changed. */
function mergeChanges(earlier: ProjectChanges, later: ProjectChanges): ProjectChanges {
  return { ...earlier, ...later, providers: { ...earlier.providers, ...later.providers } }
}

/** Saves Project settings, and what belongs to no project, for the panel: each change of a project,
 *  and each edit of the global branch settings, waits with the other pending changes for the timed
 *  save, or for a caller that saves now. Every save writes every pending change in one write, every
 *  write keeps what it doesn't change, everything global included, and no promise it leaves goes
 *  unhandled. Other global changes are written at once, never left pending. */
export function settingsSaver({ storage, timers, onSaved, onTimedSaveFailed }: SettingsSaverOptions) {
  /** The changes not saved yet, by project. */
  const pending = new Map<string, ProjectChanges>()
  /** The edits of the global branch settings not saved yet, by field. */
  let pendingBranch: BranchSettings | null = null
  const writes = serialQueue()
  /** The timer of the timed save, while one is pending. */
  let timer: unknown = null

  /** `settings` with `changes`, by project, and `branch`, edits of the global branch settings, on
   *  top. */
  function withChanges(settings: Settings, changes: ReadonlyMap<string, ProjectChanges>, branch: BranchSettings | null): Settings {
    for (const [projectId, project] of changes) settings = withProjectChanges(settings, projectId, project)
    return branch ? withGlobalChanges(settings, { branch: { ...globalSettings(settings).branch, ...branch } }) : settings
  }

  /** Stops the timer of a pending save, for a save that runs sooner. */
  function cancelTimer(): void {
    if (timer !== null) timers.clearTimeout(timer)
    timer = null
  }

  /** Saves every project's pending changes, and the pending edits of the global branch settings on
   *  top of those stored, in one write. A failed write puts them back, under the changes made
   *  meanwhile, while `keepOnFailure`. Only through `writes`, and never given to it bare: the queue
   *  would pass the previous task's result as `keepOnFailure`. */
  async function savePending(keepOnFailure: boolean): Promise<void> {
    if (pending.size === 0 && pendingBranch === null) return
    const toSave = new Map(pending)
    const branchToSave = pendingBranch
    pending.clear()
    pendingBranch = null
    try {
      await storage.set(SETTINGS_KEY, withChanges(readSettings(await storage.get(SETTINGS_KEY)), toSave, branchToSave))
    } catch (error) {
      if (keepOnFailure) {
        for (const [projectId, changes] of toSave) pending.set(projectId, mergeChanges(changes, pending.get(projectId) ?? {}))
        if (branchToSave) pendingBranch = { ...branchToSave, ...(pendingBranch ?? {}) }
      }
      throw error
    }
    onSaved()
  }

  /** Saves the pending changes, then writes the settings `compute` gives from those stored with
   *  them, unless it gives none, both in one turn of the queue, and answers its answer. */
  function writeStored<T>(compute: (settings: Settings) => { answer: T; settings: Settings | null }): Promise<T> {
    cancelTimer()
    return writes(async () => {
      await savePending(true)
      const { answer, settings } = compute(readSettings(await storage.get(SETTINGS_KEY)))
      if (settings) await storage.set(SETTINGS_KEY, settings)
      return answer
    })
  }

  function saveOnTimer(): void {
    timer = null
    writes(() => savePending(true)).catch(onTimedSaveFailed)
  }

  /** Times a save of the pending changes, from now. */
  function timeSave(): void {
    cancelTimer()
    timer = timers.setTimeout(saveOnTimer, SAVE_DELAY_MS)
  }

  return {
    /** Keeps `changes` with the project's other pending changes, later ones on top, and times a save. */
    change(projectId: string, changes: ProjectChanges): void {
      pending.set(projectId, mergeChanges(pending.get(projectId) ?? {}, changes))
      timeSave()
    },

    /** Keeps `changes` to the global branch settings with the other pending edits of them, later
     *  ones on top, and times a save, which writes them on top of the global branch settings as
     *  stored. */
    changeGlobalBranch(changes: BranchSettings): void {
      pendingBranch = { ...pendingBranch, ...changes }
      timeSave()
    },

    /** Saves every pending change now, after every write asked for before, for a caller that
     *  depends on the stored settings. Rejects when that save fails, keeping the changes pending. */
    saveNow(): Promise<void> {
      cancelTimer()
      return writes(() => savePending(true))
    },

    /** Saves the pending changes, then writes the project's changes and the global ones that
     *  `compute` gives for the project's settings and the global ones as stored with them, both in
     *  one write, in one turn of the queue: never one without the other. A part it leaves out stays
     *  as stored; with neither, nothing more is written. Answers its `answer`. Rejects when either
     *  write fails; a failed save of the pending changes keeps them pending and computes nothing. */
    writeProjectAndGlobal<T>(
      projectId: string,
      compute: (project: ProjectSettings, global: GlobalSettings) => { answer: T; project?: ProjectChanges; global?: GlobalChanges }
    ): Promise<T> {
      return writeStored((settings) => {
        const { answer, project, global } = compute(projectSettings(settings, projectId), globalSettings(settings))
        if (!project && !global) return { answer, settings: null }
        const withProject = project ? withProjectChanges(settings, projectId, project) : settings
        return { answer, settings: global ? withGlobalChanges(withProject, global) : withProject }
      })
    },

    /** `settings`, as read from storage, with every pending change on top, as the panel shows them:
     *  a project shown while an edit of the global branch settings waits shows that edit. */
    withPending(settings: Settings): Settings {
      return withChanges(settings, pending, pendingBranch)
    },

    /** The save when the panel closes.
 A failure drops the changes it saved, since no panel is left
     *  to show it or to save them again, and rejects nowhere. */
    unload(): void {
      cancelTimer()
      writes(() => savePending(false)).catch(() => {})
    }
  }
}
