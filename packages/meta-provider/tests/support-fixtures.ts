import { readFileSync } from 'node:fs'
import type { GraphWebhookBody } from '../src/parseInbound.js'

/** Load a webhook fixture from tests/fixtures as an object. */
export function fixture(name: string): GraphWebhookBody {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as GraphWebhookBody
}

/** Load a webhook fixture as the raw string body (what `ingest` receives). */
export function rawFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')
}
