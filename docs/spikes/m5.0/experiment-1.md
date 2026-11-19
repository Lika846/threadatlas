# M5.0 Experiment 1: multilingual-e5-small with Transformers.js on ONNX Runtime (2026-11-09)

Status: **done, awaiting review.** Research only (D119). Everything ran in a scratch
directory outside the repository on synthetic data. Nothing was added to the project's
dependencies, schema or application code, and the real database, backup and manifest
were not touched (size, mtime and inode unchanged). The benchmark scripts are in
`experiment-1/bench/` and the raw results in `experiment-1/results/` (uncommitted, for
review).

**Summary:**
- **Semantic retrieval:** nDCG@10 is **0.81**, against 0.48 for the any-word keyword
  baseline (+0.33; the research target was +0.15).
- **Cross-lingual queries:** nDCG@10 0.74–0.84, against 0.00 for keyword search.
- **Speed:** queries take about 7 ms at the median and under 40 ms at p95, against the
  300 ms target.
- **What didn't work:**
  - Simple rank fusion with keyword search made results *worse* than semantic search
    alone, especially across languages.
  - Unfinished-project discovery stays weak (0.46–0.49).
- **Costs:** indexing takes about 10 chunks/s for 256-token chunks, and peak memory is
  1.2–1.8 GB.
- **Licensing:** the runtime loads an LGPL image library that nothing here uses.

## 1. Installation and compatibility

| Item | Finding |
| --- | --- |
| Packages | `@huggingface/transformers@3.8.1` with an npm `overrides` entry forcing `onnxruntime-node@1.23.2` (3.8.1 itself pins 1.21.0). 49 packages, 413 MB in `node_modules`, installed in 8 s with `npm install --ignore-scripts --no-audit --no-fund` (no install script is needed on this platform). `package-lock.json` kept in the scratch directory |
| Install network | Only `registry.npmjs.org` (Cloudflare addresses, matched by DNS), sampled with `lsof` |
| Runtime actually loaded | `onnxruntime-node/bin/napi-v6/darwin/x64/libonnxruntime.1.23.2.dylib` (checked with `lsof` on the running process): native Intel build, no WASM fallback. The override worked without errors or warnings |
| Also loaded | `sharp` and `libvips-cpp.8.17.3.dylib`: Transformers.js 3.8.1 imports `sharp` at module load, so the image library is loaded even for text-only use (see §6) |
| Model | `Xenova/multilingual-e5-small` at revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, from huggingface.co (large files via its CDN `us.aws.cdn.hf.co`). Four files, 135.4 MB in total: `onnx/model_quantized.onnx` 118,308,185 B (SHA-256 `f80102d3…c98c193`), `tokenizer.json` 17,082,730 B (`0b44a9d7…dc4f39`), `config.json` 658 B, `tokenizer_config.json` 443 B. Sizes and hashes checked against the Hugging Face metadata for that revision (LFS SHA-256 for the large files, git blob SHA-1 for the small ones). The model folder was made read-only |
| Model licence | The ONNX repository declares no licence of its own; its card says it is the ONNX conversion of `intfloat/multilingual-e5-small`, whose card (revision `614241f6…`) declares **MIT** and lists en, no and ru. There is no separate LICENSE file; MIT asks for the copyright and licence notice to be kept when redistributing |
| Model usage | Prefixes `query: ` and `passage: `, mean pooling, L2 normalisation, 384 dimensions, input truncated at 512 tokens (all as in the model card) |
| Stability | No crash in normal runs. One run that ended with an uncaught JavaScript exception also aborted on exit inside ONNX Runtime (`mutex lock failed`); a production worker would need to shut down cleanly |

## 2. Retrieval quality (synthetic set v0: 51 conversations, 38 queries)

The baselines are those committed in `eval/` (unchanged). "Semantic" ranks conversations
by their best unit's cosine similarity; the linked message is that unit's message.

**Overall, nDCG@10:**

| Method | all | paraphrase | cross-lingual | buried | decoy | unfinished | keyword controls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AND keyword (the app today) | 0.13 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.83 |
| Any-word keyword (OR + bm25) | 0.48 | 0.41 | 0.00 | 0.57 | 0.77 | 0.16 | 1.00 |
| **Semantic, message level** | **0.81** | 0.94 | 0.74 | 0.77 | 0.95 | 0.49 | 1.00 |
| Semantic, 256-token chunks | 0.80 | 0.94 | 0.80 | 0.77 | 0.95 | 0.46 | 0.92 |
| Semantic, 64-token chunks | 0.80 | 0.94 | 0.74 | 0.82 | 0.95 | 0.47 | 0.94 |
| Semantic, turn level (user + assistant) | 0.81 | 0.94 | 0.84 | 0.83 | 0.81 | 0.47 | 1.00 |
| Hybrid RRF (k = 60, semantic top 50 + keyword top 20), message | 0.65 | 0.80 | 0.06 | 0.83 | 0.89 | 0.34 | 1.00 |
| Hybrid RRF, both lists cut at 10, message | 0.71 | 0.81 | 0.37 | 0.83 | 0.89 | 0.36 | 1.00 |
| Hybrid RRF, semantic weight 2, message | 0.69 | 0.81 | 0.14 | 0.83 | 0.95 | 0.40 | 1.00 |

**Other measures, semantic message level (any-word keyword in brackets):**
- Recall@10 0.91 (0.59).
- MRR@10 0.81 (0.46).
- hit@1 0.74 (0.34).
- Target message is the best match: 0.71 (0.40); at turn level, the target is inside the
  best turn: 0.80.

**By query language, nDCG@10, semantic message level:**
- en 0.80, no 0.74, ru 0.94.
- Same-language 0.95, cross-language 0.57 (keyword: 0.72 and 0.08).
- Norwegian is the weakest query language (0.66–0.74 depending on the representation).
- Russian queries are the strongest, but there are only 7 of them.

**Cross-lingual and buried ideas:**
- Every cross-lingual target is in the top 10 (Recall@10 1.00), but only half are first.
- Buried ideas: 5 of 6 targets are in the top 10 at message level.
- The miss, `b03`, is an English query for an idea buried in a Russian answer about bathroom
  renovation. It is found in the top 10 only with 64-token chunks (buried Recall@10 1.00).
- In 2 of 6 buried cases the best message isn't the one holding the idea.

**Failure patterns (per query, `results/metrics-*.json`):**
- **Unfinished projects (0.46–0.49):** "knitting project left half done" ranks the
  birdhouse first. The model matches *topic*, not *state*: it sees "unfinished" no more
  than the keyword index does. Finished-project hard negatives (`n01`, `n02`) appear in
  the top 3 for five queries, two of them unfinished-project queries.
- **A "hub" conversation:** `c04`, the long budget-spreadsheet conversation, is in the top
  3 for six unrelated queries. Long generic texts attract queries.
- **Norwegian:** "romanprosjekt som stoppet opp" misses the English novel conversation
  entirely; "samle regnvann til tomatene" finds the English target only at rank 3.

**Why fusion hurt:**
- With a 51-conversation corpus, the any-word keyword list contains loosely matching
  conversations (shared function words such as "with" and "to", or "med").
- Reciprocal rank fusion gives those the same weight as semantic hits. A conversation in
  the middle of both lists outranks the semantic first place.
- This happens most for cross-lingual queries, where the keyword side has no true match.
- Cutting the lists to 10 or weighting the semantic side doesn't fix it.
- Fusion needs a gate:
  - use keyword results only when they are strong, for example when the AND query
    matches or a rare term matches;
  - or let semantic results lead and use keyword only to promote.
- This is a design result for M5.2, measured here only on rankings and not tuned (tuning
  on 38 queries would overfit).

**Representations:**
- On v0, message, chunk (256 or 64 tokens) and turn level agree within 0.01 overall.
- That is within noise: one query moves the overall score by about 0.03.
- The v0 messages are short (mean 38 tokens, longest 350), so 256-token chunking split
  only 6 messages.
- Turn level helps cross-lingual queries (0.84) but hurts decoys (0.81).
- The set can't separate representations yet; v1 needs long messages (§9).

## 3. Query latency (38 queries, warm, message level; single process, CPU)

| Step | p50 | p95 | Max |
| --- | --- | --- | --- |
| Query embedding | 5.9 ms | 19.8 ms | 20.8 ms |
| Vector retrieval (216 vectors, JS loop) | 1.0 ms | 4.4 ms | 9.1 ms |
| Keyword (FTS5 OR + bm25, in memory) | 0.3 ms | 1.2 ms | 1.6 ms |
| Fusion | 0.03 ms | 0.24 ms | 0.28 ms |
| **End to end** | **7.6 ms** | **21.1 ms** | 22.7 ms |

Other representations: end to end p50 6.8–8.5 ms, p95 20–37 ms.

**Retrieval at larger sizes** (brute-force dot product in JavaScript, float32, 384
dimensions, random vectors, 20 runs):

| Vectors | p50 | p95 |
| --- | --- | --- |
| 5,000 | 4.3 ms | 11.2 ms |
| 50,000 | 39 ms | 41 ms |
| 100,000 | 75 ms | 189 ms |

So an end-to-end search over 50,000 chunks is expected at roughly 50–80 ms p95 with this
model, well under the 300 ms target, without `sqlite-vec` or an index.

## 4. Indexing throughput, memory, load time, disk

Synthetic 256-token chunks (windows over the set's text; 260 tokens on average with the
prefix and special tokens), batch 16, default ONNX Runtime threads. Each size ran in a
fresh process:

| Chunks | Embedding time | Chunks/s | Tokens/s | RSS after model load | Peak RSS |
| --- | --- | --- | --- | --- | --- |
| 100 | 10.5 s | 9.6 | 2,489 | 827 MB | 1,214 MB |
| 1,000 | 101.3 s | 9.9 | 2,568 | 817 MB | 1,683 MB |
| 5,000 | 507.5 s | 9.9 | 2,563 | 782 MB | 1,829 MB |

The set's real messages (mean 38 tokens) embedded at about 31 messages/s; 64-token chunks
at about 75 chunks/s. Throughput is roughly constant in tokens, at about 2,500 tokens/s,
so indexing time depends on the archive's total length:

- 75,000 chunks of 256 tokens: about **2 hours**;
- an archive of 50,000 messages averaging 150 tokens: about **50 minutes**.

My preparation estimate (20–60 chunks/s) was too optimistic for 256-token chunks.

**Model load (fresh process, 3 runs):**
- importing Transformers.js: 113–118 ms;
- creating the pipeline (reading the 118 MB model and creating the session): 1.13–1.17 s;
- first query embedding: 9.8–16.2 ms, then 4.3–6.7 ms;
- RSS after load: 799–838 MB. In the benchmark runs, pipeline
creation took 1.26–1.42 s and importing Transformers.js about 0.13 s.

**Memory:**
- Peak RSS 1.2–1.8 GB during indexing (1,214 → 1,683 → 1,829 MB for 100 → 1,000 → 5,000
  chunks: growth slows, consistent with the runtime's memory pool settling rather than a leak;
  a longer run would confirm), and 1.5 GB in the quality run (which also held
  100,000 random vectors).
- My preparation estimate (0.3–0.6 GB) was too low.
- About 0.8 GB is resident as soon as the model is loaded, from the runtime, the 250k-token
  vocabulary and the session.

**Disk:**
- Model: 135.4 MB.
- Runtime: 413 MB `node_modules` in the scratch directory. ONNX Runtime alone is 247 MB,
  because it includes every platform's binary; Transformers.js 47 MB; ONNX Runtime Web 91
  MB, unused in Node; libvips 17 MB.
- Vectors: 1,536 bytes per chunk in float32 (115 MB per 75,000 chunks), or 384 bytes in
  int8.

## 5. Privacy and network

- **After the download, every benchmark run was offline by three independent checks:**
  - **macOS sandbox:** each run was wrapped in `sandbox-exec` with outbound network
    denied. A control fetch to the npm registry failed with `EPERM`, and all runs
    completed, so nothing they needed was on the network.
  - **In-process tripwire:** preloaded into every run. `net`, `tls`, `http`, `https`,
    `dns` and `fetch` throw and count attempts. **0 attempts** in every run.
  - **`lsof` sampling** of node processes every 0.1 s: **no non-loopback connection** in
    any run.
- **Configuration:** `env.allowRemoteModels = false`, local model path only, file and
  browser caches off. Transformers.js loaded only the four verified files.
- **Network use overall:** only the approved steps — npm registry for the install, and
  huggingface.co plus its CDN for the four model files.
- **Data:** only synthetic text; no real conversation was read. Embeddings and timings
  stayed in the scratch directory.

## 6. Licences: the LGPL dependency

- **What it is:** `@img/sharp-libvips-darwin-x64@1.2.4` is **LGPL-3.0-or-later**. It is
  the prebuilt `libvips` image library used by `sharp`.
- **What else it bundles:**
  - more LGPLv3 libraries: glib, fribidi, libexif, libheif, librsvg, pango,
    proxy-libintl;
  - cairo (MPL-2.0);
  - aom (BSD-2-Clause plus the AOMedia patent licence);
  - permissive libraries.
- **Actual use:**
  - Transformers.js 3.8.1 imports `sharp` unconditionally, so the library is loaded into
    the process (confirmed with `lsof`).
  - ThreadAtlas would never call it, because nothing processes images.
  - Everything else in the tree is permissive: MIT 25 packages, BSD-3-Clause 13,
    Apache-2.0 6, ISC 3, MIT-or-CC0 1.
- **Implications (not legal advice):**
  - **Local use**, as in this research, carries no obligations.
  - **If ThreadAtlas distributes** an application or bundle that contains it (for
    example a packaged M7 release with `node_modules`), the LGPL requires:
    - shipping its licence text and notices;
    - letting users replace the library (dynamic linking, as here, normally satisfies
      this);
    - providing, or offering, the corresponding source of the LGPL parts;
    - the MPL-2.0 and patent-licence notices for the other bundled libraries also apply.
  - **If users install from source with npm**, npm fetches the library itself and the
    project doesn't redistribute it, but the notices still belong in the documentation.
- **Ways to avoid it:**
  - (a) call `onnxruntime-node` directly with `@huggingface/tokenizers` (runtime R2 in
    the preparation report): no image library at all;
  - (b) find out whether Transformers.js runs with `sharp` absent. That is unlikely with
    the static import, and untested.
- **Recommendation:** don't adopt Transformers.js for the application without deciding
  this first. Option (a) is also leaner: 247 MB of ONNX Runtime instead of 413 MB.

## 7. Failures and limitations

- **The evaluation set is small and easy in places.**
  - 51 conversations (Recall@10 is lenient), 38 queries, one author for the texts and
    queries, mostly short messages.
  - A single query moves category scores by about 0.15.
  - The results show direction, not precise effect sizes.
- **Simple fusion hurts** (§2). The hybrid design is open.
- **Unfinished-project discovery** isn't solved by embeddings alone: 0.46–0.49. It likely
  needs explicit signals (for example "next step", "I stopped", "haven't finished yet",
  or recency), not just similarity.
- **Hubness:** long generic conversations attract unrelated queries.
- **Norwegian is the weakest query language;** the model is small.
- **Measurement method:**
  - Throughput was measured with default threads and batch 16 only; no sweep.
  - RSS is from `process.resourceUsage().maxRSS` and `/usr/bin/time -l`.
  - The OS file cache was warm after the first run, so "cold" load times are
    process-cold, not disk-cold.
  - Vector-scan timings use random vectors; real retrieval also groups by conversation.
- **Abort on exit:** ONNX Runtime aborted on exit once, after an uncaught error.
- **Maintenance:** ONNX Runtime 1.23.2 and Transformers.js 3.8.1 are both older lines
  without Intel Mac successors. This is approved for research only.

## 8. Research targets

| Target | Result |
| --- | --- |
| +0.15 nDCG@10 over the any-word baseline (0.48) | **Met by semantic search alone** (0.80–0.81, +0.32 to +0.33). Hybrid fusion as tried: +0.17 to +0.25, but with a cross-lingual regression against semantic alone |
| ≤ 300 ms query latency | **Met:** end to end p95 21–37 ms here; about 50–80 ms expected at 50,000 chunks |
| Cross-lingual retrieval | Recall@10 1.00, nDCG 0.74–0.84 (keyword: 0.00) |
| Buried ideas | nDCG 0.77–0.83; the target message is the best match in 4 of 6 cases |
| Offline after download | **Shown** (sandbox, tripwire, sampling) |

## 9. Is a second model or another runtime justified?

**Another runtime, yes: R2** (`onnxruntime-node@1.23.2` with `@huggingface/tokenizers`,
no Transformers.js):

- **Licence:** it removes the LGPL image library (§6).
- **Size:** 413 MB of packages becomes about 250 MB.
- **Same engine:** it uses the ONNX Runtime build that was just verified on this Mac, so
  the risk is small.
- **Embeddings:** these should be identical. Comparing them against this experiment
  doubles as a correctness check of my own pooling code.
- **llama.cpp (`node-llama-cpp`)** remains the only path with continued Intel Mac builds.
  It is worth testing only if the project must track newer runtimes on this machine. I
  would not test it yet.

**A second model, not yet:**

- **Speed:** the small model already beats the target by a wide margin. A larger model
  (e5-base, bge-m3 or Qwen3-0.6B) would cut indexing throughput by roughly 3–20× on this
  CPU, turning about 50 minutes into hours.
- **Where it might help:** only in the weak spots — Norwegian queries, unfinished-project
  queries and cross-lingual first place.
- **Before any larger model:**
  1. **Evaluation set v1**: about 300 conversations, long messages (so representations
     separate), about 70 queries balanced across en/no/ru, topic labels, more hard
     negatives. Run e5-small again on it as the reference.
  2. **A fusion design with a gate** (§2), evaluated on v1.
- Then, if Norwegian or unfinished-project queries still fall short, test **one** larger
  model (I'd pick e5-base: same family and prefixes, ~2.4× the size, MIT) before bge-m3
  or Qwen3.
