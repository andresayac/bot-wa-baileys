---
"@bot-wa/core": minor
---

Add golden transcripts: `recordTranscript` (recording `IProvider` wrapper), `transcriptFromStore`/`transcriptFromMessages` (from the store message log), `redactTranscript` (stable `<user:N>`/`<email:N>`/`<phone:N>` placeholders), a versioned JSON format (`parseTranscript`/`serializeTranscript`), and `replayTranscript`/`assertTranscript` in `@bot-wa/core/testing` with expected-vs-actual diffs and tolerance options (masks, ids, timestamps, content fields, ordering).
