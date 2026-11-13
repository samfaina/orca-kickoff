import { assert, test } from 'orca/testing'
import { adfToText } from './adf'

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })
const textNode = (text: string, marks?: unknown[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })

test('paragraphs, headings, lists and code blocks become lines', () => {
  const adf = doc(
    { type: 'heading', attrs: { level: 2 }, content: [textNode('Context')] },
    paragraph(textNode('The '), textNode('settings', [{ type: 'strong' }]), textNode(' page needs a dark theme.')),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(textNode('Colors'))] },
        { type: 'listItem', content: [paragraph(textNode('Icons'))] }
      ]
    },
    {
      type: 'orderedList',
      attrs: { order: 1 },
      content: [
        { type: 'listItem', content: [paragraph(textNode('Design'))] },
        { type: 'listItem', content: [paragraph(textNode('Test'))] }
      ]
    },
    { type: 'codeBlock', attrs: { language: 'css' }, content: [textNode(':root {\n  color-scheme: dark;\n}')] }
  )
  assert.equal(
    adfToText(adf),
    [
      'Context',
      'The settings page needs a dark theme.',
      '- Colors',
      '- Icons',
      '1. Design',
      '2. Test',
      ':root {',
      '  color-scheme: dark;',
      '}'
    ].join('\n')
  )
})

test('a hard break starts a new line, and a nested list is indented', () => {
  const adf = doc(
    paragraph(textNode('First'), { type: 'hardBreak' }, textNode('Second')),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            paragraph(textNode('Parent')),
            { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(textNode('Child'))] }] }
          ]
        }
      ]
    }
  )
  assert.equal(adfToText(adf), 'First\nSecond\n- Parent\n  - Child')
})

test('blank lines inside a code block stay, and a trailing line break does not add one', () => {
  const adf = doc(
    { type: 'codeBlock', content: [textNode('one\n\ntwo\n')] },
    paragraph(textNode('after'), { type: 'hardBreak' })
  )
  assert.equal(adfToText(adf), 'one\n\ntwo\nafter')
})

test('an ordered list starts at its own number', () => {
  const adf = doc({
    type: 'orderedList',
    attrs: { order: 3 },
    content: [{ type: 'listItem', content: [paragraph(textNode('Third'))] }]
  })
  assert.equal(adfToText(adf), '3. Third')
})

test('inline nodes without text show their text attribute, and unknown nodes keep their text', () => {
  const adf = doc(
    paragraph(
      textNode('See '),
      { type: 'mention', attrs: { id: 'acc-1', text: '@Ana Example' } },
      textNode(' and '),
      { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
      textNode(' in '),
      { type: 'inlineCard', attrs: { url: 'https://example.atlassian.net/browse/WEB-7' } }
    ),
    { type: 'panel', attrs: { panelType: 'info' }, content: [paragraph(textNode('Note'))] },
    { type: 'rule' },
    paragraph()
  )
  assert.equal(adfToText(adf), 'See @Ana Example and 🎉 in https://example.atlassian.net/browse/WEB-7\nNote')
})

test('no description gives an empty string, and plain text stays as it is', () => {
  assert.equal(adfToText(null), '')
  assert.equal(adfToText(undefined), '')
  assert.equal(adfToText({ type: 'doc', version: 1, content: [] }), '')
  assert.equal(adfToText('Plain text'), 'Plain text')
  assert.equal(adfToText(42), '')
})
