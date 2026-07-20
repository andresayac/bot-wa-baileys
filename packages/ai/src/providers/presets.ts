/**
 * Presets — OpenAI-compatible model providers reachable through the `openai`
 * SDK with a custom `baseURL`. Zero extra dependencies: DeepSeek, Qwen, GLM,
 * Kimi, Groq, OpenRouter, Mistral, Grok (xAI) and Together all speak the
 * OpenAI chat-completions protocol. `provider: 'deepseek'` etc. resolve to an
 * {@link OpenAIProvider} pointed at the preset's endpoint + default model.
 *
 * API keys fall back to each preset's conventional env var when `apiKey` is
 * not passed explicitly.
 */

export interface Preset {
  /** OpenAI-compatible endpoint. */
  baseUrl: string
  /** Default model id (overridable via `cfg.model`). */
  model: string
  /** Conventional env var holding the API key. */
  env: string
  /**
   * Field these providers accept for the output-token cap. Nearly all OpenAI
   * clones want `max_tokens`; only current OpenAI chat models want
   * `max_completion_tokens`.
   */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
}

export const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', env: 'DEEPSEEK_API_KEY', maxTokensField: 'max_tokens' },
  qwen: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', env: 'DASHSCOPE_API_KEY', maxTokensField: 'max_tokens' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', env: 'ZHIPUAI_API_KEY', maxTokensField: 'max_tokens' },
  kimi: { baseUrl: 'https://api.moonshot.ai/v1', model: 'moonshot-v1-8k', env: 'MOONSHOT_API_KEY', maxTokensField: 'max_tokens' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', env: 'GROQ_API_KEY', maxTokensField: 'max_tokens' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', env: 'OPENROUTER_API_KEY', maxTokensField: 'max_tokens' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', env: 'MISTRAL_API_KEY', maxTokensField: 'max_tokens' },
  grok: { baseUrl: 'https://api.x.ai/v1', model: 'grok-2-latest', env: 'XAI_API_KEY', maxTokensField: 'max_tokens' },
  together: { baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', env: 'TOGETHER_API_KEY', maxTokensField: 'max_tokens' },
} satisfies Record<string, Preset>

export type PresetName = keyof typeof PRESETS

export function isPreset(name: string): name is PresetName {
  return name in PRESETS
}
