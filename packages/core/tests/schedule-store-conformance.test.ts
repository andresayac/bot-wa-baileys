/** MemoryScheduleStore / MemoryLeaseProvider against the shared conformance suites (the reference impls). */
import { MemoryScheduleStore } from '../src/scheduler/ScheduleStore.js'
import { MemoryLeaseProvider } from '../src/coordination/lease.js'
import { runScheduleStoreConformance } from '../../../test-utils/schedule-store-conformance.js'
import { runLeaseConformance } from '../../../test-utils/lease-conformance.js'

runScheduleStoreConformance('MemoryScheduleStore', {
  async make() {
    return { store: new MemoryScheduleStore(), teardown: async () => {} }
  },
})

runLeaseConformance('MemoryLeaseProvider', {
  async make() {
    return { lease: new MemoryLeaseProvider(), teardown: async () => {} }
  },
})
