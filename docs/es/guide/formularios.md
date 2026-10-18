# Formularios (WhatsApp Flows)

`flow().form()` recoge varios campos tipados en un solo paso. Tú describes **qué**
recoger y el provider decide **cómo** mostrarlo:

- En los providers con `capabilities.forms === 'native'` (hoy la Cloud API de
  WhatsApp, `@bot-wa/meta`) el formulario se envía como un formulario nativo, un
  **WhatsApp Flow**, y la respuesta llega en un solo mensaje.
- En el resto (Baileys, Telegram, Discord, Messenger, Instagram, el simulador)
  el bot pregunta **campo por campo** con mensajes de texto.

Los dos caminos validan con las mismas reglas y guardan los mismos valores en `c.state`.

```ts
import { flow, type FormDefinition } from '@bot-wa/core'

const registro: FormDefinition = {
  id: 'registro',
  title: 'Registro',
  intro: 'Completa tus datos',
  fields: [
    { type: 'text', name: 'nombre', label: 'Nombre', minLength: 2 },
    { type: 'number', name: 'edad', label: 'Edad', min: 18, integer: true },
    { type: 'email', name: 'correo', label: 'Correo' },
    { type: 'date', name: 'cumple', label: 'Cumpleaños', required: false },
    { type: 'select', name: 'plan', label: 'Plan', options: { basic: 'Básico', pro: 'Pro' } },
    { type: 'multiselect', name: 'temas', label: 'Temas', options: ['Ventas', 'Soporte', 'Noticias'], maxSelected: 2 },
    { type: 'optin', name: 'terminos', label: 'Acepto los términos', required: true },
  ],
}

bot.use(
  flow('registro')
    .form(registro)
    .say((_ctx, c) => `¡Gracias ${(c.state.registro as { nombre: string }).nombre}!`),
)
```

## Campos

| Tipo | Valor en `c.state` | Opciones |
| --- | --- | --- |
| `text` | `string` | `minLength`, `maxLength`, `pattern`, `multiline` |
| `number` | `number` | `min`, `max`, `integer` |
| `email` | `string` | |
| `date` | `'AAAA-MM-DD'` | `min`, `max` (`'AAAA-MM-DD'`) |
| `select` | clave de la opción | `options` (`{ clave: etiqueta }` o lista de etiquetas) |
| `multiselect` | `string[]` de claves | `options`, `minSelected`, `maxSelected` |
| `optin` | `boolean` | `required: true` obliga a aceptar |

Todos los campos aceptan además `name`, `label`, `required` (por defecto `true`;
`false` en `optin`), `helper`, `prompt` (texto de la pregunta campo por campo) y
`error` (mensaje de error propio). La definición se comprueba al construir el
flujo: un id inválido, un nombre de campo repetido u opciones vacías lanzan un
`TypeError`.

Campo por campo, `select`/`multiselect` aceptan el número del menú, la clave o la
etiqueta; las fechas aceptan `AAAA-MM-DD` y `DD/MM/AAAA`; los números aceptan
punto o coma decimal (`1.5`, `1,5`). Los números agrupados como `1.500` o `1,500`
se **rechazan** (el separador puede ser de miles o decimal) y se pide al usuario
que los escriba sin separador de miles.

Las respuestas nativas se validan otra vez en el servidor: nunca se confía en un
formulario del lado del cliente.

## Opciones

```ts
flow('pedido').form(pedido, {
  stateKey: 'pedido',  // clave de c.state con las respuestas (por defecto, el id del formulario)
  flatten: true,       // copia además cada respuesta a c.state[campo.name]
  mode: 'auto',        // 'auto' | 'native' | 'degraded'
  nativeId: '123456',  // id del formulario en el provider (en la Cloud API, id o nombre del Flow)
  timeout: '10m',      // por respuesta (campo por campo) / para el envío (nativo)
  retries: 3,          // respuestas inválidas toleradas por campo / por envío
  skipWord: 'omitir',  // campo por campo: palabra que salta un campo opcional
  pendingMessage: '👆 Completa el formulario de arriba para continuar.',
})
```

`skipWord`, `pendingMessage`, las pistas del modo campo por campo (`1) Sí /
2) No`, el formato de fecha, "escribe … para saltar") y todos los errores de
validación salen por defecto de los mensajes internos `core.form.*` en el
idioma del usuario (`ctx.lang`, con `es` y `en` incluidos). Cámbialos por
idioma con `bot.locale()` (ver [i18n](./i18n#mensajes-internos)); el `error`
propio de un campo sigue ganando.

En modo `'auto'` el paso solo se muestra de forma nativa si el provider declara
`forms: 'native'` **y** puede mostrar ese formulario en concreto. El provider lo
indica con el método opcional `IProvider.canRenderForm(form, { nativeId })`
(disponible como `ctx.canRenderForm()`). Si devuelve `false`, el paso pregunta
campo por campo directamente, sin enviar antes un mensaje de formulario que
fallaría. Si aun así el envío nativo se rechaza con `UnsupportedContentError`, el
modo auto también pasa a campo por campo. `'native'` nunca hace ese cambio.

## Cloud API de WhatsApp

`@bot-wa/meta` compila el formulario a un **WhatsApp Flow estático de una
pantalla** (Flow JSON `6.2`, acción `navigate`, sin endpoint ni cifrado) y lo
envía como mensaje interactivo `flow`. El webhook `nfm_reply` se convierte en un
mensaje `'form'` cuyo `flow_token` corresponde al paso pendiente.

El Flow tiene que existir en Meta antes de enviarse. Asocia tus formularios a Flows:

```ts
import { CloudAPIProvider, toFlowJson } from '@bot-wa/meta'

const provider = new CloudAPIProvider({
  ...cfg,
  wabaId: process.env.WABA_ID,         // solo lo necesita publishForm()
  flows: { registro: '1234567890' },   // id del formulario → id del Flow, nombre o { flowId, mode: 'draft' }
})

// O créalo una vez desde el bot (Flows API, token con whatsapp_business_management):
const { flowId } = await provider.publishForm(registro, { categories: ['SIGN_UP'] })
// Cada llamada crea un Flow nuevo: guarda flowId y pásalo en config.flows la próxima vez.

// O exporta el JSON y pégalo en WhatsApp Manager:
writeFileSync('registro.flow.json', JSON.stringify(toFlowJson(registro), null, 2))
```

Un formulario sin Flow (sin entrada en `config.flows`, sin `publishForm()` y sin
`nativeId`) se pregunta campo por campo, como en cualquier otro canal.
`flowJsonWarnings(def)` avisa de las etiquetas que WhatsApp recortará (`FLOW_LIMITS`).

Los Flows con endpoint (`data_exchange`, pantallas dinámicas cifradas) aún no están soportados.

## Tests e introspección

`MockProvider` no declara formularios nativos, así que `createTestBot` ejecuta los
formularios campo por campo. Para probar el camino nativo, pon
`provider.capabilities.forms = 'native'` y responde con
`chat.send(formReplyBody({ token, values }), { type: 'form' })`.

`bot.describe()` dibuja nodos `form` con sus campos y `bot.lint()` avisa con
`form-state-collision` cuando un formulario escribe una clave de `c.state` que
otro `ask`/`choose`/`form` del mismo flujo también escribe. Las reglas de
timeouts se aplican también a los formularios. Más en
[Inspeccionar y validar flujos](./inspeccion-flujos.md).
