/**
 * Browser identity for the Baileys handshake.
 *
 * The `browser` tuple (`[os, browserName, osVersion]`) feeds three parts of the
 * WhatsApp Web handshake: the registration `DeviceProps.platformType`, the
 * companion web-client type sent with QR/pairing codes, and the login
 * `webInfo`. Since late July 2026 WhatsApp closes non-standard clients with
 * 428 "Connection Terminated" before the QR is shown; Baileys 7.0.0-rc14 ships
 * the refreshed handshake and its default identity is `Browsers.macOS('Chrome')`.
 *
 * The old presets used `'Desktop'` (DeviceProps DESKTOP / companion ELECTRON) and
 * `'Bot'` (DeviceProps falls back to CHROME but the companion type becomes
 * OTHER_WEB_CLIENT), i.e. identities that disagree with what rc14 sends by
 * default. Every preset now resolves to Chrome on the chosen OS so all three
 * handshake fields agree.
 */
import { Browsers } from '@whiskeysockets/baileys'

/** OS presets; each one advertises Chrome on that OS. */
export type BrowserPreset = 'macOS' | 'ubuntu' | 'windows' | 'appropriate'

/** A preset, or an explicit `[os, browserName, osVersion]` tuple (caller-owned risk). */
export type BrowserConfig = BrowserPreset | [string, string, string]

/** The browser name every preset advertises; matches Baileys' own default. */
const BROWSER_NAME = 'Chrome'

/**
 * Resolve the `browser` socket option.
 *
 * - `undefined` → `undefined`: the caller must then OMIT the `browser` key so
 *   Baileys' default (`Browsers.macOS('Chrome')`) applies. `makeWASocket` spreads
 *   the user config over its defaults, so even `browser: undefined` would clobber it.
 * - a preset → `Browsers.<os>('Chrome')`.
 * - a tuple → returned verbatim (escape hatch, e.g. `Browsers.macOS('Desktop')`
 *   for full-history desktop emulation). WhatsApp may reject it.
 */
export function resolveBrowser(browser?: BrowserConfig): [string, string, string] | undefined {
  if (browser === undefined) return undefined
  if (Array.isArray(browser)) return browser
  switch (browser) {
    case 'macOS': return Browsers.macOS(BROWSER_NAME)
    case 'ubuntu': return Browsers.ubuntu(BROWSER_NAME)
    case 'windows': return Browsers.windows(BROWSER_NAME)
    case 'appropriate': return Browsers.appropriate(BROWSER_NAME)
  }
}
