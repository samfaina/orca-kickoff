// Runs async tasks one at a time, in the order they were asked for. No Orca API, so the panel can
// use it and the tests can drive it with tasks they settle by hand.

/** A queue of its own: each task it is given starts once every earlier one has settled, resolved
 *  or rejected, and its promise settles as the task does. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  /** Settles when the last task given settles; never rejects, so a failure doesn't reach the next. */
  let last: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = last.then(task)
    last = run.catch(() => undefined)
    return run
  }
}
