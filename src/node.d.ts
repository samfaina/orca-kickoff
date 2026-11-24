// The few Node.js APIs the worker and the tests use, declared here because Kickoff has no
// dependencies (and so no @types/node). Only for type checking: Orca provides the real ones.
declare module 'node:child_process' {
  type ExecFileError = Error & { code?: string | number; killed?: boolean; signal?: string | null }
  export function execFile(
    file: string,
    args: readonly string[],
    options: {
      cwd?: string
      env?: Record<string, string | undefined>
      timeout?: number
      signal?: AbortSignal
      windowsHide?: boolean
      maxBuffer?: number
      encoding: 'utf8'
    },
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:fs/promises' {
  export function readFile(path: URL, encoding: 'utf8'): Promise<string>
}

declare module 'node:os' {
  export function homedir(): string
}

/** Tests yield an event-loop turn with it, the turn Orca's test runtime draws the panel on. */
declare function setImmediate(callback: () => void): unknown

declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}
