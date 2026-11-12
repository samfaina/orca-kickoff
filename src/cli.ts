// Finding and running the CLIs Kickoff relies on: `orca`, `gh` and `twg`. Choosing candidates and
// writing error messages are pure functions; `nodeExec` is the only part that starts processes.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { isRecord, parseJson, text } from './json'

export type Tool = 'orca' | 'gh' | 'twg'

export type RunOptions = { timeoutMs?: number; signal?: AbortSignal }

/** Runs a tool and resolves with its stdout, or rejects with a `CliError` the panel can show. */
export type RunCli = (tool: Tool, args: string[], options?: RunOptions) => Promise<string>

/** A failure whose message is ready for the panel. `timedOut` is true when the tool didn't answer
 *  in time, so it may still be doing what it was asked. */
export class CliError extends Error {
  readonly timedOut: boolean

  constructor(message: string, timedOut = false) {
    super(message)
    this.timedOut = timedOut
  }
}

/** Starts one process in `cwd` with `env`. It rejects as Node's `execFile` does: `code` is
 *  `'ENOENT'` when the executable doesn't exist, the exit code when it failed, and `killed` is
 *  true on a timeout. */
export type Exec = (
  file: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal } & ChildProcessSetup
) => Promise<{ stdout: string; stderr: string }>

/** 20 s for Orca queries, 45 s for trackers. Callers pass longer ones, such as `worktree create`. */
const DEFAULT_TIMEOUT_MS: Record<Tool, number> = { orca: 20_000, gh: 45_000, twg: 45_000 }

export function createRunCli(environment: CliEnvironment, exec: Exec): RunCli {
  const setup = childProcessSetup(environment)
  return async (tool, args, options = {}) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[tool]
    for (const file of cliCandidates(tool, environment)) {
      try {
        const { stdout } = await exec(file, args, { timeoutMs, signal: options.signal, ...setup })
        return stdout
      } catch (error) {
        const failure = describeExecError(error)
        if (failure) throw new CliError(cliFailureMessage(tool, failure), failure.kind === 'timeout')
      }
    }
    throw new CliError(cliFailureMessage(tool, { kind: 'not-found' }))
  }
}

/** null when the executable doesn't exist, so the next candidate is tried. */
function describeExecError(error: unknown): CliFailure | null {
  const fields = isRecord(error) ? error : {}
  if (fields.code === 'ENOENT') return null
  if (fields.killed === true) return { kind: 'timeout' }
  const stderr = text(fields.stderr) || (typeof fields.code === 'string' && error instanceof Error ? error.message : '')
  return {
    kind: 'failed',
    exitCode: typeof fields.code === 'number' ? fields.code : null,
    stdout: text(fields.stdout),
    stderr
  }
}

/** Node's `execFile`, without a shell, with no console window on Windows and room for big output. */
export const nodeExec: Exec = (file, args, { timeoutMs, signal, cwd, env }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, env, timeout: timeoutMs, signal, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      }
    )
  })

/** Runs the real tools, found from this process's platform, environment and home folder. */
export function systemRunCli(): RunCli {
  return createRunCli({ platform: process.platform, env: process.env, home: homedir() }, nodeExec)
}

export type CliEnvironment = {
  platform: string
  env: Record<string, string | undefined>
  /** The user's home folder. */
  home: string
}

export type ChildProcessSetup = { cwd: string; env: Record<string, string | undefined> }

/** Where the tools run and with which variables.
 *
 *  - `cwd` is the home folder. The worker runs in Orca's install folder, and on Windows a bare
 *    `orca` is looked up in the current folder first, which finds the Orca app (`Orca.exe`), not
 *    its CLI.
 *  - On Windows Orca starts the worker without `APPDATA` and `LOCALAPPDATA`. The Orca CLI needs
 *    `APPDATA` to find the running Orca, and `gh` needs it to find its login, so both get their
 *    default values back. A variable that is already set is kept. */
export function childProcessSetup({ platform, env, home }: CliEnvironment): ChildProcessSetup {
  if (platform !== 'win32') return { cwd: home, env }
  return {
    cwd: home,
    env: {
      ...env,
      APPDATA: env.APPDATA || `${home}\\AppData\\Roaming`,
      LOCALAPPDATA: env.LOCALAPPDATA || `${home}\\AppData\\Local`
    }
  }
}

const OVERRIDE_VARIABLE: Record<Tool, string> = {
  orca: 'ORCA_CLI_COMMAND',
  gh: 'GH_CLI_COMMAND',
  twg: 'TWG_CLI_COMMAND'
}

/** The executables to try for `tool`, in order. The next one is tried only on ENOENT. */
export function cliCandidates(tool: Tool, { platform, env, home }: CliEnvironment): string[] {
  const override = env[OVERRIDE_VARIABLE[tool]]
  if (override) return [override]
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || `${home}\\AppData\\Local`
    const programFiles = env.ProgramFiles || `${home.slice(0, 2)}\\Program Files`
    const installed: Record<Tool, string> = {
      orca: `${localAppData}\\Programs\\orca\\resources\\bin\\orca.exe`,
      gh: `${programFiles}\\GitHub CLI\\gh.exe`,
      twg: `${localAppData}\\Programs\\twg\\bin\\twg.exe`
    }
    return [tool, installed[tool]]
  }
  if (platform === 'darwin') {
    if (tool === 'orca') return ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca']
    if (tool === 'gh') return ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
    return [tool]
  }
  // On Linux `orca` is usually GNOME's screen reader, so Orca's CLI is `orca-ide`.
  return [tool === 'orca' ? 'orca-ide' : tool]
}

export type CliFailure =
  /** Every candidate gave ENOENT. */
  | { kind: 'not-found' }
  | { kind: 'timeout' }
  | { kind: 'failed'; exitCode: number | null; stdout: string; stderr: string }

const NOT_FOUND: Record<Tool, string> = {
  orca:
    "Couldn't find the Orca CLI. It comes with Orca: reinstall or update Orca, and connect Jira in Orca's settings if you read Jira through Orca. Or set ORCA_CLI_COMMAND to the full path of the CLI.",
  gh: "Couldn't find the GitHub CLI (gh). Install it from https://cli.github.com, then run `gh auth login`. Or set GH_CLI_COMMAND to the full path of gh.",
  twg: "Couldn't find the Teamwork Graph CLI (twg). Install it from https://developer.atlassian.com/cloud/twg-cli/, then run `twg login`. Or set TWG_CLI_COMMAND to the full path of twg."
}

/** The message the panel shows for a failed run: the tool's own words, without email addresses. */
export function cliFailureMessage(tool: Tool, failure: CliFailure): string {
  if (failure.kind === 'not-found') return NOT_FOUND[tool]
  if (failure.kind === 'timeout') return `${tool} didn't answer in time.`
  const reason = jsonErrorMessage(failure.stdout) ?? stderrReason(failure.stderr)
  if (reason) return cleanMessage(`${tool} failed: ${reason}`)
  return `${tool} failed with exit code ${failure.exitCode ?? 'unknown'}.`
}

/** `error.message` of a `{ ok: false, error }` answer on stdout, as `orca` and `twg` print. */
export function jsonErrorMessage(stdout: string): string | null {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed) || parsed.ok !== false || !isRecord(parsed.error)) return null
  return text(parsed.error.message).trim() || null
}

/** For a tool that answered with output of a shape Kickoff doesn't know. */
export function unreadableOutput(tool: Tool): CliError {
  return new CliError(`${tool} returned output Kickoff couldn't read. Update ${tool} and try again.`)
}

const MAX_MESSAGE = 300
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** Removes email addresses and cuts the text to about 300 characters. */
export function cleanMessage(text: string): string {
  const clean = text.replace(EMAIL, '[email]').trim()
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean
}

/** A line such as `Error: Cannot find module ...` or `TypeError [ERR_X]: ...`. */
const ERROR_LINE = /^[A-Za-z]*Error( \[[A-Z0-9_]+\])?: \S/
/** Lines of a Node.js crash that only say where it happened: `node:internal/...:1575`,
 *  `throw err;`, the `^` marker and `at ...` stack frames. */
const STACK_LINE = /^(\S+:\d+(:\d+)?|throw\b.*|\^+|at\s.*)$/

/** The stderr line that says what went wrong: the first error line if there is one, otherwise the
 *  first line that isn't a stack location, otherwise the first non-empty line. */
export function stderrReason(stderr: string): string | null {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  return lines.find((line) => ERROR_LINE.test(line)) ?? lines.find((line) => !STACK_LINE.test(line)) ?? lines[0] ?? null
}
