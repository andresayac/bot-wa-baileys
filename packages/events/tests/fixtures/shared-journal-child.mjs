// Child process for shared-file-journal.test.ts: opens a SharedFileEventJournal on the file the
// parent names and runs one scenario, reporting to the parent over IPC.
//  - 'drain': on 'go', claim + ack until nothing is claimable; report the ids it claimed.
//  - 'hold':  claim the record with a short lease, report its token, then on 'ack' try to ack
//             it with that token and report the outcome.
import { SharedFileEventJournal } from '../../lib/index.js'

const [file, mode, owner] = process.argv.slice(2)
const journal = await SharedFileEventJournal.open(file)
const next = () => new Promise((resolve) => process.once('message', resolve))

if (mode === 'drain') {
  process.send({ ready: true })
  await next()
  const claimed = []
  for (;;) {
    const records = await journal.claim(2, { owner, leaseMs: 60_000 })
    if (records.length === 0) break
    for (const r of records) {
      claimed.push(r.envelope.eventId)
      await journal.ack(r.envelope.eventId, { fencingToken: r.fencingToken })
    }
  }
  await journal.close()
  process.send({ claimed })
} else if (mode === 'hold') {
  const [record] = await journal.claim(1, { owner, leaseMs: 50 })
  process.send({ token: record?.fencingToken ?? null })
  await next()
  let outcome = 'acked'
  try {
    await journal.ack(record.envelope.eventId, { fencingToken: record.fencingToken })
  } catch (error) {
    outcome = `${error.name}:${error.currentToken}`
  }
  await journal.close()
  process.send({ outcome })
}
