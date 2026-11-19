// JQL recipes: ready-made kinds of filter on Jira that write a new filter's JQL queries from a few
// answers. A recipe is used once, when a filter is created; its answers are not stored. No Node
// imports, so the panel can use them.
import type { FilterRecipe } from './filter'
import { jqlStringContent } from './jql'

/** Whose tasks a recipe lists: the person's, the person's or nobody's, or anyone's. */
export type RecipeAssignees = 'mine' | 'mine-or-unassigned' | 'anyone'

/** The answers to a JQL recipe. `leaveOut` is the statuses to leave out, as typed: names separated
 *  by commas. */
export type JqlRecipeAnswers =
  | { recipe: 'board-order'; projectKey: string; assignees: RecipeAssignees; leaveOut: string }
  | { recipe: 'my-open-tasks'; leaveOut: string }

/** The name and JQL queries of the new filter that a recipe writes from its answers, or null when
 *  they lack one it needs: Board order's project key. The key is trimmed, not checked: a wrong one
 *  shows as the query's error when the filter lists its tasks. */
export function jqlRecipe(answers: JqlRecipeAnswers): FilterRecipe | null {
  const status = statusCondition(answers.leaveOut)
  if (answers.recipe === 'my-open-tasks') {
    return { name: 'My open tasks', queries: [andQuery(['assignee = currentUser()', status], 'updated DESC')] }
  }
  const projectKey = answers.projectKey.trim()
  if (projectKey === '') return null
  const project = `project = ${projectKey}`
  const assignee = ASSIGNEE_CONDITION[answers.assignees]
  const query = (sprint: string, order: string) => andQuery([project, sprint, assignee, status], order)
  return {
    name: 'Board order',
    queries: [
      query('sprint in openSprints()', 'Rank ASC'),
      query('sprint in futureSprints()', 'Sprint ASC, Rank ASC'),
      query('(sprint IS EMPTY OR sprint NOT IN (openSprints(), futureSprints()))', 'Rank ASC')
    ]
  }
}

/** A JQL query of the `conditions` that aren't null, joined by AND, in the order `order`. */
function andQuery(conditions: (string | null)[], order: string): string {
  return `${conditions.filter((condition) => condition !== null).join(' AND ')} ORDER BY ${order}`
}

const ASSIGNEE_CONDITION: Record<RecipeAssignees, string | null> = {
  mine: 'assignee = currentUser()',
  'mine-or-unassigned': '(assignee IS EMPTY OR assignee = currentUser())',
  anyone: null
}

/** The condition that leaves out the statuses named in `leaveOut`, or null when it names none. Each
 *  name is trimmed and quoted, with its `"` and `\` escaped; blank names are dropped. */
function statusCondition(leaveOut: string): string | null {
  const names = leaveOut
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  if (names.length === 0) return null
  return `status NOT IN (${names.map((name) => `"${jqlStringContent(name)}"`).join(', ')})`
}
