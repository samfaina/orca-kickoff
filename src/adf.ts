// Atlassian Document Format (ADF), the JSON Jira keeps descriptions in, as plain text for the
// prompt template. Paragraphs, headings, list items and code lines each become lines; marks are
// dropped. Pure, with no Node imports.
import { isRecord, text } from './json'

/** The plain text of an ADF document. A string is kept as it is; anything else that isn't ADF
 *  gives ''. */
export function adfToText(adf: unknown): string {
  if (typeof adf === 'string') return adf
  return blockLines(adf).join('\n')
}

function children(node: Record<string, unknown>): unknown[] {
  return Array.isArray(node.content) ? node.content : []
}

function blockLines(node: unknown): string[] {
  if (!isRecord(node)) return []
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return inlineText(children(node))
        .split('\n')
        .filter((line, _, lines) => lines.length > 1 || line.trim() !== '')
    case 'bulletList':
      return children(node).flatMap((item) => listItemLines(item, '- '))
    case 'orderedList': {
      const start = isRecord(node.attrs) && typeof node.attrs.order === 'number' ? node.attrs.order : 1
      return children(node).flatMap((item, index) => listItemLines(item, `${start + index}. `))
    }
    case 'text':
      return text(node.text).split('\n')
    default:
      return children(node).flatMap(blockLines)
  }
}

/** A list item's lines: the first after its marker, the rest indented under it. */
function listItemLines(item: unknown, marker: string): string[] {
  const indent = ' '.repeat(marker.length)
  const lines = isRecord(item) ? children(item).flatMap(blockLines) : []
  return lines.map((line, index) => (index === 0 ? marker : indent) + line)
}

function inlineText(nodes: unknown[]): string {
  return nodes
    .map((node) => {
      if (!isRecord(node)) return ''
      if (node.type === 'text') return text(node.text)
      if (node.type === 'hardBreak') return '\n'
      const attrs = isRecord(node.attrs) ? node.attrs : {}
      if (text(attrs.text)) return text(attrs.text)
      if (node.type === 'inlineCard') return text(attrs.url)
      return inlineText(children(node))
    })
    .join('')
}
