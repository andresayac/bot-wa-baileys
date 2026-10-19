# Trazas (OpenTelemetry)

Por cada mensaje el bot hace mucho trabajo: listas de acceso, persistencia, la cola del chat, hooks, enrutado, un paso de conversación, una llamada a la IA con herramientas, el envío del provider. Las trazas muestran ese trabajo como un árbol de **spans** por mensaje, para ver dónde se va el tiempo y dónde falla algo, en Jaeger, Grafana Tempo o cualquier backend de OpenTelemetry.

Las trazas son **opt-in**. Sin `BotConfig.telemetry` el bot ejecuta exactamente el mismo código que antes: sin spans y sin `await` extra.

- `@bot-wa/core` trae los hooks de trazas: una interfaz mínima `BotTracer`, un no-op por defecto y `bot.tracing`. Sin dependencias nuevas.
- `@bot-wa/otel` (privado por ahora) los adapta a OpenTelemetry y además publica `bot.metrics()` como métricas de OpenTelemetry.
- `@bot-wa/ai` añade spans de modelo, herramientas y recuperación a la misma traza.

::: tip Sin contenido de mensajes
Los spans llevan **tipos, etapas, resultados e ids**, nunca cuerpos de mensaje, captions, prompts, respuestas del modelo, argumentos o resultados de herramientas, `c.state` ni mensajes de error. Los ids de chat, usuario y mensaje van con hash por defecto. Mira [Datos personales](#datos-personales).
:::

## Inicio rápido

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-metrics
```

```ts
// telemetry.ts — cárgalo antes que el bot (p. ej. `node --import ./telemetry.js bot.js`)
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

export const sdk = new NodeSDK({
  serviceName: 'bot-ventas',
  traceExporter: new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
  }),
})
sdk.start()
```

```ts
// bot.ts
import { Bot } from '@bot-wa/core'
import { createOtelTracer, otelMetricsPlugin } from '@bot-wa/otel'

const bot = new Bot({
  provider,
  telemetry: {
    tracer: await createOtelTracer(),
    // La misma clave en todas las réplicas: los ids con hash coinciden entre procesos y reinicios.
    idKey: process.env.TRACE_ID_KEY,
  },
})
bot.plug(otelMetricsPlugin())   // bot.metrics() como métricas de OpenTelemetry
bot.plug(aiPlugin({ /* … */ })) // los spans de IA entran solos en la misma traza

process.on('SIGTERM', async () => {
  await bot.stop()
  await sdk.shutdown()          // vacía los spans y métricas que siguen en buffer
})
```

`createOtelTracer()` carga `@opentelemetry/api` en diferido y rechaza con un mensaje de instalación si falta. Si el bot se tiene que construir de forma síncrona, usa `lazyOtelTracer()`: sus spans son no-op hasta que la API carga, y un fallo de carga se informa por su promesa `ready` (nunca se lanza dentro del bot).

## Backends locales

### Jaeger

```bash
docker run --rm --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
```

Apunta los exporters a `http://localhost:4318` y abre <http://localhost:16686>. Jaeger solo guarda trazas: manda las métricas a un Prometheus o a un OpenTelemetry Collector, o quita el lector de métricas mientras pruebas.

### Grafana Tempo + Grafana

`docker-compose.yml`:

```yaml
services:
  tempo:
    image: grafana/tempo:latest
    command: ['-config.file=/etc/tempo.yaml']
    volumes: ['./tempo.yaml:/etc/tempo.yaml']
    ports: ['4318:4318', '3200:3200']
  grafana:
    image: grafana/grafana:latest
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: 'true'
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
    volumes: ['./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml']
    ports: ['3000:3000']
```

`tempo.yaml`:

```yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    local: { path: /var/tempo/traces }
    wal: { path: /var/tempo/wal }
```

`grafana-datasources.yaml`:

```yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: true
```

`docker compose up`, abre Grafana en <http://localhost:3000> → Explore → Tempo y busca por nombre de servicio (`bot-ventas`) o de span (`bot.send`, `chat claude-…`). Tempo solo recibe trazas: para las métricas añade un Prometheus con su receptor OTLP (`--web.enable-otlp-receiver`, ruta OTLP `/api/v1/otlp/v1/metrics`) o un OpenTelemetry Collector delante de ambos. En producción fija las versiones de las imágenes.

## Cómo se ve un mensaje

```
bot.inbound                      consumer · bot.event.kind=message · bot.inbound.outcome=dispatched
├─ bot.persist                   escrituras de chat / contacto / mensaje
└─ bot.dispatch                  bot.queue.wait_ms · bot.dispatch.stage=matcher
   └─ bot.handler                bot.handler.stage=matcher · bot.matcher.kind=text · bot.flow.id=pedido
      └─ bot.conversation.turn   bot.conversation.reason=start · parked=true
         ├─ chat claude-…        gen_ai.* (modelo, tokens, motivo de fin)
         │  └─ (span http de la llamada al SDK, de su propia instrumentación)
         ├─ execute_tool buscar  bot.ai.tool.outcome=ok
         └─ bot.pace             retraso + escribiendo…
            └─ bot.send          client · bot.send.outcome=ok
               └─ (span http de la llamada al provider)
```

La respuesta del usuario llega como otro mensaje: su propio `bot.inbound` → `bot.dispatch` (etapa `conversation`), con el **siguiente** turno de la misma conversación (mismo `bot.conversation.id`) como hijo.

### Catálogo de spans

| Span | Kind | Dónde |
| --- | --- | --- |
| `bot.inbound` | consumer | Un evento de mensaje, interacción o llamada del provider (conexión, presencia y estados no tienen span). Padre: el contexto activo de OpenTelemetry, p. ej. el span HTTP de un webhook. |
| `bot.persist` | internal | Escrituras de chat, contacto y mensaje de un mensaje entrante (`spans.persist`). |
| `bot.dispatch` | internal | El trabajo del mensaje en la cola FIFO del chat, cuando le llega el turno. |
| `bot.handler` | internal | Cada handler que corre el dispatcher: comando, matcher, catch-all, trigger de evento (llamada). |
| `bot.conversation.turn` | internal | Un tramo de conversación entre dos esperas (ver abajo). |
| `bot.trigger` / `bot.broadcast` | internal | `bot.trigger()` / `bot.broadcast()`. |
| `bot.pace` | internal | Una respuesta con ritmo: retraso + indicador de escritura + su envío (`spans.pace`). |
| `bot.send` | client | Cada envío y edición del pipeline de salida. La llamada al provider corre dentro. |
| `bot.stream.update` | client | Un borrador/edición de `ctx.stream()`: solo con `spans.streamUpdates`; si no, un evento en el span activo. |
| `chat {model}` | client | Una llamada al modelo de `@bot-wa/ai` (convenciones GenAI de OpenTelemetry). |
| `execute_tool {name}` | internal | Una llamada a herramienta del bucle de herramientas de la IA. |
| `bot.ai.retrieve` | internal | Recuperación RAG (`bot.ai.rag.chunks`). |

### Atributos

| Atributo | En | Valores |
| --- | --- | --- |
| `bot.provider.id`, `bot.id` | inbound, send | Id del provider, bot id del namespace del store. |
| `bot.event.kind`, `bot.message.type`, `bot.chat.kind` | inbound, dispatch | `message`/`interaction`/`call`; `text`, `image`…; `private`/`group`. |
| `bot.chat.id`, `bot.sender.id`, `bot.message.id` | inbound, send | Según la [política de ids](#datos-personales). |
| `bot.inbound.outcome` | inbound | `dispatched`, `blocked`, `duplicate`, `group_filtered`, `stopped`, `from_me`, `handoff` (llamadas). |
| `bot.queue.wait_ms` | dispatch | Espera por el turno del chat (incluye el turno entre réplicas con coordinación). |
| `bot.dispatch.stage` | dispatch | `aborted_by_hook`, `handoff`, `command`, `command_unknown`, `conversation`, `dormant`, `matcher`, `catch_all`, `unhandled`, `event`. |
| `bot.handler.stage`, `bot.matcher.kind` | handler | `command`/`matcher`/`catch_all`/`event`; `welcome`/`text`/`function`/`type`. |
| `bot.command.name` | handler | Solo para un comando **registrado** (el texto de un comando desconocido nunca se registra). |
| `bot.flow.id` | handler | El flujo/conversación en el que entra un matcher. |
| `bot.conversation.id`, `.name`, `.reason`, `.parked`, `.outcome`, `.goto` | turno | Ver abajo. |
| `bot.send.outcome`, `bot.content.kind`, `bot.send.origin`, `bot.send.edit` | send | `ok`, `failed`, `skipped`, `deduplicated` (outbox durable), `deferred`; `text`, `image`…; `ctx`/`api`. |
| `error.type` | cualquier span fallido | El nombre de la clase de error (`RateLimitedError`, `timeout`…). |

Todos los nombres se exportan como `TRACE_ATTR` / `SPAN_NAMES` desde `@bot-wa/core`.

### Turnos de conversación

Una conversación puede durar días, así que no es un único span. Cada tramo de trabajo entre dos esperas es un `bot.conversation.turn`:

- el primer turno empieza bajo el handler (o `bot.trigger`) que la inició: `reason: start`, `goto` o `dormant` (un flujo persistente retomado desde su checkpoint);
- quedarse esperando en un `ask` cierra el turno con `bot.conversation.parked = true`;
- una respuesta abre el siguiente turno bajo el span de dispatch del mensaje que respondió: `reason: reply`;
- el timeout de una espera (o un watchdog de inactividad) abre un turno **raíz** enlazado al primero (`reason: timeout`/`idle`), porque ningún mensaje lo causó;
- el final de la conversación pone `bot.conversation.outcome` (`completed`, `ended`, `guarded`, `cancelled`, `timedOut`, `retriesExceeded`, `error`) en el turno abierto; una conversación abortada mientras esperaba (`/reset`, handoff, `stop()`) recibe un turno corto de cierre (`reason: end`).

Los pasos de un flujo son eventos `flow.step` del turno (`bot.flow.step.index`, `bot.flow.step.kind`).

### Spans de IA

`aiPlugin` pasa `bot.tracing` a su `AIClient`, así que con telemetría activa cada llamada al modelo es un span `chat {model}` (kind client) con `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` y `bot.ai.purpose` (`reply`, `ask`, `generate`, `memory`, `tool_step`). Un timeout es estado error con `error.type = timeout`; un rechazo es `finish_reasons = [refusal]` con el estado sin marcar. Un stream es un span desde el primer fragmento hasta el final (`bot.ai.streamed`, `bot.ai.cancelled` si se cortó antes); Anthropic y Gemini informan el uso de tokens en streaming, los compatibles con OpenAI y Ollama no.

Las herramientas son spans `execute_tool {name}` con `gen_ai.tool.name`, `gen_ai.tool.call.id` y `bot.ai.tool.outcome` (`ok`, `error`, `timeout`, `invalid_args`, `unknown`, `duplicate`, `confirm.denied`, `confirm.replied`, `confirm.cancelled`). Una herramienta que espera la confirmación del usuario mantiene su span abierto (con un evento `confirm.requested`) hasta que responde.

Un `AIClient` suelto solo traza si le pasas `tracing` (p. ej. `bot.tracing`) en sus opciones.

## Tus propios spans

`bot.tracing` es la fachada de trazas del bot (un no-op desactivado sin telemetría). Los spans que inicies dentro de un handler cuelgan de los del bot:

```ts
bot.when('pedido', async (ctx) => {
  const pedido = await bot.tracing.trace('erp.lookup', { kind: 'client' }, () => erp.buscar(ctx.body))
  await ctx.reply(`Pedido ${pedido.id}`)
})
```

Con `@bot-wa/otel`, los spans del bot también son el contexto activo de OpenTelemetry, así que `tracer.startActiveSpan()` y las auto-instrumentaciones del SDK (http, undici, pg…) cuelgan de ellos. Los plugins usan `ctx.bot.tracing` igual; `bot.tracing.idAttribute(id)` aplica la política de ids a un id tuyo.

## Métricas

`otelMetricsPlugin()` (o `await registerOtelMetrics(bot)`) lee `bot.metrics()` en cada recolección:

| Métrica | Tipo | Atributos |
| --- | --- | --- |
| `botwa.messages.inbound` | counter | |
| `botwa.messages.outbound` | counter | `result` = `ok`/`failed` |
| `botwa.dropped` | counter | `reason` = `duplicate`/`blocked`/`handoff` |
| `botwa.conversations.started` / `.ended` | counter | `outcome` (ended) |
| `botwa.flow.conversations.started` / `.ended` | counter | `flow`, `outcome` (`perFlow`) |
| `botwa.triggered`, `botwa.errors` | counter | |
| `botwa.conversations.active`, `botwa.uptime` (s) | gauge | |
| `botwa.conversation.duration` (s) | histogram | `flow`, `outcome` |

Cada punto lleva `bot.id` más tus `attributes`. `bot.resetMetrics()` hace caer los contadores acumulados, y OpenTelemetry y Prometheus lo tratan como un reinicio de contador.

El tracer además deriva histogramas de los spans terminados (`spanMetrics`, activo por defecto), que se registran aunque la traza no se muestree: `botwa.inbound.duration{bot.event.kind, bot.inbound.outcome, bot.provider.id}`, `botwa.dispatch.duration{bot.dispatch.stage}`, `botwa.queue.wait`, `botwa.send.duration{bot.provider.id, bot.send.outcome}`, `gen_ai.client.operation.duration` y `gen_ai.client.token.usage{gen_ai.token.type}`. Ninguna métrica lleva ids de chat, usuario o mensaje.

## Datos personales

- **Nunca se registran**: cuerpos de mensaje, captions, prompts, respuestas del modelo, argumentos y resultados de herramientas, `c.state`, respuestas de `ask`, texto de comandos desconocidos ni payloads crudos del provider.
- **Los mensajes de error** pueden contener texto del usuario: solo se registran la clase y el código del error, salvo que pongas `telemetry.errorMessages: true`.
- **Los ids** siguen `telemetry.ids`:
  - `'hash'` (por defecto): HMAC-SHA256, base64url, 16 caracteres. La clave es `telemetry.idKey`; sin ella se usa una clave aleatoria por proceso, y los hashes no coinciden entre réplicas ni reinicios. Pon el mismo secreto en todas partes para buscar las trazas de un chat.
  - `'raw'`: el id tal cual lo da el provider; en WhatsApp es un número de teléfono, un dato personal.
  - `'omit'`: sin ids.

## Configuración

```ts
new Bot({
  telemetry: {
    tracer,                          // BotTracer (obligatorio)
    ids: 'hash',                     // 'hash' | 'raw' | 'omit'
    idKey: process.env.TRACE_ID_KEY, // string | Uint8Array
    errorMessages: false,
    spans: { persist: true, pace: true, streamUpdates: false },
  },
})
```

| Opción de `@bot-wa/otel` | Por defecto | |
| --- | --- | --- |
| `tracerProvider` | el global (`trace.getTracerProvider()`) | |
| `tracerName` | `'@bot-wa/otel'` | Scope de instrumentación. |
| `spanMetrics` | `true` | `false`, o `{ meterProvider, prefix }`. |
| `otelMetricsPlugin({ meterProvider, prefix, attributes, perFlow, conversationDuration })` | global, `'botwa'`, `{}`, `true`, `true` | |

### Muestreo

Muestrea en la raíz con un sampler basado en el padre (`new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.1) })` en las opciones del `NodeSDK`): los spans de un mensaje comparten su decisión. Cuando un span no se graba, el core se salta el hash de sus ids. Los histogramas derivados de spans se registran igual, así que los paneles de latencia siguen completos con cualquier tasa de muestreo.

## Otros backends y tests

`BotTracer` es pequeño a propósito: `startSpan(name, options)`, que devuelve un span con `setAttribute(s)`, `addEvent`, `recordException`, `setStatus`, `end`, `isRecording` y `spanContext`, y un `withSpan(span, fn)` opcional para hacer de un span el contexto activo del backend. Cualquier librería de trazas puede implementarlo. Un tracer que lanza errores nunca rompe el bot: la llamada cae a un span no-op y se registra un aviso como mucho una vez por minuto.

En tests, `createRecordingTracer()` de `@bot-wa/core/testing` guarda cada span en memoria:

```ts
import { createRecordingTracer, createTestBot } from '@bot-wa/core/testing'

const rec = createRecordingTracer()
const { bot, chat } = await createTestBot({ telemetry: { tracer: rec.tracer, ids: 'raw' } })
bot.when('hola', (ctx) => ctx.reply('buenas'))
await chat.send('hola')
expect(rec.parentOf(rec.find('bot.send')!)?.name).toBe('bot.pace')
```

## Límites

- **Reproducciones durables**: un registro entrante que reproduce el motor de durabilidad (tras una caída o un reintento) no tiene span `bot.inbound`; su `bot.dispatch` es un span raíz.
- **Varias réplicas**: una conversación que se retoma en otra réplica empieza un turno `dormant` nuevo; todavía no hay enlace de traza entre réplicas.
- **Spans de OpenTelemetry de terceros dentro de una conversación retomada** (código después de `await c.ask()`) cuelgan del contexto propio de OpenTelemetry, que sigue siendo el del primer turno; los spans del bot sí cuelgan bien.
- **Las tareas programadas** (`bot.schedule`) no tienen span propio; sus envíos son spans `bot.send` raíz.
- Vaciar el buffer es cosa del SDK: llama a `sdk.shutdown()` después de `bot.stop()`.
