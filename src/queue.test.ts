import { assert, test } from 'orca/testing'
import { serialQueue } from './queue'

/** A promise the test settles by hand. */
function deferred<T>() {
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

test('a second task does not start before the first one finishes', async () => {
  const enqueue = serialQueue()
  const first = deferred<string>()
  const started: string[] = []
  const a = enqueue(() => {
    started.push('a')
    return first.promise
  })
  const b = enqueue(async () => {
    started.push('b')
    return 'b'
  })
  await turn()
  assert.deepEqual(started, ['a'])
  first.resolve('a')
  assert.equal(await a, 'a')
  assert.equal(await b, 'b')
  assert.deepEqual(started, ['a', 'b'])
})

test('tasks run in the order they were asked for, even when a later one would finish first', async () => {
  const enqueue = serialQueue()
  const holds = [deferred<void>(), deferred<void>(), deferred<void>()]
  const events: string[] = []
  const runs = ['a', 'b', 'c'].map((name, index) =>
    enqueue(async () => {
      events.push(`${name} starts`)
      await holds[index].promise
      events.push(`${name} ends`)
    })
  )
  holds[2].resolve()
  holds[1].resolve()
  await turn()
  holds[0].resolve()
  await Promise.all(runs)
  assert.deepEqual(events, ['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends'])
})

test('a rejected task neither blocks the next one nor changes its result', async () => {
  const enqueue = serialQueue()
  const first = deferred<string>()
  const a = enqueue(() => first.promise)
  const b = enqueue(async () => 'b')
  first.reject(new Error('write failed'))
  await assert.rejects(a, /write failed/)
  assert.equal(await b, 'b')
})
