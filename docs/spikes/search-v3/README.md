# Search spike v3: a search ranked a relevant conversation 21st (2026-11-19)

Status: **done; a correction is in production** (`src/lib/semantic/search/hub.ts`).
- **Data:** synthetic data only.
- **Databases:** none opened, except the temporary ones of the opt-in model test.

**Question.** The UI review (`docs/ui-review/2026-11-18/`) saw "I can't stop thinking about work in
the evening" rank "Overwhelmed and can't switch off" 21st. Why, and is there a targeted fix that
holds on other queries?

**Short answer:**
- **The example was partly misread in the review.** The first result is relevant: "Waking at 3am
  every night" ("my mind starts racing about work"). So is the fourth. The 21st conversation is
  relevant, but its passages never mention work or evenings.
- **The real problem is generic passages in a compressed score range.** The best 25 conversations
  scored within 0.04 of each other. Passages that are close to almost any query took places among
  them:
  - an essay paragraph about architecture;
  - a pottery answer;
  - a riddle;
  - a line sharing common words ("works. can i run this automatically every night on windows").
- **Correction:** subtract half of each passage's *genericness* from its score. Genericness is its
  mean similarity to about 150 everyday subjects (the theme vocabulary's names). The weight was
  chosen on one query set and checked on three others.
- **The gain is modest:**
  - meaning-only nDCG@10: v0 +0.012, long +0.038, v2 +0.040;
  - the chatter archive's targets all stay first;
  - one trade-off, described below.
- **It doesn't remove every intruder.** For the reported query the "every night on windows"
  conversation is still third.

## Diagnosis (`diagnose.mts`, `results/diagnose-work-evening.txt`)

The production rule is reproduced offline on the v2 set's production passages and int8 vectors: a
conversation scores its best passage of at least 8 tokens. The resulting ranking matches the
review.

- Scores of the first 25 run from 0.868 down to 0.825.
- Among them are unrelated passages: an essay paragraph (#5, 0.849), "every evening" in a dinner
  plan (#6), pottery (#12) and a riddle (#13).

## Variants (`rank-variants.mts`, `results/rank-variants.md`)

Four query sets with graded judgements, meaning only (exact-word fusion is unchanged):

| Set | Corpus | Queries | Judged by |
| --- | --- | --- | --- |
| v0 | M5.0 research corpus (51) | 38 | M5.0 judgements |
| long | M5.0 combined corpus (60) | 20 | M5.0 judgements |
| v2 | mind-map v2 set (453; en, no, ru) | 34 (`queries-v2.mjs`) | topic labels, written before any variant ran |
| chat | the model test's chatter archive (34 + 300 template fillers) | 7 | the model test's targets; added after the first correction failed there |

nDCG@10, and the close tier's average size in the chatter archive (margin 0.03):

| Variant | v0 | long | v2 | chat | Chat close tier |
| --- | --- | --- | --- | --- | --- |
| Best passage (production before) | 0.840 | 0.828 | 0.556 | 1.000 | 26.9 |
| ½ best + ½ mean of the best 3 passages | 0.833 | 0.822 | 0.580 | 1.000 | 20.0 |
| Best − 0.5 × mean similarity to the 10 nearest subjects (first attempt) | 0.871 | 0.890 | 0.599 | **0.947** | **52.7** |
| **Best − 0.5 × mean similarity to all subjects (chosen)** | **0.852** | **0.866** | **0.596** | **1.000** | 36.3 |
| Best − 1 × mean similarity to all subjects | 0.779 | 0.889 | 0.625 | 1.000 | 55.0 |
| Best − 0.25 × similarity to the corpus mean | 0.839 | 0.841 | 0.578 | 1.000 | 6.6 |
| Centred cosine (corpus mean removed) | 0.811 | 0.837 | 0.605 | 1.000 | 1.6 |

- **The first attempt was dropped.** Similarity to the *10 nearest* subjects is high for any passage
  about a subject the vocabulary covers well. A cooking passage is near "Food and cooking",
  "Dinner recipes", "Vegetarian cooking", "Bread and baking" and more. It also spares vague
  template text, which matches no subject strongly. It scored best on three sets, but in the
  model test's chatter archive:
  - "debugging" lost its target (1st → 2nd);
  - the close tier for vague queries grew from 4–5 to 40–46.

  The *mean over all* subjects measures what was meant (similar to everything a little) and isn't
  driven by one subject cluster.
- **How the weight was chosen:**
  - It was picked on **v0 only**: 0.5 is v0's best for this definition.
  - It improves long, v2 and chat (no target lost), which it wasn't picked on.
  - Weight 1 helps long and v2 but drops v0 below the old ranking.
- **Per query (v2):** most queries improve. The losses are listed in `results/rank-variants.md`;
  the largest are on queries whose relevant conversations use very common wording.
- **Corpus centring** keeps the close tier small, but at 0.25 it barely changes the ranking, and
  stronger settings lower v0. The centred cosine shrinks every close tier (the 0.03 margin would
  need recalibrating) and lowers v0. Neither was taken.

## In production

- `hub.ts`: penalty = 0.5 × (passage · mean of the vocabulary's vectors). The vectors are the
  precomputed ones the atlas uses, so nothing new is downloaded or stored. Without matching vectors
  the penalty is 0, which gives the old ranking.
- `vector-cache.ts`: the penalties are computed once per index state, at the first search: one dot
  product per passage. They are subtracted from each passage's score.
- **Only with the production model:** the correction applies only when search runs the production
  inference child (`usesProductionModel` in `meaning-search.ts`): a deterministic check of the
  configured pipeline. The vocabulary's vectors already record the embedding version, which
  must match the index's. The only way to get another model is the test suite's fake one, which
  declares the production version on purpose. Found by the e2e suite: the fake model's random
  vectors, plus hundreds of fixture conversations sharing one message, made all 50 results tie
  as close matches. A first guard compared the index's mean vector with the vocabulary's
  (cosine 0.94–0.95 for real archives, 0.05 for random vectors). It was replaced by this explicit
  check, because a statistical test of the vectors is fragile.
- **Tests:**
  - `hub.test.ts`, deterministic.
  - The opt-in real-model test (`meaning-search.model.test.ts`). It now also rebuilds the v2 set
    (`build.mjs --out`) and runs the 34 queries through indexing and search. It asserts
    meaning-only nDCG@10 ≥ 0.58 (0.556 before) and a fully relevant first result for the
    reported query.

**Real-model test, before → after** (full search: query process, cache, exact-word fusion):

| | v0 | long | v2 (meaning only) |
| --- | --- | --- | --- |
| nDCG@10 | 0.840 → 0.852 | 0.828 → 0.866 | 0.556 → 0.596 |
| Relevant among close matches | 0.796 → 0.815 | 0.905 → 0.905 | — |
| Close matches per query | 5.8 → 6.6 | 3.3 → 2.8 | — |
| Warm p95 | 10 → 9 ms | 28 → 14 ms | — |

In the chatter archive every target is still first, with a real passage. For two vague queries
the close tier grows ("some recipe" 4 → 15, "when i was debugging some code" 5 → 24). That
archive has 300 near-identical template conversations, more than a real archive has, but the effect
is real: after the correction, template advice passages sit closer to the best match.

## Limits

- All four sets are synthetic. The v2 queries and labels have the same author as the code.
- Genericness is measured against a fixed English list of everyday subjects. Editing that list
  changes search slightly; `CONCEPTS_VERSION` forces the vectors to be regenerated, and the model
  test re-measures search.
- The correction is small. The compressed score range of the model remains the main limit; a
  larger model is the open question from M5 (cross-language quality).
