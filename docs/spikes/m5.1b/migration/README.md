# M5.1b migration: reviewed draft, rehearsal and SQL prototype

Date: 2026-11-11. Pre-implementation work only:
- `prisma/` is unchanged; nothing here is applied to the real database, backup or
  manifest;
- synthetic data and temporary databases only;
- all of it ran under `lsof` connection sampling, which recorded no non-loopback
  connection.

## Files

| File | What it is |
| --- | --- |
| `schema.prisma` | The proposed `prisma/schema.prisma`: today's schema plus three models and two back-relations on `Conversation` (`schema.diff`) |
| `prisma-generated-diff.sql` | Unedited `prisma migrate diff --from-migrations prisma/migrations --to-schema schema.prisma --script` |
| `migration.sql` | **The reviewed migration**, to become `prisma/migrations/20261111120000_semantic_index/migration.sql` |
| `rollback.sql` | Manual rollback (never automatic) |
| `rehearsal.int.test.ts.txt` | The rehearsal harness (ran as `tests/m51b-rehearsal.int.test.ts`, then archived) |
| `prototype.int.test.ts.txt` | The SQL prototype: the exact statements planned for M5.1b-1, run against the draft schema with the real import code |

SHA-256:
- `migration.sql`: `e761409da750d7c12f6ac146335cd792b1f92a47394d9e65e4f5d6ed5771598d`
- `rollback.sql`: `5ef7c23b972f2133fe7c79162b02fee0458e06072572fbbcdc9c275f94820ce0`
- `schema.prisma`: `ea46f6278f45f8bf52f00f44d24a964d31fdabe63ecf33229cce5da19fd206ea`

## The reviewed migration

The file is exactly Prisma's generated `CREATE TABLE` and `CREATE INDEX` statements:
- with the 10 FTS5 `DROP TABLE` blocks removed, checked by a script that refused any
  other kind of block;
- wrapped in one `BEGIN … COMMIT` (Prisma does not wrap SQLite migrations).

It contains 3 `CREATE TABLE` and 2 `CREATE INDEX` statements, and nothing else.

### Two changes from the design's §3, found while drafting

Prisma emits `INTEGER PRIMARY KEY AUTOINCREMENT` for every `Int @id` on SQLite, even
without `@default(autoincrement())`. `AUTOINCREMENT` creates SQLite's `sqlite_sequence`
table, which would:
- keep the highest chunk id ever issued, even after delete-all and VACUUM (a count,
  not content, but a residue);
- remain after a rollback, because SQLite does not allow dropping it.

Both integer keys are therefore replaced:

| Table | Design §3 | Draft | Effect |
| --- | --- | --- | --- |
| `EmbeddingChunk` | `id INTEGER PK` (rowid) and a unique (`conversationId`, `sourceNodeId`, `chunkIndex`) | composite **primary key** (`conversationId`, `sourceNodeId`, `chunkIndex`) | no `AUTOINCREMENT`; one index less; the chunk's natural identity is the key |
| `EmbeddingIndex` | `id INTEGER PK`, always 1 | `id TEXT PK`, always `'main'` | no `AUTOINCREMENT`; still at most one row by convention |

The rehearsal confirms there is no `sqlite_sequence` table after deploy or rollback.

### Objects created

- **Tables:** `EmbeddingIndex`, `EmbeddingStatus`, `EmbeddingChunk`.
- **Indexes:** `EmbeddingStatus_state_queuedAt_idx`, `EmbeddingChunk_epoch_idx`.
- **Primary-key indexes SQLite creates itself:** `sqlite_autoindex_EmbeddingIndex_1`,
  `sqlite_autoindex_EmbeddingStatus_1`, `sqlite_autoindex_EmbeddingChunk_1`.
- **Foreign keys:** both `conversationId` columns → `Conversation(id)` with `ON DELETE
  CASCADE` (Prisma also adds `ON UPDATE CASCADE`; conversation ids never change).
- **Not touched:** no existing table, index, trigger or row.

## Rehearsal (8 of 8 passed)

**Setup:**
- A synthetic M2 database: 44 conversations, 1,549 messages, 2 import batches, 1.17 MB.
  It was migrated with the committed migrations and filled through the real import
  service, including one replacing import.
- The draft ran from a throwaway Prisma workspace inside the project, removed afterwards.
  All databases were in the system temp directory.

| Check | Result |
| --- | --- |
| Backup with SQLite's backup API | integrity ok; data, schema and migration history fingerprints equal the source |
| `migrate deploy` | applies only `20261111120000_semantic_index` (1.1 s including CLI start-up); a second deploy reports no pending migrations |
| Existing data | SHA-256 fingerprint of every `ImportBatch`, `Conversation` and `Message` row unchanged |
| Existing schema | every existing `sqlite_master` entry (tables, indexes, FTS5 virtual and shadow tables, triggers) unchanged |
| New objects | exactly the 3 tables and 5 indexes above, all empty; no `sqlite_sequence` |
| Integrity | `integrity_check` ok; `foreign_key_check` empty |
| FTS5 preservation | FTS5 `integrity-check` ok on both indexes; four keyword searches (Norwegian, Russian, English, a canary word) give identical results, snippets included |
| `migrate status` | up to date |
| Drift: migrations against schema | only the 10 expected FTS5 drops (`analyzeDrift` ok) |
| Drift: database against schema (`--from-config-datasource`) | the same: ok |
| Drift check without the migration | flags `EmbeddingChunk` etc. (the guard works) |
| Delete-all (today's code, unchanged) with 44 status rows and 132 canary chunks | `complete`; the cascade emptied both tables; `EmbeddingIndex` kept; no free pages; integrity ok; **the canary vector bytes are absent from the file** |
| Rollback A: restore from the backup | data, schema and migration history equal the pre-migration state; status lists the migration as pending; redeploy works |
| Rollback B: `rollback.sql` | schema identical to M2 (no residue), data unchanged, FTS5 ok, `migrate status` up to date with the committed migrations, no drift; redeploy works |
| Failing migration (an error inserted before `COMMIT`) | deploy fails; **no new table exists** (the transaction rolled back); data and schema unchanged; Prisma records the failure and refuses further deploys (P3009) until `migrate resolve --rolled-back`, after which the correct migration applies |
| Path guards | the isolation guard refuses the real database path and a non-temp path under the test flag; a read-only `migrate status` against the real path exits before opening it |

## SQL prototype (20 of 20 passed)

The statements planned for M5.1b-1 were run inside the real import transaction, through
the existing test hook. They cover:
- invalidation (I2);
- Reconcile;
- claim (T1) with `UPDATE … RETURNING`;
- commit (T2) as one compare-and-set;
- the failure classes, and retry;
- the vector reader.

### C: invalidation of retained status rows, for every import decision

| Decision | Result |
| --- | --- |
| 5 add | `pending` row with the conversation's version, epoch 0 before the first Start |
| 8 replace (newer copy) | in place (same id, so **the FK cascade does not fire**); I2 resets the row to `pending` and deletes the chunks in the import transaction |
| 7 reprocess (parser only) | `contentHash` unchanged, `parserVersion` changed; the pair check catches it; I2 resets and deletes |
| 6, 9, 10, 11, 12, 13 (no write) | row, chunks and messages byte-identical; the vectors stay readable |
| Import failing after I2 (`afterInsert`, `beforeCommit`) | status and chunks unchanged: atomic with the messages |
| Replacement during inference (cases 7 and 8) | the in-flight commit is `stale`; nothing written |
| Without I2 (today's code) | a replacement leaves stale chunk rows; the reader's join (I6) still hides them, but I2 is required |

**Every write path was checked:** `persistConversation` (add and replace) is the only
writer of `Conversation` and `Message` apart from delete-all. So I2 goes in exactly one
place, after the message writes in the add and replace branches.

### D: explicit cases

| Case | Result |
| --- | --- |
| Zero-chunk completion | `indexed`, `chunkCount = 0`; three further Starts queue nothing |
| Backfill | conversations imported before the migration are queued once |
| Oversized | `failed` with `CONVERSATION_TOO_LARGE` after one attempt, no retries; the other conversation is indexed; Start does not requeue it; **keyword search still finds it** |
| Failed jobs | a recoverable error: `failed` after exactly 3 claims, the others indexed; "retry failed" resets to `pending`, attempts 0 |
| Attempt accounting | a clean run-level failure refunds (5 failures, attempts still 0); a worker crash keeps it (`failed` after 3) |
| Crash mid-inference | a `running` row with attempts 1; the next Start resets it (attempt kept) |
| A→B→A | the versions match again, but the commit is refused by the token, then re-embedded with a new claim |
| Delete-all during inference | commit refused |
| Model-version incompatibility | each of the five configuration fields changed in turn gives `INDEX_INCOMPATIBLE` before Reconcile; so does a query worker on another version; no row gives `INDEX_EMPTY` |
| Model-version change | Reconcile drops all chunks and increments the epoch; a worker still on the old version can't commit |
| Reader | skips and counts a malformed vector; hides rows from an old epoch or version |

**Notes from the prototype:**
- **An exact A→B→A can't happen through the real import path:** the v1 content hash
  covers `update_time`, and older copies are refused. That test therefore drives I2
  directly; the token is the guarantee.
- **Timestamps:** `DateTime` is stored as text in the adapter's format
  (`…T…+00:00`); raw SQL writes the same format (checked against `ImportBatch`).
- **Foreign keys:** enforcement is on for the app's connections (`PRAGMA foreign_keys
  = 1`); a chunk for a missing conversation is rejected.
- **Integers:** raw queries return SQLite integers as JS numbers.
