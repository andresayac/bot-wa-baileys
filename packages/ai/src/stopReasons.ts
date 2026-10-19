/** Stop reasons meaning the answer hit the output-token cap (Anthropic, OpenAI-compatible, Ollama, Gemini). */
const TRUNCATED = new Set(['max_tokens', 'length', 'MAX_TOKENS'])

/** True when `stopReason` says the model was cut off by the output-token cap. */
export const isTruncated = (stopReason: string | undefined): boolean => stopReason !== undefined && TRUNCATED.has(stopReason)
