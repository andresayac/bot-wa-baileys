import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The simulator tests import the built @bot-wa/core dev engine and drive whole
    // conversations; a cold start on a loaded machine can take several seconds.
    testTimeout: 30_000,
  },
})
