import { assert, test } from 'orca/testing'
import { serialQueue } from './queue'

/** A promise the test settles by hand. */
function held<T>() {
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
  const first = held<string>()
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
  const holds = [held<void>(), held<void>(), held<void>()]
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
  const first = held<string>()
  const a = enqueue(() => first.promise)
  const b = enqueue(async () => 'b')
  first.reject(new Error('write failed'))
  await assert.rejects(a, /write failed/)
  assert.equal(await b, 'b')
})

/** A store like the panel's settings storage, whose every read and write waits for the test. */
function heldStore(initial: Record<string, string>) {
  let value = initial
  const calls: { kind: 'get' | 'set'; done: () => void }[] = []
  const wait = (kind: 'get' | 'set') => new Promise<void>((resolve) => calls.push({ kind, done: resolve }))
  return {
    get value() {
      return value
    },
    calls,
    async get() {
      await wait('get')
      return value
    },
    async set(next: Record<string, string>) {
      await wait('set')
      value = next
    }
  }
}

/** Lets the store's calls through one by one, until none is waiting. */
async function drain(store: ReturnType<typeof heldStore>): Promise<void> {
  for (;;) {
    await turn()
    const call = store.calls.shift()
    if (!call) return
    call.done()
  }
}

test('two overlapping read-modify-writes through the queue keep both changes', async () => {
  const store = heldStore({ jql: 'project = WEB' })
  const enqueue = serialQueue()
  const save = (changes: Record<string, string>) => enqueue(async () => store.set({ ...(await store.get()), ...changes }))
  const first = save({ agent: 'claude' })
  const second = save({ provider: 'jira-twg' })
  await drain(store)
  await Promise.all([first, second])
  assert.deepEqual(store.value, { jql: 'project = WEB', agent: 'claude', provider: 'jira-twg' })
})

test('a task with nothing to write, asked while a write is under way, resolves only after that write', async () => {
  const store = heldStore({ agent: 'codex' })
  const enqueue = serialQueue()
  const events: string[] = []
  const saving = enqueue(async () => {
    await store.set({ agent: 'claude' })
    events.push('written')
  })
  const nothing = enqueue(async () => undefined).then(() => events.push('second resolved'))
  await turn()
  assert.deepEqual(events, [])
  await drain(store)
  await Promise.all([saving, nothing])
  assert.deepEqual(events, ['written', 'second resolved'])
})
