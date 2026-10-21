#!/usr/bin/env node
/**
 * `botmesh` executable (package.json "bin"). All logic lives in `runCli`
 * (./cli.ts); this only binds it to the real process streams and exits once
 * stdout has flushed — so timers or sockets the bot left open never keep the
 * simulator alive after `:quit`.
 */

import { runCli } from './cli.js'

runCli(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }).then(
  (code) => {
    process.stdout.write('', () => process.exit(code))
  },
  (error: unknown) => {
    process.stderr.write(`botmesh: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`, () => process.exit(1))
  },
)
