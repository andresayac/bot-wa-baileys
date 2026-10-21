#!/usr/bin/env node
/**
 * api-check.cjs — cheap API-extractor-style checks over the compiled `.d.ts` of the
 * public packages (run `pnpm build` first). Uses the root TypeScript (5.9, the one
 * TypeDoc uses) only to read declarations; it never compiles anything.
 *
 *   node scripts/api-check.cjs missing    # types referenced by public signatures but exported from no entry,
 *                                         # and DANGLING references (a type stripped by stripInternal but still named by a kept signature)
 *   node scripts/api-check.cjs surface    # sorted list of every exported name per entry (diff it before/after)
 *   node scripts/api-check.cjs any        # `any` in exported declarations
 *   node scripts/api-check.cjs internal   # exported symbols, and members of exported declarations, tagged @internal
 *                                         # (tsconfig.base.json sets stripInternal, so both lists must be empty)
 *   node scripts/api-check.cjs deprecated # exported names tagged @deprecated (on the export or its declaration)
 *
 * `pnpm api-check` runs missing + any + internal. Exits 1 when `missing`, `internal` or `any` finds
 * something (`deprecated` only lists). See docs/api-review.md.
 */
const path = require('path')
const fs = require('fs')

const root = path.resolve(__dirname, '..')
const mode = process.argv[2] || 'missing'
const ts = require(path.join(root, 'node_modules/typescript'))
const PUBLIC = ['core', 'baileys-provider', 'meta-provider', 'telegram-provider', 'sqlite-store', 'redis-store', 'ai', 'http', 'graph-core']
/** Reviewed and accepted (see docs/api-review.md): the EventEmitter-compatible overloads of Bot.on/once/off/emit. */
const ALLOWED_ANY = new Set(['Bot'])

let problems = 0
for (const dir of PUBLIC) {
  const pdir = path.join(root, 'packages', dir)
  const pj = JSON.parse(fs.readFileSync(path.join(pdir, 'package.json'), 'utf8'))
  const entries = Object.entries(pj.exports).map(([k, v]) => [k, path.join(pdir, typeof v === 'string' ? v : v.types)])
  const program = ts.createProgram(entries.map((e) => e[1]), {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, skipLibCheck: true,
  })
  const checker = program.getTypeChecker()
  const libDir = path.join(pdir, 'lib').replace(/\\/g, '/')
  const exported = new Set()
  const names = []
  const exportSyms = []
  for (const [k, file] of entries) {
    const sf = program.getSourceFile(file)
    if (!sf) throw new Error(`${pj.name}: missing ${file} — run pnpm build first`)
    for (const s of checker.getExportsOfModule(checker.getSymbolAtLocation(sf))) {
      const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s
      exported.add(target)
      names.push(`${pj.name}${k === '.' ? '' : k.slice(1)}#${s.name}`)
      exportSyms.push([k, s.name, target, s])
    }
  }
  if (mode === 'surface') { names.sort().forEach((n) => console.log(n)); continue }

  const missing = new Map()
  const dangling = new Map()
  const anys = []
  const internals = []
  const deprecated = []
  const seen = new Set()
  const lineOf = (node) => {
    const sf = node.getSourceFile()
    return `${path.relative(pdir, sf.fileName).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
  }
  const visit = (decl, owner) => {
    const walk = (node) => {
      if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node) || ts.isTypeQueryNode(node)) {
        const nameNode = ts.isTypeReferenceNode(node) ? node.typeName : ts.isTypeQueryNode(node) ? node.exprName : node.expression
        let sym = checker.getSymbolAtLocation(nameNode)
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
        // A plain identifier that resolves to nothing: the declaration was stripped (`@internal` +
        // stripInternal) while a kept signature still names it. Lib/global names always resolve.
        if (!sym && ts.isIdentifier(nameNode)) {
          const key = `${nameNode.text} (${lineOf(nameNode)})`
          if (!dangling.has(key)) dangling.set(key, new Set())
          dangling.get(key).add(owner)
        }
        if (sym && sym.declarations && sym.declarations.length && !(sym.flags & ts.SymbolFlags.TypeParameter)) {
          const f = sym.declarations[0].getSourceFile().fileName.replace(/\\/g, '/')
          if (f.startsWith(libDir) && !exported.has(sym)) {
            const key = `${sym.name} (${path.relative(pdir, f).replace(/\\/g, '/')})`
            if (!missing.has(key)) missing.set(key, new Set())
            missing.get(key).add(owner)
            if (!seen.has(sym)) { seen.add(sym); for (const d of sym.declarations) visit(d, sym.name) }
          }
        }
      }
      if (node.kind === ts.SyntaxKind.AnyKeyword && !ALLOWED_ANY.has(owner)) {
        const sf = node.getSourceFile()
        anys.push(`${owner} @ ${path.relative(pdir, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
      }
      const isPrivate = (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node))
        && node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
      // Members of an exported declaration tagged @internal would leak without stripInternal.
      const isMember = ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node)
        || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
      if (isMember && !isPrivate && ts.getJSDocTags(node).some((t) => t.tagName.text === 'internal')) {
        const member = ts.isConstructorDeclaration(node) ? 'constructor' : node.name.getText()
        internals.push(`member ${owner}.${member} @ ${lineOf(node)}`)
      }
      if (!isPrivate) ts.forEachChild(node, walk)
    }
    walk(decl)
  }
  const hasTag = (decls, tag) => (decls ?? []).some((d) => ts.getJSDocTags(d).some((t) => t.tagName.text === tag))
  for (const [k, name, sym, alias] of exportSyms) {
    if (hasTag(alias.declarations, 'deprecated') || hasTag(sym.declarations, 'deprecated')) deprecated.push(`${k} ${name}`)
    for (const d of sym.declarations ?? []) {
      if (ts.getJSDocTags(d).some((t) => t.tagName.text === 'internal')) internals.push(`${k} ${name}`)
      visit(d, name)
    }
  }
  const out = mode === 'missing' ? [
      ...[...missing].map(([k, v]) => `MISSING ${k} <- ${[...v].slice(0, 4).join(', ')}`),
      ...[...dangling].map(([k, v]) => `DANGLING ${k} <- ${[...v].slice(0, 4).join(', ')}`),
    ]
    : mode === 'any' ? anys.map((a) => `ANY ${a}`)
    : mode === 'internal' ? [...new Set(internals)].map((a) => `INTERNAL ${a}`)
    : mode === 'deprecated' ? deprecated.map((a) => `DEPRECATED ${a}`)
    : []
  console.log(`${pj.name}: ${names.length} exports${out.length ? `, ${out.length} finding(s)` : ''}`)
  for (const line of out) console.log(`  ${line}`)
  if (mode !== 'deprecated') problems += out.length
}
process.exitCode = problems > 0 ? 1 : 0
