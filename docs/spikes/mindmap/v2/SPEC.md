# Mind-map spike v2: spec (frozen 2026-11-16, before any v2 conversation was written or embedded)

## Roles
- **Dev set:** the 94 conversations of v1 (`../labels.mjs`). All v1 choices were tuned on them.
- **Test set:** the new hand-written conversations in `src/*.txt`. Main results are test-only;
  dev + test combined is secondary.

## Frozen before embedding
- **Language detector:** `detectLang()` exactly as in v1 `analyse.mts` (same stopword lists).
  Primary: per message. Secondary (reported, not used for decisions): per chunk.
- **Representations:** `all [det]` and `all+title [det]` (v1 winners). Baseline uses production
  vectors (`all`, no correction). User-only and `query:` are dropped (lost in v1).
- **Configs:**
  - k-means: production `groupConversations()` (k = round(√n), 2–12).
  - Hierarchical average linkage on centred cosine distance; singletons → unsorted.
    Grid t ∈ {0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00, 1.05}.
  - Louvain on symmetric kNN graph (positive weights), groups of 1 → unsorted.
    Grid k ∈ {6, 10, 15} × γ ∈ {1, 1.5, 2, 3, 4}.
- **Threshold reported three ways** for each method:
  (a) fixed v1 values: hierarchical t = 0.85 (topics) / 0.95 (themes); Louvain k = 8, γ = 1.5
      (v1 table row) → nearest grid point k = 10, γ = 1.5;
  (b) best in grid by test B³ F (oracle ceiling);
  (c) **label-free rule:** among settings with unsorted share ≤ 25% and largest group ≤ 15% of
      conversations, the one with the highest subsample stability (mean ARI, 20 × 90%).
      Ties → the finer setting (more groups).
- **Theme level:** the coarse cut is scored against theme labels; the fine cut against topic labels.

## Decision criteria (written before results)
Replace k-means (subject to a check on real data) only if hierarchical-with-language-correction
at the **label-free (c)** setting, on the **test** set:
1. B³ F (topic level) ≥ baseline + 0.15;
2. same-subject cross-language co-grouping ≥ 0.25;
3. stability ≥ baseline + 0.15;
4. largest group ≤ 15% of conversations, and at most one catch-all group
   (≥ 5 members with intruder rate > 50%);
5. (c) is within 0.05 B³ F of the oracle (b) (the rule generalises).
If 1–4 hold but 5 fails → the algorithm is better but the threshold rule needs real data.
If 1–3 fail → wait for real data.

## Dataset targets (test set)
About 450–550 conversations; diversity over volume. Languages ≈ en 55%, no 25%, ru 20%.
Length: ~50% short (one question, one answer), ~30% medium (2–3 turns), ~20% long (4–8 messages).
Messiness on purpose: code and logs inside no/ru conversations, mixed-language messages,
English titles on no/ru conversations, ~5% "New chat"/empty titles, "thanks" chatter,
multi-topic drift, one-offs ~15%. Uneven topic sizes (code largest).

Source format (`src/*.txt`):
```
=== <id> | <title or empty> | <topic> | <topic2 or -> | <lang>
U: user message (multi-line allowed)
A: assistant message
U[en]: a message whose language differs from the conversation's
```
`build.mjs` splits sources into `conversations.json` (id, title, messages: text + role only)
and `labels.json` (theme, topic, topic2, oneoff, per-message intended language). Clustering
reads only `conversations.json`.

## Label tree (theme → topics, target counts)
See `taxonomy.json`. One-offs use topic `oneoff:<slug>` (theme `oneoff`).
