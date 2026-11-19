# Knowledge-graph spike: links between related conversations (2026-11-18)

Status: **experiment only.** No production code, schema, UI or dependency changed; no model
downloaded; no real conversation or database opened. Not committed.

**Question:** can the stored multilingual-e5-small chunk vectors give a readable graph of
meaningful links between conversations, including links across topics? Which representation,
which edge rule, what UI?

## Setup

- **Data:** the 453 hand-written synthetic conversations of mind-map spike v2
  (`docs/spikes/mindmap/v2/`: en 252, no 113, ru 88; 53 topics, 102 with a second topic, 58
  one-offs). Its labels are the reference: *related* = shares a topic or theme; *cross-topic* =
  shares a topic through a second topic; *false* = shares neither (every link from a one-off
  counts as false).
- **Stress variant** (`generic.mjs`): 173 conversations (40%) get one extra generic assistant
  message in their language ("I hope this helps! If you have any other questions…").
- **Embeddings:** production chunker and inference child (`embed.mts`; vectors in the session
  scratchpad, int8 round-trip as stored).
- **Representations:**
  - `mean`: production conversation vector (average of long passages), centred;
  - `mean [det]`: the same with each language's average removed first (as `tree-map.ts`);
  - `max` and `max [det]`: best passage pair;
  - `chamfer [det]`: average best match per passage, both ways.
- **Edge rules:** kNN, mutual kNN (k = 3, 5, 10), global top pairs, CSLS (hubness-corrected)
  mutual kNN, and kNN with an absolute similarity floor.
- **Reproduce:** the first two commands regenerate the synthetic datasets: the mind-map v2
  set (`conversations.json` isn't committed; see `../mindmap/v2/README.md`) and the
  generic-conversation set.
  ```
  node docs/spikes/mindmap/v2/build.mjs
  node docs/spikes/graph/generic.mjs <scratch>/generic-convs.json
  fnm exec --using=24 -- node docs/spikes/graph/embed.mts docs/spikes/mindmap/v2/conversations.json <scratch>/v2.json
  fnm exec --using=24 -- node docs/spikes/graph/embed.mts <scratch>/generic-convs.json <scratch>/generic.json
  EXAMPLES="mean [det] | kNN k=5, mean [det] ≥ 0.35;max | mutual k=5" \
    fnm exec --using=24 -- node docs/spikes/graph/graph.mts docs/spikes/mindmap/v2/conversations.json <scratch>/v2.json base
  fnm exec --using=24 -- node docs/spikes/graph/graph.mts <scratch>/generic-convs.json <scratch>/generic.json generic <scratch>/generic-convs.generic.json
  ```
  Output: `results/metrics-*.md` (all tables), `results/edges-*.md` (every edge, with the passages).

## Findings

### 1. Representation: the language-corrected average wins and resists boilerplate

| Representation | P@1 topic | P@3 topic | P@1 with boilerplate | Related links across languages* |
|---|---|---|---|---|
| `mean` | 0.62 | 0.48 | 0.59 | 1–2% |
| **`mean [det]`** | **0.71** | **0.64** | **0.68** | **≈ 50%** |
| `max` | 0.48 | 0.36 | 0.29 | 2–6% |
| `max [det]` | 0.60 | 0.52 | 0.39 | 30–43% |
| `chamfer [det]` | 0.69 | 0.64 | 0.53 | 37–46% |

\* Share of related links that join conversations in different languages.

- **Without language correction there are almost no cross-language links.**
- **Best-passage similarity is fragile.** Identical boilerplate scores 1.00 and links anything:
  false links at mutual k = 5 rise from 37% to 67%; 56% of those links rest on a boilerplate
  passage. Even without boilerplate, short chatter links "Jupyter kernel keeps dying" ↔
  "Kitchen tap dripping".
- **Chamfer** matches the average on clean data but degrades with boilerplate (false 27% → 39%).

### 2. Edges: top-k neighbours with an absolute similarity floor

| Rule (`mean [det]`) | Mean degree | Max degree | Related conversations left isolated | False (all) | False (labelled only) | One-offs linked |
|---|---|---|---|---|---|---|
| kNN k = 3 | 4.5 | 17 | 0% | 0.29 | – | 100% |
| mutual k = 5 | 2.8 | 5 | 6% | 0.25 | – | 90% |
| CSLS mutual k = 5 | 3.9 | 5 | 0% | 0.31 | – | 98% |
| top pairs (mean degree 3) | 3.0 | 20 | 21% | 0.08 | – | 26% |
| **kNN k = 5, similarity ≥ 0.35** | 3.8 | 20 | 11% | 0.13 | **0.08** | 62% |
| **kNN k = 5, similarity ≥ 0.40** | 2.3 | 16 | 26% | 0.07 | **0.04** | 21% |

- **Any rule without a floor links every one-off** to something: rank-only rules (kNN, mutual,
  CSLS) always find neighbours. The floor does nearly all the precision work; mutual kNN on
  top of it adds little.
- **The floor holds on smaller archives.** On random subsets (100, 200, 300 conversations,
  recomputed), false links stay at about 0.10 at 0.35. Coverage grows with size: 45% of related
  conversations isolated at 100, 16% at 300.
- **Per conversation** (what one view shows: its own top 5 above 0.35): 3.0 links on average,
  86% related; 11% of labelled conversations have none. **Similarity ≥ 0.45 is a useful
  "strong" tier** (34% of links, 96% related). Mutual-neighbour status is not (73% of links,
  85% related, no better than the rest).
- **Second hop:** about 6 more conversations, 89% related to the conversation that led there,
  but only 8% in a theme the first hop didn't reach. It adds breadth, not many surprises.
- **A relative floor (top 1% of pairs) doesn't scale:** it admits 1% of all pairs, so mean
  degree grows with n (about 30 at 3,000 conversations).

### 3. What the links look like (`mean [det]`, kNN k = 5, ≥ 0.35)

**Good links across topics and themes** (supported by the labels):
- "Trail running shoes or road shoes" ↔ "Hiking boots or trail runners" (0.53)
- "Сколько белка нужно для роста мышц" ↔ "Calorie counting for weight loss" (0.50, ru ↔ en)
- "Groupby with several aggregations" ↔ "Spreadsheet for tracking shared flat costs" (0.41,
  code ↔ money)
- "Anxiety before presentations" ↔ "Exam anxiety in driving test" (0.43, work ↔ study)
- "Ремонт в съёмной квартире" ↔ "Landlord entering without notice" (0.42, ru ↔ en)
- "Insulating an attic" ↔ "Home studio acoustic treatment" (0.43, home ↔ music)

**Unlabelled but sensible** (counted as false; read by hand, a 38-link sample of the false ones:
about 25 sensible, 8 weak, 5 wrong):
- "Why is the sky blue" ↔ "Black hole in simple words"
- "Hvem var Harald Hårfagre" ↔ "Romerrikets fall"
- "Organisere digitale bilder" ↔ "Building a portfolio site as a photographer"
- "Websocket disconnects every 60 seconds" ↔ "Почему падает скорость интернета вечером"
- "Index funds for a beginner" ↔ "Explain inflation like I'm 12"
- "Name ideas for a fantasy kingdom" ↔ "Help me name a cat"

**Wrong:**
- "Origin of the word salary" ↔ "Hvorfor er sjøvann salt" (one shared word)
- "Чай пуэр как заваривать" ↔ "Как начать работать с эпоксидной смолой"
- "Door won't close properly" ↔ "Плохо сплю после переезда"
- "Difficult conversation with a colleague" ↔ "Choosing a thesis topic"
- With `max`: "Jupyter kernel keeps dying" ↔ "Kitchen tap dripping"; with boilerplate, dozens
  of links at 1.00 through "Of course! To summarise, the key points are above…"

### 4. "Why linked": the evidence passages

For each link, the passage in each conversation closest to the *other* conversation's average.
It needs no global passage comparison.

| Evidence passage pair shows boilerplate | Best passage pair | Closest to the other's average | min(closest to other's, own average) |
|---|---|---|---|
| Boilerplate variant, 795 links | 75 | 28 | 21 |

The rest would need near-duplicate passage detection across conversations, which isn't tested here.

### 5. Cost (`mean [det]` vectors, resampled; JavaScript on the development Mac)

| Conversations | One conversation's top 5 | With second hop (6 rows) | Whole graph (all pairs) |
|---|---|---|---|
| 1,000 | 0.7 ms | 8 ms | 1.0 s |
| 3,000 | 1.7 ms | 9 ms | 9.9 s (unoptimised) |
| 10,000 | 11 ms | 76 ms | not run |

The language-corrected vectors themselves need one pass over the chunks plus reading message text
for language detection (as `/map?mode=tree` does), so they should be cached under the vector
cache key. Once cached, a single conversation's neighbourhood is cheap on request. The whole
graph is quadratic.

### 6. Advisory review (Fable) and where the evidence disagreed

| Advice | Evidence |
|---|---|
| Use `mean [det]` with a 0.35–0.40 floor | Agreed |
| One-offs inflate the false rate | Confirmed: 0.08 / 0.04 among labelled conversations |
| One view can only cheaply show its own top 5 (not who lists it) | Confirmed; recommendation adjusted |
| Cache the corrected vectors (my "no cache needed" was wrong) | Agreed: language detection reads message text |
| Mark mutual neighbours as "strong" | **Rejected:** 73% of links, no more precise; similarity ≥ 0.45 works (96%) |
| Rank by min(sim to other, sim to own average) to drop boilerplate evidence | Partly: 28 → 21 of 795 |
| Fall back to a relative floor (top 1% of pairs) | **Rejected:** mean degree grows with n |
| List before graph; second hop adds little | Mostly supported: 8% of second-hop conversations reach a new theme |
| Collapse near-duplicates (regenerations) | Not tested: no near-duplicates in the data |

## Recommendation: a minimal "related conversations" MVP

**Model:**
- **Representation:** `mean [det]` conversation vectors, shared with `/map?mode=tree` (one
  helper, cached under the vector cache key).
- **Links:** a conversation's own top 5 with similarity ≥ 0.35, computed on request.
  - Tiers: **strong** ≥ 0.45, **possible** 0.35–0.45.
  - "No close conversations" when none pass the floor.
- **Evidence:** per link, one passage from each side, chosen by min(closest to the other's
  average, closest to its own average). Shown as plain text, with a link to the message.
- **Flags:** "across topics" when the neighbour is in another experimental topic, and "possible
  duplicate" at ≥ 0.9 (threshold untested).

**Slices:**
1. **"Related conversations" on the conversation page.** Server-rendered list, works without
   JavaScript.
2. **Ego graph** (`/graph?focus=<id>`, React Flow with a hand-placed radial layout):
   - the focus conversation and its links;
   - clicking a neighbour expands its links (the second hop, on request), or re-centres on it;
   - the list from slice 1 serves as its accessible equivalent.

**Not in the MVP:**
- a whole-archive graph (quadratic, unreadable, competes with the map);
- new dependencies (no force-layout library);
- precomputed or stored edges.

**How it complements map and search:**
- **Search:** what you ask for.
- **Map:** what topics exist.
- **Related:** what this conversation connects to, including across topics and languages,
  which neither of the others shows.

## Limitations

- One author wrote all conversations and labels. The hand reading of links is mine.
- The floors were chosen and judged on the same data.
- **Synthetic conversations are short and stay on topic** (about 4.7 passages each). Real ones
  drift, and an average can wash out the main subject.
- **Boilerplate is modelled as one separate message,** whereas real ChatGPT phrases sit inside
  long answers. Code blocks aren't modelled.
- **No near-duplicates** (regenerated or reused prompts), which would fill the top 5 at ≥ 0.9.
- **The floor is untested above 453 conversations and on a skewed mix** (for example a mostly
  coding archive). Centring makes similarity depend on the archive's mix.
- **Before relying on 0.35,** measure similarity quantiles and degrees (numbers only) on the
  owner's archive.
