# M5.0 Experiment 2: runtime, chunking, storage and indexing lifecycle (2026-11-10)

Status: **done, awaiting review.** Research only. Everything ran in scratch directories
outside the repository, on synthetic data, offline, with temporary databases. There are
no production dependencies, migrations, schema changes or application code changes, and
the real database, backup and manifest were not read or modified (size, mtime and inode
unchanged). Scripts are in `experiment-2/bench/` and `experiment-2/proto/`, results in
`experiment-2/results/` (uncommitted, for review). The new synthetic long-conversation
set is in `eval/long.mjs` and `eval/long.json`.

**Recommendations:**

| Question | Recommendation |
| --- | --- |
| Runtime | `onnxruntime-node@1.23.2` called directly with `@huggingface/tokenizers@0.2.0`, inference in a **worker thread** |
| Chunking | **Sentence-packed chunks of up to 64 tokens**, one sentence of overlap, exact character offsets into the message |
| Vector storage | An **ordinary SQLite table** in the same database, vectors as int8 BLOBs (float32 optional), brute-force search over an in-memory cache. No `sqlite-vec` |
| Fusion | Gated: semantic results first, keyword results fused in only when the exact-word query matches |
| Indexing | Resumable job queue with per-conversation generations and a global epoch, compare-and-set commits, cooperative cancellation, drain before shutdown |

## 1. Runtime: Transformers.js versus direct ONNX Runtime

**Packages installed in separate scratch folders (approved 2026-11-10):**
- **Direct runtime:** `@huggingface/tokenizers@0.2.0` with `onnxruntime-node@1.23.2`: 25
  packages, 250 MB. All permissive: MIT 18, BSD-3-Clause 3, ISC 2, Apache-2.0 1,
  MIT-or-CC0 1. No LGPL.
- **`sqlite-vec@0.1.9` with `sqlite-vec-darwin-x64@0.1.9`:** 2 packages, 160 KB; one
  native x86_64 `vec0.dylib`, SHA-256 `d39d33d1…346996d`.
- **Network:** only the npm registry, sampled. Install scripts were disabled.

**Numerical equivalence (267 texts):**
- **The texts:** every v0 message as a passage, every v0 query, 6 texts over 512 tokens,
  and 7 edge cases (empty, whitespace, emoji, mixed scripts, markup, a 3,000-character
  run, tabs and blank lines).
- **Token IDs:** identical for all 267, with `<s>` and `</s>`, the `query: ` and
  `passage: ` prefixes, truncation at 512, padding with the pad ID and its attention
  mask, and `token_type_ids` of zero.
- **Vectors:** at the same batch size, Transformers.js and the direct embedder differ by
  at most 1.3e-7 per component. The minimum cosine is 0.9999995 at batch 16 and at
  batch 1, so the direct embedder's mean pooling and normalisation reproduce the
  pipeline's.
- **Truncation:** Transformers.js 3.8.1 cuts long inputs at 512 tokens and drops the
  closing `</s>`, while the Python tokenizers library keeps it. For texts over 512
  tokens the two give cosine ≥ 0.975. The direct embedder supports both; M5.1 should use
  the reference behaviour (keep `</s>`). With 64-token chunks nothing is truncated
  anyway.
- **Batch effect:** in *both* runtimes, the same text embedded in a batch of 16 differs
  from it embedded alone, with median cosine 0.997.
  - The difference doesn't depend on padding.
  - It fits the int8 model's dynamic quantisation, which computes one scale per tensor
    across the whole batch.
  - On rankings the effect was small (overall nDCG within ±0.03).
  - M5.1 batches each conversation's own chunks, sorted by length. Then a conversation's
    vectors depend only on its own text, and incremental re-indexing equals a full
    rebuild.

**Performance (1,000 chunks of 260 tokens, fresh process each):**

| | Chunks/s | Tokens/s | Import + load | Memory after load | Peak |
| --- | --- | --- | --- | --- | --- |
| Transformers.js, batch 16 (Experiment 1) | 9.9 | 2,568 | 132 + 1,319 ms | 817 MB | 1,683 MB |
| **Direct, batch 16** | **12.3** | **3,188** | **22 + 1,039 ms** | **633 MB** | 1,544 MB |
| Transformers.js, batch 1 | 7.8 | 2,030 | 136 + 1,307 ms | 811 MB | 1,500 MB |
| Direct, batch 1 | 9.6 | 2,497 | 25 + 1,068 ms | 612 MB | 1,289 MB |

**Batching on real, mixed-length text** (long corpus, direct runtime):

| Units | Batch 1 | Batch 16 | **Batch 16, sorted by length** | Peak (sorted) |
| --- | --- | --- | --- | --- |
| Whole messages (252) | 42.4/s | 16.8/s | 40.5/s | 1,166 MB |
| 256-token chunks (279) | 37.3/s | 21.3/s | **47.1/s** | 778 MB |
| 64-token chunks (531) | 52.9/s | 61.0/s | **75.4/s (3,063 tokens/s)** | 715 MB |

Unsorted batches waste most of their time on padding.

**Indexing estimate:** a 50,000-message archive averaging 150 tokens per message would
take about 40 minutes with 64-token chunks on this Mac.

**Licences and size:**

| | Transformers.js 3.8.1 | Direct |
| --- | --- | --- |
| Packages | 49 | 25 |
| Size | 413 MB | 250 MB |
| LGPL | libvips (loaded, unused) | none |

Of the 250 MB, 247 MB is ONNX Runtime, which ships every platform's binary. A production
install could prune the others, but that would be a packaging decision for M7.

**The shutdown crash** (5 runs per case, sandboxed; `results/exit-matrix.txt`):

| Where the model runs | How the process ends | Result |
| --- | --- | --- |
| Main thread | Normal exit, or `process.exitCode = 1` | Clean, 10/10 |
| Main thread | Uncaught exception, unhandled rejection, `process.exit()` during inference, exception after `session.release()` | **Abort (134, `mutex lock failed`), 20/20** |
| Main thread, Transformers.js | Exception, also after `dispose()` | **Abort, 10/10.** Not specific to the direct code |
| Worker thread | Normal; exception in the main thread (with or without terminating the worker, or after a clean worker shutdown) | Clean, 20/20 |
| Worker thread | `process.exit()` or `worker.terminate()` **while an inference is in flight** | **Abort (134, uncaught `Napi::Error`), 10/10** |

ONNX Runtime 1.23.2 can't be torn down while it is busy, or on the main thread's abnormal
exit path. The native completion callback fires after its JavaScript environment is gone.

**Rules for M5.1:**
1. Load the model only in a worker thread.
2. Cancel cooperatively between batches, never by terminating the worker.
3. On shutdown (SIGINT/SIGTERM), stop claiming jobs, wait for the in-flight batch,
   release the session, then terminate the worker.

**If an abort still happens** (for example the user force-quits the server
mid-inference), no data is lost: chunks are written only in the commit transaction. It
does show a crash message.

## 2. Long conversations and chunking

**New synthetic set (`eval/long.mjs`):** 9 long conversations (3 each in en, no, ru) and 20
queries.
- **Conversations:** each has a long assistant answer of 569–860 tokens, with an idea
  buried deep in it, and a second topic later in the conversation.
- **Idea depth:** 11 of 13 buried ideas start beyond the 512-token truncation limit; the
  other two straddle it.
- **Query categories:**
  - deep: a buried idea, same language, 9;
  - deepx: a buried idea, other language, 4;
  - topic2: the second topic, 5;
  - head: early in a long answer, as a control, 2.
- **Evaluation:** the long queries were run on the combined corpus, the 51 v0
  conversations plus 9 long ones. The 38 v0 queries stayed a fixed baseline on their own
  corpus. Each long query names an evidence phrase, used to check whether the retrieved
  chunk actually contains the idea.

**Relevance judgements:**
- **Pooling:** the top 5 from every method were pooled, giving 180 (query, conversation)
  pairs without a label.
- **Judging:** each pair was judged from its best passage, without knowing which method
  retrieved it.
- **Result:** none was relevant (`results/pool-judgements.json`), so the scores are not
  inflated by missing labels.
- **Caveat:** the same author wrote the texts, the queries and the judgements. Truly
  independent judgements still need a second person (decision 7).

**Results, nDCG@10, semantic only** (direct runtime, batch 16):

| Representation | Fixed v0 (38) | Long: all (20) | deep | deepx | topic2 | head | Chunks (long corpus) | Evidence in best chunk* |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Whole message (truncated) | 0.81 | 0.65 | 0.72 | 0.00 | 0.93 | 0.95 | 252 | 0.25 |
| User + assistant turn | 0.81 | 0.64 | 0.71 | 0.00 | 0.93 | 0.91 | 126 | 0.30 |
| 256-token windows | 0.80 | 0.79 | 1.00 | 0.10 | 0.90 | 0.91 | 279 | 0.65 |
| 64-token windows | 0.80 | 0.83 | 1.00 | 0.33 | 0.88 | 0.91 | 455 | 0.70 |
| 256-token sentence chunks | 0.81 | 0.73 | 0.90 | 0.00 | 0.90 | 0.95 | 279 | 0.60 |
| **64-token sentence chunks** | **0.83** | **0.83** | **1.00** | **0.37** | 0.88 | 0.91 | 531 | **0.80** |
| 64-token sentence chunks + title | 0.83 | 0.83 | 1.00 | 0.19 | 1.00 | 0.95 | 531 | 0.70 |

\* Share of long queries whose target is in the top 10 *and* whose best chunk contains
the evidence phrase. For deep and deepx queries: 0.92 with 64-token sentence chunks,
against 0.08 for whole messages.

**Other measures:**
- **Recall@10 and MRR@10 on the long set:** whole message 0.80 and 0.61; 64-token
  sentence chunks 0.93 and 0.81.
- **Linked message is the target:** 0.55 and 0.80.
- **By query language, 64-token sentence chunks, long set:** en 0.84, no 0.87, ru 0.80.
- **v0 queries on the combined corpus,** with more distractors: 0.78–0.80. Unfinished
  projects drop to 0.40–0.47.

**Why 64-token sentence chunks:**
- **Best or tied-best everywhere:** on both sets and on deep ideas.
- **The best explanations:** the passage shown for a hit averages 53 tokens and contains
  the idea in 92% of deep cases.
- **Exact substrings:** they are exact substrings of the message, with offsets, so the
  page can open the right message and highlight the passage. Token windows are
  re-decoded text with no reliable offsets.
- **Fastest to index:** 75 chunks/s, sorted.
- **Cost:** about 2.1 chunks per message here, against 1.1 for 256-token chunks.

**Notes on the other options:**
- **Title prefix:** it helps second-topic queries (1.00) but hurts cross-language ones
  (0.19), so it isn't recommended on this evidence.
- **Whole messages and turns:** they win only on second-topic queries, which are short
  messages anyway.

**What still fails: buried ideas asked in another language** (deepx 0.37).
- With 64-token chunks, the right passage is the best chunk of its conversation in all 4
  cases.
- But same-language conversations outrank it (target at rank 2, 3, 7 and 13).
- This is the clearest limit of the small model, and the one result that could justify
  testing a larger model later.

**int8 vectors** (stored as int8 with one scale per vector): 64-token chunks 0.83 →
0.83; 256-token chunks 0.73 → 0.75. No measurable loss.

**Hybrid fusion, not tuned:**
- **The gated rule:** decided before seeing results — use reciprocal rank fusion with the
  exact-word (AND) results only when that query returns anything; otherwise semantic
  only. Plain fusion with the any-word list was kept for comparison.

| nDCG@10 | Fixed v0, 64-token chunks | Long, 64-token chunks | Long, whole message |
| --- | --- | --- | --- |
| Semantic only | 0.83 | 0.83 | 0.65 |
| **Gated** | **0.83** | **0.83** | **0.71** |
| Plain fusion with any-word keyword | 0.68 | 0.76 | 0.67 |
| Exact-word keyword alone | 0.13 | 0.25 | 0.25 |
| Any-word keyword alone | 0.48 | 0.59 | 0.59 |

- **Gating never fell below semantic search** in any run, and helped when chunks are
  large.
- **Plain fusion keeps hurting cross-language queries,** as in Experiment 1.

## 3. Storage

Random 384-dimension unit vectors, temporary databases, 30 queries per size
(`results/storage.json`). "Cache" means vectors loaded once into one typed array and
searched in JavaScript.

| 50,000 vectors | Plain float32 | Plain int8 | `sqlite-vec` vec0 |
| --- | --- | --- | --- |
| Insert (one transaction) | 0.62 s | 0.71 s | 1.09 s |
| Bytes per vector on disk | 2,068† | 470 | 1,595 |
| Search, reading BLOBs per query | 220 ms | 368 ms | — |
| Cache load / size | 301 ms / 73 MB | 143 ms / 18.5 MB | — (in SQLite) |
| **Search, p50 / p95** | 37 / 79 ms (cache) | **36 / 82 ms (cache)** | 55 / 58 ms (KNN) |
| `vec_distance_cosine` over plain BLOBs | 90 / 114 ms | — | — |
| Delete one conversation (50 vectors) | 1.7 ms | 1.6 ms | 2.7 ms |
| Delete all | 0.8 s | 0.2 s | 1.5 s |

At 100,000 vectors:
- **Plain table, cache:** 77 / 153 ms (float32) and 73 / 167 ms (int8).
- **`sqlite-vec`:** 117 / 175 ms.
- **Cache size:** 146 MB (float32) or 37 MB (int8).

† Includes a model name and content hash stored on every row. M5.1 stores those once per
conversation, which brings float32 to about 1.6 KB per vector.

**Compatibility:**
- **Loading `sqlite-vec` through Prisma isn't possible.** The Prisma adapter creates its
  connection privately, and SQL-level `load_extension()` is refused ("not authorized").
- **Using it would need a second, direct `better-sqlite3` connection** with
  `loadExtension()`. The app already opens one, for the write lock.
- **Its `vec0` table adds four shadow tables** (`*_info`, `*_chunks`, `*_rowids`,
  `*_vector_chunks00`), which the strict drift check (`db:check-migrations`) would need
  to allow.
- **The extension is pre-1.0.**
- **A plain table is an ordinary Prisma migration,** like the search index.

**Deleted data:** after a plain `DELETE`, the deleted vectors' bytes stay in free pages,
in both storage options. After `secure_delete = ON` plus `VACUUM`, the canary vector was
gone from the file in every case. The existing delete-all already does both.
Re-importing one conversation leaves its old vectors in free pages until the next
cleanup, the same documented limitation as for replaced message text. (The int8 canary
check can't detect residue, because the float pattern isn't stored as such.)

**Verdict:** `sqlite-vec` brings no speed advantage at personal-archive scale and adds
compatibility and maintenance cost. A plain table with an in-memory cache is enough up to
about 100,000 chunks, at p95 ≈ 150–170 ms for vector search. Above that, revisit; an int8
cache keeps memory small.

## 4. Indexing architecture (prototype, `experiment-2/proto/`)

A scratch prototype on temporary databases: the inference worker thread does chunking
and embedding, and the main thread does short transactions.

**Invariants:**
- **I1:** each conversation has a generation, bumped by every replacing import.
- **I2:** a replacing import deletes the conversation's chunks and queues a job, in the
  same transaction.
- **I3:** delete-all clears everything and bumps a global epoch.
- **I4:** a job's chunks are committed in one transaction, only if the generation and
  epoch are unchanged (compare-and-set).
- **I5:** running jobs are reset at start-up.
- **I6:** search joins chunks to conversations on generation.

**Scenario results** (`results/proto-scenarios.json`, 60 conversations, 64-token
chunks):

| Scenario | Result |
| --- | --- |
| Full index with progress | 531 chunks in 7.4 s; 60 progress events (total, indexed, remaining, chunks); consistency check passed |
| Main-server responsiveness | Event-loop delay with the worker: p50 11 ms, p99 19 ms, max 32 ms. Same work inline on the main thread (15 conversations): p99 **290 ms**. With 256-token chunks: 17 ms against 655 ms |
| Cancellation | Stopped after 10 conversations: 97 chunks, 50 pending, no running job, no partial conversation. Resume finished at exactly 531 chunks |
| Re-import during inference | The worker was embedding the old version when a new import arrived. Its commit was rejected (1 discarded); only generation 2 remains, and the result shows the new text, not the old |
| Delete-all during inference | The in-flight result was discarded: 0 conversations, 0 chunks, 0 jobs |
| Hard kill (SIGKILL) | After 12 commits. Recovered to exactly 531 chunks, no duplicates, `integrity_check` ok. One run killed mid-job (1 running job reset), one between jobs (none) |
| Stale window | Between a re-import and its re-index, the conversation has no chunks, so no outdated passage can appear |
| Search | "felles kalender for å reservere hyttehelger" returns L04 first, with the calendar sentence as its passage |

**How stale embeddings are prevented from appearing:**
1. **Removed at once:** a re-import deletes the old chunks in the same transaction that
   replaces the messages, so old vectors are never searchable next to new text.
2. **A late result is rejected:** a result computed from old text is refused at commit,
   because the generation changed.
3. **Delete-all wins:** delete-all changes the epoch, so no in-flight result can
   resurrect deleted data.
4. **A second guard at query time:** search joins on the generation, so even a bug in
   step 1 couldn't surface a stale chunk.
5. **Configuration changes:** every chunk records the model and chunker version (in the
   prototype). Changing either queues a full rebuild, and search uses only chunks
   matching the current configuration (design; the filter isn't in the prototype).
6. **The cache:** the in-memory vector cache is invalidated by a counter that every
   commit, import and delete-all increments (design; the prototype reads vectors from
   the database on each search).

Until a conversation is re-indexed it is still found by keyword search, and the page
should say that semantic indexing is in progress.

## 5. Privacy and network

- **Every model run, offline three ways:** each ran inside a `sandbox-exec` profile with
  outbound network denied, with the in-process tripwire (0 attempts in every run), and
  under `lsof` sampling (no non-loopback connection). That covers equivalence,
  throughput, quality, storage, the prototype scenarios and the exit matrix.
- **Network use:** only the two approved package installs.
- **Keyword baselines:** produced with the real import and search code through a
  temporary integration test on temporary databases, removed afterwards.
- **No real data:** no real conversation was read. The real database, backup and
  manifest are unchanged.
- **No text in error paths:** the prototype's worker returns error codes only, never
  message text.

## 6. Limitations

- **Small synthetic sets:** 20 long queries and 38 fixed queries. One query moves a
  category score by 0.1–0.25.
- **Judgements are not independent:** pooled, but by the same author.
- **Storage timings use random vectors.** Real searches also group results by
  conversation (measured: ≤ 13 ms p95 at 531 chunks).
- **Throughput was measured with default ONNX Runtime threads.** No thread sweep.
- **The prototype is single-process, scratch code.** The Next.js integration (where the
  worker lives, signal handling in `next start` and `next dev`) is untested.
- **Next.js shutdown:** abort-on-exit during inference remains possible if the server is
  killed mid-batch; the draining rule only covers graceful shutdown.
- **The small model's cross-language weakness** for buried ideas remains.

## 7. Decisions for review

See `m5.1-proposal.md` for the bounded implementation proposal, and the updated draft
`docs/adr/0002-local-semantic-retrieval.md`.
