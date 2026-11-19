# Mind-map spike v3: themes → topics, and their names (2026-11-19)

Status: **done; in production** as the map's data (`src/lib/semantic/topics/atlas.ts`).
- **Data:** synthetic data only.
- **Database:** none opened.
- **Model:** the production chunker and model, run through the v1 and v2 embed scripts.

**Questions.** The map should open on a few broad themes, each holding its topics.
1. Which rule cuts the existing tree into themes?
2. Are the resulting themes and topics meaningful?
3. How should they be named, in English, Norwegian and Russian, without filler words?

**Short answer:**
- **Themes:** the finest cut of the same average-linkage tree that leaves **at most 15 themes**. The
  production topic cut is unchanged, so every topic sits in exactly one theme. A fixed distance
  (0.90) scores slightly higher, but its theme count keeps growing with the archive.
- **Meaningful, with limits.** Most themes are clear (code, food and garden, fitness, money, home,
  travel, music, pets), and every large theme mixes languages. The 15-theme cap makes some themes
  broader than their labels. One theme holds career, study and family together.
- **Names:**
  - **themes** take a name from a vocabulary of everyday subjects, matched by the local model,
    each name used once;
  - **topics** take their two most typical titles;
  - **word names** with filler removed are the fallback.

  Theme names matched the label for 9 of 9 clear themes on the held-out set; title or word names
  managed 3–4.

## Setup

| Set | Conversations | Labels | Role |
| --- | --- | --- | --- |
| Dev (v1) | 94 (chat corpus + M5.0 research sets) | v1 tags, mapped to themes | choosing the rules |
| Test (v2) | 453 hand-written (en 252, no 113, ru 88) | 14 themes, 53 topics, 58 one-offs | confirming |

- **Vectors:** the production pipeline (`conversation-vectors.ts`): per-message language, language
  means removed, generic text left out, centred (`shared-v3.mts`).
- **Tree:** the production average linkage and topic cut (`hierarchy.ts`).
- **Scores:**
  - B³ against the labels;
  - stability: ARI of 10 subsamples of 80%;
  - drift with archive size: 100 / 200 / 300 / 453 conversations;
  - for names, whether a name contains an accepted word for its group's majority label
    (`gold-names.mjs`, written before the improved variants were run). Accepted words come in
    English, Norwegian and Russian, so any naming style can hit.

## 1. Theme cut (`themes-v3.mts`, `results/themes.md`)

Theme-level B³ F (dev / test), with the theme count as the archive grows:

| Rule | B³ F dev / test | Themes at 100 / 200 / 300 / 453 | Stability |
| --- | --- | --- | --- |
| Fixed t = 0.90 | 0.52 / **0.58** | 14 / 18 / 19 / 24 | 0.76 |
| Fixed t = 0.95 | 0.44 / 0.51 | 8 / 10 / 11 / 12 | 0.71 |
| At most 12 themes | 0.49 / 0.51 | 12 / 11 / 11 / 12 | 0.72 |
| **At most 15 themes (chosen)** | 0.49 / 0.53 | **14 / 14 / 14 / 15** | 0.75 |
| Largest theme ≤ 20% | 0.48 / 0.56 | 12 / 14 / 15 / 19 | 0.74 |
| Largest gap in merge heights | 0.28 / 0.36 | 5 / 2 / 3 / 3 | 0.34 |

- **Why not the best score:**
  - A fixed 0.90 gives 24 themes at 453 conversations and more as the archive grows. A first level
    of 30–60 nodes isn't a map.
  - The bounded rule costs 0.05 B³ F and keeps the first level the same size at every archive
    size.
  - Stability is about the same either way.
- **Small archives:** when there are at most 15 topics, the themes *are* the topics, and the map
  has one level. No level is invented.
- **Every rule has 4–5 catch-all themes** on the test set. These are themes whose majority label
  covers less than half of them. That is the cost of ~15 themes for 14 themes plus 58 one-offs.

## 2. What the levels look like (`results/listing-*-blind.md`, read before `*-labelled.md`)

The test set at the chosen cut has 15 themes, 94 topics, 54 loose conversations and 0 other.

- **Clear themes:**
  - Programming and software (92; 80% code);
  - Travel and outdoors (75% travel);
  - Home and housing (67% home);
  - Money and personal finance (63% money);
  - Pets and animals (93% family/pets).
- **Broad but defensible:**
  - Food and cooking, with garden and nutrition;
  - Fitness and sport, with sleep and stress;
  - Writing and creativity.
- **Mixed:**
  - "Family and relationships": career 43%, with study and family;
  - "Science and nature": 17 one-off science questions;
  - "Computers, phones and gadgets": a mixed small theme;
  - two small single-language groups: Norwegian (3) and Russian/Norwegian (2). These are the
    leftover language effect from v2.
- **Topics** are mostly specific and multilingual, for example:
  - "Cold brew ratio / Pour-over coffee tastes sour";
  - "Kitchen garden on a north-facing balcony / Tomatoes on the balcony split".

  Some are poor pairs, as in v2.

## 3. Names (`names-v3.mts`, `results/names.md`)

Share of clear groups (majority label ≥ 50%) whose name contains an accepted word:

| Naming | Themes dev / test | Topics dev / test | Typical length (themes / topics) |
| --- | --- | --- | --- |
| Three typical titles (the earlier experimental view) | 86% / 67% | 67% / 61% | 91 / 75 characters |
| Most typical title | 14% / 33% | 33% / 41% | 30 / 27 |
| Words, titles only | 14% / 33% | 33% / 42% | 29 / 24 |
| Words, titles + user messages (filler removed, per-language coverage) | 29% / 44% | 33% / 39% | 27 / 20 |
| Nearest vocabulary name | 71% / 100% | 33% / 41% | 19 / 16 |
| **Themes: vocabulary name, each used once; topics: two typical titles** | **86% / 100%** | **50% / 58%** | **19 / 57** |

A second check is label-free: each name, embedded as a query, should find its own group among
all groups at its level. The chosen naming scores MRR 0.78 for themes and 0.96 for topics.

- **Three typical titles** score well on matching but are 75–91 characters long, too long for a
  map.
- **Word names** stay weak even with filler removed, because a multilingual group spreads one idea
  over three languages' words. Coverage within each language helped a little (themes 33% → 44%).
  They remain the fallback when the vocabulary vectors don't match the model.
- **Each vocabulary name once:** without it, two themes were both called "Money and personal
  finance". With it, the second (career, study and family) takes its next name, "Family and
  relationships".
- **The vocabulary** (`concepts.ts`, 28 broad and 124 specific names) is a general list of everyday
  subjects, not fitted to these sets. Its vectors are precomputed with the pinned model
  (`npm run concepts:embed`) and used only when the vocabulary hash and embedding version match.

## Limits and open questions

- **Synthetic data, one author:** one author wrote the conversations, the labels, the accepted
  names and the code. The vocabulary may cover these sets' subjects better than a real archive's.
- **Not tuned on a real archive:** the cut rules carry the v2 caveat. A real export may need a
  different theme cap or vocabulary names.
- **A fixed English vocabulary:** names are English even for a Norwegian-only theme. Subjects
  outside the vocabulary get the nearest broad name, which may be loose; a similarity floor
  wasn't needed on these sets.
- **Cost:** the tree is O(n²) in time and memory (36 MB at 3,000 conversations). It's cached in
  memory per index state; see the scale measurement in `docs/PROGRESS.md`.

## Reproduce

```
node docs/spikes/mindmap/v2/build.mjs
fnm exec --using=24 -- node docs/spikes/mindmap/v2/embed-v2.mts <scratch>/v2.json
fnm exec --using=24 -- node docs/spikes/mindmap/embed.mts <scratch>/v1.json
fnm exec --using=24 -- node docs/spikes/mindmap/v3/themes-v3.mts <scratch>/v1.json <scratch>/v2.json docs/spikes/mindmap/v3/results/themes.md
V3_LISTING=14 fnm exec --using=24 -- node docs/spikes/mindmap/v3/names-v3.mts <scratch>/v1.json <scratch>/v2.json docs/spikes/mindmap/v3/results
```
