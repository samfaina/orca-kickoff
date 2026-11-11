// Helpers for reading JSON of unknown shape. No Node imports, so the panel can use it too.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value when it is a string, else ''. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Parsed JSON, or undefined when the text isn't JSON. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
