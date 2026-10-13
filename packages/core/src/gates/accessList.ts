/**
 * Dynamic blacklist / whitelist — the inbound access gate.
 *
 * `bot.blacklist` and `bot.whitelist` are evaluated by the Bot for every inbound
 * message and interaction BEFORE anything else happens to it: a blocked message is
 * not persisted, runs no `before('message')` hook, reaches no command, conversation,
 * dormant checkpoint, matcher or catch-all, and does not fire the `'message'` event.
 * The drop is debug-logged (ids and gate only, never the body).
 *
 * Ids are OPAQUE strings compared by exact equality, exactly as the provider emits
 * them in `ctx.sender` (senderId) and `ctx.from` (chatId) — e.g. a full WhatsApp JID,
 * a Telegram numeric id. The core never trims, parses or normalizes them.
 *
 * Both lists live in memory. Persist them yourself with {@link AccessList.export} /
 * {@link AccessList.load} (or `bot.exportAccessLists()` / `bot.loadAccessLists()`),
 * optionally saving on every mutation through {@link AccessList.onChange}.
 *
 * @example
 * ```ts
 * bot.blacklist.add('573001234567@s.whatsapp.net')
 * bot.blacklist.add(['a@s.whatsapp.net', 'b@s.whatsapp.net'])
 * bot.blacklist.has('a@s.whatsapp.net')   // true
 *
 * // Whitelist mode: only these senders/chats are answered.
 * bot.whitelist.add(['vip@s.whatsapp.net', '1203630@g.us']).enable()
 *
 * // Host-side persistence.
 * bot.blacklist.onChange(() => fs.writeFileSync('acl.json', JSON.stringify(bot.exportAccessLists())))
 * bot.loadAccessLists(JSON.parse(fs.readFileSync('acl.json', 'utf8')))
 * ```
 */

import type { ChatId, UserId } from '../core/provider.js'

/** Which list a change belongs to. */
export type AccessListName = 'blacklist' | 'whitelist'

/** What happened to a list. `enable`/`disable` only exist on the {@link Whitelist}. */
export type AccessListAction = 'add' | 'remove' | 'clear' | 'load' | 'enable' | 'disable'

/**
 * Change notification delivered to {@link AccessList.onChange} listeners.
 *
 * `ids` holds the ids that were actually added (`add`), actually removed (`remove`,
 * `clear`), or the full new contents (`load`). It is empty for `enable`/`disable`.
 */
export interface AccessListChange {
  list: AccessListName
  action: AccessListAction
  ids: string[]
}

/** JSON-serializable snapshot of an {@link AccessList}. */
export interface AccessListSnapshot {
  ids: string[]
}

/** JSON-serializable snapshot of a {@link Whitelist} (ids + whether whitelist mode is on). */
export interface WhitelistSnapshot extends AccessListSnapshot {
  enabled: boolean
}

/** Combined snapshot returned by `bot.exportAccessLists()` and accepted by `bot.loadAccessLists()`. */
export interface AccessListsSnapshot {
  blacklist: AccessListSnapshot
  whitelist: WhitelistSnapshot
}

/** Outcome of {@link checkAccess}. Anything other than `'allowed'` means the message is dropped. */
export type AccessDecision = 'allowed' | 'blacklisted' | 'not-whitelisted'

/** Normalize `string | string[]` input and validate every id BEFORE any mutation. */
function toIds(input: unknown, list: AccessListName, method: string): string[] {
  const ids = Array.isArray(input) ? (input as unknown[]) : [input]
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError(`${list}.${method}() expects a non-empty string id or an array of them`)
    }
  }
  return ids as string[]
}

/**
 * A set of opaque ids with change notifications. Used as `bot.blacklist`; the
 * {@link Whitelist} subclass adds the enable/disable switch.
 */
export class AccessList {
  protected readonly ids = new Set<string>()
  private readonly listeners = new Set<(change: AccessListChange) => void>()

  constructor(readonly name: AccessListName) {}

  /** Add one id or many. Duplicates are ignored. Throws `TypeError` on an empty/non-string id. */
  add(ids: string | readonly string[]): this {
    const added: string[] = []
    for (const id of toIds(ids, this.name, 'add')) {
      if (this.ids.has(id)) continue
      this.ids.add(id)
      added.push(id)
    }
    if (added.length) this.notify('add', added)
    return this
  }

  /** Remove one id or many. Unknown ids are ignored. Throws `TypeError` on an empty/non-string id. */
  remove(ids: string | readonly string[]): this {
    const removed: string[] = []
    for (const id of toIds(ids, this.name, 'remove')) {
      if (this.ids.delete(id)) removed.push(id)
    }
    if (removed.length) this.notify('remove', removed)
    return this
  }

  /** Is `id` on the list? Exact, case-sensitive match. Never throws. */
  has(id: string): boolean {
    return typeof id === 'string' && this.ids.has(id)
  }

  /** The ids on the list, in insertion order (a copy). */
  list(): string[] {
    return [...this.ids]
  }

  /** Number of ids on the list. */
  get size(): number {
    return this.ids.size
  }

  /** Remove every id. */
  clear(): this {
    if (this.ids.size === 0) return this
    const removed = this.list()
    this.ids.clear()
    this.notify('clear', removed)
    return this
  }

  /**
   * Replace the contents with a snapshot from {@link export} (or a bare id array).
   * Always notifies `onChange` listeners with action `'load'`.
   */
  load(snapshot: AccessListSnapshot | readonly string[]): this {
    const ids = toIds(Array.isArray(snapshot) ? snapshot : (snapshot as AccessListSnapshot).ids ?? [], this.name, 'load')
    this.ids.clear()
    for (const id of ids) this.ids.add(id)
    this.notify('load', this.list())
    return this
  }

  /** JSON-serializable snapshot for host-side persistence. */
  export(): AccessListSnapshot {
    return { ids: this.list() }
  }

  /**
   * Subscribe to effective mutations (no-op calls do not notify). Returns an
   * unsubscriber. A throwing listener never breaks the mutation that triggered it.
   */
  onChange(listener: (change: AccessListChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  protected notify(action: AccessListAction, ids: string[]): void {
    const change: AccessListChange = { list: this.name, action, ids }
    for (const listener of [...this.listeners]) {
      try { listener(change) } catch { /* listener errors must not undo or break the mutation */ }
    }
  }
}

/**
 * `bot.whitelist` — an {@link AccessList} plus a mode switch. While **disabled**
 * (the default) its entries have no effect. While **enabled**, only messages whose
 * senderId OR chatId is on the list are processed; an enabled, empty whitelist
 * blocks everyone. The blacklist always wins over the whitelist.
 */
export class Whitelist extends AccessList {
  private on = false

  constructor() { super('whitelist') }

  /** Is whitelist mode active? */
  get enabled(): boolean {
    return this.on
  }

  /** Turn whitelist mode on. */
  enable(): this {
    if (!this.on) {
      this.on = true
      this.notify('enable', [])
    }
    return this
  }

  /** Turn whitelist mode off (open access, subject to the blacklist). */
  disable(): this {
    if (this.on) {
      this.on = false
      this.notify('disable', [])
    }
    return this
  }

  /**
   * Replace the contents from a snapshot. A bare id array, or a snapshot without
   * `enabled`, leaves the current mode untouched.
   */
  override load(snapshot: Partial<WhitelistSnapshot> | readonly string[]): this {
    super.load(Array.isArray(snapshot) ? snapshot : { ids: (snapshot as Partial<WhitelistSnapshot>).ids ?? [] })
    const enabled = Array.isArray(snapshot) ? undefined : (snapshot as Partial<WhitelistSnapshot>).enabled
    if (enabled === true) this.enable()
    else if (enabled === false) this.disable()
    return this
  }

  override export(): WhitelistSnapshot {
    return { ids: this.list(), enabled: this.on }
  }
}

/**
 * Pure access decision used by the Bot's inbound gate. A message is
 * `'blacklisted'` when its senderId OR chatId is on the blacklist; otherwise, with
 * whitelist mode on, it is `'not-whitelisted'` unless its senderId OR chatId is on
 * the whitelist.
 */
export function checkAccess(
  blacklist: AccessList,
  whitelist: Whitelist,
  ids: { chatId: ChatId; senderId: UserId },
): AccessDecision {
  if (blacklist.has(ids.senderId) || blacklist.has(ids.chatId)) return 'blacklisted'
  if (whitelist.enabled && !whitelist.has(ids.senderId) && !whitelist.has(ids.chatId)) return 'not-whitelisted'
  return 'allowed'
}
