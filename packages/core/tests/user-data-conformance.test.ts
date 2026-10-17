/**
 * MemoryStore (the reference impl) and NamespacedStore against the shared
 * user-data (`ctx.user`) conformance suite.
 */
import { MemoryStore } from '../src/store/MemoryStore.js'
import { NamespacedStore } from '../src/store/NamespacedStore.js'
import { runUserDataConformance } from '../../../test-utils/user-data-conformance.js'

runUserDataConformance('MemoryStore', {
  async make() {
    const store = new MemoryStore({})
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})

runUserDataConformance('NamespacedStore(MemoryStore)', {
  async make() {
    const store = new NamespacedStore(new MemoryStore({}), {
      tenantId: 'tenant', environmentId: 'env', botId: 'bot', providerId: 'mock', connectionId: 'primary',
    })
    await store.start()
    return { store, teardown: () => store.stop() }
  },
})
