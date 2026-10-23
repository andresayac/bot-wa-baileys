import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scaffold } from '../src/scaffold.js'
import { TEMPLATE_NAMES, TEMPLATES, type TemplateName } from '../src/templates.js'

const tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'create-botmesh-domain-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

const DOMAIN: TemplateName[] = ['games', 'support', 'store', 'restaurant', 'clinic', 'ai-full']

/** v1 / builderbot idioms that must never appear in generated code. */
const V1_API = /\.addAnswer\(|\.addAction\(|capture:\s*true|flowDynamic|gotoFlow|endFlow|\.end\(\)|globalState/

describe('use-case templates (FEATURES #39)', () => {
  it('are registered', () => {
    for (const name of DOMAIN) {
      expect(TEMPLATE_NAMES).toContain(name)
      expect(TEMPLATES[name].name).toBe(name)
      expect(TEMPLATES[name].description.length).toBeGreaterThan(10)
    }
  })

  it.each(DOMAIN)('template "%s" scaffolds valid ESM on the v2 API', async (template) => {
    const target = join(await makeTempDir(), 'my-' + template)
    const result = await scaffold({ targetDir: target, template })
    expect(result.files).toContain('AGENTS.md')

    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    expect(pkg.type).toBe('module')
    expect(pkg.scripts.dev).toBe('botmesh dev src/bot.js --env-file-if-exists .env')
    expect(pkg.dependencies['@botmesh/baileys']).toBeTruthy()

    const bot = await readFile(join(target, 'src/bot.js'), 'utf8')
    expect(bot).toContain('defineBot(')
    expect(bot).toContain('if (isMainModule(import.meta)) {')
    expect(bot).not.toMatch(V1_API)
    expect(bot).not.toMatch(/console\./)
    expect(bot).not.toMatch(/await\s+[\w.]*runtime\.enter\(/)

    const check = spawnSync(process.execPath, ['--check', join(target, 'src/bot.js')], { encoding: 'utf8' })
    expect(check.stderr).toBe('')
    expect(check.status).toBe(0)
  })

  it('ai-full wires AI, SQLite store, scheduler, slash commands and handoff', async () => {
    const target = join(await makeTempDir(), 'full')
    await scaffold({ targetDir: target, template: 'ai-full' })
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/sdk',
      '@botmesh/ai',
      '@botmesh/baileys',
      '@botmesh/core',
      '@botmesh/sqlite-store',
      'better-sqlite3',
    ])
    const bot = await readFile(join(target, 'src/bot.js'), 'utf8')
    expect(bot).toContain('new SQLiteStore(')
    expect(bot).toContain('bot.every(')
    expect(bot).toContain('bot.schedule(')
    expect(bot).toContain('ctx.handoff(')
    // Slash commands are plugged before the AI catch-all.
    expect(bot.indexOf('bot.plug(slashCommandsPlugin)')).toBeGreaterThan(0)
    expect(bot.indexOf('bot.plug(slashCommandsPlugin)')).toBeLessThan(bot.indexOf('aiPlugin({'))
    expect(bot).toContain('WhatsApp Business Platform')
    expect(bot).toContain('https://www.whatsapp.com/legal/business-solution-terms')
    expect(await readFile(join(target, '.env.example'), 'utf8')).toContain('SQLITE_FILE=')
    // AI tools: enum-validated products, confirmed order create/update/cancel.
    expect(bot).toContain('enum: PRODUCTS')
    for (const tool of ['ver_menu', 'mis_pedidos', 'crear_pedido', 'actualizar_pedido', 'cancelar_pedido']) expect(bot).toContain(tool + ': {')
    expect(bot).toContain('tools: TOOLS')
    // Built-in texts pinned to the persona's language; tool-loop audit trail.
    expect(bot).toContain("i18n: { defaultLocale: 'es', locales: ['es'] }")
    expect(bot).toContain('onToolEvent:')
  })
})

describe('AGENTS.md in every generated project', () => {
  it.each(TEMPLATE_NAMES)('template "%s" documents the v2 API and commands', async (template) => {
    const target = join(await makeTempDir(), 'agents-' + template)
    await scaffold({ targetDir: target, template })
    const agents = await readFile(join(target, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('# AGENTS.md')
    expect(agents).toContain('npm run dev')
    expect(agents).toContain('npm start')
    expect(agents).toContain('defineBot')
    expect(agents).toContain("flow('pedido')")
    expect(agents).toContain('bot.conversation(')
    expect(agents).toContain('ctx.user')
    // The forbidden v1 idioms are named (in the "does NOT exist" table) so agents avoid them.
    for (const v1 of ['addAnswer', 'capture: true', 'addAction', 'flowDynamic', 'gotoFlow', 'endFlow']) expect(agents).toContain(v1)
    expect(agents).toMatch(/Does NOT exist/)
    // Its dependency list matches package.json.
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    for (const dep of Object.keys(pkg.dependencies)) expect(agents).toContain('`' + dep + '`')
    expect(await readFile(join(target, 'README.md'), 'utf8')).toContain('AGENTS.md')
  })
})

/* ---------------------------------------------------------------------------
 * Drive each generated use-case bot in the real `botmesh dev` engine.
 * ------------------------------------------------------------------------ */

const coreLib = fileURLToPath(new URL('../../core/lib/', import.meta.url))
const devEntry = join(coreLib, 'dev', 'index.js')
const testingEntry = join(coreLib, 'testing', 'index.js')
// The real @botmesh/ai (built), to render the template tools' confirmation prompts.
const aiEntry = fileURLToPath(new URL('../../ai/lib/index.js', import.meta.url))

interface DevSessionLike {
  start(): Promise<boolean>
  handleLine(line: string): Promise<string>
  stop(): Promise<void>
}
interface DevModule {
  DevSession: new (options: { load: () => Promise<unknown>; write: (text: string) => void }) => DevSessionLike
}

const STUBS = [
  "const forbidden = (name) => class { constructor() { throw new Error(name + ' must not be built under botmesh dev') } }",
  "export const BaileysProvider = forbidden('BaileysProvider')",
  "export const SQLiteStore = forbidden('SQLiteStore')",
  "export const aiPlugin = (config) => { globalThis.__botwaAiConfig = config; return { name: 'ai-stub', install() {} } }",
  '',
].join('\n')

/** [user line, text expected in the output afterwards] */
type Script = Array<[string, string]>

const SCRIPTS: Record<string, Script> = {
  games: [
    ['hola', 'ahorcado'],
    ['trivia', '¿Cuál es el planeta más grande'],
    ['2', '¿Cuántos lados tiene un hexágono?'],
    ['1', '¿En qué continente está Colombia?'],
    ['3', '3/3 aciertos. Total: 3 puntos.'],
    ['puntos', 'Tienes 3 puntos'],
    ['ppt', '¿Piedra, papel o tijera?'],
    ['1', 'Yo elegí'],
    ['triqui', 'Elige una casilla libre'],
    ['10', 'Elige el número de una casilla libre'],
  ],
  support: [
    ['hola', 'mis tickets'],
    ['ticket', '¿Sobre qué es tu consulta?'],
    ['1', 'Describe el problema'],
    ['corto', 'mínimo 10 caracteres'],
    ['Mi pedido no ha llegado todavía', 'Ticket *T-'],
    ['mis tickets', 'Pedido (abierto)'],
    ['faq', 'Preguntas frecuentes'],
    ['2', 'de 2 a 5 días'],
    ['agente', 'Te comunico con una persona'],
    ['/bot', '¡He vuelto!'],
  ],
  store: [
    ['catalogo', 'Camiseta básica'],
    ['comprar', '¿Qué producto quieres?'],
    ['1', '¿Cuántas unidades?'],
    ['2', 'Añadido. Total del carrito'],
    ['carrito', '2 × Camiseta básica'],
    ['pagar', '¿A nombre de quién'],
    ['Ana', '¿Dirección de entrega?'],
    ['Calle 1', '¿Cómo vas a pagar?'],
    ['2', '¿Confirmas el pedido?'],
    ['1', 'recibido por'],
    ['carrito', 'Tu carrito está vacío'],
  ],
  restaurant: [
    ['carta', 'Bandeja paisa'],
    ['pedir', '¿Qué deseas pedir?'],
    ['1', '¿Cuántas porciones?'],
    ['2', '¿Domicilio o recoger?'],
    ['1', '¿Dirección de entrega?'],
    ['Calle 9', 'Tu pedido: 2 × Bandeja paisa'],
    ['1', '¡Pedido confirmado!'],
    ['repetir', 'Repetimos tu último pedido: 2 × Bandeja paisa'],
    ['reservar', '¿Para cuántas personas?'],
    ['4', '¿Qué día y hora?'],
    ['viernes 8pm', '¿A nombre de quién?'],
    ['Ana', 'Reserva para 4 personas (viernes 8pm) a nombre de Ana'],
  ],
  clinic: [
    ['hola', 'cancelar cita'],
    ['cita', 'Nombre completo del paciente'],
    ['Ana Pérez', '¿Qué especialidad necesitas?'],
    ['2', '¿Qué día?'],
    ['1', '¿A qué hora?'],
    ['1', 'Confirma la cita de Ana Pérez: Odontología'],
    ['1', 'Cita agendada'],
    ['mis citas', 'Odontología'],
    ['cancelar cita', '¿Cuál cita quieres cancelar?'],
    ['1', 'cancelada'],
    ['urgencias', 'llama al'],
    ['sedes', '¿Qué sede te queda mejor?'],
    ['2', 'Carrera 7 #24-10'],
  ],
  'ai-full': [
    ['hola', 'Soy el asistente de Mi Negocio'],
    ['me llamo Ana', 'Mucho gusto, Ana'],
    ['hola', '¡Hola Ana!'],
    ['cual es el horario', 'Atendemos de lunes a sábado'],
    ['/ping', 'pong'],
    ['contacto', '¿Cómo te llamas?'],
    ['Ana', '¿A qué hora prefieres'],
    ['mañana a las 10', 'Te llamamos mañana a las 10'],
  ],
}

async function prepare(template: TemplateName): Promise<string> {
  const target = join(await makeTempDir(), 'sim-' + template)
  await scaffold({ targetDir: target, template })
  const source = await readFile(join(target, 'src/bot.js'), 'utf8')
  const runnable = source
    .replace(/from '@botmesh\/core'/g, `from '${pathToFileURL(join(coreLib, 'index.js')).href}'`)
    .replace(/from '@botmesh\/(?:baileys|ai|sqlite-store)'/g, "from './stubs.mjs'")
  await writeFile(join(target, 'src/stubs.mjs'), STUBS)
  await writeFile(join(target, 'src/bot.sim.mjs'), runnable)
  return join(target, 'src/bot.sim.mjs')
}

describe.skipIf(!existsSync(devEntry))('use-case bots run in the botmesh dev simulator', () => {
  it('has a script for every use-case template', () => {
    expect(Object.keys(SCRIPTS).sort()).toEqual([...DOMAIN].sort())
  })

  it.each(DOMAIN)('template "%s" holds a conversation', async (template) => {
    const entry = await prepare(template)
    const dev = (await import(pathToFileURL(devEntry).href)) as DevModule
    let output = ''
    const session = new dev.DevSession({
      load: () => import(pathToFileURL(entry).href),
      write: (text) => { output += text },
    })
    expect(await session.start()).toBe(true)
    try {
      let seen = 0
      for (const [line, needle] of SCRIPTS[template]!) {
        await session.handleLine(line)
        // Look only at output produced after this line, so repeated texts don't match early.
        for (let i = 0; i < 1000 && !output.slice(seen).includes(needle); i++) await new Promise((r) => setTimeout(r, 5))
        expect(output.slice(seen), 'after "' + line + '"').toContain(needle)
        seen = output.length
      }
    } finally {
      await session.stop()
    }
    expect(output).not.toContain('must not be built')
  })

  it('ai-full order tools: enum products, quote, confirm with code totals, create → update → cancel on ctx.user', async () => {
    const entry = await prepare('ai-full')
    const mod = (await import(pathToFileURL(entry).href)) as { default: (provider: unknown) => Promise<unknown> }
    const testing = (await import(pathToFileURL(testingEntry).href)) as { MockProvider: new () => unknown }
    const ai = (await import(pathToFileURL(aiEntry).href)) as { defaultConfirmPrompt: (name: string, tool: unknown, args: unknown) => string }
    await mod.default(new testing.MockProvider())
    type Tool = { schema?: Record<string, any>; confirm?: boolean; dedupe?: unknown; title?: string; labels?: Record<string, Record<string, string>>; handler: (args: any, tctx: any) => any }
    const tools = (globalThis as { __botwaAiConfig?: { tools: Record<string, Tool> } }).__botwaAiConfig!.tools
    expect(Object.keys(tools).sort()).toEqual(['actualizar_pedido', 'cancelar_pedido', 'cotizar_pedido', 'crear_pedido', 'mis_pedidos', 'ver_menu'])
    expect(tools.crear_pedido!.schema!.properties.items.items.properties.producto.enum).toEqual(['torta_chocolate', 'pan_queso', 'cafe'])
    expect(tools.cotizar_pedido!.schema!.properties.items.items.properties.producto.enum).toEqual(['torta_chocolate', 'pan_queso', 'cafe'])
    expect(tools.cotizar_pedido!.confirm).toBeFalsy()
    for (const name of ['crear_pedido', 'actualizar_pedido', 'cancelar_pedido']) {
      expect(tools[name]!.confirm, name).toBe(true)
      expect(tools[name]!.title, name).toBeTruthy()
    }
    expect(tools.crear_pedido!.dedupe).toBe('args')
    // Every tool has a human title; product keys have labels (fallback when confirmLines is absent).
    for (const [name, tool] of Object.entries(tools)) expect(tool.title, name).toBeTruthy()
    expect(tools.crear_pedido!.labels).toEqual({ producto: { torta_chocolate: 'Torta de chocolate', pan_queso: 'Pan de queso', cafe: 'Café' } })
    const { confirmLines: _omit, ...withoutLines } = tools.crear_pedido as Tool & { confirmLines?: unknown }
    expect(ai.defaultConfirmPrompt('crear_pedido', withoutLines, { items: [{ producto: 'pan_queso', cantidad: 2 }] })).toContain('Pan de queso')
    // A minimal ctx.user namespace.
    const data = new Map<string, unknown>()
    const tctx = { ctx: { user: { ns: () => ({ get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => { data.set(k, v) } }) } } }
    expect(tools.ver_menu!.handler({}, tctx)).toContainEqual({ clave: 'cafe', nombre: 'Café', precio: 4000 })
    // The quote is computed in code, with human names.
    const items = [{ producto: 'torta_chocolate', cantidad: 2 }, { producto: 'cafe', cantidad: 1 }]
    expect(tools.cotizar_pedido!.handler({ items }, tctx)).toEqual({
      items: [
        { producto: 'torta_chocolate', nombre: 'Torta de chocolate', cantidad: 2, precio: 45000, subtotal: 90000 },
        { producto: 'cafe', nombre: 'Café', cantidad: 1, precio: 4000, subtotal: 4000 },
      ],
      total: 94000,
    })
    // The confirmations show human names and the code-computed total, never raw keys.
    const createPrompt = ai.defaultConfirmPrompt('crear_pedido', tools.crear_pedido, { items })
    expect(createPrompt).toBe([
      'Voy a: Crear pedido',
      '• 2 × Torta de chocolate: $90.000',
      '• 1 × Café: $4.000',
      'Total: $94.000',
      '¿Confirmas? (sí/no)',
    ].join('\n'))
    const updatePrompt = ai.defaultConfirmPrompt('actualizar_pedido', tools.actualizar_pedido, { id: 'P-1', items: [{ producto: 'pan_queso', cantidad: 3 }] })
    expect(updatePrompt).toBe('Voy a: Cambiar pedido\n• Pedido: P-1\n• 3 × Pan de queso: $10.500\nTotal nuevo: $10.500\n¿Confirmas? (sí/no)')
    expect(ai.defaultConfirmPrompt('cancelar_pedido', tools.cancelar_pedido, { id: 'P-1' })).toBe('Voy a: Cancelar pedido\n• Pedido: P-1\n¿Confirmas? (sí/no)')
    for (const prompt of [createPrompt, updatePrompt]) expect(prompt).not.toMatch(/torta_chocolate|pan_queso/)

    const order = await tools.crear_pedido!.handler({ items: [{ producto: 'torta_chocolate', cantidad: 2 }] }, tctx)
    expect(order).toMatchObject({ total: 90000, estado: 'confirmado' })
    const updated = await tools.actualizar_pedido!.handler({ id: order.id, items: [{ producto: 'cafe', cantidad: 5 }] }, tctx)
    expect(updated).toMatchObject({ id: order.id, total: 20000 })
    expect(await tools.cancelar_pedido!.handler({ id: order.id }, tctx)).toEqual({ id: order.id, estado: 'cancelado' })
    // Unknown / already cancelled ids: an explicit { error } for the model, nothing changes.
    expect(await tools.cancelar_pedido!.handler({ id: order.id }, tctx)).toEqual({ error: expect.stringMatching(/No existe un pedido activo/) })
    expect(await tools.actualizar_pedido!.handler({ id: 'P-NOPE', items }, tctx)).toEqual({ error: expect.stringMatching(/P-NOPE/) })
    // Ids written loosely by the model still find the order.
    const second = await tools.crear_pedido!.handler({ items: [{ producto: 'cafe', cantidad: 1 }] }, tctx)
    expect(await tools.cancelar_pedido!.handler({ id: ' ' + second.id.toLowerCase() + ' ' }, tctx)).toEqual({ id: expect.any(String), estado: 'cancelado' })
    expect(await tools.mis_pedidos!.handler({}, tctx)).toMatchObject([{ id: order.id, estado: 'cancelado' }, { id: second.id, estado: 'cancelado' }])
  })

  it.each(DOMAIN)('template "%s" passes bot.lint() without errors', async (template) => {
    const entry = await prepare(template)
    const mod = (await import(pathToFileURL(entry).href)) as { default: (provider: unknown) => Promise<{ lint(): Array<{ severity: string; code: string; message: string }> }> | { lint(): Array<{ severity: string; code: string; message: string }> } }
    const testing = (await import(pathToFileURL(testingEntry).href)) as { MockProvider: new () => unknown }
    const bot = await mod.default(new testing.MockProvider())
    const errors = bot.lint().filter((d) => d.severity === 'error')
    expect(errors).toEqual([])
  })
})
