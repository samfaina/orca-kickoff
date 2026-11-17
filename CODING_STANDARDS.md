# Coding standards

Read during review. Each rule is a judgement call: what `orca plugin validate`, `test`, `check` and `tsc` already catch isn't repeated here.

- **Parallel helpers change together.** When a diff changes one helper of a family that repeats a pattern, such as `withIntervals` and `withTimeouts` in `src/panel.test.tsx`, it makes the same change in the others, or the PR says why not.
- **Comments follow the code.** A comment that describes behaviour the diff changes is updated in the same diff.
