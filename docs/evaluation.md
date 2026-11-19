# Evaluation

How ThreadAtlas's search by meaning, map and related conversations were evaluated, and how to
reproduce the numbers. Every figure here comes from **synthetic** conversations written for the
purpose (English, Norwegian and Russian), never from a real archive, so they show that each
design works and how the alternatives compare, not how well it will do on your data.

## Data sets

| Set | Size | Used for | Where |
| --- | --- | --- | --- |
| v0 research set | 51 conversations, 38 graded queries | choosing the model, chunking and search rules | `docs/spikes/m5.0/eval/` |
| Long set | 60 conversations, 20 queries (long, mixed-language conversations) | the same, under harder conditions | `docs/spikes/m5.0/eval/` |
| Mind-map v2 set | 453 conversations (en 252, no 113, ru 88) with theme and topic labels, 34 queries | held-out check of the map and search rules | `docs/spikes/mindmap/v2/` |
| Chatter archive | 34 conversations + 300 template fillers | search robustness to boilerplate | `src/lib/semantic/search/meaning-search.model.test.ts` |

## Results

**Search by meaning** (nDCG@10, meaning only, before and after the correction for generic
passages; `docs/spikes/search-v3/`):

| Set | Best passage | With the correction (production) |
| --- | --- | --- |
| v0 | 0.840 | 0.852 |
| Long | 0.828 | 0.866 |
| v2 (held out) | 0.556 | 0.596 |

The correction's weight was chosen on v0 only; the chatter archive's targets all stay first.
Fused with exact-word matches, both research sets clear nDCG@10 0.80 in the model tests.

**Map** (`docs/spikes/mindmap/`):
- Average-linkage hierarchical clustering with language correction against the earlier k-means
  map on the held-out v2 set: B³ F **0.53 against 0.16**. Without the language correction, groups
  split by language first.
- Themes: the finest cut of the same tree with at most 15 themes keeps the theme count steady as
  the archive grows (14 / 14 / 14 / 15 at 100 / 200 / 300 / 453 conversations), where a fixed
  distance grows from 14 to 24.
- Theme names from the vocabulary of everyday subjects matched the label for 9 of 9 clear themes
  on the held-out set, against 3–4 for title or keyword names.

**Related conversations** (`docs/spikes/graph/`): top 5 at cosine similarity ≥ 0.35 on
language-corrected conversation vectors. About **8%** of links were wrong on the synthetic set,
and about one in nine conversations that had related ones got none.

## Reproducing

- **Model tests** (about 20 s after `npm run model:fetch`): `npm run test:model` checks the
  tokenizer and vectors against reference outputs, runs the full search path on the v0, long, v2
  and chatter sets and fails below the bars above, and groups a test corpus with the real model.
- **Spikes:** each folder under `docs/spikes/` has a README with its question, method, results and
  the commands that produced them. The scripts run on temporary databases and the synthetic sets
  in the same folders (`docs/spikes/mindmap/v2/README.md` explains how to rebuild that set's
  export byte for byte).
- **Speed:** `THREADATLAS_PERF=1` and `THREADATLAS_SEARCH_PERF=1` turn on the opt-in performance
  tests (see [development.md](development.md#testing)).

## What is not evaluated yet

- Relevance on a real archive, and independent relevance judgements (the queries and judgements
  were written by the same person as the conversations).
- Languages other than English, Norwegian and Russian.
- Archives much larger than 3,000 conversations (the map and related conversations were timed at
  3,000; search at 50,000 chunks).
