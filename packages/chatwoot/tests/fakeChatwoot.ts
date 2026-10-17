/**
 * In-memory fake of the parts of the Chatwoot Application API the plugin uses.
 * Plugged in through the injected `fetch` (no network): every request is recorded.
 */

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  body: unknown
}

interface FakeConversation { id: number; contactId: number; status: string; labels: string[]; messages: FakeMessage[] }
interface FakeMessage { id: number; content: string; message_type: string; private: boolean }

export class FakeChatwoot {
  requests: RecordedRequest[] = []
  contacts: Array<{ id: number; name: string; identifier?: string; source_id: string }> = []
  conversations = new Map<number, FakeConversation>()
  /** Next responses forced to an HTTP status (by method+path regex). */
  failures: Array<{ match: RegExp; status: number; times: number }> = []
  /** Hook called right before a message creation responds (to simulate webhook races). */
  onMessageCreated?: (conversationId: number, message: FakeMessage) => void
  private seq = 100

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    this.requests.push({ method, path: url.pathname, query: url.searchParams, headers, body })

    const key = `${method} ${url.pathname}`
    const failure = this.failures.find((f) => f.match.test(key) && f.times > 0)
    if (failure) {
      failure.times -= 1
      return json({ error: 'forced' }, failure.status)
    }
    if (headers['api_access_token'] !== 'secret-key') return json({ error: 'unauthorized' }, 401)
    return this.route(method, url, body)
  }

  private route(method: string, url: URL, body: any): Response {
    const p = url.pathname.replace(/^\/api\/v1\/accounts\/1/, '')
    let m: RegExpExecArray | null
    if (method === 'GET' && p === '/contacts/search') {
      const q = url.searchParams.get('q')
      return json({ payload: this.contacts.filter((c) => c.identifier === q).map((c) => ({ id: c.id, name: c.name, identifier: c.identifier })) })
    }
    if (method === 'POST' && p === '/contacts') {
      const c = { id: ++this.seq, name: body.name, identifier: body.identifier, source_id: `src-${this.seq}` }
      this.contacts.push(c)
      return json({ payload: { contact: { id: c.id, name: c.name, identifier: c.identifier }, contact_inbox: { source_id: c.source_id } } })
    }
    if (method === 'POST' && (m = /^\/contacts\/(\d+)\/contact_inboxes$/.exec(p))) {
      return json({ source_id: `ci-${m[1]}` })
    }
    if (method === 'POST' && p === '/conversations') {
      const id = ++this.seq
      this.conversations.set(id, { id, contactId: body.contact_id, status: body.status ?? 'open', labels: [], messages: [] })
      return json({ id, status: 'open' })
    }
    if ((m = /^\/conversations\/(\d+)\/messages$/.exec(p)) && method === 'POST') {
      const conv = this.conversations.get(Number(m[1]))
      if (!conv) return json({ error: 'not found' }, 404)
      const msg = { id: ++this.seq, content: body.content, message_type: body.message_type, private: body.private ?? false }
      conv.messages.push(msg)
      this.onMessageCreated?.(conv.id, msg)
      return json({ id: msg.id, content: msg.content })
    }
    if ((m = /^\/conversations\/(\d+)\/toggle_status$/.exec(p)) && method === 'POST') {
      const conv = this.conversations.get(Number(m[1]))
      if (!conv) return json({ error: 'not found' }, 404)
      conv.status = body.status
      return json({ payload: { success: true, current_status: conv.status } })
    }
    if ((m = /^\/conversations\/(\d+)\/labels$/.exec(p))) {
      const conv = this.conversations.get(Number(m[1]))
      if (!conv) return json({ error: 'not found' }, 404)
      if (method === 'POST') conv.labels = [...body.labels]
      return json({ payload: conv.labels })
    }
    return json({ error: `no route ${method} ${p}` }, 404)
  }

  messagesOf(conversationId: number): FakeMessage[] {
    return this.conversations.get(conversationId)?.messages ?? []
  }

  onlyConversation(): FakeConversation {
    const all = [...this.conversations.values()]
    if (all.length !== 1) throw new Error(`expected 1 conversation, got ${all.length}`)
    return all[0]
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

/** Resolver that never touches DNS (public address so secureFetch's SSRF guard passes). */
export const publicResolver = async (): Promise<string[]> => ['93.184.216.34']
