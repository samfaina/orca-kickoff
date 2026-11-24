import { assert, test } from 'orca/testing'
import { aboutKickoff, manifestUrl } from './about'

const HASH = 'a3f0c1d2e4b5968778695a4b3c2d1e0f1a2b3c4d5e6f708192a3b4c5d6e7f809'
const MANIFEST = JSON.stringify({ manifestVersion: 2, id: 'kickoff', name: 'Kickoff', version: '0.6.0' })

test("the manifest is the orca-plugin.json next to the worker's src folder", () => {
  assert.equal(
    manifestUrl('file:///C:/Users/example/AppData/Roaming/orca/plugins/acme.kickoff/' + HASH + '/src/worker.ts').href,
    'file:///C:/Users/example/AppData/Roaming/orca/plugins/acme.kickoff/' + HASH + '/orca-plugin.json'
  )
  assert.equal(manifestUrl('file:///home/example/code/orca-kickoff/src/worker.ts').href, 'file:///home/example/code/orca-kickoff/orca-plugin.json')
})

test("Kickoff installed is its manifest's version, not a development plugin, on Windows and POSIX", () => {
  const windows = `file:///C:/Users/example/AppData/Roaming/orca/plugins/acme.kickoff/${HASH}/src/worker.ts`
  const posix = `file:///home/example/.config/orca/plugins/local.kickoff/${HASH}/src/worker.ts`
  assert.deepEqual(aboutKickoff(windows, MANIFEST), { version: '0.6.0', development: false })
  assert.deepEqual(aboutKickoff(posix, MANIFEST), { version: '0.6.0', development: false })
})

test('Kickoff loaded from a folder being worked on is a development plugin, on Windows and POSIX', () => {
  assert.deepEqual(aboutKickoff('file:///L:/code/orca-kickoff/src/worker.ts', MANIFEST), { version: '0.6.0', development: true })
  assert.deepEqual(aboutKickoff('file:///home/example/code/orca-kickoff/src/worker.ts', MANIFEST), { version: '0.6.0', development: true })
  assert.deepEqual(aboutKickoff('file:///C:/Users/example/My%20Code/orca-kickoff/src/worker.ts', MANIFEST), { version: '0.6.0', development: true })
})

test("a folder is an installed content folder only when it is 64 hex inside a folder whose name ends with .kickoff", () => {
  const inside = (parent: string, folder: string) => aboutKickoff(`file:///home/example/orca/plugins/${parent}/${folder}/src/worker.ts`, MANIFEST)
  assert.equal(inside('acme.kickoff', HASH)?.development, false)
  assert.equal(inside('acme.kickoff', HASH.toUpperCase())?.development, false)
  // A worked-on folder that happens to sit where an install would.
  assert.equal(inside('acme.kickoff', 'orca-kickoff')?.development, true)
  assert.equal(inside('acme.kickoff', HASH.slice(1))?.development, true)
  assert.equal(inside('acme.kickoff', `${HASH.slice(1)}g`)?.development, true)
  assert.equal(inside('acme.tasks', HASH)?.development, true)
  assert.equal(inside('kickoff', HASH)?.development, true)
  assert.equal(inside('acme.kickoff-old', HASH)?.development, true)
})

test('a manifest that is not JSON, or has no version, gives nothing', () => {
  const worker = 'file:///home/example/code/orca-kickoff/src/worker.ts'
  assert.equal(aboutKickoff(worker, '{ "version": '), null)
  assert.equal(aboutKickoff(worker, JSON.stringify({ id: 'kickoff' })), null)
  assert.equal(aboutKickoff(worker, JSON.stringify({ version: 6 })), null)
  assert.equal(aboutKickoff(worker, JSON.stringify({ version: '  ' })), null)
  assert.equal(aboutKickoff(worker, JSON.stringify(['0.6.0'])), null)
})

test('a worker URL that is not a file URL gives nothing', () => {
  assert.equal(aboutKickoff('not a url', MANIFEST), null)
  assert.equal(aboutKickoff('https://example.com/src/worker.ts', MANIFEST), null)
})
