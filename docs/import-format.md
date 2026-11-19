# ChatGPT import format and parsing rules

How ThreadAtlas reads a ChatGPT `conversations.json` export (parser version `0.3.0`,
`src/lib/import/`) and stores it (M1.4, *Persistence* below). The rules below are the
confirmed decisions A16–A34 and A52–A75 in `docs/IMPLEMENTATION_PLAN.md` §8. Every rule
is covered by tests that use the hand-written synthetic fixtures in
`tests/fixtures/chatgpt/`, or synthetic data generated in the tests.

Imported content is **untrusted data**. Parsing never executes, evaluates or renders it.
Extracted text is plain text and must never be rendered as HTML. Issue reports contain
codes, positions, field names and identifiers only, never message text or titles.

## Pipeline

```text
POST /api/import (http.ts: request checks, M1.5)
  │
upload bytes ─▶ read-upload.ts ─▶ adapter.ts ─▶ normalize.ts ─▶ import-service.ts
               size limit,        file and        tree, path,     one transaction
               UTF-8, JSON,       conversation    content, hash   per conversation
               SHA-256            level (M1.1)    (M1.2)          (M1.4)
```

`parseExportText` / `parseExportStream` in `validate-export.ts` run the parsing steps
without writing anything. `importExportStream` / `importAdapterResult` in
`import-service.ts` also persist the result (*Persistence*). Nothing is logged, and the
upload itself is never written to disk (A4).

## Expected shape (an assumption, checked at runtime)

An array of conversations, each with `title`, `create_time`/`update_time`, `mapping`
(node key → `{id, message | null, parent, children[]}`), `current_node`, and
`conversation_id` or `id`. Every field is checked when it is read. A mismatch produces a
coded warning or error, never a crash. Unknown fields are ignored. They never fail an
import (A17), although unknown **node-level** fields do feed the content hash.

## Error levels

| Level | Effect | Codes |
| --- | --- | --- |
| File | Fatal; nothing imported | `FILE_READ_FAILED`, `FILE_INCOMPLETE`, `FILE_TOO_LARGE`, `FILE_EMPTY`, `FILE_NOT_UTF8`, `FILE_INVALID_JSON`, `FILE_TOO_DEEP`, `FILE_UNSUPPORTED_STRUCTURE`, `FILE_NO_CONVERSATIONS` |
| Conversation: skipped | That conversation is not imported | `CONVERSATION_NOT_OBJECT`, `CONVERSATION_TOO_DEEP`, `CONVERSATION_ID_TOO_LONG`, `CONVERSATION_NODE_ID_TOO_LONG`, `CONVERSATION_MAPPING_MISSING`, `CONVERSATION_MAPPING_INVALID`, `CONVERSATION_ID_UNDERIVABLE`, `DUPLICATE_ID_SUPERSEDED` |
| Conversation: flagged | Not imported until a resolution flow exists (I8) | `DUPLICATE_ID_AMBIGUOUS`, `CONVERSATION_ID_AMBIGUOUS`, `CONVERSATION_ID_RESERVED` |
| Conversation: warning | Imported | `CONVERSATION_ID_DERIVED`, `CONVERSATION_ID_MISMATCH`, `FIELD_INVALID_TYPE`, `FIELD_TOO_LONG`, `TIMESTAMP_INVALID`, `TIMESTAMP_UNUSUAL`, `CURRENT_NODE_NOT_IN_MAPPING`, `PATH_FALLBACK`, `PATH_NONE`, `PATH_CYCLE`, `MULTIPLE_ROOTS`, `TREE_CYCLE` |
| Node: warning | Node kept (except `NODE_NOT_OBJECT`, which drops the entry) | `NODE_NOT_OBJECT`, `NODE_REFERENCE_TOO_LONG`, `NODE_ID_MISMATCH`, `NODE_PARENT_INVALID`, `NODE_PARENT_NOT_IN_MAPPING`, `NODE_CHILDREN_INVALID`, `NODE_CHILD_NOT_IN_MAPPING`, `NODE_CHILD_PARENT_MISMATCH`, `NODE_NOT_LISTED_BY_PARENT`, `MESSAGE_MALFORMED`, `MESSAGE_ROLE_MISSING`, `CONTENT_UNSUPPORTED` |

Static, content-free messages for every code are in `errors.ts`.

## Nesting limit (F2)

Hashing and ID derivation serialise JSON recursively, and hostile input a few KB in size
can nest deeply enough to exhaust the call stack. To prevent that, ThreadAtlas limits
**object/array nesting to 512 levels** (`MAX_JSON_DEPTH`).

- **How depth is counted:** in object/array levels from the **file root**. The top-level
  export array is level 1 and each conversation object is level 2, so a file whose
  deepest container is at level 512 is accepted and one at 513 is not. Primitives add no
  level. The length of a branch in the message tree is unrelated, because the `mapping`
  is flat. Real exports nest about 10 levels deep.
- **Per conversation:** each conversation is checked **iteratively**, before anything
  recursive runs (derived ID, content hash, raw payload). A conversation nested deeper
  than the limit, in any field, is skipped with `CONVERSATION_TOO_DEEP`. The rest of the
  file is imported normally. As with other skipped copies, a duplicate ID's remaining
  copies are resolved without it.
- **File level:** conversations are always separate entries of the top-level array, so
  nesting never prevents isolating them. V8's `JSON.parse` is iterative: on Node 24 it
  parses 26 million nested arrays, the most a 50 MiB file can hold. If a runtime does run
  out of stack while parsing, the file fails with `FILE_TOO_DEEP` rather than
  `FILE_INVALID_JSON`.
- **Backstop:** `canonicalJson` itself refuses input deeper than 512 levels with a
  `JsonTooDeepError` (static message, no content), so a future caller can't reintroduce
  the stack overflow.
- Reports contain only the code, position and source ID, never content or stack traces.

## Identifier length limit (Q12)

Externally supplied identifiers are limited to **512 characters**, counted as Unicode
code points (`identifiers.ts`). An oversized identifier is **never truncated** and never
copied into an issue. What happens depends on where it appears:

| Identifier | Over 512 characters |
| --- | --- |
| The conversation ID that would be used (`conversation_id`, or `id` when there is no `conversation_id`) | The conversation is skipped with `CONVERSATION_ID_TOO_LONG`. There is **no fallback** to `id` or to a derived ID |
| `id` when `conversation_id` is used | Ignored, with `FIELD_TOO_LONG` (`field: "id"`) instead of `CONVERSATION_ID_MISMATCH` |
| A mapping key, or a node's `parent` | The **whole conversation is skipped** with `CONVERSATION_NODE_ID_TOO_LONG` (`field: "mapping"`, or `field: "parent"` with the node's own key). The rest of the file is imported |
| `children[]` entries, `message.id` | Ignored, with `NODE_REFERENCE_TOO_LONG` and the field name. The node and the tree are unchanged |
| `current_node` | Treated as absent, with `FIELD_TOO_LONG`, and not stored. The path uses a fallback, recorded in `pathStrategy` with `PATH_FALLBACK` |

Why a mapping key or `parent` skips the conversation: keeping it would mean dropping that
node (losing its message) or nulling the reference, which turns nodes into false roots.
The stored tree would then look complete while missing part of the conversation. Child
entries, `message.id` and `current_node` cannot change the tree: parents come only from
`parent` (A23), and an oversized child entry cannot name a stored node. `buildTree`
refuses an oversized key or `parent` (`OversizedNodeIdError`), so the skip can't be
bypassed.

The content hash and derived IDs are computed over the raw source, so content hash v1 is
unaffected.

## Conversation identity (A16, A19, A20)

1. `conversation_id`, then `id` (blank strings count as missing). If both are present and
   differ, `conversation_id` is used, with a warning.
2. If neither is present, a derived ID `derived:v1:<sha256>` is computed over canonical
   **raw source** content: conversation `create_time`, plus, per mapping entry sorted by
   key, its key, `parent`, `message.id`, `message.author.role`, `message.create_time` and
   `message.content`. Title and metadata are excluded, so a rename keeps the ID.
3. Identical derived IDs in one file: all copies are flagged, never merged. An explicit
   ID that starts with `derived:` is flagged. An ID-less conversation with no message
   content is skipped.
4. Duplicate explicit IDs in one file: the copy with the strictly later **valid**
   `update_time` wins. If the times are tied, missing or invalid, all copies are
   flagged.
5. **Duplicate reports (F3):** every copy still has its own `skipped` or `flagged`
   entry, so counts are exact. Each group of copies, however large, produces **one**
   issue (`DUPLICATE_ID_SUPERSEDED`, `DUPLICATE_ID_AMBIGUOUS` or
   `CONVERSATION_ID_AMBIGUOUS`) without an `index`. Instead it carries `sourceId` and a
   `duplicateGroup` summary:

   | Field | Meaning |
   | --- | --- |
   | `occurrences` | Copies of the ID that reached duplicate resolution. Copies already skipped for another reason (for example, no mapping) are not counted |
   | `sampleIndices` | Positions of the first copies in file order, at most 10 |
   | `truncated` | `true` when there are more copies than listed |
   | `keptIndex` | The copy that was kept (`DUPLICATE_ID_SUPERSEDED` only). It may lie outside the sample |

   Grouping uses a `Map`, and the newest copy is found in one pass, so the work is linear
   in the number of conversations.

> **Limitation (A20c):** editing or continuing an ID-less conversation changes its derived
> ID, so re-importing it creates a **duplicate** rather than updating the earlier copy. No
> fuzzy matching is attempted in M1.

## Timestamps (A22, A30)

One implementation (`timestamps.ts`) is shared by duplicate resolution and tree parsing.

- **Numbers** are epoch seconds (floats allowed). They are valid when finite and
  representable as a JavaScript date (|ms| ≤ 8.64 × 10¹⁵), and precision is kept exactly
  as exported.
- **Strings** must be strict ISO 8601: `YYYY-MM-DD` (UTC midnight), or
  `YYYY-MM-DDTHH:MM[:SS[.fraction]]` with `Z` or `±HH:MM`. Fields are validated, so there
  is no 30 February, no 24:00 and no leap second. A date-time **without an offset is
  invalid**, because its meaning would depend on the machine's time zone. Numeric strings
  are invalid.
- Anything else counts as missing and adds `TIMESTAMP_INVALID` (with the field name).
- No historical cutoff rejects a value. Values before 2000-01-01 or more than one day
  after the import time are kept and add `TIMESTAMP_UNUSUAL`. This catches milliseconds
  mistaken for seconds.
- Newer-wins comparisons happen only when **both** values are valid.

## Tree reconstruction (A23, A24)

- Every mapping entry that is an object becomes exactly one stored node, including
  structural nodes (`message: null`), off-path branches and nodes in cycles. A non-object
  entry is dropped with `NODE_NOT_OBJECT`.
- The **mapping key** is the node ID. If `node.id` differs, the key wins, with a warning.
- A node's parent comes **only** from its `parent` field. The exported value is stored
  even when it dangles. A parent is **never inferred** from another node's `children[]`.
  - A `parent` that is not in the mapping makes the node a root for display, with
    `NODE_PARENT_NOT_IN_MAPPING`.
  - A non-string `parent` is stored as null, with `NODE_PARENT_INVALID`.
- `children[]` only orders siblings:
  - Listed children whose own `parent` agrees come first, in listed order.
  - Nodes whose parent does not list them follow, in mapping order, with
    `NODE_NOT_LISTED_BY_PARENT`.
  - A listed child that names a different parent stays with that parent, with
    `NODE_CHILD_PARENT_MISMATCH`.
  - A listed child that isn't in the mapping is ignored, with
    `NODE_CHILD_NOT_IN_MAPPING`.
  - Repeated entries are ignored.
- `siblingIndex` is the position among the parent's children. For roots, it is the
  position among roots.
- More than one root adds `MULTIPLE_ROOTS`. Nodes that no root reaches (a cycle) add
  `TREE_CYCLE`.
- **Mapping order** is the property order of the parsed JSON object. JavaScript lists
  integer-like keys (`"1"`, `"2"`) first, in ascending order. Real exports use UUID keys.

## Default visible path (A25)

1. **`current_node`**, if it is a key in the mapping. It may end on an inner node. If it is
   not in the mapping, `CURRENT_NODE_NOT_IN_MAPPING` is added and the next rule is tried.
2. **`latest_leaf`**: among leaves (nodes without children) that have a message and a
   **valid** `create_time`, pick the latest. Ties go to the later mapping order.
3. **`last_child`**: start at the first root (mapping order) and keep following the last
   child until reaching a leaf.
4. **`none`**: no path can be built (empty mapping, or no root because of a cycle). Adds
   `PATH_NONE`.

Strategies 2 and 3 add `PATH_FALLBACK`: the path **may not be the branch last viewed** in
ChatGPT. The strategy used is stored with the conversation.

The path is built by walking from the chosen node up through parents and then
reversing. A cycle stops the walk with `PATH_CYCLE`. Nodes on the path get `pathIndex`
0..n−1, including structural nodes; all other nodes get `null`.

## Messages (A24, A26, A29)

| Case | Stored as |
| --- | --- |
| `message` absent or `null` | **Structural node** (`isStructural`): never displayed as a message, never hidden, never malformed, no role |
| `message` is a string | **Malformed message**; the string is kept as text |
| `message` is another non-object | Malformed message; no text; the payload is kept as raw content |
| `message` object with missing or unreadable content | Malformed message; only safely recoverable text is kept (see below) |
| Missing or non-string `author.role` | `role = null` with `MESSAGE_ROLE_MISSING`; **not** structural |
| Any string role | Kept **exactly**, including unknown roles |

**Hidden by default:** every message whose role is exactly `"system"`, and every message
with `metadata.is_visually_hidden_from_conversation` **strictly `true`** (not `"true"`, not
`1`). Hidden messages are stored with their content and can be revealed in the UI.
`visibleMessageCount` counts path messages that are neither structural nor hidden.

## Content extraction (A27, A28)

| `content_type` | Text | Unsupported? |
| --- | --- | --- |
| `text` | String parts joined with a blank line; other parts become `[unsupported part]` | Only if a part isn't a string |
| `multimodal_text` | String parts; `image_asset_pointer` → `[image]`; other object parts → `[attachment: <type>]` | Only for non-image object parts |
| `code` | `text` exactly; `language` kept as `codeLanguage` | No |
| `execution_output` | `text` exactly | No |
| anything else | String parts, else a string `text`, else `[unsupported content: <type>]` | **Always** |

- Text is never trimmed or normalised.
- `<type>` in placeholders is shown only if it matches `[A-Za-z0-9_.:-]{1,64}`; otherwise
  it is shown as `unknown`. The raw `content_type` is always stored as data.
- **Malformed content.** Missing content gives no text. A string is kept. A record without
  a `content_type` gets string parts or a string `text` recovered. `text` without `parts`
  gets `text` recovered. Nothing is invented.
- **Raw payload (narrow exception to A4).** When content cannot be fully represented as
  text (`hasUnsupportedParts`), the message's original `content` value is kept as
  `rawContentJson`. Entire export files are never stored. The payload lives on the message
  row, so it follows the same privacy, retention and delete-all rules as the rest of the
  conversation. The stored `parserVersion` lets a later parser reprocess it.

## Content hash (A21)

`contentHash = "v1:" + sha256(canonicalJson(projection))`, where the projection is:

```json
{ "v": 1, "title": …, "create_time": …, "update_time": …, "current_node": …, "mapping": … }
```

- `title`, `current_node`: the validated value, or `null` (absent, null or wrong type).
- `create_time`, `update_time`: validated epoch seconds, or `null`. Equivalent forms hash
  the same (`5`, `5.0`, `"1970-01-01T00:00:05Z"`).
- `mapping`: the whole mapping **as exported**, so a change anywhere in the message tree
  (content, metadata, structure, unknown node fields) changes the hash.
- Excluded: other conversation-level fields (ThreadAtlas doesn't store them), the
  conversation ID (the comparison key), and all import metadata (batch, time, file name,
  file hash, parser version).

**Canonical JSON** (`canonical-json.ts`):
- Object keys are sorted recursively by UTF-16 code unit; keys with `undefined` values
  are omitted.
- Arrays keep their order. There is no whitespace.
- Numbers and strings are written by `JSON.stringify` (shortest round-trip; `-0` → `0`).
- There is **no Unicode normalisation**.

## Persistence (M1.4)

`import-service.ts` writes a parsed export into SQLite. Decisions A52–A64.

```text
acquire the write lock (cross-process)            busy → IMPORT_BUSY, nothing written
└─ mark stale `running` batches `interrupted`
   create ImportBatch (status running; seen, plus the adapter's flagged/skipped)
   for each accepted conversation, in file order:
       normalise (just in time; the candidate is then released)
       one transaction: read stored summary → decide → add | replace | nothing
                        → increment the batch counters in the same transaction
       database error → sanitised code; per-conversation → continue; systemic → stop
       checkpoint the counters and report every 250 conversations or 1 s
   finalise (status, error code, last tallies, report, finish time)
release the lock
```

### Decision per conversation (state table)

Only cases 5, 7 and 8 write. Newer data is never replaced by older data: a write needs
an identical source and a strictly newer parser (7), or a strictly newer valid
`update_time` (8), and the update re-checks the stored hash and parser version inside the
transaction (it must affect exactly one row).

| # | Case | Condition | Effect | Counter | Code |
| --- | --- | --- | --- | --- | --- |
| 1 | File error | adapter returns `ok: false` | nothing written, no batch row | — | `FILE_*` |
| 2 | Busy | the write lock is held | nothing written | — | `IMPORT_BUSY` |
| 3 | Skipped by the parser | in `skipped[]` | none | skipped | existing codes |
| 4 | Flagged by the parser | in `flagged[]` | none | flagged | existing codes |
| 5 | New | no stored (`source`, `sourceId`) | insert conversation and every node | added | — |
| 6 | Unchanged | equal hash; stored parser version ≥ current | none | unchanged | — |
| 7 | Parser refresh | equal hash; stored parser version < current | replace rows | updated | `CONVERSATION_REPROCESSED` (info) |
| 8 | Newer | different hash; both times valid; incoming later; stored parser ≤ current | replace rows | updated | — |
| 9 | Older | different hash; both times valid; incoming earlier | none | older | `CONVERSATION_OLDER` |
| 10 | Ambiguous: equal times | different hash; equal valid times | none | flagged | `CONVERSATION_VERSION_AMBIGUOUS` |
| 11 | Ambiguous: missing time | different hash; either time missing or invalid | none | flagged | same, `field: "update_time"` |
| 12 | Parser downgrade | case 8, but the stored parser version is newer | none | flagged | `CONVERSATION_PARSER_DOWNGRADE` |
| 13 | Unrecognised state | stored hash or parser version unrecognised, or hash versions differ | none | flagged | `CONVERSATION_STATE_UNRECOGNISED` |
| 14 | Conversation failed | non-systemic database error in its transaction | rolled back; any stored copy intact | skipped | `CONVERSATION_PERSIST_FAILED` + `errorCode` |
| 15 | Systemic failure | missing file or tables, disk full, read-only, corrupt, configuration, locked by a foreign program | stop; earlier commits stay | — | batch `errorCode` |
| 16 | Crash | the process dies | committed conversations stay; batch left `running` | — | `IMPORT_INTERRUPTED` at the next import |

- **Version grammars** (`persist/versions.ts`): parser versions must match
  `^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$` and are compared
  numerically; content hashes must be `v1:` plus 64 lowercase hex digits. Anything else
  is unrecognised and never compared (case 13). The running parser checks its own
  version first (`IMPORT_PARSER_VERSION_INVALID` refuses the import).
- **Parser refresh (case 7)** is safe because hash v1 covers the raw source (I15): an
  equal hash means identical source data. An older export imported with a newer parser
  is still *older* (case 9): the parser version alone never causes an overwrite.
- **C9 (accepted M1 limitation):** a conversation stored without a valid `update_time`
  can't be updated by a changed copy; every such copy is flagged. Resolving it needs a
  future, user-confirmed conflict-resolution flow.
- `lastImportBatchId` is the last batch that **wrote** the conversation;
  `firstImportBatchId` and `Conversation.id` never change.

### Transactions and message replacement

- One interactive transaction per conversation on the **writer connection** (A55), with
  `timeout` 300 s and `maxWait` 10 s. These are backstops, not hard limits:
  better-sqlite3 runs each statement synchronously, so the timer can't fire during a long
  statement. Work is bounded by chunking and the 50 MiB upload limit.
- Replace = guarded `updateMany` → delete all message rows → insert the full new tree.
  Any exception rolls all of it back. "No partial data" means per conversation: never a
  conversation without all its messages, never a mix of old and new messages. A batch
  can be partial, and says so (*Accounting*).
- Messages are inserted in chunks of 500 rows, yielding to the event loop between
  chunks, after normalisation and between conversations. Prisma's adapter settles every
  query synchronously, so without the per-conversation yield an import would starve all
  other requests (measured: 0 timer ticks in 21 s).
- **Message references (A62):** a replacement gives every message a new `Message.id`.
  Later features must refer to messages by (`conversationId`, `sourceNodeId`), and treat a
  reference to a node that a later import removed as dangling ("message no longer
  present"), never resolving it to a different message. Data derived from a
  conversation's messages (e.g. the M2 search index) must be rebuilt or deleted in the
  same replacement transaction.

### Connections and locking

- **Writer connection** (`getWriterDb()`): the adapter gives each Prisma client exactly
  one SQLite connection, and queries outside a transaction run on it, inside any open
  transaction (F4). Pages use `getDb()`; imports use the separate writer, so pages only
  ever see committed data. The writer sets `PRAGMA cache_spill = OFF`, so a large
  transaction never takes the file's EXCLUSIVE lock before commit and readers keep
  working (cost: one transaction's pages stay in memory until commit). The writer is
  never disconnected while the process runs: closing it during a transaction leaves the
  transaction's promise pending forever.
- **Write lock** (`write-lock.ts`): `BEGIN EXCLUSIVE` on a separate empty SQLite file,
  `<database>.lock` (mode 0600), held for recovery, processing and finalisation. It is
  atomic, exclusive across processes and between connections in one process, never
  blocks the event loop (busy timeout 0, then up to 6 attempts with short random
  delays), and fails closed (`IMPORT_BUSY`, or `IMPORT_LOCK_FAILED` for a symlink,
  directory, foreign owner, unreadable or non-SQLite file). The operating system releases
  it when the holder dies, even on SIGKILL. The file is never deleted or replaced, and
  once it exists it is never opened with a raw file descriptor: under POSIX record
  locking, closing any descriptor of a file releases all of the process's locks on it,
  so it is checked by path only (`lstat`, `chmod`).
  **Limitation:** reliable on local filesystems only, not on network drives; deleting
  the file while it's held defeats it.

### Batch statuses and accounting

| Status | Meaning |
| --- | --- |
| `running` | In progress, or the process died (becomes `interrupted` at the next import) |
| `succeeded` | Every conversation has an outcome; no warnings (info notes allowed) |
| `succeeded_with_warnings` | Every conversation has an outcome; warnings, or skipped, flagged or older conversations |
| `completed_with_errors` | Every conversation has an outcome; at least one `CONVERSATION_PERSIST_FAILED` |
| `failed` | A systemic error stopped processing (or finalisation failed); `errorCode` is set; earlier commits stay |
| `interrupted` | A stale `running` batch found by a later import under the lock; `errorCode` `IMPORT_INTERRUPTED` |

- `conversationsSeen` is every conversation discovered in the file. The six outcome
  counters are **durable**: each write commits its own counter in the same transaction,
  together with the tallies of outcomes that wrote nothing since the last durable write.
  Checkpoints (every 250 conversations without a write, or 1 s) and finalisation commit
  the rest. The committed counters therefore always describe an unbroken prefix of the
  file, and every committed write lies inside it.
- `accounted = added + updated + unchanged + older + flagged + skipped`;
  `notAccounted = seen − accounted`. For completed statuses `notAccounted` is 0.
- An interrupted or failed batch is never presented as complete. The summary reads
  **"Accounted for X of Y; Z not accounted for."** (`accountingSummary`). It does not
  claim that unaccounted conversations were unexamined, only that no outcome was
  recorded for them; none of them changed stored data.
- **Re-import is safe and idempotent:** after an interruption, importing the same file
  again finds committed conversations unchanged and completes the rest, ending in the
  same state as one clean import (tested after SIGKILL at ten boundaries).

### Warnings report (`ImportBatch.warningsJson`)

`{v: 1, complete, accountedConversations, counts, samples, truncated, samplesOmitted}`
(`report.ts`): exact per-code counts (keys sorted, never truncated); at most 500 samples
in pipeline order; a sample over 1 KiB serialised becomes `{code, oversized: true}`;
sampling stops before the report would exceed 128 KiB, with the envelope's maximum size
reserved up front. `complete` is false at checkpoints and for stopped batches. Samples
contain codes, positions, field names, source identifiers and, for persistence failures,
the sanitised database code; never content. Source identifiers may appear here because
the report is a bounded local diagnostic; they never appear in error messages or logs.

### Database errors (`src/lib/db/errors.ts`)

Every exception is mapped to one fixed code by reading only the error class, Prisma's
`code`, and the adapter's `kind` and `originalCode`; never `.message`, `.stack`,
`originalMessage` or query arguments (Prisma validation errors quote arguments, and the
adapter copies SQLite's raw message into `originalMessage`).

| Code | From | Systemic (stops the import) |
| --- | --- | --- |
| `DB_CONSTRAINT` | P2002, P2003, P2004, P2011, P2014, constraint kinds, `SQLITE_CONSTRAINT*` | no |
| `DB_BUSY` | P1008, `SocketTimeout`, `SQLITE_BUSY`, `SQLITE_LOCKED` | yes |
| `DB_TIMEOUT` | P2024, P2028 | no |
| `DB_CONFLICT` | P2034, guarded update affected no row | no |
| `DB_NOT_MIGRATED` | P2021, P2022, `TableDoesNotExist`, `ColumnNotFound` | yes |
| `DB_NOT_INITIALIZED` | `SQLITE_CANTOPEN` (the missing-file error uses it as its `code`), P1003 | yes |
| `DB_DISK_FULL` / `DB_READ_ONLY` / `DB_CORRUPT` | `SQLITE_FULL` / `SQLITE_READONLY`, `SQLITE_PERM` / `SQLITE_CORRUPT`, `SQLITE_NOTADB` | yes |
| `DB_CONFIG` | initialisation, configuration and isolation errors | yes |
| `DB_INVALID_QUERY` | `PrismaClientValidationError` | no |
| `DB_UNKNOWN` | any other Prisma error | no |
| `IMPORT_INTERNAL_ERROR` | any non-database error | no |

### Persistence limitations

- One import or delete at a time per database, across processes (`IMPORT_BUSY`).
- Locking is reliable on local filesystems only.
- better-sqlite3 is synchronous: the server can't answer other requests while a single
  statement runs. Measured maximum blocking: about 115 ms between conversations of a
  bulk import, and up to about 570 ms for a 20,000-message conversation (of which about
  375 ms is normalising it). A second server process on the same database waits
  synchronously while the importer commits. No worker threads (not approved).
- Importing about 30 MiB (2,000 conversations, 52,000 messages) takes about 23 s; an
  unchanged re-import about 1.3 s (measured on one Mac; slower disks are slower).
- C9 above; parser downgrades are flagged rather than written.
- Replaced message text (a newer copy of a conversation replacing an older one) stays
  in SQLite free pages, and after a crash in the leftover `-journal` file, until the next
  write reuses them or a storage cleanup runs. Import-time `secure_delete` is deferred
  (A79). Delete-all removes the text of *deleted* data (*Deleting imported data*). The
  search index keeps the replaced text's *terms* until it is merged, which happens right
  after an import that replaced conversations (*Search index*).
- A failed COMMIT (SQLITE_BUSY while another connection holds a read transaction for
  more than the 5 s busy timeout) leaves the SQLite transaction open on the writer
  connection (measured in M1.7). Every writer transaction (a conversation's import, the
  delete-all transaction) therefore goes through `runWriterTransaction`
  (`src/lib/db/transaction-recovery.ts`). On failure it issues `ROLLBACK`, proves that no
  transaction is open with a deferred `BEGIN` that is rolled back at once, and rethrows
  the original error: the import stops with that code (`DB_BUSY` is systemic), the
  conversation stays unaccounted and its writes are rolled back. If no clean state can be
  shown, the writer is marked unusable for the rest of the process. The import then stops
  without finalising through it (the batch stays `running` and is marked `interrupted`
  after a restart), and every later import, delete-all and cleanup refuses with
  `DB_WRITER_UNUSABLE` until ThreadAtlas is restarted. Single-statement writes (batch-row
  updates) need no recovery: SQLite rolls back an autocommit statement whose commit fails
  (regression-tested).

## Upload route (M1.5)

`POST /api/import` (`src/app/api/import/route.ts` → `src/lib/import/http.ts`), used by
the import page. Decisions A65–A70.

- **Raw body.** The page sends the file itself as the request body with `fetch` (not a
  multipart form, not a Server Action), so the size limit is enforced while reading. The
  browser sets `Content-Length` and `Origin`; scripts cannot (measured in Chromium).
- **Excluded from `src/proxy.ts`** by the matcher `/((?!api/import$).*)`. With a proxy,
  Next.js buffers request bodies and passes only the first 10 MB to the route without an
  error, keeping the original `Content-Length` (measured). Only the exact path is
  excluded; `e2e/import.spec.ts` pins the coverage of path variants.
- **Request checks, before the body is read:** loopback `Host` (the proxy's rule);
  `Origin` exactly equal to the server's own origin, port included; `Sec-Fetch-Site:
  same-origin` when sent; header `X-ThreadAtlas-Import: 1`; `Content-Type:
  application/json`. Other local origins can make simple, `no-cors`, beacon and form
  POSTs reach the route (measured), all carrying `Origin` and none able to add the custom
  header. The content type is CSRF hardening; validation stays content-based (A13).
- **Size:** `Content-Length` is required (411) and must be within `IMPORT_MAX_BYTES`
  (413, before reading). The bytes read must equal it, or the upload is
  `FILE_INCOMPLETE`; a broken upload stream is `FILE_READ_FAILED`.
- **File name:** `X-ThreadAtlas-Filename`, percent-encoded; stored sanitised (basename,
  no control characters, ≤ 255 code points), never returned or logged.

| Situation | Status | Body |
| --- | --- | --- |
| A batch was created (any status, including `failed`) | 200 | `{ok: true, batch}` |
| Host, Origin, fetch metadata or custom header rejected | 403 | `REQUEST_FORBIDDEN` |
| Other content type | 415 | `REQUEST_CONTENT_TYPE` |
| No `Content-Length` | 411 | `REQUEST_LENGTH_REQUIRED` |
| Over the size limit | 413 | `FILE_TOO_LARGE` |
| Other file errors | 400 | `FILE_*` |
| Another import or delete is running | 409 | `IMPORT_BUSY` |
| Database or lock not usable | 503 | `DB_*`, `IMPORT_LOCK_FAILED` |
| Misconfigured limit, invalid parser version, anything unexpected | 500 | `IMPORT_CONFIG_INVALID`, `IMPORT_PARSER_VERSION_INVALID`, `IMPORT_INTERNAL_ERROR` |

Error bodies are `{ok: false, code, message}` with a static message. `batch` is built
from the **stored** batch row (`summary.ts`): status, durable counters, `accounted` and
`notAccounted`, "Accounted for X of Y; Z not accounted for." for incomplete batches,
warnings grouped by code with static messages, and the report's samples. If that row
can't be read, the response is 503 `IMPORT_SUMMARY_UNAVAILABLE`; a summary is never
constructed from in-memory values. Every response
is `Cache-Control: no-store`. The handler never throws (Next.js would print an uncaught
error's message and stack) and never logs.

- **Disconnects (measured):** if the tab closes or the request is aborted after the file
  was sent, the import still finishes and is recorded. If the upload itself is cut off,
  nothing is written (`FILE_READ_FAILED`). The import page's *Last import* section shows
  the newest batch, so a result whose tab was closed is visible.
- **Memory (measured, 2026-11-05):** resident memory (RSS) of the Next.js server process
  alone, importing synthetic exports through this route on a freshly started production
  server: about +0.26 GiB for 12 MiB, +0.40 GiB for 24 MiB and +0.50–0.56 GiB for 48 MiB
  (three runs; about 0.65–0.71 GiB in total over a 0.15 GiB baseline). The upload text,
  parsed JSON and normalised rows are held during the import. The process keeps that
  memory afterwards, so repeated large imports in one server process can reach about
  0.9 GiB (measured after several 48 MiB uploads).

## Viewing conversations (M1.6)

Read-only pages on the reader connection (`src/lib/conversations/queries.ts`), covered by
the proxy's Host check. Decisions A71–A75.

- **List** (`/conversations`): newest first by `update_time`; conversations without one
  come last; ties by internal id. 50 per page (`?page=`); a missing or malformed page is
  page 1, a page past the end is the last page.
- **Detail** (`/conversations/<internal id>`): the stored visible path (A25) in
  `pathIndex` order, with role (exactly as exported; known roles labelled), author name
  and time. Structural nodes are never shown. Hidden messages (A26) are left out unless
  `?hidden=show`; the page always states how many there are. Filtering happens before
  pagination: **1,000 displayed messages per page**, with Previous/Next links and page
  indicators. Unknown or malformed ids give a 404. ChatGPT IDs are not shown.
- **Path note** from the stored strategy: none for `current_node`; for `latest_leaf` and
  `last_child` a note that the branch may not be the one last viewed; for `none`, that no
  path could be reconstructed.
- **Branch markers** (A75): a displayed message shows "n versions exist" for the nearest
  fork on the path between it and the previous displayed message. Only alternatives that
  lead to a real message count; structural or hidden nodes in between are looked through.
  Branches can't be navigated in M1.
- **Rendering:** plain text only, escaped by React: no Markdown, no HTML, no automatic
  links, no images. Code and execution output keep their exact text in a `<pre>`, with the
  language as a plain label. Malformed and unsupported messages are marked; raw payloads
  (`rawContentJson`) are never selected.
- **Queries:** the list uses the `updatedAtSec` index. A detail page reads every node's
  structure columns (ids, parent, flags, `pathIndex`; no text) for ordering and branch
  markers, then the text of only its 1,000 messages through the
  (`conversationId`, `pathIndex`) index. Measured for a 20,000-message conversation:
  about 0.1 s per page, about 1.4 MiB of HTML.

## Deleting imported data (M1.7)

Settings → *Delete all imported data* (`src/app/settings/`, service
`src/lib/data/delete-all.ts`). Decisions A76–A82. Step 0 measured the SQLite and
Next.js behaviour this relies on; the numbers are below.

### Two phases, one lock

Both phases run under the cross-process write lock (A57), taken before the transaction
and released only after verification. Imports, deletes and cleanups therefore never
overlap; a second one gets `WRITE_BUSY` ("Another import or delete is in progress") and
changes nothing. The lock file itself is handled only by `write-lock.ts` and is never
unlinked.

1. **Logical deletion.** The writer connection gets `secure_delete = ON` and
   `temp_store = MEMORY`, both read back; if SQLite doesn't confirm them, nothing is
   deleted (`WRITER_SETTINGS_UNAVAILABLE`). Then one transaction deletes every
   `Message`, `Conversation` and `ImportBatch` row (A44), then empties the search index
   with FTS5's `delete-all` command (M2.1, A89). The clear comes after the row deletes,
   because the delete triggers need the index entries. The schema and
   `_prisma_migrations` are untouched. If the transaction fails, it is rolled back and
   nothing is deleted, index included; a failed COMMIT is rolled back explicitly
   (`runWriterTransaction`, see *Persistence limitations*).
2. **Storage cleanup.** If the search index still holds anything while the three tables
   are empty (leftovers, for example from an interrupted run), it is emptied first. Then
   `VACUUM` (through `vacuumDatabase`, A90) rebuilds the database file without the deleted
   pages; with `temp_store = MEMORY` it writes no temporary copy to disk. Then the checks:
   all three tables empty, `freelist_count = 0`, `quick_check = ok`, no `-journal` or
   `-wal` file next to the database (checked by path, never opened), the search index
   empty (only FTS5's own averages and structure records remain) and passing its
   integrity check.

Finally the writer's settings are reset to the import defaults (`secure_delete = OFF`,
`temp_store = DEFAULT`, via `configureWriterConnection`, which every import also runs
first). A failed reset is reported (`writerSettingsRestored: false`) but never changes the
reported outcome.

### Outcomes

| Result | Meaning | Message starts with |
| --- | --- | --- |
| `complete` | Rows deleted; VACUUM ran and every check passed | "All imported data was deleted: … Storage cleanup finished and its checks passed." |
| `deleted_cleanup_incomplete` | Rows deleted (committed); cleanup failed or a check did not pass: `CLEANUP_DB_BUSY`, `CLEANUP_FAILED`, `CLEANUP_UNVERIFIED` | "All imported data was deleted: … Storage cleanup is incomplete or unverified (…)" |
| `not_deleted` | Nothing deleted: lock busy or unusable, settings not confirmed, or the transaction failed (a `DbErrorCode`, e.g. `DB_BUSY`) | "Nothing was deleted." |

Full success is never reported unless the checks passed. Errors become fixed codes; no
error object, message, path or content is logged or returned.

### Finish storage cleanup (recovery)

Phase 2 on its own (`finishStorageCleanup`), offered whenever all three tables are empty:
after an incomplete run, after a crash, or simply again. It takes the same lock, issues no
DELETE, re-checks under the lock that no imported row exists (otherwise
`IMPORTED_DATA_PRESENT`, nothing done), and is safe to repeat. It needs no confirmation
phrase, since it cannot delete records.

There is no stored "cleanup pending" marker (no schema change). The page shows **"Cleanup
may be incomplete"** when the database itself gives evidence of it: free pages, a
leftover journal or WAL file, or entries left in the search index. The absence of that evidence is *not* treated as proof that
an earlier cleanup succeeded, so the button stays available. After a crash between the
commit and the end of VACUUM, the database always has free pages or a stale journal
(measured), so the warning appears.

| Crash point (SIGKILL, measured) | After restart | Recovery |
| --- | --- | --- |
| Inside the delete transaction | Hot journal rolls back: all rows back, intact. The journal file can stay (not hot) until the next write | Delete again |
| After the commit, before VACUUM | Rows gone; free pages, so the warning shows; a few text fragments can remain in live pages | Finish storage cleanup |
| During VACUUM | Rolled back to the post-commit state; a stale journal may stay; VACUUM's journal holds at most those fragments | Finish storage cleanup |

The lock is released by the operating system on SIGKILL; the next run can take it at once.

### Request checks and confirmation

Both actions are Server Actions that check the request themselves (A81), first thing:
loopback `Host` (and `X-Forwarded-Host`), `Origin` exactly equal to this server's origin,
`Sec-Fetch-Site: same-origin` when sent, then a non-empty `Next-Action` header as a
supplementary check only. Delete-all then requires the form field `confirm` to be
exactly `DELETE` (case-sensitive, no trimming); the button is disabled until then, but
the server checks it again.

Measured against Next.js 16.4.4: its own check rejects a foreign, `null` or other-name
`Origin` (500), a missing `Next-Action` on a fetch-style body (400) and an unknown action
ID (409), but **runs the action** for a missing `Origin`, for `Sec-Fetch-Site:
cross-site`, and for the no-JavaScript multipart form path (which sends no
`Next-Action`, even without `Origin`). Our checks reject all three. A real cross-origin
form post or `fetch` from another page never reached the action.

### Step 0 measurements (synthetic canaries, temporary databases)

| Check | Result |
| --- | --- |
| Migrated database | `journal_mode=delete`, `auto_vacuum=0`, `secure_delete=0`, `temp_store=0`, 20 pages |
| `secure_delete` via Prisma | per connection; readable inside a transaction |
| 1.8 MB database, delete + commit | without `secure_delete`: canary still in the file; with it: 0 in the file, but the delete's journal (unlinked at commit) holds a full copy of the content |
| VACUUM after the delete | file 1.8 MB → 80 KB, 0 canaries, 3–8 ms; its journal held 103 canary copies without `secure_delete`, 0 with it |
| 17.5 MB database (20,150 messages) | `secure_delete` delete about 160 ms; one fragment left in a live page until VACUUM |
| VACUUM temporary file | default `temp_store`: a full copy in `$TMPDIR/etilqs_*`, unlinked afterwards; `temp_store=MEMORY`: none |
| Reader transaction held across an await | blocks VACUUM (and the delete's COMMIT) for the 5 s busy timeout, blocking the event loop, then `SQLITE_BUSY`; retry succeeds. The app's page reads hold no transaction |

### Limitations (best effort)

- Cleanup removes deleted text from the database's own files as SQLite sees them. It does
  **not** guarantee erasure: unlinked journal and temporary-file blocks, APFS snapshots,
  SSD wear levelling and backups (Time Machine, sync tools) can keep copies. FileVault and
  deleting the database file itself are the stronger measures.
- "Canary absent" in the tests is not a forensic check.
- VACUUM or the delete commit can block the server for up to 5 s if another program holds
  a read transaction; the result is then a retryable `DB_BUSY` or `CLEANUP_DB_BUSY`.
- The original export file is not touched.

## Search index (M2.1)

Full-text index for keyword search (M2). Decisions A85–A92, from the M2.0 spike (synthetic
2,000-conversation corpus; measurements in `docs/PROGRESS.md`, *M2.0 spike*). The search
page itself comes in a later task; nothing reads the index yet.

### Structure

The migration `20261107190000_search_index` creates two **external-content FTS5 tables**:

- `message_fts` over `Message.contentText`, and
- `conversation_fts` over `Conversation.title` (title matches are ranked separately).

They store terms and positions only and read the text from those tables by rowid, so
there is no second copy of the text. Each has four shadow tables (`_config`, `_data`,
`_docsize`, `_idx`). Tokenizer: `unicode61 remove_diacritics 2`, no stemming: case- and
accent-insensitive whole words, with prefix queries possible. Every message is indexed,
including hidden messages and branches off the visible path. The search task decides
what is shown; the M2.0 spike recommends filtering at query time to openable messages.

The same migration backfills existing rows (`rebuild`; about 0.7 s per 52,000
messages). It is additive only (`tests/search-migration.test.ts` checks every
statement) and wrapped in an explicit `BEGIN`/`COMMIT`. Prisma does not run SQLite
migrations in a transaction: measured 2026-11-08, a failure at the last statement left
all tables and triggers behind, while with the wrapper nothing was left. Prisma then
records the attempt as failed; recover by restoring the backup taken before the
migration. It is applied to the real database only with `npm run db:deploy`, after its
SQL has been reviewed (A92). It was applied to the user's database on 2026-11-08 (app
stopped, verified backup first, verification afterwards; `docs/PROGRESS.md`). That
database held no conversations at the time, so the backfill of existing rows has been
verified only on synthetic databases.

### Synchronisation

Six triggers keep the index in sync: after insert, delete, and update of the text
column, for each table. They run inside the same transaction as the row change, so the
index commits and rolls back with it. They also fire for rows removed by `ON DELETE
CASCADE`. No application code writes the index during imports. Tested with FTS5's
integrity check, document sets, and probe terms compared with a freshly built index
(`src/lib/search/fts-index.int.test.ts`):

- add;
- unchanged re-import, which writes nothing to the index;
- replacement, including title changes;
- an injected failure after the index writes;
- a failed COMMIT;
- `SIGKILL` inside a replacement transaction;
- cascade delete;
- delete-all;
- backfill of an existing database.

### Maintenance (`src/lib/search/fts-index.ts`)

- **After an import that replaced conversations** (`updated > 0`), the import service runs
  `optimize` on both indexes while it still holds the write lock (A88). This merges the
  index, drops the replaced text's terms from it, and shrinks it again: a full
  replacement roughly doubles the index until then. It takes about 0.3 s per 52,000
  messages, blocking the server that long. A failure changes nothing: the index stays
  correct, only unmerged, and the import's outcome is unaffected.
- **Delete-all** empties the index in its transaction and verifies it during cleanup (see
  *Deleting imported data*).
- **VACUUM** may renumber rowids of tables without an `INTEGER PRIMARY KEY`, and the
  index refers to rows by rowid. Not observed in M2.0 (0 of 666 rowids changed), but
  SQLite allows it. VACUUM can't run inside a transaction, so a rebuild could only follow
  it as a separate step. Other connections could read a mismatched index in between,
  and a crash there would leave it stale. So the only sanctioned VACUUM,
  `vacuumDatabase`, runs only while `Message` and `Conversation` are both empty (the
  index is then empty too), as in delete-all's cleanup. With rows present it refuses
  (`NonEmptyVacuumError`) and changes nothing. `tests/vacuum-guard.test.ts` rejects any
  other VACUUM in source code (A90, tightened 2026-11-08).
- **Offline compaction** of a database that holds conversations is not implemented. If
  it is ever needed, it must run with the app stopped: backup, VACUUM, `rebuild`, then
  the integrity check.
- `checkSearchIndex` runs FTS5's integrity check against the content tables; a stale
  index fails it, and `rebuildSearchIndex` repairs it.

### Prisma

- Prisma can't describe virtual tables, so they are not in `schema.prisma`. Its diff
  always proposes to drop the 10 tables. `npm run db:check-migrations`
  (`scripts/check-migrations.mjs`) accepts exactly those drops, each once, with Prisma's
  `foreign_keys` pragma pair, and rejects any other difference, including a missing
  search-index migration (A91).
- Prisma doesn't see triggers; `src/lib/db/schema.int.test.ts` lists them.
- Future migrations generated with Prisma will contain the same drop statements, and
  they must be removed by hand. Never run `migrate dev`.
- The SQLite driver adapter rejects numbered parameters (`?1`); raw search queries must
  use positional `?` (or the tagged `$queryRaw`).

### Storage and cost (M2.0, synthetic corpus)

- Index size about 0.5× the message text: 10.4 MB of index and 0.1 MB of titles for
  20.6 MB of text. The database file grew from 37.8 MB to 48.4 MB.
- Import time:
  - first import +23% (19.5 → 24.0 s);
  - unchanged re-import +4%;
  - replacing all 2,000 conversations +36% (21.2 → 28.8 s), accepted for M2.
- Delete-all at 52,000 messages: about 1.2 s instead of 0.4 s.

### Privacy and remanence

- The index holds the **words** of every imported message and title (sorted terms with
  positions, not sentences), hidden messages and other branches included. It stays on
  the machine like the rest of the database.
- Replaced text: its terms stay in the index until the `optimize` that follows the
  replacing import. Afterwards, freed pages can still hold them until reused or
  cleaned up, because `secure_delete` is off during imports (A79).
- Delete-all removes the index's content and verifies that only FTS5's own empty
  records remain. In the M2.0 spike, triggers alone left 642 data rows and indexed
  words in the file. The explicit clear leaves none.

### Database without this migration

Imports still work, but nothing is indexed and the `optimize` step fails harmlessly.
Delete-all deletes nothing and reports `DB_NOT_MIGRATED` ("not migrated"). Run
`npm run db:deploy`, which also indexes the existing conversations.

### Known limitations

Words in Chinese or Japanese text without spaces can't be matched individually. ß is not
matched by ss, Greek is matched only with its accents, and emoji aren't indexed. There
is no stemming: "run" doesn't find "running".

## Search queries (M2.2)

The server-side query layer over the search index: `src/lib/search/query.ts` (parsing),
`search.ts` (`searchConversations`), `snippet.ts` (segments) and `link.ts` (links to the
detail page). Decisions A93–A100. There is no search page yet (M2.3).

### Query syntax (`parseSearchQuery`, A93)

- Ordinary words, separated by whitespace, and `"quoted phrases"`. Every term must match
  (implicit AND), either in the title or within one message, never split across the two.
- A trailing `*` on the **last** unquoted word means "starts with", with at least two
  letters or digits before it. Elsewhere `*` is an ordinary character.
- No FTS5 operator is exposed. Each term is sent as one FTS5 string, `"..."` with any
  `"` doubled, so `AND`, `OR`, `NOT`, `NEAR(...)`, `column:`, `^`, `+`, `-` and
  parentheses are searched as words: `foo OR bar` requires all three words.
- The tokenizer splits terms at punctuation: `C++` searches the word `c`, `.NET` the
  word `net`, `alice@example.com` the phrase `alice example com` (adjacent words, in
  order).
- An unbalanced quote is ignored and its words are searched as plain words.
- The input is NFKC-normalised (full-width letters, ligatures, composed accents), and
  control characters separate terms. Terms without any letter or digit (punctuation or
  emoji alone) are dropped: the tokenizer would ignore them.

### Limits and validation (A94)

Nothing meaningful is truncated. Instead, `searchConversations` returns
`{ status: "invalid", rejection }` with one of these reasons:

| Reason | When |
| --- | --- |
| `empty` | Blank input (or not a string) |
| `no_terms` | No word with a letter or digit |
| `too_long` | More than 256 code points, after trimming surrounding whitespace (`limit`, `length`) |
| `too_many_terms` | More than 16 terms; a phrase is one term (`limit`, `terms`) |
| `prefix_too_short` | Fewer than 2 letters or digits before the trailing `*` (`minimum`) |

### What is searched (A96)

Titles, and the messages the detail page shows by default: on the stored path, not
structural, not hidden. The index also holds hidden messages and messages on
alternative branches. Matches found only there are neither returned nor counted.
`matchingMessages` counts visible matching messages only.

### Ranking (A95)

FTS5's `bm25()`: lower (more negative) is better. A conversation's score is the lower of
its best visible-message score and its title score × 2. Doubling a negative score ranks
the title higher. Ties (for example identical text) are ordered by update time, newest
first with missing times last, then by internal id descending, the same as the
conversation list. Title and message scores come from separate indexes with their own
statistics, so the weight is a pragmatic choice, not a calibrated one.

### Pagination (A99)

20 conversations per page. Page numbers follow the conversation list's rules
(`parsePage`): invalid → 1, past the end → last page. Each search ranks all matching
conversations (ids and scores only, about 2,000 rows at most in the measurements
below), then loads titles, snippets and links for the requested page only.

### Snippets and titles (A97)

- **Source:** FTS5's `snippet()` around the conversation's best visible message, up to
  16 words, and `highlight()` for a matching title.
- **Markers:** private-use characters plus a 128-bit random value created per search.
  Imported text can't contain them, even text with private-use characters.
- **Output:** marked text becomes `{ text, match }` segments. The UI renders them as
  text and `<mark>`, never as HTML. If the markers aren't well formed (unmatched,
  nested or empty), the snippet falls back to one plain segment with the markers
  removed.
- **Caps:** context before the first match keeps its last 120 characters, context
  after the last match its first 120, context between matches both ends, and a match
  its first 80. Each cut is shown as "…". Cuts never split a character. This bounds a
  snippet even when one "word" of imported text is very long.
- **Titles:** returned as stored (`title`) and as capped segments (`titleSegments`),
  marked when the title matched. A title-only match has no snippet.

### Links (A98)

The best visible message is chosen by score, then path position. Its number is its
1-based position among the messages `getConversationDetail` displays with default
settings, counted with the `(conversationId, pathIndex)` index. The link is
`/conversations/<id>?page=<n>#m-<number>`: `page` = number ÷ 1,000 rounded up, omitted
on page 1, and never `hidden=show`, exactly like the detail page's own links. A
title-only match links to the top of the conversation. The tests open every link
through `getConversationDetail` and check the message, including hidden messages before
it, alternative branches, and page 2 of a 2,100-message conversation.

### Execution, errors and privacy (A100)

- **Statements:** on the reader connection, one statement at a time, without a
  transaction (like every page read).
  1. One ranked statement: one pass over each index for scores, match counts and best
     messages.
  2. The page's conversations through Prisma.
  3. Link numbers from the `Message` table only.
  4. Snippets and title highlights for at most 20 rows.
- **Prefix snippets:** for prefix queries the snippet statement hides its rowid list
  from FTS5 (`rowid + 0`). FTS5's rowid seek re-merges a broad prefix's word lists per
  row: measured 815 ms for 9 rows, against 215 ms to scan all 50,000 matches.
- **Concurrent changes:** an import can commit between the statements. The result then
  degrades rather than failing:
  - a deleted conversation is left off the page, which can then show fewer than 20
    results;
  - a conversation whose matching messages vanished is left off, or shown as a title
    match if its title matched;
  - a message replaced in between can lose its snippet, and its link then points to
    the message now at that position.
- **Errors:** outcomes are typed. Database errors go through `sanitizeDbError`, and a
  database without the search-index migration returns `DB_NOT_MIGRATED`.
- **Privacy:** the query text is only ever a bound parameter. The SQL text interpolates
  constants and placeholder lists only, and a test checks this. Nothing is logged, and
  `rawContentJson` is never selected (raw payloads are not indexed either).

### Performance (opt-in test, synthetic corpus)

`THREADATLAS_PERF=1 npx vitest run --project int src/lib/search/search-perf.int.test.ts`.
The corpus is 2,000 conversations × 25 messages (50,000 messages of about 400
characters). The figures are median and worst of 15 runs, end to end, on one machine.
A search's statements are synchronous, so this is also how long it blocks the event
loop.

| Query | Matching conversations | Median | Worst |
| --- | --- | --- | --- |
| Rare word | 5 | 1.5 ms | 2.5 ms |
| Title word | 20 | 1.2 ms | 11 ms |
| Word in one message of every conversation (page 1 / last page) | 2,000 | 16 / 18 ms | 34 / 21 ms |
| Word in 48,000 of the 50,000 messages | 2,000 | 159 ms | 171 ms |
| Two such words | 2,000 | 109 ms | 120 ms |
| Prefix covering 100 words | 2,000 | 17 ms | 32 ms |
| Prefix covering 1,111 words and nearly every message | 2,000 | 428 ms | 505 ms |
| No match | 0 | 0.7 ms | 1.1 ms |

The broad prefix took 2,136 ms (median) before the restructuring described above. A
prefix index (FTS5 `prefix=` option) would make it fast, but it needs a migration and is
not part of M2.2.

### Known limitations

- **Broad prefixes are slow:** a two-letter prefix matching most words (as `th*` would
  in English text) can block the server for about half a second on 50,000 messages,
  growing with the data.
- **Punctuation is ignored:** `C++` also finds messages that mention C# or the letter c.
- **Links can go stale:** a link reflects the stored path at search time and can point
  to a different message after a re-import.
- **Tokenizer limits:** the index's limitations above apply.

## Search page (M2.3)

`/search`: `src/app/search/page.tsx` (server), `search-form.tsx` (client) and `actions.ts`
(the Server Action), on top of the M2.2 query layer, which is unchanged. Decisions
A101–A106.

### Submitting a search (A101)

- **Mechanism:** the form calls `searchAction(query, page)`, a Server Action, with two
  plain values. It is never called through `useActionState`, so no previous results are
  ever sent back to the server.
- **Guard:** the action checks the request first, as the Settings actions do (loopback
  Host, exact Origin, `Sec-Fetch-Site`, then `Next-Action`), and treats its arguments as
  untrusted. A non-string query is empty; the page must be a whole number from 1 to
  1,000,000,000 (`pageArgument`), otherwise page 1.
- **Response:** the result is mapped to what the page shows (`src/lib/search/view.ts`).
  That is title and snippet segments, the link, counts and the update date; scores and
  raw titles are dropped. Errors become fixed codes. Nothing is logged, revalidated or
  cached.
- **Measured (Next.js 16.4.4):** Server Action calls are queued on the client, so a
  second search is sent only after the first response arrives.

### Privacy guarantee (A106)

Search terms are not intentionally persisted, logged or placed in URLs:

- They travel in the POST body to `/search`; the page URL never changes.
- The browser is asked not to keep form history (`autocomplete="off"`).
- The last query and page are kept in a module variable of the client code. That is
  memory only, per tab, until a reload; nothing is written to cookies or browser storage.
- Server logging: `logging.serverFunctions: false` in `next.config.ts`. Without it, the
  dev server prints every Server Function call with its arguments, and the dev-mode test
  measured the search term in its output. With it, the output keeps the request lines
  (`POST /search`) but no terms, titles or snippets. Production (`next start`) prints
  neither.
- Cache headers, measured on the production build: the page sends `private, no-cache,
  no-store, max-age=0, must-revalidate`, and the action response `no-cache, no-store,
  max-age=0, must-revalidate`.

The terms are not hidden from the browser's developer tools or from anything that can
read the request body sent to the local server.

### State and navigation (A103)

- **Back from a conversation:** a result is opened with client-side navigation, so the
  module memory survives. On return the form shows the query and runs the search again
  for the same page. Results are never replayed from memory, so deleted or re-imported
  content does not reappear. Focus is not moved on this restore.
- **Reload:** a reload (or a new tab) starts empty.
- **No JavaScript:** search needs JavaScript; a `<noscript>` note says so. The form
  never submits natively: its submit button stays disabled until hydration, and its
  method is POST, so even a native submission could not put the query in a URL.
- **No data:** with no imported conversations, the page shows an empty state linking to
  Import instead of the form.

### Feedback and accessibility (A104)

- **Validation:** the client checks a query with the same pure parser before sending
  anything (the server stays authoritative). The rejection message is linked to the
  input (`aria-describedby`, `aria-invalid`, `role="alert"`). There is no `maxLength`,
  so nothing typed or pasted is cut.
- **Loading:** the button reads "Searching…" and is disabled, the results region is
  `aria-busy`, and the status region says "Searching…".
- **Overlap:** only the latest search may update the page (`createLatestGate`); a
  superseded response is dropped whatever order it arrives in.
- **Errors:** a fixed alert (database not migrated, busy, refused, unexpected), and the
  previous results are cleared.
- **Results:** a landmark region labelled by its heading, which carries the count and
  receives focus after a search or page change. Results are an ordered list; each title
  is a link to the matching message, followed by the update date, "Title match" and/or
  "N matching messages", the best match's position ("Best match: message 1,351", the
  number shown on the conversation page), and the snippet. Matches are `<mark>` around React text
  (`HighlightedText`), never HTML.
- **Live region:** announces counts and positions only, for example "25 conversations
  match. Page 2 of 2, results 21–25." It never reads out titles or snippets.
- **Pagination:** "Previous results" and "Next results" buttons with "Page N of M".
  The query and page stay out of the URL.

### Changed or deleted conversations (A105)

- **Deleted:** a deleted (or unknown) conversation shows `conversations/[id]/not-found.tsx`
  ("Conversation not found"), with links to Search and to the list.
- **Linked message (A107):** message headings have a scroll margin, and the linked
  message is outlined. CSS `:target` covers links loaded directly (a new tab, a
  reload). Next.js navigates with `history.pushState`, which browsers do not treat as a
  fragment navigation, so `LinkedMessageMarker` (a client component on the
  conversation page) also sets `data-linked` on the message named by the `#m-<n>`
  anchor. It checks after each render of the page, on `hashchange` and `popstate`
  (Back and Forward), and when the page content changes. The last is needed because
  Next.js can render a page's content after the URL changes, measured on Back within
  one conversation. Only the exact `#m-<positive integer>` form is accepted
  (`linkedMessageId`), and nothing is stored or sent.
- **Re-imports:** a re-import can change which message a link's number points to;
  searching again gives fresh links.

## Known limitations

- **Content hash v1 is frozen** (A34): a change only to a conversation-level field the
  hash excludes (anything except title, times and `current_node`) is not detected as an
  update. A future schema change may require hash v2.
- Duplicates on re-import of edited ID-less conversations (A20c).
- The import report is the only place a skipped or flagged conversation appears.
- Unknown node-level fields change the content hash, so a new export format makes
  unchanged conversations count as updated once.
- Sub-millisecond timestamp precision is kept by the parser and the database (`Float`
  epoch seconds, A36).
- Persistence limitations are listed at the end of *Persistence*; upload behaviour in
  *Upload route*.
- Branch navigation is not available in M1. Off-path branches are stored but not shown;
  branch points are marked (*Viewing conversations*).
- Conversations nested deeper than 512 JSON levels are skipped (`CONVERSATION_TOO_DEEP`).
- A duplicate-ID report lists at most 10 positions per group. The full list of affected
  conversations is in `skipped` and `flagged`.
