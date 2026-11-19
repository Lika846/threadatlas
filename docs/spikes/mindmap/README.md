# Mind-map grouping spike (2026-11-16)

Status: **experiment only.** No production code, schema or UI changed. Nothing downloaded or
installed, no reindexing, no real conversation or database opened. Not committed.

**Question:** can topic grouping get clearly better with the existing multilingual-e5-small
vectors, by changing only the algorithm and the conversation representation?

**Short answer:** yes, but the main fix is not the algorithm. On this data **language is the
strongest signal in the conversation vectors**, so every algorithm mostly grouped by language.
After removing the language signal, **average-linkage hierarchical clustering with a distance
cut** gave the clearest groups: B³ F 0.60 against 0.29 for today's k-means, and stability 0.86
against 0.58.

## Setup

- **Data:** 94 synthetic conversations: the chat corpus (34, en), the M5.0 v0 set (51:
  en 21, no 16, ru 14) and the long set (9: en/no/ru). Embedded by `embed.mts` with the
  production chunker and inference child, batched per conversation like the indexer
  (626 chunks, 7 s). The vectors went to the session scratchpad; regenerate them with the script.
- **Labels (`labels.mjs`):** 1–3 subject tags per conversation, from 22 tags, written before any
  clustering ran. 19 conversations have two tags.
- **Baseline:** the production `groupConversations()` from `topics.ts`, imported unchanged
  (k = 10 here).
- **Metrics:**
  - **B³ F (extended BCubed):** handles conversations with several tags and several groups;
    an unsorted conversation counts as its own group.
  - **Intruder rate:** members without their group's most common tag.
  - **Language test:** how often pairs end up in the same group:
    - same subject, different language (should be high);
    - different subject, same language (should be low).
  - **Stability:** adjusted Rand index (ARI) over 20 random 90% subsamples.
  - **Side-by-side listings:** read by eye.
- **Reproduce:**
  ```
  fnm exec --using=24 -- node docs/spikes/mindmap/embed.mts <scratch>/vectors.json
  LIST="k-means (prod, k=10) @ all;hier t=0.85 @ all+title [det]" \
    fnm exec --using=24 -- node docs/spikes/mindmap/analyse.mts <scratch>/vectors.json docs/spikes/mindmap/results
  ```
  `results/`: `metrics.md` (every table), `groups.md` (listings), `hierarchy.md` (two levels),
  `multi-topic.md`.

## 1. Language drives today's groups

With today's vectors (mean of the eligible chunks), the groups split by language before subject:

| Today's vectors | B³ F | Same subject, other language, grouped together | NMI with subject / with language |
|---|---|---|---|
| k-means (production) | 0.29 | 0.00 | 0.45 / **0.62** |
| Graph + Louvain (k = 6, γ = 1) | 0.26 | 0.00 | 0.35 / **0.74** |
| Hierarchical (t = 0.75) | 0.40 | 0.01 | 0.60 / 0.49 |

- **k-means puts languages in their own groups.** Its groups include *all 17 Russian
  conversations* in one group and two Norwegian-only groups. The English remainder is a
  22-conversation mix of code, sleep, garden, home and food (`results/groups.md`).
- **Louvain at low resolution finds the languages exactly** (NMI with language = 1.00).
- **Not explained by the datasets' different styles:** NMI with the source dataset is only
  0.10–0.18.

This matches the M5.0 search finding: same-language conversations outrank the right
other-language one.

## 2. Removing the language signal is the largest gain

**Method:** detect each message's language and subtract each language's mean chunk vector
before averaging a conversation's chunks.

- **The detector:** about 20 lines, no dependency (Cyrillic share, then Norwegian vs English
  stopwords). It agreed with the dataset language for 357 of 358 messages.
- **Same result without dataset labels:** using the dataset's own language labels gives
  the same results (0.61 vs 0.60).

| `all + title` vectors, detected language removed | groups | largest | unsorted | B³ F | intruders | same subject, other language | stability |
|---|---|---|---|---|---|---|---|
| k-means (production, k = 10) | 10 | 12 | 0 | 0.35 | 0.62 | 0.22 | 0.31 |
| k-means, k = 20 | 20 | 8 | 0 | 0.42 | 0.46 | 0.20 | 0.34 |
| Graph + Louvain (k = 8, γ = 1.5) | 9 | 16 | 0 | 0.50 | 0.49 | 0.55 | 0.83 |
| Graph + Louvain (k = 10, γ = 3) | 17 | 10 | 0 | 0.55 | 0.34 | 0.30 | 0.80 |
| **Hierarchical, t = 0.85** | 20 | 10 | 6 | **0.60** | **0.23** | 0.35 | **0.86** |
| Hierarchical, t = 0.9 | 18 | 10 | 1 | 0.59 | 0.28 | 0.39 | 0.80 |
| *Reference: the labels themselves (primary tag)* | 22 | | | *0.88* | | | |

**Other ways to remove language** (label-free, smaller gain):
- **Removing the top 3 principal components:** up to 0.53.
- **Centring per low-resolution Louvain community:** identical to the label-based result here,
  but it relies on those communities being languages, which a real archive may not give.

## 3. What the groups look like

Excerpts below, with the full lists in `results/groups.md`. ✗ means the conversation lacks the
group's main tag.

**Today (k-means, all chunks):**
- *G2 (17):* every Russian conversation (moving, dacha, Japanese, bathroom, keys, router,
  marathon, borscht, cat, CV…)
- *G7 (6):* car maintenance · chess opening · dog training · learning guitar · git merge ·
  guitar chords
- *G6 (7):* autumn poem · apple pie · weekend in Rome · pancakes · garden tomatoes · Lisbon
  trip · bookshelf finished

**Hierarchical, t = 0.85, language removed:**
- *Food (8, three languages):* Middag med laks · Coffee brewing · Apple pie · Dinner idea ·
  Pancakes · Brødbaking · Борщ · Sourdough
- *Fitness (5, three languages):* Løping etter kneoperasjon · Подготовка к марафону · Running
  shoes · Marathon · Workout plan
- *Pets (3):* Valpen bjeffer · Dog training · Кот не ест
- *Moving (3):* Переезд в Новосибирск · Flytting til ny leilighet · Moving checklist
- *Travel (3):* Weekend in Rome · Поездка в Казань · Lisbon trip
- *Money & data (9):* budgets, savings, tax, Lånekassen, plus ✗ Pandas and ✗ SQL. A reader
  would call this "spreadsheets & data", which is reasonable.
- *Plants & outdoors (10):* tomatoes, houseplants, dacha, plus ✗ birdhouse, ✗ photosynthesis,
  ✗ ball-python terrarium, ✗ autumn poem. The tags count these as wrong, but a reader would
  probably accept the group.
- **Still poor:**
  - two groups of short Norwegian/Russian leftovers (knitting, lost keys, bike wrench, fence,
    new phone);
  - a Russian code group kept apart from the English code group;
  - "Gift ideas + Startup name".

**My reading of the listings** (not blind: I wrote both the labels and the code):

| | groups I can name and would keep | mixed but defensible | not useful |
|---|---|---|---|
| k-means today | 2 of 10 | 1 | 7 |
| Graph + Louvain, language removed | 4 of 9 | 3 | 2 |
| Hierarchical, language removed | 14 of 20 | 3 | 3 |

**Two levels work too** (`results/hierarchy.md`). Cutting at t = 0.95 gives 11 broad themes
that contain the t = 0.85 topics:
- *Home & garden* = garden/outdoors + home repairs;
- *Body & wellbeing* = fitness + sleep/meditation + pets;
- *Moving & travel*;
- *Money & data*;
- *Food*;
- *Code*.

One theme is still a catch-all (career + languages + occasions + Russian code). The hierarchy
gives the mind map a natural theme → topic → conversation structure.

## 4. Conversation representation

- **User messages only: worse.** With language removed: 0.41 against 0.55 for all chunks
  (hierarchical t = 0.85). Assistant answers carry most of the subject vocabulary. This
  disproves the earlier review's hypothesis, at least on this data.
- **Adding the title vector: small gain.** All + title 0.60 against all 0.55; user + title
  0.41.
  - The chat corpus titles are derived from ids, not real ChatGPT titles.
  - Real titles may be in a different language from the conversation (the title is centred by
    the conversation's language here).
- **`query: ` prefix for user chunks: no gain** (0.35 against 0.36 before language removal).
  Not worth re-embedding.

## 5. Multi-topic membership: no measurable benefit here

On the hierarchical groups, two ways of adding a second group were tested
(`results/multi-topic.md`):

| variant | extra memberships | match a tag | two-tag conversations given their second topic | B³ F |
|---|---|---|---|---|
| none | 0 | – | 0 / 19 | 0.60 |
| (a) nearest other centroid within δ = 0.05 (leave-one-out) | 9 | 3 | 1 / 19 | 0.61 |
| (a) δ = 0.1 | 21 | 9 | 1 / 19 | 0.60 |
| (b) per-turn assignment (substantive user turns only) | 0–1 | 0 | 0 / 19 | 0.59–0.60 |

- **Most correct extras repair a split topic** (e.g. git merge joining the code group) rather
  than adding a second subject.
- **Turn-level assignment found none of the long set's second topics** (shed workshop,
  conference talk, solar panels, moving the car).
- **The test is weak:** many second tags (business, games, legal) have no group to join.

**Verdict:** not worth building now. Revisit with real data.

## 6. Interpretability: the group names need work

- **Production naming finds no word for most groups.** It picks words shared by a group's
  titles, so multilingual groups (Food: "Middag med laks", "Борщ", "Pancakes") share none:
  7 of 20 groups had no name, including Food, Fitness, Code and Languages.
- **Better label:** the 2–3 most typical titles of a group (closest to its centroid). This is
  also what a person scans first.

## Recommendation

1. **Representation:** keep the mean of all eligible chunks. Remove the language signal per
   message before averaging (detect language, subtract that language's mean chunk vector).
   Optionally add the title vector. Don't switch to user-only vectors, and don't re-embed with
   `query: `.
2. **Algorithm:** average-linkage hierarchical clustering on the language-removed, centred
   cosine distance.
   - **Topics:** cut at a distance (about 0.85 here), not at a fixed count.
   - **Unsorted:** single conversations go to "Other conversations".
   - **Themes:** a coarser cut (about 0.95) for the mind map's top level.
   - **Not k-means:** worst on every measure and the least stable.
   - **Not Louvain for topics:** keep the kNN graph for the later "related conversations"
     edges.
3. **Names:** show the most typical titles instead of shared title words.
4. **Not now:** multi-topic membership.

**Validate before adopting** (the main risk is that a threshold tuned on 94 synthetic
conversations doesn't transfer):
- **On your own archive, locally and privately:** you tag about 150 conversations (only
  numbers are printed).
- **Then compare three things:** the cut level (t = 0.8–0.95), group sizes, and the share
  left unsorted.
- **Plus a blind side-by-side** of today's map against the new one.
- **What needs measuring:** the cost of average linkage at a few thousand conversations (O(n²)
  memory: about 50 MB in float32 at 5,000). The spike's naive version is O(n³) and was fine
  at 94.

## Limitations

- **The data:**
  - 94 short synthetic conversations;
  - long v0 conversations are built from repeated sentence banks;
  - chat corpus titles are synthetic.
- **No held-out set:** the labels, parameters and listings review all used the same data. The
  sweeps show a plateau (t = 0.85–0.9, B³ F 0.59–0.60) rather than a sharp peak, which helps.
- **Language residue remains for short conversations** (the two leftover groups).
- **Only three languages** (en/no/ru) in the detector; others would need more stopword lists
  or a small detector.
- **Possible effect on search:** removing the language signal might also help cross-language
  search (the M5.0 deepx weakness). Not tested here; a hypothesis for a later spike.
