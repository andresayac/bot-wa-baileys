#!/usr/bin/env node
/**
 * create-bot-wa — scaffold a new @bot-wa bot project.
 *
 * Thin bin: parses argv, prompts for anything missing when interactive,
 * then delegates to `scaffold()` (the testable core in scaffold.ts).
 *
 * Usage: create-bot-wa <dir> [--template <name>] [--name <n>] [--yes] [--overwrite]
 * Templates: baileys, meta, telegram, ai, games, support, store, restaurant, clinic, ai-full.
 */

import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { scaffold } from './scaffold.js'
import { TEMPLATE_NAMES, getTemplate } from './templates.js'

const DEFAULT_TEMPLATE = 'baileys'

/**
 * Parse CLI arguments (exported for tests — pure, no I/O).
 * @param {string[]} argv process.argv without node + script
 * @returns {{ targetDir?: string, template?: string, name?: string, yes: boolean, overwrite: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { targetDir: undefined, template: undefined, name: undefined, yes: false, overwrite: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--yes' || arg === '-y') out.yes = true
    else if (arg === '--overwrite') out.overwrite = true
    else if (arg === '--template' || arg === '-t') out.template = argv[++i]
    else if (arg.startsWith('--template=')) out.template = arg.slice('--template='.length)
    else if (arg === '--name') out.name = argv[++i]
    else if (arg.startsWith('--name=')) out.name = arg.slice('--name='.length)
    else if (arg.startsWith('-') && arg.length > 1) throw new Error('Unknown option: ' + arg)
    else if (out.targetDir === undefined) out.targetDir = arg
    else throw new Error('Unexpected argument: ' + arg)
  }
  return out
}

function printUsage(log = console.log) {
  log('Usage: create-bot-wa <dir> [options]')
  log('')
  log('Scaffold a new @bot-wa bot (npm create bot-wa@latest).')
  log('')
  log('Arguments:')
  log('  dir                 target directory; the package name is derived from it')
  log('')
  log('Options:')
  log('  -t, --template <t>  one of: ' + TEMPLATE_NAMES.join(', ') + ' (default: ' + DEFAULT_TEMPLATE + ' when non-interactive)')
  log('  --name <name>       package name (default: directory name)')
  log('  -y, --yes           skip prompts; use defaults for anything missing')
  log('  --overwrite         allow scaffolding into a non-empty directory')
  log('  -h, --help          show this help')
  log('')
  log('Examples:')
  log('  npm create bot-wa@latest my-bot')
  log('  npm create bot-wa@latest my-bot -- --template telegram')
  log('  npm create bot-wa@latest my-shop -- --template store')
}

/** Prompt for missing options (interactive TTY only). */
async function completeInteractively(args) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.yes
  if (!interactive) {
    if (!args.template) args.template = DEFAULT_TEMPLATE
    if (!args.targetDir) throw new Error('Missing target directory. Usage: create-bot-wa <dir> [--template ' + TEMPLATE_NAMES.join('|') + '] (or run in a TTY to be prompted)')
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (!args.targetDir) {
      args.targetDir = (await rl.question('Project directory: ')).trim()
      if (!args.targetDir) throw new Error('A target directory is required.')
    }
    if (!args.template) {
      console.log('Templates:')
      TEMPLATE_NAMES.forEach((t, i) => console.log('  ' + (i + 1) + ') ' + t.padEnd(11) + '— ' + getTemplate(t).description))
      const answer = ((await rl.question('Template [1]: ')) || '').trim() || '1'
      const idx = Number(answer)
      args.template = Number.isInteger(idx) && idx >= 1 && idx <= TEMPLATE_NAMES.length ? TEMPLATE_NAMES[idx - 1] : answer
    }
  } finally {
    rl.close()
  }
}

/**
 * CLI entry point (exported for tests).
 * @param {string[]} argv defaults to process.argv.slice(2)
 */
export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    printUsage(console.error)
    process.exitCode = 1
    return
  }

  if (args.help) {
    printUsage()
    return
  }

  try {
    await completeInteractively(args)
    const result = await scaffold({
      targetDir: args.targetDir,
      name: args.name,
      template: /** @type {import('./templates.js').TemplateName} */ (args.template),
      overwrite: args.overwrite,
    })

    const template = getTemplate(result.template)
    const cd = relative(process.cwd(), result.targetDir).split(/[\\/]/).join('/') || '.'
    console.log('')
    console.log('✨ Created ' + template.label + ' project "' + result.name + '" in ' + result.targetDir)
    console.log('')
    console.log('Files:')
    for (const f of result.files) console.log('  ' + f)
    console.log('')
    console.log('Next steps:')
    console.log('  cd ' + cd)
    console.log('  npm install            # or: pnpm install')
    console.log('  cp .env.example .env   # then fill in your credentials')
    console.log('  npm start')
  } catch (err) {
    console.error('Error: ' + (err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  }
}

// Run only when executed directly (not when imported — e.g. by tests).
const isMain = (() => {
  try {
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return entry !== '' && entry === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) void main()
