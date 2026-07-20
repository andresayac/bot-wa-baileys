#!/usr/bin/env node
/**
 * copy-api-docs.cjs — copy the TypeDoc API reference (docs/api/) into the
 * VitePress build output (docs/dist/api/) so both are served together.
 *
 * `.cjs` because the workspace root is `"type": "module"`.
 */
'use strict'

const { cpSync, existsSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')

const root = resolve(__dirname, '..')
const src = resolve(root, 'docs', 'api')
const dest = resolve(root, 'docs', 'dist', 'api')

if (!existsSync(src)) {
  console.error('[copy-api-docs] Source not found:', src)
  console.error('[copy-api-docs] Run "pnpm run docs:api" first.')
  process.exit(1)
}

mkdirSync(resolve(root, 'docs', 'dist'), { recursive: true })
cpSync(src, dest, { recursive: true })
console.log('[copy-api-docs] Copied docs/api -> docs/dist/api')
