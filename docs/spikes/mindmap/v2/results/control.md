# Post-hoc control (2026-11-17; after the frozen run, exploratory, not used as a decision rule)

Synthetic data only. Rows marked *rule* use the proposed cut rules, chosen after the v2 results were seen.

Sanity: repDet(λ = none) vs frozen `all [det]`: max difference 0.0e+0.

## Test set (453): topic level

Topic rule picks t = 0.72 (94 groups, 12% unsorted). k-means matched: k = 94 (groups) and k = 149 (groups + unsorted singletons).

| method | setting | groups | largest | unsorted | B³ F | catch-alls | same subject, other language | stability |
|---|---|---|---|---|---|---|---|---|
| k-means (production) | `all`, k = √n ≤ 12 | 12 | 16% | 0% | **0.16** | 12 | 0.01 | 0.48 |
| k-means | `all [det]`, k = 12 | 12 | 19% | 0% | **0.28** | 12 | 0.55 | 0.58 |
| k-means | `all [det]`, k = 94 | 87 | 4% | 2% | **0.43** | 10 | 0.19 | 0.32 |
| k-means | `all [det]`, k = 149 | 115 | 2% | 8% | **0.42** | 6 | 0.13 | 0.31 |
| hierarchical | `all` (no correction), t = 0.72 | 49 | 22% | 4% | **0.35** | 9 | 0.01 | 0.94 |
| hierarchical | `all [det]`, t = 0.72 *rule* | 94 | 5% | 12% | **0.55** | 2 | 0.27 | 0.85 |
| hierarchical | `all [det]` shrunk λ = 200, t = 0.72 *rule* | 102 | 6% | 11% | **0.50** | 4 | 0.20 | 0.88 |
| hierarchical | `all [det]`, t = 0.75 (v2 oracle) | 83 | 6% | 7% | **0.54** | 7 | 0.31 | 0.85 |

## Test set (453): theme level

Theme rule: target 11 groups → t = 0.96.

| method | setting | groups | largest | unsorted | B³ F | catch-alls | same subject, other language | stability |
|---|---|---|---|---|---|---|---|---|
| k-means (production) | `all`, k = √n ≤ 12 | 12 | 16% | 0% | **0.30** | 9 | 0.02 | 0.48 |
| k-means | `all [det]`, k = 11 | 11 | 19% | 0% | **0.50** | 5 | 0.54 | 0.57 |
| hierarchical | `all [det]`, t = 0.96 *rule* | 9 | 21% | 0% | **0.48** | 6 | 0.58 | 0.69 |
| hierarchical | `all [det]`, t = 0.90 (v2 exploratory) | 24 | 16% | 0% | **0.59** | 6 | 0.53 | 0.80 |

## Dev set (94, v1): topic level

Topic rule picks t = 0.79 (25 groups, 14% unsorted). k-means matched: k = 25 (groups) and k = 38 (groups + unsorted singletons).

| method | setting | groups | largest | unsorted | B³ F | catch-alls | same subject, other language | stability |
|---|---|---|---|---|---|---|---|---|
| k-means (production) | `all`, k = √n ≤ 12 | 10 | 23% | 0% | **0.29** | 7 | 0.00 | 0.58 |
| k-means | `all [det]`, k = 12 | 12 | 15% | 0% | **0.39** | 4 | 0.29 | 0.38 |
| k-means | `all [det]`, k = 25 | 24 | 7% | 1% | **0.45** | 1 | 0.21 | 0.43 |
| k-means | `all [det]`, k = 38 | 30 | 6% | 9% | **0.42** | 0 | 0.11 | 0.45 |
| hierarchical | `all` (no correction), t = 0.79 | 18 | 20% | 7% | **0.39** | 2 | 0.01 | 0.96 |
| hierarchical | `all [det]`, t = 0.79 *rule* | 25 | 7% | 14% | **0.51** | 0 | 0.23 | 0.91 |
| hierarchical | `all [det]` shrunk λ = 200, t = 0.79 *rule* | 26 | 7% | 10% | **0.44** | 1 | 0.10 | 0.86 |

## Dev set (94, v1): theme level

Theme rule: target 8 groups → t = 0.97.

| method | setting | groups | largest | unsorted | B³ F | catch-alls | same subject, other language | stability |
|---|---|---|---|---|---|---|---|---|
| k-means (production) | `all`, k = √n ≤ 12 | 10 | 23% | 0% | **0.27** | 7 | 0.00 | 0.58 |
| k-means | `all [det]`, k = 8 | 8 | 15% | 0% | **0.38** | 6 | 0.31 | 0.36 |
| hierarchical | `all [det]`, t = 0.97 *rule* | 8 | 19% | 0% | **0.42** | 4 | 0.38 | 0.72 |
| hierarchical | `all [det]`, t = 0.90 (v2 exploratory) | 19 | 12% | 0% | **0.52** | 2 | 0.31 | 0.78 |

## Topic rule across archive sizes (test-set subsets, `all [det]`)

| n | draw | rule t | groups | unsorted | B³ F rule | B³ F t = 0.75 | B³ F k-means `[det]` matched |
|---|---|---|---|---|---|---|---|
| 100 | 1 | 0.77 | 24 | 15% | 0.66 | 0.71 | 0.54 |
| 100 | 2 | 0.76 | 27 | 15% | 0.63 | 0.63 | 0.53 |
| 100 | 3 | 0.76 | 31 | 15% | 0.63 | 0.64 | 0.57 |
| 200 | 1 | 0.74 | 46 | 15% | 0.58 | 0.59 | 0.46 |
| 200 | 2 | 0.77 | 47 | 14% | 0.57 | 0.58 | 0.48 |
| 200 | 3 | 0.75 | 48 | 14% | 0.60 | 0.60 | 0.51 |
| 300 | 1 | 0.72 | 69 | 14% | 0.58 | 0.57 | 0.46 |
| 300 | 2 | 0.73 | 71 | 15% | 0.56 | 0.54 | 0.47 |
| 300 | 3 | 0.72 | 72 | 12% | 0.56 | 0.56 | 0.47 |

## A tiny language: all English and Norwegian, only m Russian conversations (hierarchical, t = 0.75)

*Joined* = share of the kept Russian conversations (with a same-topic partner in the set) whose group contains a same-topic conversation. Mean of 5 draws.

| m Russian | representation | joined | Russian unsorted | B³ F (all) |
|---|---|---|---|---|
| 3 | `all` (no correction) | 0.00 | 0% | 0.40 |
| 3 | `all [det]` plain | 0.47 | 27% | 0.55 |
| 3 | `all [det]` shrunk λ = 200 | 0.13 | 7% | 0.54 |
| 8 | `all` (no correction) | 0.17 | 0% | 0.39 |
| 8 | `all [det]` plain | 0.75 | 10% | 0.55 |
| 8 | `all [det]` shrunk λ = 200 | 0.28 | 0% | 0.53 |
| 20 | `all` (no correction) | 0.51 | 3% | 0.38 |
| 20 | `all [det]` plain | 0.85 | 5% | 0.56 |
| 20 | `all [det]` shrunk λ = 200 | 0.51 | 3% | 0.52 |
