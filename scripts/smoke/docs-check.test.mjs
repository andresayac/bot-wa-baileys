// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  anchorsOf,
  checkSite,
  duplicates,
  linksOf,
  mermaidBlocks,
  repeatedHeadings,
  resolveLink,
  sidebarLinks,
} from './docs-check.mjs'

test('collects element ids and <a> hrefs, decoding entities', () => {
  const html = '<h2 id="options">O</h2><a href="/guide/x?a=1&amp;b=2#c%C3%B3mo">x</a><link href="/assets/a.css"><a class="x" href="#top">t</a>'
  assert.deepEqual([...anchorsOf(html)], ['options'])
  assert.deepEqual(linksOf(html), ['/guide/x?a=1&b=2#c%C3%B3mo', '#top'])
})

test('resolves site links to dist files and decoded hashes', () => {
  assert.deepEqual(resolveLink('/guide/x#c%C3%B3mo', '/es/guide/y'), { file: 'guide/x.html', hash: 'cómo' })
  assert.deepEqual(resolveLink('#top', '/guide/y'), { file: 'guide/y.html', hash: 'top' })
  assert.deepEqual(resolveLink('/es/', '/guide/y'), { file: 'es/index.html', hash: '' })
  assert.deepEqual(resolveLink('/', '/guide/y'), { file: 'index.html', hash: '' })
  assert.deepEqual(resolveLink('/llms.txt', '/'), { file: 'llms.txt', hash: '' })
  assert.equal(resolveLink('https://example.com/a', '/'), null)
  assert.equal(resolveLink('mailto:a@b.c', '/'), null)
})

test('reads the sidebar links and finds duplicates', () => {
  const html = '<a href="/a">n</a><aside class="VPSidebar"><a href="/x">1</a><a href="/y">2</a><a href="/x">3</a></aside>'
  assert.deepEqual(sidebarLinks(html), ['/x', '/y', '/x'])
  assert.deepEqual(duplicates(['/x', '/y', '/x', '/x']), ['/x'])
})

test('counts mermaid fences and repeated headings outside code blocks', () => {
  const md = [
    '# T', '## Chatwoot', '### Options', '```mermaid', 'flowchart TD', '```',
    '## Tickets', '### Options', '```md', '### Options', '```', '````mermaid', 'graph LR', '````',
  ].join('\n')
  assert.equal(mermaidBlocks(md), 2)
  assert.deepEqual(repeatedHeadings(md), ['Options'])
  assert.deepEqual(repeatedHeadings('## A {#a}\n## A {#b}\n'), [])
})

test('checkSite reports broken links, missing anchors, sidebar duplicates and unrendered mermaid', () => {
  const root = mkdtempSync(join(tmpdir(), 'botwa-docs-check-'))
  try {
    const src = join(root, 'src')
    const dist = join(root, 'dist')
    mkdirSync(join(src, 'guide'), { recursive: true })
    mkdirSync(join(dist, 'guide'), { recursive: true })
    writeFileSync(join(src, 'guide/a.md'), '# A\n\n```mermaid\ngraph LR\n```\n\n## Same\n## Same\n')
    writeFileSync(join(src, 'guide/b.md'), '# B\n\n```mermaid\ngraph LR\n```\n')
    writeFileSync(join(dist, 'guide/a.html'),
      '<aside class="VPSidebar"><a href="/guide/a">a</a><a href="/guide/a">a</a></aside>'
      + '<h1 id="a">A</h1><div class="mermaid-diagram"></div>'
      + '<a href="/guide/b#b">ok</a><a href="/guide/b#nope">bad anchor</a><a href="/guide/c">bad page</a><a href="/api/">api</a>')
    writeFileSync(join(dist, 'guide/b.html'), '<h1 id="b">B</h1><pre><code class="language-mermaid">graph LR</code></pre>')
    const { errors, warnings } = checkSite({ distDir: dist, srcDir: src, ignore: [/^\/api\//] })
    assert.deepEqual(errors.sort(), [
      '/guide/a: duplicate sidebar link /guide/a',
      '/guide/a: missing anchor /guide/b#nope',
      '/guide/a: missing page /guide/c',
      '/guide/b: 1 mermaid block(s) in the source, 0 rendered diagram(s)',
    ])
    assert.deepEqual(warnings, ['guide/a.md: repeated heading "Same"'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
