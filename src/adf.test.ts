import { assert, test } from 'orca/testing'
import { adfToText } from './adf'

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })
const textNode = (text: string, marks?: unknown[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })

test('paragraphs, headings, lists and code blocks become lines', () => {
  const adf = doc(
    { type: 'heading', attrs: { level: 2 }, content: [textNode('Contexto')] },
    paragraph(textNode('La página de '), textNode('ajustes', [{ type: 'strong' }]), textNode(' necesita un tema oscuro.')),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(textNode('Colores'))] },
        { type: 'listItem', content: [paragraph(textNode('Iconos'))] }
      ]
    },
    {
      type: 'orderedList',
      attrs: { order: 1 },
      content: [
        { type: 'listItem', content: [paragraph(textNode('Diseñar'))] },
        { type: 'listItem', content: [paragraph(textNode('Probar'))] }
      ]
    },
    { type: 'codeBlock', attrs: { language: 'css' }, content: [textNode(':root {\n  color-scheme: dark;\n}')] }
  )
  assert.equal(
    adfToText(adf),
    [
      'Contexto',
      'La página de ajustes necesita un tema oscuro.',
      '- Colores',
      '- Iconos',
      '1. Diseñar',
      '2. Probar',
      ':root {',
      '  color-scheme: dark;',
      '}'
    ].join('\n')
  )
})

test('a hard break starts a new line, and a nested list is indented', () => {
  const adf = doc(
    paragraph(textNode('Primera'), { type: 'hardBreak' }, textNode('Segunda')),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            paragraph(textNode('Padre')),
            { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(textNode('Hijo'))] }] }
          ]
        }
      ]
    }
  )
  assert.equal(adfToText(adf), 'Primera\nSegunda\n- Padre\n  - Hijo')
})

test('an ordered list starts at its own number', () => {
  const adf = doc({
    type: 'orderedList',
    attrs: { order: 3 },
    content: [{ type: 'listItem', content: [paragraph(textNode('Tercero'))] }]
  })
  assert.equal(adfToText(adf), '3. Tercero')
})

test('inline nodes without text show their text attribute, and unknown nodes keep their text', () => {
  const adf = doc(
    paragraph(
      textNode('Ver '),
      { type: 'mention', attrs: { id: 'acc-1', text: '@Ana Example' } },
      textNode(' y '),
      { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
      textNode(' en '),
      { type: 'inlineCard', attrs: { url: 'https://example.atlassian.net/browse/WEB-7' } }
    ),
    { type: 'panel', attrs: { panelType: 'info' }, content: [paragraph(textNode('Nota'))] },
    { type: 'rule' },
    paragraph()
  )
  assert.equal(adfToText(adf), 'Ver @Ana Example y 🎉 en https://example.atlassian.net/browse/WEB-7\nNota')
})

test('no description gives an empty string, and plain text stays as it is', () => {
  assert.equal(adfToText(null), '')
  assert.equal(adfToText(undefined), '')
  assert.equal(adfToText({ type: 'doc', version: 1, content: [] }), '')
  assert.equal(adfToText('Texto plano'), 'Texto plano')
  assert.equal(adfToText(42), '')
})
