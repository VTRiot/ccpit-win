import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from '../extensionScanner'

describe('parseFrontmatter', () => {
  it('extracts name and description from a well-formed frontmatter block', () => {
    const md = `---
name: dual-axis-translation
description: Fires when translating bidirectionally...
---

body here
`
    const result = parseFrontmatter(md)
    expect(result.name).toBe('dual-axis-translation')
    expect(result.description).toBe('Fires when translating bidirectionally...')
  })

  it('returns empty object when no frontmatter delimiters', () => {
    const md = '# Just a heading\n\nbody'
    const result = parseFrontmatter(md)
    expect(result.name).toBeUndefined()
    expect(result.description).toBeUndefined()
  })

  it('returns name only when description is missing', () => {
    const md = `---
name: only-name
---

body
`
    const result = parseFrontmatter(md)
    expect(result.name).toBe('only-name')
    expect(result.description).toBeUndefined()
  })

  it('handles CRLF line endings', () => {
    const md = '---\r\nname: crlf-skill\r\ndescription: With Windows line endings\r\n---\r\n\r\nbody'
    const result = parseFrontmatter(md)
    expect(result.name).toBe('crlf-skill')
    expect(result.description).toBe('With Windows line endings')
  })
})
