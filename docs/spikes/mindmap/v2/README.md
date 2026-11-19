# Mind-map spike v2: validation on a larger held-out set (2026-11-16)

Status: **experiment only.** No production code, schema or UI changed. No model downloaded, no
dependency added, no real conversation or database opened. Not committed.

**Question:** does the v1 recommendation hold on a larger, messier dataset that it wasn't tuned on?
v1 recommended language correction plus average-linkage hierarchical clustering at t = 0.85 / 0.95.

**Short answer:**
- **The direction holds:** language correction plus hierarchical clustering.
- **The v1 thresholds don't transfer.**
- **The decision criteria written before the run were narrowly missed** (2 of 5).

Production k-means is clearly the worst option again, so the evidence is strong enough to stop
investing in it. The exact parameters (threshold rule, number of themes, titles) should be
confirmed on real conversations before the production map changes.

## Setup

- **Test set:** 453 new hand-written synthetic conversations, written for this run (`src/*.txt`).
  - **Languages:** en 252, no 113, ru 88.
  - **Labels:** 14 themes and 53 topics, plus 58 one-offs. 102 conversations have a second topic.
  - **Length:** 62% short (one question, one answer), 24% medium, 13% long (5–12 messages). The
    plan aimed for 20% long.
  - **Messiness on purpose:** 8 mixed-language conversations; 12 English titles on Norwegian or
    Russian conversations; 7 "New chat" or empty titles; code and logs inside Norwegian and
    Russian conversations; "thanks" chatter; topic drift.
  - **Labels kept apart from text:** `build.mjs` writes the text to `conversations.json` (the only
    file embedding reads) and the labels to `labels.json`.
- **Dev set:** the 94 conversations from v1, which v1 was tuned on. Combined dev + test = 547.
- **Frozen before embedding** (`SPEC.md`): the language detector, the representations, the
  configuration grids, the label-free threshold rule and the decision criteria.
- **Embeddings:** the production chunker and inference child, per-conversation batching
  (2,124 chunks, 18 s).
- **Algorithms:** v2 uses an O(n²) nearest-neighbour-chain average linkage and a sparse Louvain.
  `verify-v2.mts` shows they reproduce v1 exactly on the dev set (every cut, every Louvain setting,
  identical B³).
- **Threshold, three ways:**
  - (a) fixed v1 values;
  - (b) best in the grid (oracle);
  - (c) label-free rule: the most stable setting with ≤ 25% unsorted and a largest group ≤ 15%.
- **Reproduce:** the first command regenerates the dataset. `conversations.json` isn't
  committed (the repository ignores every `conversations*.json`, so a real export can't be
  committed by mistake); `build.mjs` rebuilds it, byte for byte, from `src/*.txt`, and also
  rewrites the committed `labels.json`, which comes out unchanged.
  ```
  node docs/spikes/mindmap/v2/build.mjs --tally
  fnm exec --using=24 -- node docs/spikes/mindmap/v2/embed-v2.mts <scratch>/v2.json
  fnm exec --using=24 -- node docs/spikes/mindmap/v2/verify-v2.mts <scratch>/v1.json   # v1 vectors from ../embed.mts
  fnm exec --using=24 -- node docs/spikes/mindmap/v2/analyse-v2.mts <scratch>/v1.json <scratch>/v2.json docs/spikes/mindmap/v2/results
  fnm exec --using=24 -- node docs/spikes/mindmap/v2/explore-v2.mts <scratch>/v2.json docs/spikes/mindmap/v2/results
  ```

## 1. Main result: test set, topic level

`results/metrics.md` has every row and both full grids.

| Method (test set) | Setting | Groups | Unsorted | B³ F | Catch-alls* | Same subject, other language, grouped together | Stability |
|---|---|---|---|---|---|---|---|
| k-means (production) | k = 12 | 12 | 0% | **0.16** | 12 of 12 | 0.01 | 0.48 |
| Hierarchical, `all [det]` | (a) t = 0.85 (v1) | 38 | 1% | 0.45 | 17 | 0.50 | 0.79 |
| Hierarchical, `all [det]` | (b) oracle t = 0.75 | 83 | 7% | **0.54** | 7 | 0.31 | 0.85 |
| Hierarchical, `all [det]` | (c) label-free t = 0.70 | 98 | 16% | **0.53** | 2 | 0.24 | **0.87** |
| Hierarchical, `all+title [det]` | (c) t = 0.70 | 117 | 16% | 0.47 | 2 | 0.14 | 0.88 |
| Louvain, `all [det]` | (c) k = 15, γ = 2 | 13 | 0% | 0.34 | 11 | 0.62 | 0.86 |
| Louvain, `all+title [det]` | (b) oracle k = 15, γ = 4 | 23 | 0% | 0.44 | 15 | 0.49 | 0.80 |

\* A catch-all is a group of 5 or more where most members lack the group's main topic.

**At theme level** (coarse groups against the 14 theme labels):

| Method | Theme-level B³ F |
|---|---|
| k-means | 0.30 |
| Hierarchical, t = 0.85 (`all [det]`) | 0.61 |
| Hierarchical, t = 0.90 (`all [det]`) | 0.59 |
| Hierarchical, t = 0.95 (v1's fixed theme cut) | 0.51 |
| Louvain, best | 0.58 |

**Dev + test combined:** the same picture. At theme level k-means scores 0.30, hierarchical 0.52–0.56
and Louvain 0.55–0.56.

## 2. Decision criteria (set before the run)

Checked for hierarchical clustering with language correction, at the label-free setting (c), on
the test set:

| Criterion | `all [det]` | Met? |
|---|---|---|
| 1. B³ F ≥ baseline + 0.15 | 0.53 vs 0.16 | yes |
| 2. Same-subject cross-language grouping ≥ 0.25 | 0.24 | **no**, narrowly (0.31 at t = 0.75) |
| 3. Stability ≥ baseline + 0.15 | 0.87 vs 0.48 | yes |
| 4. Largest group ≤ 15% and at most one catch-all | 5%, but 2 catch-alls | **no** |
| 5. (c) within 0.05 of the oracle | 0.53 vs 0.54 | yes, but see below |

**Criterion 5 passes for a weaker reason than intended.** The rule doesn't find a real stability
peak. An exploratory check below the grid (`results/explore.md` §4) shows stability rising steadily
as the cut gets finer, because more conversations become stable singletons:

| t | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.85 |
|---|---|---|---|---|---|---|
| Stability | 0.90 | 0.89 | 0.87 | 0.85 | 0.85 | 0.79 |
| Unsorted | 43% | 28% | 16% | 7% | 2% | 1% |

So the rule simply picks the finest cut that keeps unsorted under 25%. Here that landed near the
best setting, but the cap did the work, not stability.

**The two misses, looked at with the labels:**
- **The two catch-alls make sense as themes.** One is a food group (bread, desserts, tea and
  dinners together). The other is Norwegian-language code questions, which is leftover language
  effect.
- **Cross-language grouping is a trade-off.** It falls as the cut gets finer, because small groups
  give same-subject conversations in other languages fewer chances to join. At theme level it is
  0.46–0.50.

The criteria didn't cover this outcome. By their wording, the result is "not enough evidence to
replace k-means", but the miss is narrow and k-means loses on every measure.

## 3. What the groups look like

My reading of the group lists, done from titles only before I looked at the labels
(`results/blind-judgement.md`):

| Listing | Representation | Groups | Clear | Defensible | Poor |
|---|---|---|---|---|---|
| k-means (production) | `all`, no language correction | 12 | 1 | 3 | 8 |
| Hierarchical, t = 0.7 (frozen listing) | `all+title [det]` | 117 (+73 unsorted) | ≈ 75 | ≈ 30 | ≈ 12 |
| Louvain, k = 15, γ = 3 (frozen listing) | `all+title [det]` | 19 | 16 | 3 | 0 |
| Hierarchical, t = 0.75 (the recommended setup, read after the frozen run) | `all [det]`, no titles | 83 (+7% unsorted) | ≈ 50 | ≈ 20 | ≈ 13 |

In the recommended setup, only six groups are a single language, and each of those is coherent.
Most poor groups are pairs of one-offs linked by a single word ("Origin of the word salary" +
"Hvorfor er sjøvann salt").

**k-means today:**
- four groups are one language each with mixed subjects (two Russian, two Norwegian);
- the English groups mix food, fitness and home;
- only English code is clear.

**Hierarchical topics (t = 0.7), multilingual and specific:**
- *Cats:* Cat scratching the sofa · Katten tisser utenfor kassen · Introducing a second cat ·
  Почему кошки мурлычут · Hund og katt sammen
- *City trips:* Weekend in Copenhagen · Helg i Berlin med tenåringer · Что посмотреть в Стамбуле
  за 3 дня · Weekend in Prague on a budget · Helg i Stockholm med venninner
- *Elderly parents:* Mamma med begynnende demens · Elderly father refuses help at home · Moving my
  mother to a care home · Мама не хочет переезжать к нам

**Two levels, without titles** (`results/explore.md`, exploratory). Themes cut at t = 0.9, topics
at t = 0.75:
- **Code** (74 conversations, 71 of them code). Topics: data and SQL (28); web and frontend (13);
  DevOps and Git (13).
- **Food & growing** (61): dinners, nutrition, bread, desserts, vegetables, houseplants.
- **Work & study** (44): workplace, applications, interviews, exams, thesis, stress.
- **Others:** Money (39), Fitness (28), Home (23), Travel (20), Family (19), Tech (17),
  Health (15), Pets (13 of 13).

These are the broad-then-narrow structure the mind map needs.

**Louvain gives themes, not topics.** Its 19 groups read like a clean theme list. It puts every
conversation in a group, so one-offs end up inside themes (for example a "science questions" group
that also took protein and water questions).

## 4. Failure cases

- **A single threshold doesn't carry over between datasets.** v1's t = 0.85 was best on the dev
  set; on the test set the best is 0.75–0.80, and 0.85 drops B³ F to 0.45 with 17 catch-alls.
- **Both trends point the wrong way for larger archives** (scale table in `results/metrics.md`
  §6). Real archives are often 2–10 times larger than this test set:
  - **Scores fall as the archive grows.** At the rule's setting, B³ F drops from 0.59–0.69 at 100
    conversations to 0.47 at 453 (`all+title [det]`). Part of that is more topics to separate.
  - **The rule's cut drifts finer:** about 0.80–0.85 at 100, 0.75 at 200, 0.70 at 300 and above.
    The oracle drifts less (0.70–0.80).
- **Titles hurt.** They helped on the dev set (titles derived from ids) but not on the test set:
  0.47–0.50 against 0.53–0.54 without titles.
  - Four "New chat" conversations formed their own group.
  - Similar wording paired unrelated conversations: "Espresso machine for beginners" + "Sewing
    machine for beginners"; "Packing light for two weeks" + "Potty training in a week".
  - Ignoring placeholder titles didn't recover the loss (exploratory).
- **Language effect remains for short Norwegian and Russian conversations.** Examples: a
  Norwegian-only code group; pairs like "Kanelboller som blir tørre" + "Огурцы горчат". The
  detector itself was right for 1,406 of 1,414 messages, including mixed ones, so the leftover
  effect is in the embeddings, not in the detection. Per-chunk detection made no difference.
- **One-offs mostly get pulled into topics.** Only 19–38% stay unsorted at topic level, and 0%
  with Louvain.
- **The food theme also takes in garden and nutrition, and "Work & study" mixes career with
  exams.** A reader would accept both, but they're broader than the labels.

## 5. Performance (resampled vectors with noise, timing only)

| Conversations | k-means (today) | Average linkage + cut | kNN graph + Louvain |
|---|---|---|---|
| 500 | 75 ms | 126 ms | 184 ms |
| 2,000 | 0.7 s | 1.2 s | 2.9 s |
| 5,000 | 1.2 s | 7.0 s (191 MiB of distances) | 21.8 s |

- **Up to about 2,000 conversations:** on-demand hierarchical clustering is fine.
- **Beyond that:** compute in the background after indexing and cache the result. Store distances
  as Float32 to halve the memory.
- **Louvain:** slowest here, and it would need an approximate neighbour search at scale.

## 6. Compared with v1 (94 dev conversations)

| | v1 (dev, 94) | v2 (test, 453) |
|---|---|---|
| k-means B³ F | 0.29 | 0.16 |
| Hierarchical with language correction, best B³ F | 0.60 (t = 0.85, with titles) | 0.54 (t = 0.75, no titles) |
| Best threshold | 0.85 | 0.75–0.80 |
| Titles | +0.05 | −0.04 to −0.06 |
| Stability, hierarchical vs k-means | 0.86 vs 0.58 | 0.87 vs 0.48 |

The scores aren't directly comparable: the test set has 53 topics, the dev set 22 tags. The gap
between k-means and the alternative grew with a larger, more varied archive. The threshold and the
title effect didn't hold.

## Recommendation

1. **Enough evidence to stop investing in k-means.** On both datasets its groups are mostly
   catch-alls driven by language. Don't tune it further.
2. **Not enough evidence for final parameters.** The pre-registered criteria were missed narrowly,
   the threshold didn't transfer from dev to test, and all of this is synthetic text I wrote
   myself. Before changing the production map, run the same frozen harness on the real export:
   about 150 conversations tagged privately by you, with scripts that print numbers only.
3. **The candidate design to test on real data:**
   - **Representation:** `all [det]`, meaning language correction per message and no titles.
   - **Topics:** hierarchical clustering. State the cut honestly as a display rule rather than a
     stability rule: pick the cut that leaves about 10–20% of conversations unsorted. On this data
     that is t = 0.70–0.75; t = 0.75 gives 83 groups with 7% unsorted. Single conversations go to
     "Other". Whether this rule holds as the archive grows is the main thing to check on real
     data.
   - **Themes:** a coarser hierarchical cut of the same tree (about 0.85–0.90), so topics nest
     inside themes. Louvain is a reasonable alternative for themes, but it doesn't nest and it
     absorbs one-offs.
   - **Labels:** the 2–3 most typical titles in each group.
4. **What would change the plan:**
   - If real data shows topic groups splitting by language, test language correction on chunks
     more carefully, and consider a model that handles cross-language matching better.
   - If real archives exceed about 3,000 conversations, add background computation and caching.

## Limitations

- **One author:** I wrote all 453 conversations and the labels. The blind reading reduces but
  doesn't remove that bias.
- **The text is cleaner than real ChatGPT:** assistant replies are shorter and tidier, and long
  conversations are 13% of the set, not the planned 20%.
- **Only three languages,** and the detector knows only those.
- **12 conversations were relabelled from one-off to a topic** before embedding, after a
  read-through.
- **One label has a duplicated second topic** (t087); the effect on the scores is negligible.
- **The theme-level thresholds and the two-level listing in `explore.md` are exploratory**
  (chosen after seeing results).

## Post-hoc control (2026-11-17, exploratory)

Run after the frozen results had been read, to answer the advisory review's questions. Script
`control-v2.mts`, output `results/control.md`. Synthetic data only; rules marked *rule* were chosen
after seeing the test set, so none of this is independent evidence.

```
fnm exec --using=24 -- node docs/spikes/mindmap/v2/control-v2.mts <scratch>/v1.json <scratch>/v2.json
```

- **Language correction helps k-means too, but hierarchical clustering still adds value.**
  Topic-level B³ F on the test set: k-means 0.16 → 0.28 with correction (k = 12) → 0.43 at a
  matched group count (k = 94); hierarchical with correction 0.55. Dev: matched k-means 0.45,
  hierarchical 0.51 (a gap inside the subset spread of about ±0.04). Stability: hierarchical
  0.85–0.91, matched k-means 0.32–0.43 (one seed). Hierarchical without correction: 0.35.
- **Shrinking language means toward the global mean (λ = 200 chunks) hurts.** Test 0.55 → 0.50,
  dev 0.51 → 0.44. With only m Russian conversations among all English and Norwegian ones,
  plain centring joined them with same-topic conversations in 0.47 / 0.75 / 0.85 of cases
  (m = 3 / 8 / 20), shrunk 0.13 / 0.28 / 0.51, no correction 0.00 / 0.17 / 0.51. At m = 3, 27% of
  the Russian conversations stayed unsorted with plain centring (7% shrunk).
- **Topic rule** (smallest t in [0.65, 0.85] leaving ≤ 15% unsorted): t = 0.72 on test (B³ F 0.55,
  2 catch-alls, cross-language 0.27), 0.79 on dev (0.51, 0 catch-alls). On 100/200/300 subsets it
  stays within 0.05 of a fixed t = 0.75; the drift (0.77 → 0.72) stays inside the clamp.
- **Theme rule** (target clamp(round(√n / 2), 8, 20) groups) **is poor**: test 0.48 with the
  largest group at 21% and 6 catch-alls, below k-means with correction at k = 11 (0.50) and a
  fixed t = 0.90 (0.59, also 6 catch-alls). Dev 0.42 vs 0.52. No theme rule is settled.
- **Untested worst case:** a small language whose conversations all share one subject; centring
  on its own mean would remove exactly that subject.
