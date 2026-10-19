// Run with: pnpm test:scripts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relativeLinks } from './readme-links.mjs'

test('flags relative markdown, reference and HTML links', () => {
  const md = [
    'See [the example](examples/bot.ts) and [guide](./docs/x.md).',
    '![logo](logo.png)',
    '[ref]: ../CHANGELOG.md',
    '<a href="LICENSE">license</a> <img src="img/a.svg">',
  ].join('\n')
  assert.deepEqual(relativeLinks(md), ['examples/bot.ts', './docs/x.md', 'logo.png', '../CHANGELOG.md', 'LICENSE', 'img/a.svg'])
})

test('accepts absolute URLs, anchors and mailto', () => {
  const md = [
    '[gh](https://github.com/a/b/blob/main/examples/bot.ts) [npm](http://npmjs.com)',
    '[top](#install) [mail](mailto:a@b.c)',
    '[ref]: https://example.com/x',
    '<a href="https://x.y">x</a>',
  ].join('\n')
  assert.deepEqual(relativeLinks(md), [])
})

test('ignores links inside code blocks and inline code', () => {
  const md = ['```ts', "const x = '[a](b.ts)'", '```', 'Use `[x](y.md)` literally.'].join('\n')
  assert.deepEqual(relativeLinks(md), [])
})
