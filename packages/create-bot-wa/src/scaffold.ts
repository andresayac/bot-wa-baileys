/**
 * scaffold — the core (pure-ish, testable) logic behind `create-bot-wa`.
 *
 * Given a target directory + template, materializes the full project and
 * returns the list of files written. No prompts, no process.exit, no network —
 * the CLI (`cli.js`) is a thin wrapper around this.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { getTemplate, type TemplateName } from './templates.js'

export interface ScaffoldOptions {
  /** Directory to create the project in (created if missing). */
  targetDir: string
  /** npm package name; defaults to the (sanitized) target directory name. */
  name?: string
  /** Which project template to render. */
  template: TemplateName
  /** Allow writing into a non-empty target directory (default: false → throw). */
  overwrite?: boolean
}

export interface ScaffoldResult {
  /** Absolute path of the created project directory. */
  targetDir: string
  /** The npm package name stamped into package.json. */
  name: string
  /** The template that was rendered. */
  template: TemplateName
  /** Repo-relative paths of every file written, in write order. */
  files: string[]
}

/**
 * Derive a valid npm package name from a raw name or directory path:
 * lowercase, illegal characters → dashes, no leading `.`/`_`, never empty.
 */
export function sanitizeName(raw: string): string {
  const cleaned = basename(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[._]+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'my-bot'
}

/** True when `dir` exists and contains at least one entry. */
async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length > 0
  } catch (err) {
    // ENOENT → missing (fine to create); anything else (ENOTDIR = a file
    // occupies the path, EACCES, …) counts as a conflict so the guard fires.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Render `options.template` into `options.targetDir`.
 *
 * @throws if the target directory is non-empty and `overwrite` is not set,
 * or if the template name is unknown.
 * @returns the list of files written (repo-relative POSIX paths).
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const template = getTemplate(options.template)
  const targetDir = resolve(options.targetDir)
  const name = sanitizeName(options.name ?? targetDir)

  if (!options.overwrite && (await isNonEmptyDir(targetDir))) {
    throw new Error(
      'Target directory "' + targetDir + '" already exists and is not empty. ' +
      'Pass overwrite (CLI: --overwrite) to scaffold into it anyway.',
    )
  }

  const files = template.files(name)
  const written: string[] = []
  for (const file of files) {
    const dest = join(targetDir, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.contents, 'utf8')
    written.push(file.path.replace(/\\/g, '/'))
  }

  return { targetDir, name, template: template.name, files: written }
}
