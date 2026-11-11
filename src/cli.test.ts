import { assert, test } from 'orca/testing'
import { CliError, cliCandidates, cliFailureMessage, createRunCli, type Exec } from './cli'

const windows = (env: Record<string, string>) => ({ platform: 'win32', env, home: 'C:\\Users\\ana' })

test('on Windows each tool is tried by name, then at its default install path', () => {
  const env = { LOCALAPPDATA: 'D:\\Local', ProgramFiles: 'D:\\Programs' }
  assert.deepEqual(cliCandidates('orca', windows(env)), ['orca', 'D:\\Local\\Programs\\orca\\resources\\bin\\orca.exe'])
  assert.deepEqual(cliCandidates('gh', windows(env)), ['gh', 'D:\\Programs\\GitHub CLI\\gh.exe'])
  assert.deepEqual(cliCandidates('twg', windows(env)), ['twg', 'D:\\Local\\Programs\\twg\\bin\\twg.exe'])
})

test('on Windows the default paths are rebuilt from the home folder when the variables are missing', () => {
  assert.deepEqual(cliCandidates('orca', windows({})), [
    'orca',
    'C:\\Users\\ana\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe'
  ])
  assert.deepEqual(cliCandidates('gh', windows({})), ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'])
  assert.deepEqual(cliCandidates('twg', windows({})), ['twg', 'C:\\Users\\ana\\AppData\\Local\\Programs\\twg\\bin\\twg.exe'])
})

test('a *_CLI_COMMAND variable replaces the candidate list with its path', () => {
  const env = { ORCA_CLI_COMMAND: 'E:\\tools\\orca.exe', GH_CLI_COMMAND: '/opt/gh', TWG_CLI_COMMAND: '/opt/twg' }
  assert.deepEqual(cliCandidates('orca', windows(env)), ['E:\\tools\\orca.exe'])
  assert.deepEqual(cliCandidates('gh', { platform: 'linux', env, home: '/home/ana' }), ['/opt/gh'])
  assert.deepEqual(cliCandidates('twg', { platform: 'darwin', env, home: '/Users/ana' }), ['/opt/twg'])
})

test('on Linux the Orca CLI is orca-ide', () => {
  assert.deepEqual(cliCandidates('orca', { platform: 'linux', env: {}, home: '/home/ana' }), ['orca-ide'])
})

test('on macOS the app bundle and Homebrew paths follow the names', () => {
  const mac = { platform: 'darwin', env: {}, home: '/Users/ana' }
  assert.deepEqual(cliCandidates('orca', mac), ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca'])
  assert.deepEqual(cliCandidates('gh', mac), ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
  assert.deepEqual(cliCandidates('twg', mac), ['twg'])
})

test('a missing executable names the tool, how to install it and log in, and its path variable', () => {
  const gh = cliFailureMessage('gh', { kind: 'not-found' })
  assert.match(gh, /GitHub CLI \(gh\)/)
  assert.match(gh, /https:\/\/cli\.github\.com/)
  assert.match(gh, /gh auth login/)
  assert.match(gh, /GH_CLI_COMMAND/)

  const twg = cliFailureMessage('twg', { kind: 'not-found' })
  assert.match(twg, /twg/)
  assert.match(twg, /https:\/\/developer\.atlassian\.com\/cloud\/twg-cli\//)
  assert.match(twg, /twg login/)
  assert.match(twg, /TWG_CLI_COMMAND/)

  const orca = cliFailureMessage('orca', { kind: 'not-found' })
  assert.match(orca, /Orca CLI/)
  assert.match(orca, /Jira/)
  assert.match(orca, /ORCA_CLI_COMMAND/)
})

test('a timeout names the tool that did not answer', () => {
  assert.equal(cliFailureMessage('orca', { kind: 'timeout' }), "orca didn't answer in time.")
})

test('a JSON error on stdout gives its message and never the feedback URL', () => {
  const stdout = JSON.stringify({
    ok: false,
    error: {
      code: 'TWG_TOOL_EXECUTION_FAILED',
      message: "Error in the JQL query: the field 'sprnt' does not exist.",
      feedback: { url: 'https://feedback.example.com/?user=ana@example.com' }
    }
  })
  const message = cliFailureMessage('twg', {
    kind: 'failed',
    exitCode: 1,
    stdout,
    stderr: 'Error: something\nFeedback: https://feedback.example.com/?user=ana@example.com'
  })
  assert.equal(message, "twg failed: Error in the JQL query: the field 'sprnt' does not exist.")
})

test('any other failure gives the first non-empty stderr line', () => {
  const stderr = '\nTo get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.\n'
  assert.equal(
    cliFailureMessage('gh', { kind: 'failed', exitCode: 4, stdout: '', stderr }),
    'gh failed: To get started with GitHub CLI, please run:  gh auth login'
  )
})

test('a failure with nothing on stderr gives the exit code', () => {
  assert.equal(cliFailureMessage('gh', { kind: 'failed', exitCode: 2, stdout: '', stderr: '  \n' }), 'gh failed with exit code 2.')
})

test('messages have email addresses removed and are cut to about 300 characters', () => {
  const withEmail = cliFailureMessage('orca', {
    kind: 'failed',
    exitCode: 1,
    stdout: JSON.stringify({ ok: false, error: { code: 'runtime_error', message: 'No access for ana.example+jira@example.co.uk here' } }),
    stderr: ''
  })
  assert.equal(withEmail, 'orca failed: No access for [email] here')

  const long = cliFailureMessage('gh', { kind: 'failed', exitCode: 1, stdout: '', stderr: 'x'.repeat(1000) })
  assert.equal(long.length, 300)
  assert.ok(long.endsWith('…'))
})

const mac = { platform: 'darwin', env: {}, home: '/Users/ana' }

function fakeExec(answers: Record<string, () => { stdout: string; stderr: string }>): { exec: Exec; tried: string[] } {
  const tried: string[] = []
  const exec: Exec = async (file) => {
    tried.push(file)
    const answer = answers[file]
    if (!answer) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
    return answer()
  }
  return { exec, tried }
}

test('run tries the next candidate only when the executable is not found', async () => {
  const { exec, tried } = fakeExec({ '/usr/local/bin/gh': () => ({ stdout: '[]', stderr: '' }) })
  const run = createRunCli(mac, exec)
  assert.equal(await run('gh', ['issue', 'list']), '[]')
  assert.deepEqual(tried, ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
})

test('run stops at the first candidate that fails for another reason', async () => {
  const { exec, tried } = fakeExec({
    gh: () => {
      throw Object.assign(new Error('Command failed'), { code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' })
    },
    '/opt/homebrew/bin/gh': () => ({ stdout: '[]', stderr: '' })
  })
  const run = createRunCli(mac, exec)
  await assert.rejects(run('gh', ['issue', 'list']), (error) => {
    return error instanceof CliError && error.message === 'gh failed: To get started with GitHub CLI, please run:  gh auth login'
  })
  assert.deepEqual(tried, ['gh'])
})

test('run reports a missing tool when no candidate exists', async () => {
  const run = createRunCli(mac, fakeExec({}).exec)
  await assert.rejects(run('twg', []), (error) => error instanceof CliError && /TWG_CLI_COMMAND/.test(error.message))
})

test('run reports a timeout when the process is killed', async () => {
  const { exec } = fakeExec({
    orca: () => {
      throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' })
    }
  })
  const run = createRunCli(mac, exec)
  await assert.rejects(run('orca', ['project', 'list']), (error) => error instanceof CliError && error.message === "orca didn't answer in time.")
})
