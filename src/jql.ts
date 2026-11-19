// JQL text that the Jira providers and the JQL recipes share. No Node imports, so the panel can use
// it too.

/** `value` escaped to go between the double quotes of a JQL string: each `"` and `\` gets a `\`. */
export function jqlStringContent(value: string): string {
  return value.replace(/[\\"]/g, (char) => `\\${char}`)
}
