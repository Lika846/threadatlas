# M5.0 Semantic discovery: research preparation (2026-11-09)

Status: **preparation complete and accepted (2026-11-09).** The first experiment (§10
decisions 1–2, narrowed) was approved the same day; its results are reported separately. Nothing downloaded or installed; no
semantic-search code in the application; no dependency added to `package.json`. All
measurements on synthetic data in temporary databases. Approved scope (2026-11-09):
hardware inspection, evaluation-set design, keyword-only baseline, model/runtime and
licence research, benchmark method and criteria, a draft ADR 0002
(`docs/adr/0002-local-semantic-retrieval.md`).

Network use during this preparation: package metadata from the npm registry
(`npm view`), package file listings from unpkg.com, model metadata (file lists, sizes,
SHA-256 values) from the Hugging Face API, release metadata from the GitHub API, and two
web searches. No model or package files were downloaded, and no project data was sent.

## 1. Hardware (sysctl, 2026-11-09)

| Item | Value | Consequence |
| --- | --- | --- |
| CPU | Intel Core i9-8950HK, 6 cores / 12 threads, 2.9 GHz | CPU inference only; no Apple Silicon (Metal) acceleration |
| Vector instructions | AVX2, FMA, F16C; **no AVX-512 / VNNI** | Use generic int8 models, not `*_avx512_vnni` variants |
| Memory | 32 GB | Every shortlisted model fits comfortably |
| OS / Node | macOS 15.4.1; Node 24.22.2, **x64** | Native packages need a `darwin-x64` binary |
| Free disk | 140 GB of 932 GB (85 % used) | Downloads (≤ ~4 GB worst case) are not a constraint |

**Key finding: Intel Mac support is shrinking.** `onnxruntime-node` ships a macOS Intel
(darwin/x64) binary up to **1.23.2**; 1.24.1 and later (1.30.0, 1.31.1 checked) bundle only
Apple Silicon, and their install script downloads nothing for darwin/x64. Transformers.js
**4.x** (current 4.3.2) depends on `onnxruntime-node` ≥ 1.24, so its default Node backend
**cannot run natively on this Mac**. Transformers.js **3.8.1** (Dec 2025, last 3.x) uses
1.21.0, which has the binary. llama.cpp (`node-llama-cpp`) and `sqlite-vec` still publish
`darwin-x64` builds.

## 2. Runtime candidates (exact versions)

| ID | Packages (pinned) | Licence | Unpacked size | Notes |
| --- | --- | --- | --- | --- |
| R1 | `@huggingface/transformers@3.8.1` → `onnxruntime-node@1.21.0`, `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`, `sharp@^0.34.1` (`@img/sharp-darwin-x64@0.34.5`, `@img/sharp-libvips-darwin-x64@1.2.4`), `@huggingface/jinja@^0.5.3` | Apache-2.0 / MIT; **libvips LGPL-3.0-or-later** (image library, unused for text) | ≈ 380 MB (ORT-node 218 MB with all platforms, ORT-web 93 MB, transformers 48 MB, libvips 18 MB) | Easiest; frozen 3.x line, so a maintenance risk on this hardware. Must set `env.allowRemoteModels = false` and a local model path |
| R2 | `onnxruntime-node@1.23.2` + `@huggingface/tokenizers@0.2.0` | MIT / Apache-2.0 | ≈ 259 MB | Lower level (own pooling and normalisation), no image library; newest ORT with an Intel Mac binary |
| R3 | `node-llama-cpp@3.22.3` + `@node-llama-cpp/mac-x64@3.22.3` | MIT | ≈ 75 MB + 28 small deps | GGUF models; CPU (AVX2). Install with `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` so a failed prebuilt check never fetches llama.cpp source and builds it |
| S1 | `sqlite-vec@0.1.9` + `sqlite-vec-darwin-x64@0.1.9` | MIT OR Apache-2.0 | 128 KB | Pre-1.0 (last release 2026-03-31); loadable extension |
| O1 (optional) | Ollama v0.40.15 (2026-11-03), standalone `ollama-darwin.tgz` (186 MB) run from the scratch folder, not installed as an app | MIT | 186 MB + models | Benchmark comparison only; Intel = CPU only, macOS 14+ (official docs). Runs a local server on 127.0.0.1:11434; pulls models from its own registry |

Not shortlisted: Transformers.js 4.x native (no binary; its WASM backend in Node is a
possible slower fallback, to be checked only if R1 and R2 fail), `fastembed@3.0.0` (also
built on `onnxruntime-node`), libSQL (replaces the driver), LanceDB / HNSW libraries
(extra infrastructure), sqlite-vss (deprecated), Python stacks (excluded by ADR 0001).

The scratch harness reuses the project's existing `better-sqlite3` (already installed)
by absolute path, so it needs no second SQLite download.

## 3. Model shortlist (pinned revisions, sizes from the Hugging Face API)

Stage A (small model first, per the approval), then Stage B only after Stage A runs
offline end to end.

| Stage | Model | Source repo @ revision | Files (size) | Licence | Dims / max input | Runtime |
| --- | --- | --- | --- | --- | --- | --- |
| A | multilingual-e5-small | `Xenova/multilingual-e5-small` @ `761b726d` (ONNX of `intfloat/multilingual-e5-small` @ `614241f6`) | `onnx/model_quantized.onnx` 118.3 MB, `tokenizer.json` 17.1 MB | MIT (original) | 384 / 512 tokens | R1 or R2 |
| A (optional) | same, full precision | same repo | `onnx/model.onnx` 470.3 MB | MIT | 384 / 512 | R1/R2: measures quantisation loss |
| B | multilingual-e5-base | `Xenova/multilingual-e5-base` @ `1ec92430` | `onnx/model_quantized.onnx` 278.6 MB, tokenizer 17.1 MB | MIT | 768 / 512 | R1/R2 |
| B | bge-m3 | `Xenova/bge-m3` @ `4de13258` | `onnx/model_quantized.onnx` 569.7 MB, tokenizer 17.1 MB | MIT | 1024 / 8192 | R1/R2 |
| B | Qwen3-Embedding-0.6B | `onnx-community/Qwen3-Embedding-0.6B-ONNX` @ `c25a394d` | `onnx/model_quantized.onnx` 613.5 MB, tokenizer 11.4 MB | Apache-2.0 | 1024 (shrinkable to 32–1024) / 32k | R1/R2 (Qwen3 support in Transformers.js 3.8.1 to verify) |
| B (GGUF) | Qwen3-Embedding-0.6B | `Qwen/Qwen3-Embedding-0.6B-GGUF` @ `370f27d7` | `Qwen3-Embedding-0.6B-Q8_0.gguf` 639.2 MB | Apache-2.0 | 1024 / 32k | R3 (official GGUF; runtime comparison on the same model) |
| Licence decision | EmbeddingGemma-300m | `onnx-community/embeddinggemma-300m-ONNX` @ `5090578d` | `onnx/model_quantized.onnx` + data 309.5 MB, tokenizer 20.3 MB | **Gemma Terms of Use** (use restrictions; not OSI) | 768 (→128) / 2048 | R1/R2; only if approved |

Excluded or deferred: `gte-multilingual-base` (Apache-2.0, but a custom architecture
needing remote code; JS support uncertain), `nomic-embed-text-v2-moe` (Apache-2.0, GGUF
only via llama.cpp; possible R3 extra), `paraphrase-multilingual-MiniLM-L12-v2`
(Apache-2.0, trained on 128-token inputs), community GGUF conversions such as
`gpustack/bge-m3-GGUF` (unclear provenance), and non-commercial models (e.g.
jina-embeddings-v3). The upstream `intfloat` int8 file targets AVX-512 VNNI, which this
CPU lacks; the Xenova int8 export is generic.

e5 models need the prefixes `query: ` and `passage: `; Qwen3-Embedding needs an
instruction prefix on queries. The harness applies each model's documented format.

## 4. Proposed network downloads (nothing done yet; each needs approval)

| # | What | From | Size |
| --- | --- | --- | --- |
| N1 | R1 package tree (Transformers.js 3.8.1) into a scratch folder | registry.npmjs.org | ≈ 380 MB unpacked |
| N2 | R2 (`onnxruntime-node@1.23.2`, `@huggingface/tokenizers@0.2.0`) | registry.npmjs.org | ≈ 260 MB |
| N3 | R3 (`node-llama-cpp@3.22.3` + `mac-x64`) | registry.npmjs.org | ≈ 75 MB |
| N4 | S1 (`sqlite-vec@0.1.9` + `darwin-x64`) | registry.npmjs.org | < 1 MB |
| N5 | Stage A model (e5-small int8 + tokenizer + config) | huggingface.co, pinned revision, SHA-256 checked | ≈ 136 MB (+ 470 MB optional fp32) |
| N6 | Stage B models (e5-base, bge-m3, Qwen3 ONNX, Qwen3 GGUF) | huggingface.co, pinned, checked | ≈ 2.2 GB |
| N7 | Optional: EmbeddingGemma (licence decision) | huggingface.co | ≈ 330 MB |
| N8 | Optional: Ollama standalone + one or two models | github.com, registry.ollama.ai | 186 MB + 0.3–1.2 GB |

Location: a scratch folder outside the repository (models in their own directory, never
committed). Worst case without Ollama ≈ 3.7 GB (≈ 4.2 GB with the fp32 reference); 140
GB free. After each download the harness runs with remote loading disabled and with
`lsof` sampling, to show inference makes no outbound connection.

## 5. Expected resource use on this Mac (estimates to measure, not measurements)

Order-of-magnitude estimates from parameter counts on 6 AVX2 cores; the spike replaces
them with measurements.

| Model | Process RAM while embedding (≤ 512-token chunks, batch 8) | Indexing throughput | Vectors for 75k chunks (float32) |
| --- | --- | --- | --- |
| e5-small int8 | 0.3–0.6 GB | ~20–60 chunks/s | 115 MB (int8: 29 MB) |
| e5-base int8 | 0.6–1.0 GB | ~8–20 chunks/s | 230 MB |
| bge-m3 / Qwen3-0.6B int8 | 1.2–2.5 GB | ~1–5 chunks/s | 307 MB (Qwen3 at 256 dims: 77 MB) |

Indexing 50,000 messages (≈ 75,000 chunks, an assumption to measure) would take roughly
20–60 minutes with e5-small but **4–20 hours** with bge-m3 or Qwen3 on this CPU. That
gap is likely to decide the model choice here more than quality alone. bge-m3's 8k input
is not useful at this speed: attention cost grows with the square of the input length,
so chunks stay ≤ 512 tokens whatever the model allows.

## 6. Evaluation set (v0, synthetic) — `eval/`

`eval/dataset.mjs` (source, comments), `eval/dataset.json` (generated by
`eval/build.mjs`, which also validates it). Entirely invented text.

- **51 conversations, 216 messages, ≈ 29k characters**: en 21, no 16, ru 14. Kinds: 26
  targets, 5 keyword decoys, 2 hard negatives (finished projects), 18 fillers. Six longer
  conversations (≈ 2.7–3.4k characters) hide one idea sentence in the middle of an answer.
- **38 queries** (en 23, no 8, ru 7), with graded relevance (2 = about it, 1 = partly)
  and, for 35 queries, the target message(s):

| Category | n | What it tests |
| --- | --- | --- |
| paraphrase | 6 | Same language, different words ("insomnia early morning awakening" → "I keep waking up at 4 am") |
| crosslingual | 6 | en → no/ru, no → en, ru → en |
| buried | 6 | One idea sentence inside a long answer on another topic |
| decoy | 7 | Query shares only an ambiguous word with target and decoy (python, bank, apple, Norwegian *rett*, Russian *ключ*) |
| unfinished | 7 | Projects started and abandoned, incl. three "what did I never finish" queries (en/no/ru) with six relevant conversations; finished projects as hard negatives |
| keyword | 6 | Controls where exact words should win (error codes, product names, *Lånekassen*) |

Revision during preparation: the first decoy queries contained the disambiguating words
(e.g. "terrarium", "humidity"), so keyword search scored a perfect 1.00 and the category
tested nothing. They were rewritten to share only the ambiguous word; the first version
is not kept as a result.

**Limits of v0 (to fix in v1 before model benchmarks):** too small (51 conversations, so
Recall@10 is lenient; MRR and hit@1 discriminate better); queries written by the same
author as the conversations; English-heavy queries; buried ideas sit in only ≈ 3k characters (real long
answers are longer, and 512-token chunks would split them differently); no topic labels
yet for clustering.
v1 proposal: ≈ 300 conversations (generated fillers around hand-written targets), ≈ 70
queries balanced across en/no/ru, 1–3 topic labels per conversation (allowing several
topics), plus a 50k-message generated corpus for speed and disk measurements (the M2.2
performance generator). PROJECT_PLAN M5 asks for "human-authored search questions": you
could write or review some queries (decision 8).

## 7. Keyword-only baseline (measured 2026-11-09)

Method: the real import pipeline and search index on a temporary database (a temporary
integration test, removed afterwards; copy in `eval/keyword-baseline.int.test.ts.txt`).
Two baselines:

- **AND (the app today):** `searchConversations`, every word must match.
- **OR + bm25:** the same parser, ranking SQL and visibility rules, with the terms joined
  by OR. This is the lexical side a hybrid search would use, so it is the fair baseline.

Conversation-level metrics at 10 (`eval/metrics.mjs`; raw rankings in
`eval/keyword-raw.json`, table in `eval/keyword-metrics.txt`). "msg" = the target
message is the result's best match.

| Group | n | AND nDCG@10 | OR R@10 | OR MRR@10 | OR nDCG@10 | OR hit@1 | OR msg |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **all** | 38 | 0.13 | 0.59 | 0.46 | **0.48** | 0.34 | 0.40 |
| paraphrase | 6 | 0.00 | 0.50 | 0.38 | 0.41 | 0.33 | 0.17 |
| crosslingual | 6 | 0.00 | 0.00 | 0.00 | **0.00** | 0.00 | 0.00 |
| buried | 6 | 0.00 | 0.83 | 0.49 | 0.57 | 0.33 | 0.33 |
| decoy | 7 | 0.00 | 1.00 | 0.69 | 0.77 | 0.43 | 0.71 |
| unfinished | 7 | 0.00 | 0.19 | 0.21 | **0.16** | 0.00 | 0.00 |
| keyword (control) | 6 | 0.83 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| query en / no / ru | 23 / 8 / 7 | 0.13 / 0.13 / 0.14 | 0.56 / 0.54 / 0.74 | 0.42 / 0.48 / 0.58 | 0.45 / 0.48 / 0.59 | | |
| same / cross language | 24 / 14 | 0.21 / 0.00 | 0.88 / 0.10 | 0.67 / 0.11 | 0.72 / 0.08 | | |

Findings:

- The app's AND search returns something for only 5 of 38 queries; it is right for
  exact-word lookups (5 of 6 controls). The miss is Russian inflection: "Keenetic
  гостевая сеть" does not match "гостевую сеть" (no stemming).
- OR + bm25 is a much stronger baseline (nDCG 0.48) but fails where semantic retrieval
  should help: cross-language (0.08), unfinished projects (0.16), and the exact message
  for buried ideas (0.33).
- Decoys: the right conversation is first in only 3 of 7.
- Latency on this tiny corpus: median < 1 ms, p95 ≈ 3 ms (not representative; M2.2
  measured the 50k-message case).

## 8. Benchmark plan (Stage A, then Stage B)

All in a scratch folder with temporary databases; synthetic data only; models loaded
from local files with remote loading disabled; `lsof` sampling throughout.

1. **Harness and offline proof (Stage A, e5-small).** Load, embed, cosine search;
   confirm no outbound connection after the download.
2. **Representations:** message-level (truncated at the model limit), chunk-level (256
   and 512 tokens, ~15 % overlap, with conversation/message/offset provenance),
   turn-level (user + assistant pair). Measure actual chunk counts per representation.
3. **Retrieval:** semantic only; keyword OR + bm25; hybrid by reciprocal rank fusion
   (k = 60, top 50 from each side), plus one weighted variant. Conversation score =
   best chunk; the best chunk gives the linked message.
4. **Timings, measured separately:** model load (cold), query embedding, vector retrieval,
   keyword retrieval, fusion, end to end; p50/p95, warm and cold.
5. **Indexing:** throughput (chunks/s) by batch size and thread count, peak RSS, disk
   (model, vectors, database growth), on v1 and on the 50k-message corpus.
6. **Storage:** (a) float32 / int8 BLOBs in an ordinary table, scanned in JavaScript;
   (b) `sqlite-vec` `vec0` table; (c) `sqlite-vec` distance functions over ordinary
   BLOBs. Also check whether the Prisma better-sqlite3 adapter exposes its connection
   for `loadExtension`, and how vectors behave with delete-all, `secure_delete` and
   VACUUM. Neither option is assumed necessary.
7. **Topic grouping groundwork:** (a) clustering chunks, with a conversation inheriting
   the topics of its chunks (several topics allowed); (b) one aggregated vector per
   conversation (mean, length-weighted mean, max). Compare against v1 topic labels
   (multi-label precision/recall, and NMI for the single-label view).
8. **Stage B:** repeat 2–6 with e5-base, bge-m3, Qwen3 (ONNX, and GGUF via
   node-llama-cpp for a runtime comparison), and EmbeddingGemma only if its licence is
   approved; Ollama only as an optional comparison.
9. **Report and ADR 0002 update** with the chosen model, runtime, representation and
   storage, or a stop recommendation.

Stop conditions: no model reaches the criteria for Norwegian or Russian; offline
operation cannot be shown; no runtime works natively on this Mac without unacceptable
maintenance risk.

## 9. Proposed acceptance criteria (for approval)

Aggregate improvement with category-level regression analysis, not zero regressions:

1. **Aggregate quality:** hybrid nDCG@10 and MRR@10 on v1 at least **+0.15 absolute**
   over OR + bm25.
2. **Target categories:** clear gains on cross-lingual (R@10 ≥ 0.6, from 0.10),
   paraphrase, buried (message-level hit ≥ 0.6) and unfinished projects; each reported
   separately.
3. **Regression analysis:** keyword controls may drop at most 0.05 nDCG; any category
   that drops more is explained and needs your explicit acceptance.
4. **Languages:** each query language reaches at least 80 % of the best language's
   hybrid nDCG.
5. **Latency (warm, 50k messages):** end-to-end search p95 ≤ 300 ms, of which query
   embedding p95 ≤ 100 ms; model load ≤ 5 s.
6. **Indexing:** full indexing of 50k messages finishes in the background, resumable,
   with peak RSS ≤ 2 GB. Target ≤ 60 min; longer only if you accept it.
7. **Disk:** model plus vectors ≤ 1.5 GB at 50k messages.
8. **Privacy:** no non-loopback connection during indexing, search or model loading
   (sampled), remote model loading disabled in code, no logging of text or vectors.

## 10. Decisions needed before the spike continues

1. **Runtime installs (N1–N4)** in a scratch folder outside the repository. My
   recommendation: R2 (`onnxruntime-node@1.23.2` + tokenizers) and R1 (Transformers.js
   3.8.1) for Stage A, R3 and S1 too; not Transformers.js 4.x.
2. **Stage A model download (N5):** e5-small int8 (≈ 136 MB); fp32 reference optional.
3. **Stage B downloads (N6)** after Stage A, or approve now for later.
4. **Licence policy:** permissive only (MIT / Apache-2.0), or also the Gemma Terms
   (EmbeddingGemma). Also: is LGPL libvips, pulled in by Transformers.js but unused for
   text, acceptable in a scratch install (and later in the app)?
5. **Ollama (N8):** skip, or allow the standalone binary as a comparison.
6. **Long-term hardware risk:** the newest ONNX Runtime has no Intel Mac build. Accept
   pinning to older versions, prefer llama.cpp (still built for Intel), or plan around
   another machine.
7. **Acceptance criteria** in §9 (or adjusted values).
8. **Evaluation set v1:** approve the expansion in §6, and whether you want to write or
   review some queries yourself.
9. **Where the evaluation kit lives:** currently uncommitted in `docs/spikes/m5.0/eval/`
   (data, generator and metric scripts; lint passes). Commit it as research material, or
   keep it out of Git.
