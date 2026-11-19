# Graph spike: generic

Synthetic only. 453 conversations, 2297 chunks; 173 with an added generic message. Gold: 2712 topic-sharing pairs, 1092 of them cross-topic (via a second topic).

Preparation 5473 ms: mean 75 ms, mean [det] 64 ms, max / chamfer 2691 ms, max / chamfer [det] 2525 ms.

## 1. Nearest-neighbour quality (no edge rule)

| representation | P@1 topic | P@3 topic | second topic in top 5 |
|---|---|---|---|
| mean | 0.59 | 0.46 | 0.71 |
| mean [det] | 0.68 | 0.63 | 0.74 |
| max | 0.29 | 0.22 | 0.48 |
| max [det] | 0.39 | 0.33 | 0.48 |
| chamfer [det] | 0.53 | 0.50 | 0.65 |

## 2. Edge rules

*related* = shares a topic or theme; *false* = shares neither; *cross-topic* = shares a topic but primary topics differ (recall over all such gold pairs); *cross-theme* = related across primary themes.

Similarity at the top 0.5% / 1% / 2% of all pairs, mean [det]: 0.40 / 0.35 / 0.29
Similarity at the top 0.5% / 1% / 2% of all pairs, chamfer [det]: 0.32 / 0.29 / 0.26
Similarity at the top 0.5% / 1% / 2% of all pairs, max [det]: 0.98 / 0.97 / 0.56

| representation | rule | edges | mean deg | max deg | isolated | related isolated | largest comp | P topic | P related | false | cross-topic (recall) | cross-theme | cross-lang | one-offs linked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mean | kNN k=3 | 1027 | 4.5 | 21 | 0% | 0% | 100% | 0.35 | 0.58 | **0.42** | 104 (0.10) | 78 | 2% | 100% |
| mean | mutual k=3 | 332 | 1.5 | 3 | 21% | 17% | 8% | 0.54 | 0.76 | **0.24** | 39 (0.04) | 28 | 1% | 50% |
| mean | mutual k=5 | 595 | 2.6 | 5 | 11% | 7% | 64% | 0.45 | 0.71 | **0.29** | 76 (0.07) | 49 | 1% | 66% |
| mean | mutual k=10 | 1307 | 5.8 | 10 | 2% | 1% | 96% | 0.36 | 0.62 | **0.38** | 148 (0.14) | 109 | 1% | 91% |
| mean | top pairs, mean deg 3 | 680 | 3.0 | 39 | 46% | 42% | 20% | 0.26 | 0.43 | **0.57** | 65 (0.06) | 68 | 0% | 26% |
| mean | CSLS mutual k=5 | 853 | 3.8 | 5 | 1% | 0% | 99% | 0.38 | 0.62 | **0.38** | 93 (0.09) | 70 | 2% | 97% |
| mean [det] | kNN k=3 | 1016 | 4.5 | 17 | 0% | 0% | 100% | 0.52 | 0.70 | **0.30** | 115 (0.11) | 68 | 50% | 100% |
| mean [det] | mutual k=3 | 343 | 1.5 | 3 | 21% | 21% | 12% | 0.63 | 0.75 | **0.25** | 43 (0.04) | 26 | 44% | 78% |
| mean [det] | mutual k=5 | 646 | 2.9 | 5 | 9% | 8% | 87% | 0.60 | 0.75 | **0.25** | 83 (0.08) | 53 | 50% | 84% |
| mean [det] | mutual k=10 | 1458 | 6.4 | 10 | 0% | 1% | 100% | 0.50 | 0.70 | **0.30** | 174 (0.16) | 120 | 53% | 100% |
| mean [det] | top pairs, mean deg 3 | 680 | 3.0 | 21 | 27% | 22% | 38% | 0.64 | 0.90 | **0.10** | 96 (0.09) | 39 | 49% | 40% |
| mean [det] | CSLS mutual k=5 | 885 | 3.9 | 5 | 0% | 0% | 100% | 0.53 | 0.69 | **0.31** | 94 (0.09) | 64 | 51% | 100% |
| mean [det] | kNN k=5, mean [det] ≥ 0.3 | 1188 | 5.2 | 21 | 6% | 5% | 93% | 0.56 | 0.79 | **0.21** | 152 (0.14) | 85 | 51% | 84% |
| mean [det] | mutual k=5, mean [det] ≥ 0.3 | 586 | 2.6 | 5 | 15% | 13% | 79% | 0.65 | 0.80 | **0.20** | 79 (0.07) | 49 | 50% | 74% |
| mean [det] | kNN k=5, mean [det] ≥ 0.35 | 795 | 3.5 | 20 | 18% | 14% | 70% | 0.64 | 0.87 | **0.13** | 108 (0.10) | 50 | 50% | 50% |
| mean [det] | mutual k=5, mean [det] ≥ 0.35 | 480 | 2.1 | 5 | 24% | 20% | 38% | 0.69 | 0.85 | **0.15** | 63 (0.06) | 35 | 47% | 47% |
| mean [det] | kNN k=5, mean [det] ≥ 0.4 | 449 | 2.0 | 16 | 38% | 32% | 17% | 0.71 | 0.92 | **0.08** | 60 (0.05) | 22 | 45% | 21% |
| mean [det] | mutual k=5, mean [det] ≥ 0.4 | 331 | 1.5 | 5 | 41% | 35% | 12% | 0.74 | 0.92 | **0.08** | 40 (0.04) | 19 | 45% | 19% |
| mean [det] | kNN k=5, mean [det] ≥ 0.45 | 221 | 1.0 | 10 | 58% | 52% | 6% | 0.77 | 0.95 | **0.05** | 36 (0.03) | 10 | 37% | 5% |
| mean [det] | mutual k=5, mean [det] ≥ 0.45 | 184 | 0.8 | 5 | 60% | 54% | 5% | 0.80 | 0.96 | **0.04** | 27 (0.02) | 10 | 37% | 3% |
| mean [det] | kNN k=5, mean [det] ≥ 0.5 | 82 | 0.4 | 8 | 81% | 78% | 4% | 0.78 | 0.98 | **0.02** | 13 (0.01) | 5 | 36% | 2% |
| mean [det] | mutual k=5, mean [det] ≥ 0.5 | 75 | 0.3 | 5 | 81% | 78% | 3% | 0.79 | 0.99 | **0.01** | 11 (0.01) | 5 | 36% | 0% |
| max | kNN k=3 | 1121 | 4.9 | 18 | 0% | 0% | 100% | 0.19 | 0.34 | **0.66** | 65 (0.06) | 63 | 4% | 100% |
| max | mutual k=3 | 238 | 1.1 | 3 | 39% | 36% | 4% | 0.21 | 0.35 | **0.65** | 9 (0.01) | 6 | 2% | 41% |
| max | mutual k=5 | 463 | 2.0 | 5 | 20% | 17% | 19% | 0.18 | 0.33 | **0.67** | 22 (0.02) | 16 | 3% | 59% |
| max | mutual k=10 | 1070 | 4.7 | 10 | 9% | 7% | 52% | 0.13 | 0.27 | **0.73** | 44 (0.04) | 42 | 4% | 76% |
| max | top pairs, mean deg 3 | 680 | 3.0 | 20 | 64% | 63% | 5% | 0.02 | 0.09 | **0.91** | 11 (0.01) | 21 | 0% | 31% |
| max | CSLS mutual k=5 | 809 | 3.6 | 5 | 3% | 2% | 60% | 0.18 | 0.34 | **0.66** | 37 (0.03) | 32 | 6% | 93% |
| max [det] | kNN k=3 | 1060 | 4.7 | 15 | 0% | 0% | 100% | 0.29 | 0.42 | **0.58** | 81 (0.07) | 62 | 34% | 100% |
| max [det] | mutual k=3 | 299 | 1.3 | 3 | 24% | 22% | 4% | 0.25 | 0.37 | **0.63** | 19 (0.02) | 17 | 29% | 60% |
| max [det] | mutual k=5 | 552 | 2.4 | 5 | 11% | 9% | 38% | 0.22 | 0.34 | **0.66** | 27 (0.02) | 24 | 31% | 76% |
| max [det] | mutual k=10 | 1255 | 5.5 | 10 | 1% | 1% | 61% | 0.20 | 0.33 | **0.67** | 59 (0.05) | 61 | 38% | 97% |
| max [det] | top pairs, mean deg 3 | 680 | 3.0 | 20 | 66% | 66% | 5% | 0.03 | 0.10 | **0.90** | 10 (0.01) | 20 | 0% | 31% |
| max [det] | CSLS mutual k=5 | 878 | 3.9 | 5 | 0% | 0% | 62% | 0.25 | 0.38 | **0.62** | 48 (0.04) | 45 | 41% | 100% |
| max [det] | kNN k=5, max [det] ≥ 0.5 | 626 | 2.8 | 14 | 49% | 47% | 18% | 0.10 | 0.16 | **0.84** | 17 (0.02) | 20 | 8% | 40% |
| max [det] | mutual k=5, max [det] ≥ 0.5 | 327 | 1.4 | 5 | 56% | 54% | 4% | 0.08 | 0.15 | **0.85** | 4 (0.00) | 7 | 4% | 36% |
| max [det] | kNN k=5, max [det] ≥ 0.6 | 577 | 2.5 | 14 | 59% | 59% | 5% | 0.04 | 0.10 | **0.90** | 8 (0.01) | 14 | 0% | 38% |
| max [det] | mutual k=5, max [det] ≥ 0.6 | 302 | 1.3 | 5 | 63% | 62% | 4% | 0.04 | 0.10 | **0.90** | 3 (0.00) | 6 | 0% | 34% |
| max [det] | kNN k=5, max [det] ≥ 0.7 | 568 | 2.5 | 14 | 62% | 62% | 5% | 0.03 | 0.09 | **0.91** | 8 (0.01) | 14 | 0% | 36% |
| max [det] | mutual k=5, max [det] ≥ 0.7 | 297 | 1.3 | 5 | 64% | 64% | 4% | 0.03 | 0.08 | **0.92** | 3 (0.00) | 6 | 0% | 33% |
| chamfer [det] | kNN k=3 | 1009 | 4.5 | 17 | 0% | 0% | 100% | 0.43 | 0.60 | **0.40** | 103 (0.09) | 83 | 38% | 100% |
| chamfer [det] | mutual k=3 | 350 | 1.5 | 3 | 19% | 17% | 21% | 0.48 | 0.65 | **0.35** | 39 (0.04) | 35 | 28% | 67% |
| chamfer [det] | mutual k=5 | 650 | 2.9 | 5 | 7% | 6% | 89% | 0.44 | 0.61 | **0.39** | 61 (0.06) | 52 | 34% | 90% |
| chamfer [det] | mutual k=10 | 1455 | 6.4 | 10 | 0% | 0% | 100% | 0.38 | 0.56 | **0.44** | 126 (0.12) | 97 | 40% | 98% |
| chamfer [det] | top pairs, mean deg 3 | 680 | 3.0 | 20 | 26% | 23% | 62% | 0.38 | 0.56 | **0.44** | 58 (0.05) | 42 | 29% | 52% |
| chamfer [det] | CSLS mutual k=5 | 880 | 3.9 | 5 | 0% | 1% | 100% | 0.41 | 0.58 | **0.42** | 75 (0.07) | 65 | 39% | 100% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.25 | 1262 | 5.6 | 20 | 5% | 4% | 94% | 0.42 | 0.61 | **0.39** | 129 (0.12) | 95 | 40% | 83% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.25 | 610 | 2.7 | 5 | 11% | 9% | 83% | 0.45 | 0.62 | **0.38** | 59 (0.05) | 50 | 33% | 74% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.3 | 710 | 3.1 | 19 | 23% | 19% | 70% | 0.40 | 0.58 | **0.42** | 64 (0.06) | 48 | 32% | 55% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.3 | 455 | 2.0 | 5 | 26% | 23% | 62% | 0.43 | 0.61 | **0.39** | 44 (0.04) | 40 | 27% | 53% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.35 | 233 | 1.0 | 16 | 57% | 55% | 21% | 0.36 | 0.54 | **0.46** | 22 (0.02) | 21 | 10% | 31% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.35 | 194 | 0.9 | 5 | 58% | 57% | 8% | 0.41 | 0.60 | **0.40** | 20 (0.02) | 20 | 9% | 31% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.4 | 63 | 0.3 | 10 | 84% | 83% | 3% | 0.44 | 0.56 | **0.44** | 8 (0.01) | 7 | 9% | 14% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.4 | 58 | 0.3 | 5 | 84% | 84% | 2% | 0.48 | 0.60 | **0.40** | 8 (0.01) | 7 | 9% | 12% |

## 3. Generic boilerplate

| representation | rule | edges whose best chunk pair has a generic chunk | of those, false | false edges overall |
|---|---|---|---|---|
| max | mutual k=5 | 257 of 463 (56%) | 231 | 309 (67%) |
| max | CSLS mutual k=5 | 319 of 809 (39%) | 285 | 537 (66%) |
| max [det] | mutual k=5 | 297 of 552 (54%) | 272 | 362 (66%) |
| max [det] | CSLS mutual k=5 | 339 of 878 (39%) | 310 | 540 (62%) |
| chamfer [det] | mutual k=5 | 239 of 650 (37%) | 158 | 256 (39%) |
| chamfer [det] | CSLS mutual k=5 | 276 of 880 (31%) | 184 | 369 (42%) |

## 4. Evidence passages for mean [det] | kNN k=5, mean [det] ≥ 0.35

Edges whose evidence shows a generic passage: best chunk pair 75 of 795; passage closest to the other conversation's average 28 of 795.

## 5. The floor on smaller archives (`mean [det]`, kNN k=5 with a floor, recomputed per subset)

| n | floor | mean deg | max deg | related isolated | false |
|---|---|---|---|---|---|
| 100 | 0.35 | 0.8 | 5 | 49% | 0.12 |
| 100 | 0.4 | 0.5 | 4 | 65% | 0.08 |
| 200 | 0.35 | 1.7 | 9 | 29% | 0.13 |
| 200 | 0.4 | 0.9 | 8 | 50% | 0.12 |
| 300 | 0.35 | 2.6 | 15 | 19% | 0.12 |
| 300 | 0.4 | 1.4 | 11 | 40% | 0.08 |

## 6. Cost (`mean [det]` vectors, resampled with noise; timing only)

| conversations | one conversation's top 5 (ego view) | ego view with 2nd hop and mutual check (6 rows) | all pairs + kNN (whole graph) |
|---|---|---|---|
| 1000 | 0.7 ms | 6.4 ms | 1085 ms |
| 3000 | 1.8 ms | 9.3 ms | 9883 ms |
| 10000 | 12.0 ms | 69.8 ms | skipped |

## 7. Checks of the advisory review

- **Floor 0.35:** 40 of 795 edges involve a one-off; false among edges between labelled conversations: 0.08 (all edges: 0.13).
- **Floor 0.4:** 16 of 449 edges involve a one-off; false among edges between labelled conversations: 0.05 (all edges: 0.08).

| floor | listed per conversation | empty lists (labelled conversations) | related among listed | mutual: share / related | ≥ 0.45: share / related |
|---|---|---|---|---|---|
| 0.35 | 2.8 | 14% | 0.86 | 75% / 0.85 | 32% / 0.96 |
| 0.4 | 1.7 | 32% | 0.92 | 85% / 0.92 | 52% / 0.96 |

- **Second hop (floor 0.35):** per conversation with a list, themes reached 1.78 at one hop and 2.84 with two; 6.3 new conversations at the second hop, 0.88 of them related to the conversation that led there, 0.09 in a theme the first hop didn't reach.
- **Relative floor:** the top 1% of pairs is 0.35 here; it always admits 1% of all pairs, i.e. a mean degree of 0.01 × (n − 1): 4.5 at 453, 30 at 3,000, 100 at 10,000.
- **Evidence with a generic passage:** closest to the other's average 28 of 795; min(closest to the other's, to its own average) 21 of 795.
