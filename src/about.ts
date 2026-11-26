// Which Kickoff runs: its manifest's version, and whether it is a development plugin. No Node
// imports, so the panel can use it too.
import { isRecord, parseJson } from './json'

/** The version Kickoff's manifest says, and whether Kickoff is a development plugin: loaded
 *  straight from a folder being worked on rather than installed. */
export type About = { version: string; development: boolean }

/** Kickoff's repository on GitHub, where its Star button is: GitHub has no URL that stars a
 *  repository directly. A constant, since the manifest has no field for it. */
export const KICKOFF_REPOSITORY_URL = 'https://github.com/samfaina/orca-kickoff'

/** The `orca-plugin.json` next to the `src/` folder that holds the worker at `workerUrl`. Throws
 *  when `workerUrl` isn't a URL. */
export function manifestUrl(workerUrl: string): URL {
  return new URL('../orca-plugin.json', workerUrl)
}

/** Orca installs a plugin in a content folder named after its 64-hex content hash, inside the
 *  plugin's folder `<publisher>.<id>`. */
const CONTENT_FOLDER = /^[0-9a-f]{64}$/i

/** Kickoff's version and whether it is a development plugin, from the file URL of its worker and
 *  the text of its manifest, or null when the URL isn't a file URL or the manifest has no
 *  version. It is a development plugin unless the manifest's folder is an installed content
 *  folder. */
export function aboutKickoff(workerUrl: string, manifestText: string): About | null {
  let manifest: URL
  try {
    manifest = manifestUrl(workerUrl)
  } catch {
    return null
  }
  if (manifest.protocol !== 'file:') return null
  const parsed = parseJson(manifestText)
  const version = isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version.trim() : ''
  if (version === '') return null
  // The path's folders, the manifest's own last: file URLs use `/` on every platform.
  const folders = manifest.pathname.split('/').slice(0, -1).map(decode)
  const folder = folders[folders.length - 1] ?? ''
  const parent = folders[folders.length - 2] ?? ''
  const installed = CONTENT_FOLDER.test(folder) && parent.endsWith('.kickoff')
  return { version, development: !installed }
}

/** A URL path segment as the folder's name, or as it is when it can't be decoded. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
