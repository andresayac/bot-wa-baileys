import { MemoryManager, type AIMemoryConfig, type UserDataAccessor } from './MemoryManager.js'

/**
 * Build the plugin's memory manager from `aiPlugin({ memory })`. Without the
 * option the API (`ctx.tools.ai.memory()` / `remember()` / `forget()`) still
 * works, but nothing is injected into prompts or extracted automatically.
 */
export function createMemory(access: UserDataAccessor, config: boolean | AIMemoryConfig | undefined): MemoryManager {
  if (!config) return new MemoryManager(access, { inject: false, autoExtract: false })
  return new MemoryManager(access, config === true ? {} : config)
}
