# Shipping

Read by the `ship-tickets` skill (samfaina/agent-skills).

- **Base branch:** `main`
- **Merge method:** `merge`
- **Merge approval:** `auto`
- **Branch naming:** `issue-<n>-` followed by two or three key words of the issue title in kebab-case: #3 "List GitHub issues end to end with zero config" becomes `issue-3-github-issues-list`. Orca prepends its configured branch prefix, if one is set, to the branch name.
- **After merge:** nothing.
- **CI:** `none`
- **Workers:** `claude` (all roles)

## PR format

- **Title:** the issue title, unchanged.
- **Body:**
  1. `## Summary`: what the PR adds or changes, with the file layout when files are added, and any fact recorded in `docs/reference.md`.
  2. `## Evidence`: **Before** and **After**, with each check command (`orca plugin validate .`, `orca plugin test .`, `orca plugin check .`, and anything confirmed manually inside Orca) and its result.
  3. `## Merge Danger`: **Door** (one-way or two-way), **Blast Radius**, and a sentence on what depends on the change.

  End with `Closes #<n>`.
