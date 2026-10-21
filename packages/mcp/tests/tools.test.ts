import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXAMPLE_FLOW_DOCUMENT,
  createTools,
  stepKindsOf,
  type ToolContext,
  type ToolDefinition,
} from '../src/tools.js'
import { parseSections, readDocPage, searchSections } from '../src/docs.js'

const tools = createTools()
const tool = (name: string, context: ToolContext = {}): ToolDefinition => {
  const found = createTools(context).find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}
const call = async (name: string, args: Record<string, unknown>, context: ToolContext = {}): Promise<Record<string, any>> => {
  const output = await tool(name, context).handler(args, context)
  return JSON.parse(output.text) as Record<string, any>
}
const output = (name: string, args: Record<string, unknown>, context: ToolContext = {}) => tool(name, context).handler(args, context)

const valid = {
  version: 1,
  id: 'menu',
  trigger: 'menu',
  steps: [
    { kind: 'say', text: 'Hola' },
    { kind: 'ask', text: '¿Nombre?', stateKey: 'name', timeout: '60s' },
  ],
}

describe('tool catalogue', () => {
  it('registers the flow tools and hides the docs tools without a docs directory', () => {
    expect(tools.map((entry) => entry.name)).toEqual([
      'flow_validate', 'flow_analyze', 'flow_migrate', 'flow_diff', 'flow_digest', 'flow_schema', 'flow_example',
    ])
    expect(tools.every((entry) => entry.description.length > 40 && entry.title !== '')).toBe(true)
    expect(tools.every((entry) => entry.inputSchema.type === 'object')).toBe(true)
  })

  it('adds the docs tools when a docs directory is configured', () => {
    const names = createTools({ docsDir: 'docs' }).map((entry) => entry.name)
    expect(names).toContain('docs_search')
    expect(names).toContain('docs_page')
    expect(createTools({ docsDir: '' }).map((entry) => entry.name)).not.toContain('docs_search')
  })
})

describe('flow_validate', () => {
  it('accepts a valid document and summarizes it', async () => {
    const result = await call('flow_validate', { document: valid })
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.summary).toMatchObject({ id: 'menu', version: 1, steps: 2, kinds: { say: 1, ask: 1 } })
  })

  it('reports invalid documents as a result, not as an error, with JSON Pointer paths', async () => {
    const result = await call('flow_validate', { document: { version: 1, id: 'x', trigger: 'x', steps: [{ kind: 'say' }] } })
    expect(result.valid).toBe(false)
    expect(result.summary).toBeUndefined()
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues.some((issue: { path: string }) => issue.path.startsWith('/steps/0'))).toBe(true)
  })

  it('rejects arguments that are not a document', async () => {
    // `flow_validate` answers synchronously, so the guard throws before a promise exists.
    expect(() => output('flow_validate', { document: 'hola' })).toThrow(/"document" must be a flow document/)
    expect(() => output('flow_validate', {})).toThrow(/"document"/)
  })
})

describe('flow_analyze', () => {
  it('renders a Mermaid graph and the lint diagnostics of a valid document', async () => {
    const result = await call('flow_analyze', { document: valid })
    expect(result.valid).toBe(true)
    expect(result.mermaid).toContain('flowchart')
    expect(result.mermaid).toContain('menu')
    expect(Array.isArray(result.diagnostics)).toBe(true)
  })

  it('returns the JSON graph and honours the direction option', async () => {
    const json = await call('flow_analyze', { document: valid, format: 'json' })
    expect(json.graph).toMatchObject({ version: 1 })
    expect(Array.isArray(json.graph.flows)).toBe(true)
    expect(json.mermaid).toBeUndefined()
    const lr = await call('flow_analyze', { document: valid, direction: 'LR' })
    expect(lr.mermaid).toContain('flowchart LR')
  })

  it('stops at validation when the document is invalid', async () => {
    const result = await call('flow_analyze', { document: { version: 1, id: 'x', trigger: 'x', steps: [] } })
    expect(result.valid).toBe(false)
    expect(result.mermaid).toBeUndefined()
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('resolves subflow steps passed alongside the document', async () => {
    const withSubflow = {
      version: 1,
      id: 'parent',
      trigger: 'parent',
      steps: [{ kind: 'subflow', flowId: 'child' }, { kind: 'say', text: 'fin' }],
    }
    const unresolved = await call('flow_analyze', { document: withSubflow })
    expect(unresolved.valid).toBe(false)
    expect(unresolved.issues[0].message).toContain('cannot be resolved')

    const resolved = await call('flow_analyze', {
      document: withSubflow,
      subflows: { child: { version: 1, id: 'child', trigger: 'child', steps: [{ kind: 'say', text: 'hijo' }] } },
    })
    expect(resolved.valid).toBe(true)
    expect(typeof resolved.mermaid).toBe('string')
    expect(Array.isArray(resolved.diagnostics)).toBe(true)
  })
})

describe('flow_migrate, flow_diff and flow_digest', () => {
  it('migrates a document without version from 0 to the current one', async () => {
    const result = await call('flow_migrate', { document: { id: 'viejo', trigger: 'viejo', steps: [{ kind: 'say', text: 'hola' }] } })
    expect(result.from).toBe(0)
    expect(result.to).toBe(1)
    expect(result.applied.length).toBeGreaterThan(0)
    expect(result.issues).toEqual([])
  })

  it('refuses a version this package cannot know', async () => {
    const result = await output('flow_migrate', { document: { ...valid, version: 99 } })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/version/i)
  })

  it('diffs two documents and reports both digests', async () => {
    const changed = { ...valid, trigger: 'inicio' }
    const result = await call('flow_diff', { left: valid, right: changed })
    expect(result.valid).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.metadata).toContain('trigger')
    expect(result.before).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.after).not.toBe(result.before)
    const same = await call('flow_diff', { left: valid, right: valid })
    expect(same.changed).toBe(false)
  })

  it('digests a valid document and rejects an invalid one as a result', async () => {
    const digest = await call('flow_digest', { document: valid })
    expect(digest.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(digest.version).toMatch(/^flow-[0-9a-f]{16}$/)
    const invalid = await call('flow_digest', { document: { version: 1 } })
    expect(invalid.valid).toBe(false)
    expect(invalid.digest).toBeUndefined()
  })
})

describe('flow_schema and flow_example', () => {
  it('returns the schema, the limits and every accepted step kind', async () => {
    const result = await call('flow_schema', {})
    expect(result.schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(result.version).toBe(1)
    expect(result.stepKinds.sort()).toEqual([
      'ai', 'ask', 'choose', 'condition', 'delay', 'end', 'form', 'goto', 'guard', 'handoff', 'http', 'media', 'say', 'subflow',
    ])
    expect(typeof result.limits).toBe('object')
  })

  it('derives the step kinds from the schema itself (no drift)', () => {
    expect(stepKindsOf({ $defs: { step: { oneOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }] } } })).toEqual(['a', 'b'])
    expect(stepKindsOf({})).toEqual([])
  })

  it('ships an example that validates and lints clean', async () => {
    const result = await call('flow_example', {})
    expect(result.issues).toEqual([])
    const analysis = await call('flow_analyze', { document: result.document })
    expect(analysis.valid).toBe(true)
    expect(analysis.diagnostics).toEqual([])
    expect(result.document).toEqual(EXAMPLE_FLOW_DOCUMENT)
  })
})

describe('documentation tools', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'botwa-mcp-docs-'))
    await mkdir(join(root, 'guide'), { recursive: true })
    await mkdir(join(root, 'es', 'guide'), { recursive: true })
    await mkdir(join(root, 'api'), { recursive: true })
    await writeFile(
      join(root, 'guide', 'flows.md'),
      '# Flows\n\n## Waits\n\nA flow parks in an `ask` until the user answers.\n\n```bash\n# this is not a heading\nbot-wa dev\n```\n\n## Timeouts\n\nThe wait ends after its timeout.\n',
      'utf8',
    )
    await writeFile(join(root, 'es', 'guide', 'flujos.md'), '# Flujos\n\n## Esperas\n\nUn flujo se queda esperando en un `ask`.\n', 'utf8')
    await writeFile(join(root, 'api', 'index.md'), '# API\n\nGenerated, must never be indexed.\n', 'utf8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds sections in both languages, skipping generated output', async () => {
    const context = { docsDir: root }
    const english = await call('docs_search', { query: 'ask wait' }, context)
    expect(english.count).toBeGreaterThan(0)
    expect(english.hits[0].path).toBe('guide/flows.md')
    expect(english.hits.map((hit: { path: string }) => hit.path)).not.toContain('api/index.md')

    const spanish = await call('docs_search', { query: 'esperas' }, context)
    expect(spanish.hits[0].path).toBe('es/guide/flujos.md')
    expect(spanish.hits[0].heading).toBe('Esperas')
  })

  it('does not treat a comment inside a code fence as a heading', () => {
    const sections = parseSections('guide/x.md', '# T\n\n```bash\n# not a heading\nbot-wa dev\n```\n\n## Real\n\nbody\n')
    expect(sections.map((section) => section.heading)).toEqual(['T', 'Real'])
    expect(sections[0]!.body).toContain('bot-wa dev')
  })

  it('returns no hits for an empty or unknown query', () => {
    const sections = parseSections('a.md', '# A\n\nhola mundo\n')
    expect(searchSections(sections, '')).toEqual([])
    expect(searchSections(sections, 'inexistente')).toEqual([])
    expect(searchSections(sections, 'hola')[0]!.snippet).toBe('hola mundo')
  })

  it('ranks a rare identifier above a word that appears everywhere', () => {
    const sections = parseSections(
      'durabilidad.md',
      '# Durabilidad\n\n## Backends\n\n`appendLog` escribe un journal append-only. appendLog compacta.\n',
    )
    // Twenty decoys that only repeat the common word.
    for (let index = 0; index < 20; index++) {
      sections.push({ path: `ruido-${index}.md`, title: 'Durabilidad', heading: 'Resumen', body: 'durabilidad durabilidad' })
    }
    const hits = searchSections(sections, 'appendLog durabilidad', 3)
    expect(hits[0]!.path).toBe('durabilidad.md')
    expect(hits[0]!.heading).toBe('Backends')
  })

  it('ignores function words but still searches a query made only of them', () => {
    const sections = parseSections('a.md', '# A\n\n## Stop a conversation\n\nhow to stop a conversation\n')
    expect(searchSections(sections, 'how to stop a conversation')[0]!.heading).toBe('Stop a conversation')
    expect(searchSections(sections, 'how to')[0]!.path).toBe('a.md')
  })

  it('reads a page by relative path and refuses escapes and non-markdown', async () => {
    const context = { docsDir: root }
    const page = await call('docs_page', { path: 'guide/flows.md' }, context)
    expect(page.path).toBe('guide/flows.md')
    expect(page.text).toContain('# Flows')
    expect(page.truncated).toBe(false)

    const escape = await output('docs_page', { path: '../package.json' }, context)
    expect(escape.isError).toBe(true)
    const notMarkdown = await output('docs_page', { path: 'guide/flows.txt' }, context)
    expect(notMarkdown.isError).toBe(true)
    const missing = await output('docs_page', { path: 'guide/nope.md' }, context)
    expect(missing.isError).toBe(true)
    await expect(readDocPage(root, '../x.md')).rejects.toThrow(/escapes the docs directory/)
  })

  it('rejects a search without a query', async () => {
    await expect(output('docs_search', { query: '  ' }, { docsDir: root })).rejects.toThrow(/"query"/)
  })
})
