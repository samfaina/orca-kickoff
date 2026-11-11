// The few Node.js APIs the worker uses, declared here because Kickoff has no dependencies (and so
// no @types/node). Only for type checking: Orca's worker runs on Node and provides the real ones.
declare module 'node:child_process' {
  type ExecFileError = Error & { code?: string | number; killed?: boolean; signal?: string | null }
  export function execFile(
    file: string,
    args: readonly string[],
    options: {
      timeout?: number
      signal?: AbortSignal
      windowsHide?: boolean
      maxBuffer?: number
      encoding: 'utf8'
    },
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:os' {
  export function homedir(): string
}

declare const process: {
  readonly platform: string
  readonly env: Record<string, string | undefined>
}
