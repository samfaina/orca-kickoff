// Linear queries: Linear has no query language, so each query of a Linear filter is a set of
// fields, stored as one JSON string among the filter's queries. No Node imports, so the panel can
// use it too.
import { isRecord, parseJson } from './json'
import { LINEAR_TEAM_VARIABLE } from './template'

/** A Linear query, every field optional. A missing `state` means 'open' (Orca's own: any state
 *  not completed or canceled), a missing `assignee` anyone, a missing `team`, `label` or `project`
 *  any, and a missing `orderBy` 'updatedAt'. */
export type LinearQuery = {
  /** A team key, or PROJECT_TEAM. */
  team?: string
  /** 'open', or a state name. */
  state?: string
  assignee?: 'me' | 'null'
  /** A label name. */
  label?: string
  /** A Linear project id: `--project` also takes a name, but an id survives a rename. */
  project?: string
  orderBy?: 'updatedAt' | 'createdAt'
}

/** A Linear query's team when it is the project's Linear team key, "This project's team":
 *  `{{linear_team}}`, filled when the list runs (`filterAsRun` in src/protocol.ts). */
export const PROJECT_TEAM = `{{${LINEAR_TEAM_VARIABLE}}}`

/** The query of the filter a Linear project has before it stores any: the open issues assigned to
 *  the user. */
export const INITIAL_LINEAR_QUERY = JSON.stringify({ assignee: 'me' } satisfies LinearQuery)

/** A Linear query with every field at its default, as the filter editor adds one: unlike a blank
 *  query, it runs. */
export const NEW_LINEAR_QUERY = JSON.stringify({} satisfies LinearQuery)

/** The stored Linear query `stored` with `changes`, as it is stored again: a field changed to
 *  undefined goes back to its default, and the fields not changed stay as `readLinearQuery` reads
 *  them. */
export function withLinearQueryChanges(stored: string, changes: Partial<LinearQuery>): string {
  return JSON.stringify({ ...readLinearQuery(stored), ...changes } satisfies LinearQuery)
}

const TEXT_FIELDS = ['team', 'state', 'label', 'project'] as const

/** `{{ linear_team }}`, spaces inside the braces allowed, as a whole team. */
const PROJECT_TEAM_PATTERN = new RegExp(`^\\{\\{\\s*${LINEAR_TEAM_VARIABLE}\\s*\\}\\}$`)

/** The Linear query a stored string holds. A string that isn't a JSON object reads as an empty
 *  query (every default); unknown keys are dropped, and a field of the wrong type or value, or a
 *  blank one, is ignored. A team written as `{{ linear_team }}`, with spaces inside the braces,
 *  reads as PROJECT_TEAM. */
export function readLinearQuery(stored: string): LinearQuery {
  const raw = parseJson(stored)
  if (!isRecord(raw)) return {}
  const query: LinearQuery = {}
  for (const field of TEXT_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && value.trim() !== '') query[field] = value.trim()
  }
  if (query.team !== undefined && PROJECT_TEAM_PATTERN.test(query.team)) query.team = PROJECT_TEAM
  if (raw.assignee === 'me' || raw.assignee === 'null') query.assignee = raw.assignee
  if (raw.orderBy === 'updatedAt' || raw.orderBy === 'createdAt') query.orderBy = raw.orderBy
  return query
}
