// Kickoff's side panel. No build step: Orca strips the types and compiles the JSX when the
// panel loads. For now it only shows what the plugin is for.
import { EmptyState } from 'orca'

export default function Panel() {
  return (
    <EmptyState
      title="Kickoff"
      description="Start tasks from your tracker in their own worktree. Task lists are coming soon."
      icon="rocket"
    />
  )
}
