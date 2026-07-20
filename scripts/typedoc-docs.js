#!/usr/bin/env node
/**
 * typedoc-docs.js — runs TypeDoc using the TypeScript 5.9.3 build.
 *
 * Why: the project's main `typescript` is 7.0.2 (for the build), but TypeDoc 0.28
 * only supports up to TS 6.0.x. pnpm keeps a separate TypeDoc instance resolved
 * against TS 5.9.3 in its store; this wrapper invokes that one directly.
 */
'use strict'

const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const typedocBin = resolve(
  __dirname,
  '..',
  'node_modules',
  '.pnpm',
  'typedoc@0.28.20_typescript@5.9.3',
  'node_modules',
  'typedoc',
  'bin',
  'typedoc',
)

const result = spawnSync(process.execPath, [typedocBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: resolve(__dirname, '..'),
})

process.exit(result.status ?? 1)