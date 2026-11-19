# Graph spike: base

Synthetic only. 453 conversations, 2124 chunks; 0 with an added generic message. Gold: 2712 topic-sharing pairs, 1092 of them cross-topic (via a second topic).

Preparation 4568 ms: mean 71 ms, mean [det] 64 ms, max / chamfer 2216 ms, max / chamfer [det] 2127 ms.

## 1. Nearest-neighbour quality (no edge rule)

| representation | P@1 topic | P@3 topic | second topic in top 5 |
|---|---|---|---|
| mean | 0.62 | 0.48 | 0.72 |
| mean [det] | 0.71 | 0.64 | 0.75 |
| max | 0.48 | 0.36 | 0.69 |
| max [det] | 0.60 | 0.52 | 0.70 |
| chamfer [det] | 0.69 | 0.64 | 0.70 |

## 2. Edge rules

*related* = shares a topic or theme; *false* = shares neither; *cross-topic* = shares a topic but primary topics differ (recall over all such gold pairs); *cross-theme* = related across primary themes.

Similarity at the top 0.5% / 1% / 2% of all pairs, mean [det]: 0.41 / 0.35 / 0.30
Similarity at the top 0.5% / 1% / 2% of all pairs, chamfer [det]: 0.30 / 0.27 / 0.24
Similarity at the top 0.5% / 1% / 2% of all pairs, max [det]: 0.41 / 0.38 / 0.34

| representation | rule | edges | mean deg | max deg | isolated | related isolated | largest comp | P topic | P related | false | cross-topic (recall) | cross-theme | cross-lang | one-offs linked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mean | kNN k=3 | 1018 | 4.5 | 20 | 0% | 0% | 100% | 0.37 | 0.60 | **0.40** | 107 (0.10) | 82 | 2% | 100% |
| mean | mutual k=3 | 341 | 1.5 | 3 | 19% | 16% | 9% | 0.56 | 0.77 | **0.23** | 44 (0.04) | 30 | 1% | 55% |
| mean | mutual k=5 | 614 | 2.7 | 5 | 8% | 6% | 67% | 0.46 | 0.72 | **0.28** | 77 (0.07) | 50 | 1% | 76% |
| mean | mutual k=10 | 1359 | 6.0 | 10 | 1% | 1% | 98% | 0.36 | 0.62 | **0.38** | 156 (0.14) | 115 | 2% | 95% |
| mean | top pairs, mean deg 3 | 680 | 3.0 | 30 | 37% | 32% | 20% | 0.33 | 0.52 | **0.48** | 74 (0.07) | 71 | 1% | 33% |
| mean | CSLS mutual k=5 | 871 | 3.8 | 5 | 0% | 0% | 100% | 0.39 | 0.63 | **0.37** | 90 (0.08) | 66 | 2% | 97% |
| mean [det] | kNN k=3 | 1009 | 4.5 | 17 | 0% | 0% | 100% | 0.53 | 0.71 | **0.29** | 114 (0.10) | 67 | 49% | 100% |
| mean [det] | mutual k=3 | 350 | 1.5 | 3 | 16% | 16% | 10% | 0.65 | 0.76 | **0.24** | 40 (0.04) | 24 | 46% | 83% |
| mean [det] | mutual k=5 | 644 | 2.8 | 5 | 7% | 6% | 90% | 0.59 | 0.75 | **0.25** | 78 (0.07) | 47 | 48% | 90% |
| mean [det] | mutual k=10 | 1478 | 6.5 | 10 | 0% | 0% | 100% | 0.51 | 0.70 | **0.30** | 167 (0.15) | 110 | 52% | 98% |
| mean [det] | top pairs, mean deg 3 | 680 | 3.0 | 20 | 28% | 21% | 36% | 0.68 | 0.92 | **0.08** | 92 (0.08) | 38 | 48% | 26% |
| mean [det] | CSLS mutual k=5 | 890 | 3.9 | 5 | 0% | 0% | 100% | 0.53 | 0.69 | **0.31** | 98 (0.09) | 64 | 50% | 98% |
| mean [det] | kNN k=5, mean [det] ≥ 0.3 | 1257 | 5.5 | 21 | 5% | 3% | 93% | 0.56 | 0.79 | **0.21** | 156 (0.14) | 91 | 51% | 81% |
| mean [det] | mutual k=5, mean [det] ≥ 0.3 | 594 | 2.6 | 5 | 11% | 9% | 83% | 0.62 | 0.79 | **0.21** | 76 (0.07) | 45 | 48% | 74% |
| mean [det] | kNN k=5, mean [det] ≥ 0.35 | 866 | 3.8 | 20 | 14% | 11% | 75% | 0.64 | 0.87 | **0.13** | 116 (0.11) | 59 | 50% | 62% |
| mean [det] | mutual k=5, mean [det] ≥ 0.35 | 499 | 2.2 | 5 | 20% | 16% | 48% | 0.67 | 0.85 | **0.15** | 66 (0.06) | 37 | 47% | 55% |
| mean [det] | kNN k=5, mean [det] ≥ 0.4 | 522 | 2.3 | 16 | 33% | 26% | 28% | 0.72 | 0.93 | **0.07** | 74 (0.07) | 30 | 47% | 21% |
| mean [det] | mutual k=5, mean [det] ≥ 0.4 | 361 | 1.6 | 5 | 36% | 29% | 9% | 0.74 | 0.93 | **0.07** | 49 (0.04) | 24 | 45% | 19% |
| mean [det] | kNN k=5, mean [det] ≥ 0.45 | 252 | 1.1 | 10 | 57% | 51% | 7% | 0.79 | 0.96 | **0.04** | 36 (0.03) | 11 | 40% | 5% |
| mean [det] | mutual k=5, mean [det] ≥ 0.45 | 208 | 0.9 | 5 | 58% | 52% | 6% | 0.80 | 0.97 | **0.03** | 29 (0.03) | 11 | 39% | 3% |
| mean [det] | kNN k=5, mean [det] ≥ 0.5 | 96 | 0.4 | 8 | 76% | 73% | 4% | 0.81 | 0.98 | **0.02** | 17 (0.02) | 6 | 36% | 2% |
| mean [det] | mutual k=5, mean [det] ≥ 0.5 | 89 | 0.4 | 5 | 77% | 73% | 4% | 0.82 | 0.99 | **0.01** | 15 (0.01) | 6 | 36% | 0% |
| max | kNN k=3 | 1044 | 4.6 | 22 | 0% | 0% | 100% | 0.28 | 0.48 | **0.52** | 94 (0.09) | 90 | 4% | 100% |
| max | mutual k=3 | 315 | 1.4 | 3 | 26% | 21% | 31% | 0.44 | 0.66 | **0.34** | 45 (0.04) | 34 | 2% | 43% |
| max | mutual k=5 | 555 | 2.5 | 5 | 15% | 10% | 78% | 0.39 | 0.63 | **0.37** | 70 (0.06) | 57 | 3% | 52% |
| max | mutual k=10 | 1145 | 5.1 | 10 | 8% | 5% | 90% | 0.31 | 0.54 | **0.46** | 112 (0.10) | 98 | 6% | 69% |
| max | top pairs, mean deg 3 | 680 | 3.0 | 32 | 31% | 24% | 63% | 0.31 | 0.52 | **0.48** | 75 (0.07) | 77 | 5% | 22% |
| max | CSLS mutual k=5 | 801 | 3.5 | 5 | 2% | 1% | 98% | 0.33 | 0.54 | **0.46** | 83 (0.08) | 74 | 4% | 88% |
| max [det] | kNN k=3 | 1005 | 4.4 | 18 | 0% | 0% | 100% | 0.42 | 0.59 | **0.41** | 106 (0.10) | 76 | 39% | 100% |
| max [det] | mutual k=3 | 354 | 1.6 | 3 | 18% | 15% | 17% | 0.55 | 0.71 | **0.29** | 53 (0.05) | 44 | 30% | 64% |
| max [det] | mutual k=5 | 648 | 2.9 | 5 | 6% | 4% | 91% | 0.48 | 0.65 | **0.35** | 75 (0.07) | 63 | 35% | 86% |
| max [det] | mutual k=10 | 1437 | 6.3 | 10 | 1% | 0% | 99% | 0.42 | 0.61 | **0.39** | 157 (0.14) | 123 | 43% | 95% |
| max [det] | top pairs, mean deg 3 | 680 | 3.0 | 20 | 21% | 16% | 73% | 0.52 | 0.74 | **0.26** | 92 (0.08) | 61 | 38% | 45% |
| max [det] | CSLS mutual k=5 | 893 | 3.9 | 5 | 0% | 0% | 100% | 0.42 | 0.58 | **0.42** | 88 (0.08) | 73 | 39% | 98% |
| max [det] | kNN k=5, max [det] ≥ 0.5 | 71 | 0.3 | 5 | 79% | 76% | 2% | 0.79 | 0.89 | **0.11** | 17 (0.02) | 10 | 14% | 3% |
| max [det] | mutual k=5, max [det] ≥ 0.5 | 71 | 0.3 | 5 | 79% | 76% | 2% | 0.79 | 0.89 | **0.11** | 17 (0.02) | 10 | 14% | 3% |
| max [det] | kNN k=5, max [det] ≥ 0.6 | 10 | 0.0 | 2 | 96% | 96% | 1% | 0.80 | 0.80 | **0.20** | 1 (0.00) | 0 | 13% | 2% |
| max [det] | mutual k=5, max [det] ≥ 0.6 | 10 | 0.0 | 2 | 96% | 96% | 1% | 0.80 | 0.80 | **0.20** | 1 (0.00) | 0 | 13% | 2% |
| max [det] | kNN k=5, max [det] ≥ 0.7 | 0 | 0.0 | 0 | 100% | 100% | 0% | 0.00 | 0.00 | **0.00** | 0 (0.00) | 0 | 0% | 0% |
| max [det] | mutual k=5, max [det] ≥ 0.7 | 0 | 0.0 | 0 | 100% | 100% | 0% | 0.00 | 0.00 | **0.00** | 0 (0.00) | 0 | 0% | 0% |
| chamfer [det] | kNN k=3 | 991 | 4.4 | 15 | 0% | 0% | 100% | 0.54 | 0.71 | **0.29** | 116 (0.11) | 80 | 42% | 100% |
| chamfer [det] | mutual k=3 | 368 | 1.6 | 3 | 16% | 16% | 11% | 0.61 | 0.76 | **0.24** | 46 (0.04) | 29 | 37% | 83% |
| chamfer [det] | mutual k=5 | 682 | 3.0 | 5 | 6% | 6% | 93% | 0.56 | 0.73 | **0.27** | 80 (0.07) | 55 | 40% | 97% |
| chamfer [det] | mutual k=10 | 1533 | 6.8 | 10 | 0% | 0% | 100% | 0.49 | 0.69 | **0.31** | 168 (0.15) | 126 | 46% | 100% |
| chamfer [det] | top pairs, mean deg 3 | 680 | 3.0 | 19 | 24% | 21% | 58% | 0.64 | 0.87 | **0.13** | 97 (0.09) | 48 | 40% | 55% |
| chamfer [det] | CSLS mutual k=5 | 891 | 3.9 | 5 | 0% | 0% | 100% | 0.52 | 0.69 | **0.31** | 91 (0.08) | 68 | 40% | 100% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.25 | 1089 | 4.8 | 16 | 8% | 6% | 90% | 0.57 | 0.79 | **0.21** | 134 (0.12) | 95 | 44% | 83% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.25 | 615 | 2.7 | 5 | 12% | 11% | 85% | 0.60 | 0.78 | **0.22** | 74 (0.07) | 50 | 40% | 78% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.3 | 444 | 2.0 | 14 | 34% | 29% | 18% | 0.68 | 0.89 | **0.11** | 63 (0.06) | 32 | 36% | 31% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.3 | 354 | 1.6 | 5 | 35% | 30% | 13% | 0.69 | 0.88 | **0.12** | 49 (0.04) | 26 | 36% | 31% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.35 | 118 | 0.5 | 9 | 71% | 69% | 5% | 0.75 | 0.92 | **0.08** | 17 (0.02) | 8 | 18% | 10% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.35 | 112 | 0.5 | 5 | 72% | 69% | 5% | 0.75 | 0.91 | **0.09** | 16 (0.01) | 8 | 17% | 10% |
| chamfer [det] | kNN k=5, chamfer [det] ≥ 0.4 | 28 | 0.1 | 4 | 91% | 89% | 2% | 0.89 | 0.96 | **0.04** | 6 (0.01) | 3 | 7% | 2% |
| chamfer [det] | mutual k=5, chamfer [det] ≥ 0.4 | 28 | 0.1 | 4 | 91% | 89% | 2% | 0.89 | 0.96 | **0.04** | 6 (0.01) | 3 | 7% | 2% |

## 4. Evidence passages for mean [det] | kNN k=5, mean [det] ≥ 0.35

Edges whose evidence shows a generic passage: best chunk pair 0 of 866; passage closest to the other conversation's average 0 of 866.

## 5. The floor on smaller archives (`mean [det]`, kNN k=5 with a floor, recomputed per subset)

| n | floor | mean deg | max deg | related isolated | false |
|---|---|---|---|---|---|
| 100 | 0.35 | 0.9 | 5 | 45% | 0.10 |
| 100 | 0.4 | 0.5 | 4 | 61% | 0.06 |
| 200 | 0.35 | 1.8 | 9 | 27% | 0.11 |
| 200 | 0.4 | 1.0 | 7 | 45% | 0.10 |
| 300 | 0.35 | 2.8 | 14 | 16% | 0.11 |
| 300 | 0.4 | 1.6 | 11 | 36% | 0.06 |

## 6. Cost (`mean [det]` vectors, resampled with noise; timing only)

| conversations | one conversation's top 5 (ego view) | ego view with 2nd hop and mutual check (6 rows) | all pairs + kNN (whole graph) |
|---|---|---|---|
| 1000 | 0.8 ms | 6.7 ms | 985 ms |
| 3000 | 1.8 ms | 10.1 ms | 10082 ms |
| 10000 | 10.9 ms | 71.9 ms | skipped |

## 7. Checks of the advisory review

- **Floor 0.35:** 50 of 866 edges involve a one-off; false among edges between labelled conversations: 0.08 (all edges: 0.13).
- **Floor 0.4:** 14 of 522 edges involve a one-off; false among edges between labelled conversations: 0.04 (all edges: 0.07).

| floor | listed per conversation | empty lists (labelled conversations) | related among listed | mutual: share / related | ≥ 0.45: share / related |
|---|---|---|---|---|---|
| 0.35 | 3.0 | 11% | 0.86 | 73% / 0.85 | 34% / 0.96 |
| 0.4 | 1.9 | 26% | 0.93 | 82% / 0.93 | 52% / 0.96 |

- **Second hop (floor 0.35):** per conversation with a list, themes reached 1.79 at one hop and 2.91 with two; 6.5 new conversations at the second hop, 0.89 of them related to the conversation that led there, 0.08 in a theme the first hop didn't reach.
- **Relative floor:** the top 1% of pairs is 0.35 here; it always admits 1% of all pairs, i.e. a mean degree of 0.01 × (n − 1): 4.5 at 453, 30 at 3,000, 100 at 10,000.
- **Evidence with a generic passage:** closest to the other's average 0 of 866; min(closest to the other's, to its own average) 0 of 866.
