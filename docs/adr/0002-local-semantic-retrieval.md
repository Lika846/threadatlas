# ADR 0002: Local semantic retrieval (DRAFT)

- **Status:** **Draft; architectural direction accepted 2026-11-10 (D122)** (updated
  after M5.0 Experiments 1 and 2; first drafted 2026-11-09). The owner accepted
  decisions 1–6 and 8 as the direction for M5.1, with int8 quantisation and manual
  indexing. **Decision 7 (the fusion rule) was approved on 2026-11-12** with the M5.2 plan
  (`docs/m5.2-plan.md`). M5.1a, M5.1b-1 and M5.1b-2 are committed; M5.2 (search by
  meaning) is committed (2026-11-13). In the app, gated fusion gives nDCG@10
  0.826 (v0) and 0.828 (long), against 0.817 and 0.828 for meaning only.
- **Deciders:** project owner; drafted with Claude Code
- **Related:** ADR 0001 (stack and privacy), `CLAUDE.md`, `PROJECT_PLAN.md` (Milestone 5),
  `docs/IMPLEMENTATION_PLAN.md` (A62, A108–A109), `docs/spikes/m5.0/README.md`,
  `experiment-1.md`, `experiment-2.md`, `m5.1-proposal.md`

## Context

ThreadAtlas has keyword search (SQLite FTS5, M2). The roadmap runs M5 (semantic
retrieval) before M3 (topic grouping) and M4 (map), so that similarity can feed
grouping, related conversations and idea rediscovery.

**Constraints:**
- **ADR 0001 / `CLAUDE.md`:** no Python, cloud services, paid APIs or vector
  infrastructure without an approved decision; imported data never leaves the machine
  without explicit approval.
- **A62:** derived data refers to messages by (`conversationId`, `sourceNodeId`) and is
  rebuilt when a conversation is replaced.
- **Hardware:** the development machine is an Intel Mac (x64, AVX2, no AVX-512, 32 GB).
  `onnxruntime-node` publishes macOS Intel builds only up to 1.23.2; Transformers.js 4.x
  requires a newer one.

**Evidence on synthetic en/no/ru sets** (38 fixed queries; 20 long-conversation queries):

| | nDCG@10 |
| --- | --- |
| Keyword, any word | 0.48 (fixed), 0.59 (long) |
| Keyword, exact words (the app today) | 0.13 / 0.25 |
| Semantic, multilingual-e5-small, 64-token sentence chunks | **0.83 / 0.83** |
| Cross-language, fixed set | keyword 0.08 → semantic ≈ 0.6 |

Query latency is about 7 ms at the median on these sets. Vector search at 100,000 chunks
measured about 75 ms p50 and 150–170 ms p95 (random vectors). Indexing runs at about 3,000 tokens/s, and peak
memory is about 0.7 GB in the indexing worker. Every model run was shown to be offline.

## Decision (proposed)

1. **Model:** `multilingual-e5-small` (MIT), int8 ONNX from `Xenova/multilingual-e5-small`
   at revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. Four files (135.4 MB), with
   sizes and SHA-256 values pinned in a checked-in manifest. Prefixes `query: ` and
   `passage: `, mean pooling, L2 normalisation, 384 dimensions.
2. **Runtime:** `onnxruntime-node@1.23.2` called directly with
   `@huggingface/tokenizers@0.2.0`. Not Transformers.js:
   - its vectors are identical to Transformers.js 3.8.1 (max difference 1.3e-7);
   - it is 24% faster and about 180 MB lighter;
   - it has no LGPL image library (Transformers.js loads `sharp`/`libvips`
     unconditionally);
   - it is 250 MB instead of 413 MB.
3. **Isolation:** the model runs only in a worker thread.
   - **Main-thread inference blocks the server:** event-loop p99 290 ms, against 19 ms
     with the worker.
   - **It also aborts on abnormal exit:** ONNX Runtime 1.23.2 aborts the process on an
     uncaught exception or on `process.exit()` while loaded on the main thread.
   - **Hence:** cancellation is cooperative between batches, and shutdown drains the
     in-flight batch before releasing the session and terminating the worker.
4. **Representation:** sentence-packed chunks of up to 64 tokens from visible messages,
   with one sentence of overlap.
   - **Provenance:** each chunk stores (`conversationId`, `sourceNodeId`, `chunkIndex`)
     and exact character offsets, so a hit opens the right message and highlights the
     passage.
   - **Truncation:** reference behaviour, keeping `</s>`.
   - **Batching:** per conversation, sorted by length, so a conversation's vectors don't
     depend on other conversations and incremental re-indexing equals a full rebuild.
5. **Storage:** an ordinary table in the existing SQLite database, created by a normal
   reviewed migration.
   - **Format:** int8 vectors with one float scale each (proposed; no measured quality
     loss), or float32.
   - **Search:** brute force in JavaScript over an in-memory cache, invalidated by a
     change counter.
   - **No `sqlite-vec`:**
     - it can't be loaded through the Prisma adapter (SQL `load_extension()` is
       refused);
     - it adds shadow tables to the strict drift check;
     - it is pre-1.0;
     - it was not faster at personal-archive scale (55 ms against 37 ms p50 at 50,000
       vectors).
   - **Revisit** above about 100,000 chunks or if p95 exceeds 300 ms.
6. **Lifecycle:**
   - **Generation:** the conversation's (`contentHash`, `parserVersion`) pair, plus a
     per-claim token on the job. `contentHash` alone is not enough: a re-import with a
     newer parser replaces the messages but keeps the hash (`decide.ts` case 7; found
     while designing M5.1b, see `docs/m5.1b-semantic-index-design.md`).
   - **Import:** a replacing import deletes its chunks and queues a job in the same
     transaction.
   - **Delete-all:** clears chunks and jobs and bumps an index epoch.
   - **The indexer:**
     - commits a conversation's chunks in one transaction, under the existing write lock,
       only if the content hash and epoch are unchanged;
     - resets running jobs at start-up;
     - rebuilds everything when the model or chunker version changes.
   - **Search:** joins chunks to the current generation, so stale embeddings can't be
     shown.
7. **Hybrid search (M5.2):** semantic results lead. Keyword results are fused by
   reciprocal rank fusion (k = 60) only when the exact-word query matches; otherwise
   semantic only. This rule was fixed before measurement and never scored below
   semantic search. Plain fusion with any-word results hurt cross-language results.
   Results say why they matched.
8. **Provisioning:** the model download is an explicit user command (`npm run
   model:fetch`) and the only network step. The app works without the model, keyword
   search only.

## Privacy and security controls (to add to ADR 0001 when accepted)

- **No network access** at inference, indexing or search time. Tested with a sandbox
  profile that denies outbound connections, an in-process network tripwire and
  connection sampling.
- **Embeddings are personal data:** never logged or sent, and removed by delete-all with
  secure delete and VACUUM (measured: no deleted vector bytes remain after both). The
  worker reports error codes only.
- **Imported text stays untrusted:** it is only ever embedded and shown as text.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Transformers.js 3.8.1 | Equivalent vectors, but slower, heavier, loads an LGPL image library, frozen 3.x line |
| Transformers.js 4.x | No ONNX Runtime binary for macOS Intel |
| `node-llama-cpp` / GGUF | Not measured. The only route with continued Intel Mac builds: the exit option if ONNX Runtime 1.23.2 becomes untenable |
| Ollama | Extra background service; benchmark-only option, not tested |
| Larger models (e5-base, bge-m3, Qwen3-0.6B) | 3–20× slower indexing on this CPU. Might help cross-language buried ideas (nDCG 0.37), the one clear weakness; deferred |
| Whole-message or turn vectors | Truncation hides ideas beyond 512 tokens (long set: 0.65 against 0.83) and gives no precise passage |
| 256-token chunks | 0.73–0.79 on the long set; less precise passages |
| `sqlite-vec` | See decision 5 |
| Remote embedding API, Python, separate vector database | Excluded by ADR 0001 |

## Consequences

- **New production dependencies:** `onnxruntime-node` (247 MB including other platforms'
  binaries) and `@huggingface/tokenizers` (0.36 MB), plus a 135 MB model file outside
  Git.
- **Pinned to the Intel Mac build:** ONNX Runtime stays at 1.23.2 while development
  happens on this Mac. Exit options: llama.cpp, newer ONNX Runtime on Apple Silicon or
  Linux, or another model runtime.
- **Index size:** about 2 chunks per message, 388 bytes each in int8 (about 41 MB for
  50,000 messages), plus an in-memory cache of similar size.
- **Indexing time:** about 40 minutes for 50,000 messages on this Mac; it runs in the
  background and is resumable.
- **The model's limits:** cross-language buried ideas and unfinished-project discovery
  remain weak. The latter likely needs signals beyond similarity.
- **Migration:** an additive migration (M5.1b), reviewed and rehearsed like M2.1.

## Implementation notes (M5.1a, 2026-11-10)

`src/lib/semantic/`:
- `model-manifest.ts`: the pinned files with sizes and SHA-256, and `EMBEDDING_VERSION`.
- `model-files.ts`, `model-fetch.ts` and `scripts/model-fetch.ts`: local verification
  and the explicit `npm run model:fetch` (hub or `--from` a local folder).
- `backend.ts`: the `TextTokenizer` and `InferenceBackend` interfaces, so another
  runtime can be added later. Implemented by `tokenizer.ts` and `ort-backend.ts`.
- `encoding.ts`: truncation, padding, pooling, normalisation.
- `chunker.ts`: `sentence-pack-v1`.
- `quantize.ts`: `int8-absmax-v1`.
- `pipeline.ts`: sorted per-call batching, cooperative cancellation.
- `worker-core.ts` and `worker.ts`: the worker loop.
- `embedder.ts`: the main-thread client, with drain-on-close.

Measured differences from the research setup:
- **Chunker** `sentence-pack-v1` (research `sent-64-v1`):
  - keeps lines without final punctuation (the research regex dropped them);
  - does not split at `.` inside `3.5` or `example.com`;
  - recognises CJK sentence marks;
  - splits oversized sentences at whitespace, then at code points, so every chunk is at
    most 64 tokens (exact count);
  - never emits an overlap-only chunk.

  On the v0 set only 1 of 216 messages chunks differently.
- **Batching** per conversation, sorted by length. Research batched across conversations
  in corpus order.
- **Quality** (real-model tests, offline):

  | | nDCG@10 |
  | --- | --- |
  | v0, float32 and int8 | 0.817 (research 0.83) |
  | Long set, float32 / int8 | 0.835 / 0.828 (research 0.83) |

  Ablation on v0: the research chunker with production batching scores 0.805. So the
  chunker changes gain 0.012, and the remaining gap to 0.83 is the batch-composition
  effect Experiment 2 measured (±0.03).
- **Equivalence** with Transformers.js 3.8.1: identical token ids; vectors within 6e-8,
  one at a time and in a padded batch.
- **Tested scope:**
  - **Tested:** the worker run standalone by Node 24 (unit tests with a fake pipeline in
    a real worker thread, the opt-in real-model tests, and scripts).
  - **Untested:** the Next.js integration, meaning starting the worker from `next dev` or
    `next start`, bundled or from source, and draining it on server shutdown. It is not
    implemented and remains M5.1b's first task.
- **Worker loading:** the worker entry is loaded by Node 24 directly with type stripping.
  Its import graph uses relative `.ts` specifiers (`allowImportingTsExtensions`) and
  erasable syntax only. `src/lib/semantic/package.json` and `scripts/package.json`
  declare `"type": "module"`.

## Integration findings (M5.1b spike, 2026-11-10)

See `docs/spikes/m5.1b/integration/README.md`.
- **Startup:** the worker starts from `next dev` and `next start`, source-loaded or
  bundled by Turbopack. Vectors are bit-identical to plain Node; start takes 1.0–1.3 s.
- **Mid-inference abort:** ending a worker thread while ONNX Runtime is inferring aborts
  the whole process (`process.exit()` and `worker.terminate()`: SIGABRT). Idle workers
  end cleanly. This confirms decision 3's drain and extends the abort finding from the
  main thread to worker threads.
- **Next.js signal handling:** Next.js exits by `process.exit()` milliseconds after
  SIGINT/SIGTERM. The proposed fix is `NEXT_MANUAL_SIG_HANDLE=true` (plus
  `NEXT_EXIT_TIMEOUT_MS` in dev), with a drain-then-exit handler registered in
  `instrumentation.ts`. Measured: 44–189 ms, with no abort.
- **Worker loading:** proposed from source, with
  `new Worker(/* turbopackIgnore: true */ url)`. The M5.1a fallback
  `opts.workerUrl ?? new URL(…, import.meta.url)` is a Turbopack wildcard and must change.
- **Singleton:** the process-wide singleton lives on `globalThis`, because module scope
  leaks a worker on every `next dev` reload.

## Shutdown comparison (2026-11-11)

See `docs/spikes/m5.1b/shutdown/README.md`. The Next.js signal workaround above is
approved for testing only (D124). A child process for native inference was compared
with it. The child process:
- drains by itself whenever the server exits, with Next's default signal handling;
- isolates native crashes from the web server;
- returns its memory when it exits.

It costs about 0.25 s at start, about 3% throughput and about 0.1 GB while indexing.
Recommended for M5.1b-2; awaiting approval.

## Implementation notes (M5.1b-1, 2026-11-11; awaiting review, uncommitted)

The persistent index core, as planned in `docs/m5.1b-1-implementation-plan.md` (approved
2026-11-11). Nothing in the app starts indexing yet (M5.1b-2).
- **Migration:** `prisma/migrations/20261111120000_semantic_index`, byte-identical to the
  reviewed file (SHA-256 `e761409da750d7c12f6ac146335cd792b1f92a47394d9e65e4f5d6ed5771598d`,
  pinned by `tests/semantic-migration.test.ts`). Not applied to the real database.
- **Code:** `src/lib/semantic/index/` (`config`, `store`, `indexer`, `reader`, `status`);
  I2 in `persist/conversation.ts`; I3 in `delete-all.ts`; the indexer lock in
  `write-lock.ts`.
- **Measured with the fake embedder** (real worker thread, real SQLite): a conversation at
  the 20,000-chunk cap commits in one T2 holding the write lock 164 ms; main-thread heap
  peak growth 53 MiB, process RSS growth 98 MiB. Import cost of I2 within single-run noise
  (+5–7% on 2,000 added or updated conversations).
- **Deviations** (details in `docs/m5.1b-semantic-index-design.md`, *M5.1b-1
  implementation notes*): chunk inserts pass the vectors as one blob per statement
  (per-row parameters took 420–490 ms at the cap); the indexer lock is retried for about
  0.5 s; page budgets are counted in characters (code points); page reads use a reader
  connection.
- **Not run:** the real-model indexer test (`indexer.model.test.ts`) — the model files are
  not installed and no download was approved.

## Open questions

- Shutdown architecture for M5.1b-2: a worker thread with the Next.js workaround
  (testing only, D124), or a child process (recommended).
- ~~Source or bundled worker~~: both work; source proposed (same).
- Whether a larger model is worth testing for cross-language buried ideas, after M5.2.
- Independent relevance judgements by a second person.
