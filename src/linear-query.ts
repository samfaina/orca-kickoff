// Linear queries: Linear has no query language, so each query of a Linear filter is a set of
// fields, stored as one JSON string among the filter's queries. No Node imports, so the panel can
// use it too.
import { isRecord, parseJson } from './json'

/** A Linear query, every field optional. A missing `state` means 'open' (Orca's own: any state
 *  not completed or canceled), a missing `assignee` anyone, a missing `team`, `label` or `project`
 *  any, and a missing `orderBy` 'updatedAt'. */
export type LinearQuery = {
  /** A team key. */
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

/** The query of the filter a Linear project has before it stores any: the open issues assigned to
 *  the user. */
export const INITIAL_LINEAR_QUERY = JSON.stringify({ assignee: 'me' } satisfies LinearQuery)

const TEXT_FIELDS = ['team', 'state', 'label', 'project'] as const

/** The Linear query a stored string holds. A string that isn't a JSON object reads as an empty
 *  query (every default); unknown keys are dropped, and a field of the wrong type or value, or a
 *  blank one, is ignored. */
export function readLinearQuery(stored: string): LinearQuery {
  const raw = parseJson(stored)
  if (!isRecord(raw)) return {}
  const query: LinearQuery = {}
  for (const field of TEXT_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && value.trim() !== '') query[field] = value.trim()
  }
  if (raw.assignee === 'me' || raw.assignee === 'null') query.assignee = raw.assignee
  if (raw.orderBy === 'updatedAt' || raw.orderBy === 'createdAt') query.orderBy = raw.orderBy
  return query
}
