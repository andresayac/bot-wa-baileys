# Forms (WhatsApp Flows)

`flow().form()` collects several typed fields in one step. You describe **what**
to collect; the provider decides **how** to show it:

- On providers with `capabilities.forms === 'native'` (today the WhatsApp Cloud
  API, `@botmesh/meta`) the form goes out as one native form, a **WhatsApp Flow**,
  and the submission comes back as a single message.
- Everywhere else (Baileys, Telegram, Discord, Messenger, Instagram, the
  simulator) the bot asks **field by field** with plain text questions.

Both paths validate with the same rules and store the same values in `c.state`.

```ts
import { flow, type FormDefinition } from '@botmesh/core'

const signup: FormDefinition = {
  id: 'signup',
  title: 'Sign up',
  intro: 'Fill in your details',
  fields: [
    { type: 'text', name: 'name', label: 'Name', minLength: 2 },
    { type: 'number', name: 'age', label: 'Age', min: 18, integer: true },
    { type: 'email', name: 'email', label: 'Email' },
    { type: 'date', name: 'birthday', label: 'Birthday', required: false },
    { type: 'select', name: 'plan', label: 'Plan', options: { basic: 'Basic', pro: 'Pro' } },
    { type: 'multiselect', name: 'topics', label: 'Topics', options: ['Sales', 'Support', 'News'], maxSelected: 2 },
    { type: 'optin', name: 'terms', label: 'I accept the terms', required: true },
  ],
}

bot.use(
  flow('signup')
    .form(signup)
    .say((_ctx, c) => `Thanks ${(c.state.signup as { name: string }).name}!`),
)
```

## Fields

| Type | `c.state` value | Options |
| --- | --- | --- |
| `text` | `string` | `minLength`, `maxLength`, `pattern`, `multiline` |
| `number` | `number` | `min`, `max`, `integer` |
| `email` | `string` | |
| `date` | `'YYYY-MM-DD'` | `min`, `max` (`'YYYY-MM-DD'`) |
| `select` | option key | `options` (`{ key: label }` or a list of labels) |
| `multiselect` | `string[]` of keys | `options`, `minSelected`, `maxSelected` |
| `optin` | `boolean` | `required: true` forces acceptance |

Every field also takes `name`, `label`, `required` (default `true`, `false` for
`optin`), `helper`, `prompt` (field-by-field question text) and `error` (custom
error message). The definition is checked when the flow is built: a bad id, a
duplicate field name or empty options throw a `TypeError`. Besides `id`,
`title`, `intro` and `fields`, a definition takes `cta` (the button that opens a
native form) and `submitLabel`. When omitted, they come from the `core.form.cta`
/ `core.form.submit` catalog entries in the subject's `ctx.lang` (`'Abrir
formulario'` / `'Enviar'` in Spanish, `'Open form'` / `'Submit'` in English);
a definition with neither `intro` nor `title` gets `core.form.body` as the
message body. The submit label is part of the published WhatsApp Flow, so it
is fixed when you publish it: `toFlowJson(def, { lang: 'en' })` /
`publishForm(def, { flowJson: { lang: 'en' } })` (default `'es'`), or set
`submitLabel`.

In field-by-field mode, `select`/`multiselect` accept the menu number, the key or
the label (several picks separated by commas, `;`, `and`/`y` or spaces between
numbers); dates accept `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` and `DD.MM.YYYY`; numbers accept a decimal
point or comma (`1.5`, `1,5`). Grouped numbers such as `1.500` or `1,500` are
**rejected** (the separator could mean thousands or decimals), and the user is
asked to type them without a thousands separator.

Native submissions are validated again on the server: a client-side form is never
trusted.

## Options

```ts
flow('order').form(orderForm, {
  stateKey: 'order',   // c.state key of the answers (default: the form id)
  flatten: true,       // also copy each answer to c.state[field.name]
  mode: 'auto',        // 'auto' | 'native' | 'degraded'
  nativeId: '123456',  // provider-side form id (on the Cloud API: a Flow id or name)
  timeout: '10m',      // per answer (field by field) / for the submission (native)
  retries: 3,          // invalid answers tolerated per field / per submission
  skipWord: 'skip',    // field by field: word that skips an optional field
  pendingMessage: '👆 Fill in the form above to continue.',
})
```

`skipWord`, `pendingMessage`, the field-by-field hints (`1) Yes / 2) No`, the
date format, "type … to skip") and every validation error default to the
built-in `core.form.*` messages in the subject's language (`ctx.lang`, `es` and
`en` included). Override them per locale with `bot.locale()` (see
[i18n](./i18n#built-in-messages)); a field's own `error` still wins.

In `'auto'` mode the step renders natively only when the provider declares
`forms: 'native'` **and** can render this particular form. Providers say so with
the optional `IProvider.canRenderForm(form, { nativeId })` (available as
`ctx.canRenderForm()`). When it returns `false`, the step asks field by field
straight away, without sending a form message that would fail. If a native send
is still rejected with `UnsupportedContentError`, auto mode falls back to field
by field too. `'native'` never falls back.

## WhatsApp Cloud API

`@botmesh/meta` compiles a form into a **static, single-screen WhatsApp Flow**
(Flow JSON `6.2`, `navigate` action, no endpoint and no encryption) and sends it
as an interactive `flow` message. The `nfm_reply` webhook is turned into a
`'form'` message whose `flow_token` matches the pending step.

A Flow has to exist on Meta before it can be sent. Map your form ids to Flows:

```ts
import { CloudAPIProvider, toFlowJson } from '@botmesh/meta'

const provider = new CloudAPIProvider({
  ...cfg,
  wabaId: process.env.WABA_ID,        // only needed by publishForm()
  flows: { signup: '1234567890' },    // form id → Flow id, Flow name or { flowId, mode: 'draft' }
})

// Or create it once from the bot (Flows API, token with whatsapp_business_management):
const { flowId } = await provider.publishForm(signup, { categories: ['SIGN_UP'] })
// Each call creates a new Flow: save flowId and pass it in config.flows next time.

// Or export the JSON and paste it into WhatsApp Manager:
writeFileSync('signup.flow.json', JSON.stringify(toFlowJson(signup), null, 2))
```

A form without a Flow (no `config.flows` entry, no `publishForm()` and no
`nativeId`) is asked field by field, as on any other channel.
`flowJsonWarnings(def)` lists labels WhatsApp will truncate (`FLOW_LIMITS`).
`toFlowJson(def, { lang })` picks the language of the default submit label.

Endpoint Flows (`data_exchange`, dynamic encrypted screens) are not supported yet.

## Testing and introspection

`MockProvider` declares no native forms, so `createTestBot` runs forms field by
field. To test the native path, set `provider.capabilities.forms = 'native'` and
answer with `chat.send(formReplyBody({ token, values }), { type: 'form' })`.

`bot.describe()` draws `form` nodes with their fields, and `bot.lint()` reports
`form-state-collision` when a form writes a `c.state` key that another
`ask`/`choose`/`form` of the same flow also writes. The timeout rules apply to
forms too. See [Inspect & lint flows](./flow-tools).
