# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## Repo-specific labels

| Label  | Meaning                                    | Applied by |
| ------ | ------------------------------------------ | ---------- |
| `spec` | The issue holds a spec (the parent ticket) | `/to-spec`, alongside `ready-for-agent` |

`spec` is not a triage state: it marks what the issue is, not where it is in the queue. Keep it when the triage label changes.

## Issues in the same module

Triage tends to open one issue per symptom when a single module is at fault. Each brief then names only the calls where its symptom showed, its worker stays inside them, and the next symptom in the same code comes back as a follow-up. Saving Project settings went from #92 to #94, #96, #97 and #99 before #100 joined them into one issue about the module's contract.

So, when you gather context for an issue, look beyond the redundancy and prior-rejection checks before you recommend anything or write a brief:

1. **Name the module.** It is the unit of code whose behaviour the issue is about: a file in `src/` such as `src/settings-save.ts` or `src/providers/jira-twg.ts`, or one concern inside a larger file, such as the task list in `src/panel.tsx`. Many issues touch `src/panel.tsx` and `src/panel.test.tsx`, so a shared file alone does not make two issues siblings. They are siblings when they share the code their symptom is in.
2. **Find its siblings.** List the open issues and the issues closed in the last two weeks, and keep those whose code is in the same module. Where an issue doesn't say which code it touches, read the files its PR changed:

   ```sh
   gh issue list --state open --limit 100 --json number,title,body,labels
   gh issue list --state closed --limit 100 --search "closed:>=<date two weeks ago>" --json number,title,body,closedAt
   gh pr list --state merged --limit 100 --search "merged:>=<date two weeks ago>" --json number,title,body,files --jq '.[] | {number, title, closes: (.body | [scan("(?i)(?:closes|fixes|resolves) #([0-9]+)")[0]]), files: [.files[].path]}'
   ```

   Run them in a POSIX shell (Git Bash on Windows): Windows PowerShell 5.1 strips the double quotes inside the `--jq` filter, and `gh` rejects the rest. Match a merged PR to its issue by the `Closes #<n>` line in its body: `closingIssuesReferences` can come back empty here even when that line is present.
3. **When there are siblings, state the module's contract.** Say which rule of the module the issue and its siblings all break, and propose one issue for that rule that joins the open siblings. Name the closed ones as history. Give the maintainer the choice to keep them apart, and wait for the answer.
4. **Brief the contract.** Whether the issues are joined or kept apart, the brief names the module's contract and every call that has to keep it, not only the calls where the symptom showed.

When there are no siblings, say so in the recommendation, with where you looked.
