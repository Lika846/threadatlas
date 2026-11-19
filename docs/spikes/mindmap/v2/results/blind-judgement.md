# Blind reading of the group listings (titles only, before the labelled listings were opened)

Read from `blind-groups.md`. Clear = I can name the group and would keep it; defensible = mixed but a reader
would accept the grouping; poor = unrelated subjects or one language with mixed subjects.
Same author as the data and labels, so this is a sanity check, not an independent judgement.

| listing | groups | clear | defensible | poor | notes |
|---|---|---|---|---|---|
| A: k-means (production) | 12 | 1 | 3 | 8 | Four groups are one language each (Russian ×2, Norwegian ×2) with mixed subjects; the English ones mix food, fitness and home; only the English code group is clear. |
| B: hierarchical t=0.7 @ all+title [det] | 117 (+73 unsorted) | ≈75 | ≈30 | ≈12 | Most groups are small, sensible and multilingual (cats, dogs, running, sleep, taxes, city trips, interviews, elderly parents…). Poor: a group of four "New chat" titles, title-phrasing pairs ("Packing light for two weeks" + "Potty training in a week", "Espresso machine for beginners" + "Sewing machine for beginners"), Norwegian-only leftovers. Too fine for a map's top level. |
| C: Louvain k=15 γ=3 @ all+title [det] | 19 (0 unsorted) | 16 | 3 | 0 | Reads like a list of themes: web code, data, food, money, career, home, fitness, writing, family, garden, pets, travel, learning, crafts, network. Defensible: no/ru code kept apart from English code; a "science questions" group that also took protein and water questions; study + thesis + CV writing together. One-offs are absorbed into groups. |

## Added after the frozen run: the recommended setting, read blind

Listing `blind-groups-recommended.md` (hierarchical t=0.75 @ all [det], no titles). I read it from
titles only, after the frozen listings but before opening the labelled `groups-recommended.md`.

| listing | groups | clear | defensible | poor | notes |
|---|---|---|---|---|---|
| D: hierarchical t=0.75 @ all [det] | 83 (+7% unsorted) | ≈ 50 | ≈ 20 | ≈ 13 | Large, clear multilingual topics: data code (28), baking and dinners (23), job applications and interviews (19), money (17), garden (15), fitness (14), web code, DevOps, travel, pets, nutrition, stress. Only six groups are a single language, and each of those is coherent (for example two Norwegian renting complaints). Poor groups are mostly pairs: one-off trivia linked by a word ("Origin of the word salary" + "Hvorfor er sjøvann salt"), "Pakke kjøkkenet" + "Sudoku strategy", "Baguettes keep spreading flat" + "Sleeping bag for cold nights", two untitled conversations each paired with a one-off, and one mixed group (tea, matcha, shower mould, wobbly chair, epoxy, wine stain). |
