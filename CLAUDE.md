# Kickoff

An Orca plugin (`id: kickoff`) that lists open tasks from a project's tracker (GitHub, or Jira through Orca's Jira connection or `twg`) and starts each one in a linked worktree, with an agent and a prompt built from a per-project template. The spec is the GitHub issue labelled `spec`. Facts about Orca, `gh` and `twg` live in `docs/reference.md`; read it before touching any CLI parsing or plugin API code.

## Working rules

- **Public repository.** Never write the user's email, OS username, personal paths, Atlassian site name or real task data into any file, test or commit. Use invented data (`example.atlassian.net`, `acme/web`, `WEB-12`). CLI output from `twg` and `orca jira` can contain the user's email (feedback URLs, `viewer`, `sites[]`): never show or log it.
- **No credentials in the plugin.** See `docs/adr/0001-credentials-stay-in-external-tools.md`.
- **No dependencies, no build step.** Orca transpiles TypeScript and JSX at load time; there is no `package.json`. Generate the API types with `orca plugin types .` (into the git-ignored `.orca/`).
- **Windows first.** The main environment is Windows with PowerShell. macOS and Linux must work too.
- **English only** in code, comments, UI strings, docs, issues and commits.
- **Pure logic apart from I/O.** Parsing CLI output, building CLI arguments, naming worktrees and filling templates are pure functions with tests. Saving Project settings (`src/settings-save.ts`) is kept apart from I/O too: it takes storage and timers from the panel, and its own tests hold them by hand. The worker only runs commands and wires things together, and the panel asks that module for every save.
- **Verify before asserting.** `docs/reference.md` tags each fact as Verified, Original or Assumed. When an Assumed fact matters to what you write, check it by running the CLI or reading the generated types, then update the file.
- **MIT.** If you copy or adapt code from [rr235/orca-task-launcher](https://github.com/rr235/orca-task-launcher), keep its copyright notice in `LICENSE` and add a header to the affected file.
- **Checks before done:** `orca plugin validate .`, `orca plugin test .`, `orca plugin check .` and the type check `npx -y -p typescript@5.6.3 tsc -p .` (after `orca plugin types .`) must pass. Run the type check exactly as written: `.claude/settings.json` allows only that string. With the repository on a different drive from Orca, `test` and `check` fail on every file with `cannot import "./orca-runtime.mjs"` (`check` still exits 0): run them from a copy on Orca's drive, as the cross-drive entry under Tests in `docs/reference.md` shows. Anything that can only be seen inside Orca, ask the user to try.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`samfaina/orca-kickoff`) and are managed with `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default canonical labels, plus `spec` for the issue that holds a spec. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
