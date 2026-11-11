// Kickoff's side panel: the active project's open tasks. No build step: Orca strips the types and
// compiles the JSX when the panel loads. The worker does the work; the panel asks it with
// `tasks.load` and draws the answer.
import {
  Badge,
  Box,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Link,
  Row,
  Spinner,
  Stack,
  Text,
  atom,
  on,
  plugin,
  read,
  set,
  type PanelContext
} from 'orca'
import { isRecord } from './json'
import type { Task, TaskList } from './protocol'

/** Orca queries and the tracker can take up to about 65 s together. */
const LOAD_TIMEOUT_MS = 90_000

const list = atom<TaskList | null>(null)
const loading = atom(false)

/** Rises with each load, so an answer that arrives after a newer request is dropped. */
let generation = 0

async function load(): Promise<void> {
  const mine = ++generation
  set(loading, true)
  let answer: TaskList
  try {
    answer = await plugin.request('tasks.load', {}, { timeoutMs: LOAD_TIMEOUT_MS })
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown error'
    answer = { kind: 'error', project: null, message: `Kickoff's worker didn't answer (${code}). Reload to try again.` }
  }
  if (mine !== generation) return
  set(list, answer)
  set(loading, false)
}

export function setup(ctx: PanelContext): void {
  let started = false
  const reload = () => {
    started = true
    void load()
  }
  // Orca sends the current context to each new subscriber; load now only if it hasn't yet.
  ctx.subscriptions.push(on('workspace.changed', reload))
  if (!started) reload()
}

export default function Panel() {
  const current = read(list)
  const busy = read(loading)
  const project = current && 'project' in current ? current.project : null
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={3}>{project ? project.name : 'Kickoff'}</Heading>
        <Row gap="xs" align="center">
          {busy && current ? <Spinner label="Reloading tasks" labelHidden /> : null}
          <IconButton icon="refresh" label="Reload tasks" tooltip="Reload tasks" size="sm" variant="ghost" onPress={() => void load()} />
        </Row>
      </Row>
      {current ? <Body list={current} /> : <Spinner label="Loading tasks" />}
    </Stack>
  )
}

function Body({ list }: { list: TaskList }) {
  switch (list.kind) {
    case 'no-project':
      return <EmptyState title="No project selected" description="Select a worktree in Orca to see its project's tasks." icon="folder" />
    case 'needs-config':
      return (
        <EmptyState
          title="No tracker for this project"
          description={`Kickoff reads GitHub issues for projects with a GitHub repository, and ${list.project.name} has none.`}
          icon="settings"
        />
      )
    case 'error':
      return (
        <Callout tone="danger" title="Couldn't load tasks" icon="error">
          <Text>{list.message}</Text>
        </Callout>
      )
    case 'ready':
      return (
        <Stack gap="sm">
          {list.warning ? (
            <Callout tone="warning" icon="warning">
              <Text>{list.warning}</Text>
            </Callout>
          ) : null}
          {list.tasks.length === 0 ? (
            <EmptyState title="No open tasks" icon="check" />
          ) : (
            list.tasks.map((task) => <TaskCard key={task.key} task={task} />)
          )}
          {list.truncated ? (
            <Text size="sm" muted>
              {list.provider === 'github'
                ? "Showing the first 100 of your repository's issues."
                : 'Showing the first 100 tasks — narrow your JQL.'}
            </Text>
          ) : null}
        </Stack>
      )
  }
}

function TaskCard({ task }: { task: Task }) {
  // Every GitHub task is open, so its status says nothing.
  const status = task.tracker !== 'github' ? task.status : null
  return (
    <Box border radius="md" padding="sm" direction="column" gap="xs">
      <Text>
        <Link href={task.url}>{task.key}</Link> {task.title}
      </Text>
      {status || task.labels.length > 0 ? (
        <Row gap="xs" wrap>
          {status ? <Badge tone="accent">{status}</Badge> : null}
          {task.labels.map((label) => (
            <Badge key={label}>{label}</Badge>
          ))}
        </Row>
      ) : null}
    </Box>
  )
}
