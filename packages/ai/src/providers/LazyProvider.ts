import type { AIProvider, GenerateInput, GenerateResult } from '../types.js'

/**
 * LazyProvider — defers real provider construction until the first use.
 *
 * Lets `aiPlugin.install` stay **synchronous** even though resolving a provider
 * is async and may throw (missing SDK, unknown provider, or an SDK constructor
 * that throws — e.g. the Anthropic SDK when no api key is available). The real
 * provider is built by `factory` on the first `generate`/`stream`/`warmup`, and
 * the resulting promise is memoized. A failing factory therefore surfaces
 * per-call (the autoreply try/catch replies `errorMessage`) instead of turning
 * into an uncatchable unhandled rejection that crashes the process at install.
 */
export class LazyProvider implements AIProvider {
  readonly name = 'lazy'
  private p?: Promise<AIProvider>

  constructor(private factory: () => Promise<AIProvider>) {}

  private get(): Promise<AIProvider> {
    return (this.p ??= this.factory())
  }

  /**
   * Eagerly resolve the underlying provider. Resolves to `void` on success and
   * rejects if the factory throws — call sites decide whether to swallow/log.
   */
  async warmup(): Promise<void> {
    await this.get()
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    return (await this.get()).generate(input)
  }

  async *stream(input: GenerateInput): AsyncIterable<string> {
    yield* (await this.get()).stream(input)
  }
}
