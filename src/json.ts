// Helpers for reading JSON of unknown shape. No Node imports, so the panel can use it too.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
