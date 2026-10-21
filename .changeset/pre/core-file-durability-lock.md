---
"@bot-wa/core": patch
---

`FileDurability`: a second `open()` of the same file in the same process is refused (`already open in this process`) until the first journal is closed; before, the lock with our own pid was taken and the two instances overwrote each other's snapshots. A lock file with our pid and no open journal in this process (a restarted container reusing pids) and one of a dead process are still taken over. An empty or garbled lock younger than 10 s is no longer treated as stale: `open()` waits up to the new `lockWaitMs` option (default 2 s). `close()` is idempotent, waits for pending writes and makes later writes reject; new `locked` getter.
