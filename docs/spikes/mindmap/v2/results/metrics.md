# Mind-map spike v2 results

Test set: 453 conversations (en 252, no 113, ru 88); dev set: 94.

Frozen detector, per message, on the test set: 1406/1414 correct (99%). Errors: ru→en 2, no→en 6.

## 1. Test set, topic level (fine groups vs topic labels)

| method | setting | groups | largest | unsorted | B³ P | B³ R | **B³ F** | intruders | catch-alls | 1-lang residue | one-offs unsorted | same subject, other lang | diff subject, same lang | stability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| k-means (production) | k=12, no correction | 12 | 16% | 0% | 0.10 | 0.40 | **0.16** | 0.83 | 12 | 12 | 0% | 0.01 | 0.21 | 0.48 |
| hierarchical @ all [det] | (a) fixed: t=0.85 | 38 | 16% | 1% | 0.34 | 0.64 | **0.45** | 0.58 | 17 | 1 | 3% | 0.50 | 0.06 | 0.79 |
| hierarchical @ all [det] | (b) oracle: t=0.75 | 83 | 6% | 7% | 0.61 | 0.49 | **0.54** | 0.37 | 7 | 0 | 19% | 0.31 | 0.01 | 0.85 |
| hierarchical @ all [det] | (c) label-free: t=0.7 | 98 | 5% | 16% | 0.75 | 0.41 | **0.53** | 0.27 | 2 | 1 | 38% | 0.24 | 0.01 | 0.87 |
| Louvain @ all [det] | (a) fixed: k=10 γ=1.5 | 12 | 15% | 0% | 0.21 | 0.73 | **0.32** | 0.69 | 10 | 0 | 0% | 0.63 | 0.08 | 0.84 |
| Louvain @ all [det] | (b) oracle: k=6 γ=4 | 24 | 7% | 0% | 0.34 | 0.64 | **0.44** | 0.55 | 15 | 0 | 0% | 0.50 | 0.03 | 0.72 |
| Louvain @ all [det] | (c) label-free: k=15 γ=2 | 13 | 14% | 0% | 0.22 | 0.73 | **0.34** | 0.68 | 11 | 0 | 0% | 0.62 | 0.07 | 0.86 |
| hierarchical @ all+title [det] | (a) fixed: t=0.85 | 46 | 11% | 1% | 0.42 | 0.58 | **0.49** | 0.50 | 10 | 3 | 7% | 0.44 | 0.03 | 0.77 |
| hierarchical @ all+title [det] | (b) oracle: t=0.8 | 70 | 6% | 4% | 0.53 | 0.48 | **0.50** | 0.42 | 7 | 5 | 12% | 0.30 | 0.02 | 0.79 |
| hierarchical @ all+title [det] | (c) label-free: t=0.7 | 117 | 2% | 16% | 0.77 | 0.34 | **0.47** | 0.24 | 2 | 3 | 34% | 0.14 | 0.00 | 0.88 |
| Louvain @ all+title [det] | (a) fixed: k=10 γ=1.5 | 12 | 21% | 0% | 0.21 | 0.78 | **0.33** | 0.71 | 10 | 0 | 0% | 0.67 | 0.11 | 0.76 |
| Louvain @ all+title [det] | (b) oracle: k=15 γ=4 | 23 | 8% | 0% | 0.33 | 0.65 | **0.44** | 0.57 | 15 | 2 | 0% | 0.49 | 0.04 | 0.80 |
| Louvain @ all+title [det] | (c) label-free: k=15 γ=3 | 19 | 9% | 0% | 0.31 | 0.69 | **0.42** | 0.58 | 12 | 1 | 0% | 0.53 | 0.05 | 0.82 |

Full grids:

| method | setting | groups | largest | unsorted | B³ P | B³ R | **B³ F** | intruders | catch-alls | 1-lang residue | one-offs unsorted | same subject, other lang | diff subject, same lang | stability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all [det] | hier t=0.7 | 98 | 5% | 16% | 0.75 | 0.41 | **0.53** | 0.27 | 2 | 1 | 38% | 0.24 | 0.01 | 0.87 |
| all [det] | hier t=0.75 | 83 | 6% | 7% | 0.61 | 0.49 | **0.54** | 0.37 | 7 | 0 | 19% | 0.31 | 0.01 | 0.85 |
| all [det] | hier t=0.8 | 63 | 8% | 2% | 0.50 | 0.55 | **0.52** | 0.44 | 9 | 0 | 5% | 0.39 | 0.02 | 0.85 |
| all [det] | hier t=0.85 | 38 | 16% | 1% | 0.34 | 0.64 | **0.45** | 0.58 | 17 | 1 | 3% | 0.50 | 0.06 | 0.79 |
| all [det] | hier t=0.9 | 24 | 16% | 0% | 0.26 | 0.69 | **0.37** | 0.66 | 14 | 1 | 2% | 0.57 | 0.08 | 0.80 |
| all [det] | hier t=0.95 | 12 | 21% | 0% | 0.17 | 0.74 | **0.28** | 0.75 | 10 | 1 | 0% | 0.63 | 0.13 | 0.75 |
| all [det] | hier t=1 | 4 | 46% | 0% | 0.08 | 0.82 | **0.15** | 0.88 | 4 | 0 | 0% | 0.73 | 0.31 | 0.67 |
| all [det] | hier t=1.05 | 1 | 100% | 0% | 0.03 | 0.99 | **0.06** | 0.95 | 1 | 0 | 0% | 1.00 | 1.00 | 1.00 |
| all [det] | louvain k=6 γ=1 | 12 | 14% | 0% | 0.21 | 0.73 | **0.33** | 0.69 | 10 | 0 | 0% | 0.62 | 0.08 | 0.79 |
| all [det] | louvain k=6 γ=1.5 | 13 | 12% | 0% | 0.22 | 0.72 | **0.34** | 0.67 | 11 | 0 | 0% | 0.60 | 0.07 | 0.77 |
| all [det] | louvain k=6 γ=2 | 19 | 9% | 0% | 0.30 | 0.69 | **0.42** | 0.59 | 14 | 0 | 0% | 0.57 | 0.05 | 0.78 |
| all [det] | louvain k=6 γ=3 | 21 | 9% | 0% | 0.31 | 0.67 | **0.43** | 0.58 | 16 | 0 | 0% | 0.55 | 0.04 | 0.78 |
| all [det] | louvain k=6 γ=4 | 24 | 7% | 0% | 0.34 | 0.64 | **0.44** | 0.55 | 15 | 0 | 0% | 0.50 | 0.03 | 0.72 |
| all [det] | louvain k=10 γ=1 | 11 | 17% | 0% | 0.20 | 0.74 | **0.31** | 0.71 | 10 | 0 | 0% | 0.63 | 0.09 | 0.77 |
| all [det] | louvain k=10 γ=1.5 | 12 | 15% | 0% | 0.21 | 0.73 | **0.32** | 0.69 | 10 | 0 | 0% | 0.63 | 0.08 | 0.84 |
| all [det] | louvain k=10 γ=2 | 14 | 14% | 0% | 0.23 | 0.71 | **0.35** | 0.66 | 13 | 0 | 0% | 0.59 | 0.07 | 0.79 |
| all [det] | louvain k=10 γ=3 | 21 | 9% | 0% | 0.30 | 0.66 | **0.41** | 0.60 | 16 | 0 | 0% | 0.52 | 0.04 | 0.80 |
| all [det] | louvain k=10 γ=4 | 22 | 8% | 0% | 0.31 | 0.66 | **0.42** | 0.58 | 16 | 0 | 0% | 0.53 | 0.04 | 0.81 |
| all [det] | louvain k=15 γ=1 | 10 | 15% | 0% | 0.18 | 0.72 | **0.29** | 0.72 | 9 | 0 | 0% | 0.62 | 0.10 | 0.75 |
| all [det] | louvain k=15 γ=1.5 | 12 | 15% | 0% | 0.20 | 0.72 | **0.32** | 0.70 | 10 | 0 | 0% | 0.61 | 0.08 | 0.83 |
| all [det] | louvain k=15 γ=2 | 13 | 14% | 0% | 0.22 | 0.73 | **0.34** | 0.68 | 11 | 0 | 0% | 0.62 | 0.07 | 0.86 |
| all [det] | louvain k=15 γ=3 | 19 | 10% | 0% | 0.27 | 0.67 | **0.39** | 0.63 | 15 | 0 | 0% | 0.54 | 0.05 | 0.85 |
| all [det] | louvain k=15 γ=4 | 21 | 8% | 0% | 0.30 | 0.66 | **0.41** | 0.60 | 15 | 0 | 0% | 0.51 | 0.04 | 0.82 |
| all+title [det] | hier t=0.7 | 117 | 2% | 16% | 0.77 | 0.34 | **0.47** | 0.24 | 2 | 3 | 34% | 0.14 | 0.00 | 0.88 |
| all+title [det] | hier t=0.75 | 97 | 4% | 8% | 0.65 | 0.40 | **0.49** | 0.35 | 4 | 3 | 19% | 0.20 | 0.01 | 0.84 |
| all+title [det] | hier t=0.8 | 70 | 6% | 4% | 0.53 | 0.48 | **0.50** | 0.42 | 7 | 5 | 12% | 0.30 | 0.02 | 0.79 |
| all+title [det] | hier t=0.85 | 46 | 11% | 1% | 0.42 | 0.58 | **0.49** | 0.50 | 10 | 3 | 7% | 0.44 | 0.03 | 0.77 |
| all+title [det] | hier t=0.9 | 26 | 16% | 0% | 0.29 | 0.68 | **0.41** | 0.63 | 14 | 4 | 0% | 0.57 | 0.07 | 0.81 |
| all+title [det] | hier t=0.95 | 13 | 21% | 0% | 0.19 | 0.76 | **0.31** | 0.73 | 10 | 0 | 0% | 0.66 | 0.12 | 0.79 |
| all+title [det] | hier t=1 | 4 | 45% | 0% | 0.09 | 0.85 | **0.17** | 0.86 | 4 | 0 | 0% | 0.78 | 0.29 | 0.59 |
| all+title [det] | hier t=1.05 | 1 | 100% | 0% | 0.03 | 0.99 | **0.06** | 0.95 | 1 | 0 | 0% | 1.00 | 1.00 | 1.00 |
| all+title [det] | louvain k=6 γ=1 | 11 | 21% | 0% | 0.19 | 0.75 | **0.31** | 0.72 | 10 | 0 | 0% | 0.64 | 0.11 | 0.76 |
| all+title [det] | louvain k=6 γ=1.5 | 12 | 17% | 0% | 0.21 | 0.73 | **0.33** | 0.69 | 10 | 0 | 0% | 0.60 | 0.08 | 0.70 |
| all+title [det] | louvain k=6 γ=2 | 17 | 12% | 0% | 0.27 | 0.68 | **0.38** | 0.64 | 14 | 0 | 0% | 0.53 | 0.06 | 0.70 |
| all+title [det] | louvain k=6 γ=3 | 22 | 8% | 0% | 0.31 | 0.62 | **0.42** | 0.60 | 18 | 0 | 0% | 0.46 | 0.04 | 0.70 |
| all+title [det] | louvain k=6 γ=4 | 28 | 6% | 0% | 0.34 | 0.58 | **0.43** | 0.57 | 21 | 3 | 0% | 0.40 | 0.03 | 0.72 |
| all+title [det] | louvain k=10 γ=1 | 10 | 21% | 0% | 0.19 | 0.80 | **0.31** | 0.73 | 8 | 0 | 0% | 0.68 | 0.12 | 0.82 |
| all+title [det] | louvain k=10 γ=1.5 | 12 | 21% | 0% | 0.21 | 0.78 | **0.33** | 0.71 | 10 | 0 | 0% | 0.67 | 0.11 | 0.76 |
| all+title [det] | louvain k=10 γ=2 | 17 | 13% | 0% | 0.28 | 0.72 | **0.40** | 0.62 | 13 | 0 | 0% | 0.59 | 0.06 | 0.78 |
| all+title [det] | louvain k=10 γ=3 | 21 | 8% | 0% | 0.32 | 0.68 | **0.43** | 0.59 | 13 | 1 | 0% | 0.52 | 0.04 | 0.77 |
| all+title [det] | louvain k=10 γ=4 | 24 | 8% | 0% | 0.33 | 0.63 | **0.43** | 0.59 | 17 | 3 | 0% | 0.46 | 0.03 | 0.74 |
| all+title [det] | louvain k=15 γ=1 | 8 | 23% | 0% | 0.17 | 0.81 | **0.28** | 0.76 | 7 | 0 | 0% | 0.72 | 0.13 | 0.78 |
| all+title [det] | louvain k=15 γ=1.5 | 11 | 17% | 0% | 0.21 | 0.77 | **0.33** | 0.69 | 9 | 0 | 0% | 0.68 | 0.09 | 0.72 |
| all+title [det] | louvain k=15 γ=2 | 14 | 13% | 0% | 0.25 | 0.72 | **0.37** | 0.64 | 10 | 0 | 0% | 0.62 | 0.07 | 0.77 |
| all+title [det] | louvain k=15 γ=3 | 19 | 9% | 0% | 0.31 | 0.69 | **0.42** | 0.58 | 12 | 1 | 0% | 0.53 | 0.05 | 0.82 |
| all+title [det] | louvain k=15 γ=4 | 23 | 8% | 0% | 0.33 | 0.65 | **0.44** | 0.57 | 15 | 2 | 0% | 0.49 | 0.04 | 0.80 |

## 2. Decision criteria (written before results)

**hierarchical @ all [det], (c) = hier t=0.7:**
- PASS — 1. B³ F ≥ baseline + 0.15 (0.53 vs 0.16)
- FAIL — 2. same-subject cross-language ≥ 0.25 (0.24)
- PASS — 3. stability ≥ baseline + 0.15 (0.87 vs 0.48)
- FAIL — 4. largest ≤ 15% (5%) and ≤ 1 catch-all (2)
- PASS — 5. (c) within 0.05 of oracle (0.53 vs 0.54)

**hierarchical @ all+title [det], (c) = hier t=0.7:**
- PASS — 1. B³ F ≥ baseline + 0.15 (0.47 vs 0.16)
- FAIL — 2. same-subject cross-language ≥ 0.25 (0.14)
- PASS — 3. stability ≥ baseline + 0.15 (0.88 vs 0.48)
- FAIL — 4. largest ≤ 15% (2%) and ≤ 1 catch-all (2)
- PASS — 5. (c) within 0.05 of oracle (0.47 vs 0.50)

## 3. Test set, theme level (coarse groups vs theme labels)

| method | setting | groups | largest | unsorted | B³ P | B³ R | **B³ F** | intruders | catch-alls | 1-lang residue | one-offs unsorted | same subject, other lang | diff subject, same lang | stability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| k-means (production) | k=12, no correction | 12 | 16% | 0% | 0.26 | 0.35 | **0.30** | 0.64 | 9 | 9 | 0% | 0.02 | 0.18 | 0.48 |
| all [det] | hier t=0.95 | 12 | 21% | 0% | 0.41 | 0.65 | **0.51** | 0.45 | 5 | 1 | 0% | 0.58 | 0.08 | 0.75 |
| all [det] | hier t=0.85 (oracle) | 38 | 16% | 1% | 0.67 | 0.55 | **0.61** | 0.24 | 6 | 1 | 3% | 0.46 | 0.01 | 0.79 |
| all [det] | hier t=1 | 4 | 46% | 0% | 0.26 | 0.77 | **0.38** | 0.67 | 3 | 0 | 0% | 0.71 | 0.26 | 0.67 |
| all [det] | hier t=1.05 | 1 | 100% | 0% | 0.09 | 1.00 | **0.16** | 0.83 | 1 | 0 | 0% | 1.00 | 1.00 | 1.00 |
| all [det] | louvain k=6 γ=2 (oracle) | 19 | 9% | 0% | 0.62 | 0.54 | **0.58** | 0.27 | 3 | 0 | 0% | 0.41 | 0.01 | 0.78 |
| all+title [det] | hier t=0.95 | 13 | 21% | 0% | 0.48 | 0.70 | **0.57** | 0.39 | 3 | 0 | 0% | 0.64 | 0.06 | 0.79 |
| all+title [det] | hier t=0.9 (oracle) | 26 | 16% | 0% | 0.59 | 0.59 | **0.59** | 0.30 | 4 | 2 | 0% | 0.50 | 0.02 | 0.81 |
| all+title [det] | hier t=1 | 4 | 45% | 0% | 0.29 | 0.82 | **0.42** | 0.63 | 2 | 0 | 0% | 0.77 | 0.24 | 0.59 |
| all+title [det] | hier t=1.05 | 1 | 100% | 0% | 0.09 | 1.00 | **0.16** | 0.83 | 1 | 0 | 0% | 1.00 | 1.00 | 1.00 |
| all+title [det] | louvain k=10 γ=2 (oracle) | 17 | 13% | 0% | 0.59 | 0.57 | **0.58** | 0.28 | 2 | 0 | 0% | 0.45 | 0.02 | 0.78 |

## 4. Dev + test combined, theme level (secondary)

| method | setting | groups | largest | unsorted | B³ P | B³ R | **B³ F** | intruders | catch-alls | 1-lang residue | one-offs unsorted | same subject, other lang | diff subject, same lang | stability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| k-means (production) | k=12, no correction | 12 | 11% | 0% | 0.27 | 0.33 | **0.30** | 0.63 | 10 | 10 | 0% | 0.01 | 0.16 | 0.51 |
| all [det] | hier t=0.85 | 44 | 9% | 1% | 0.66 | 0.43 | **0.52** | 0.25 | 7 | 0 | 2% | 0.31 | 0.01 | 0.82 |
| all [det] | hier t=0.95 | 13 | 20% | 0% | 0.39 | 0.60 | **0.47** | 0.48 | 6 | 0 | 0% | 0.52 | 0.08 | 0.75 |
| all [det] | hier t=0.9 | 26 | 18% | 0% | 0.51 | 0.53 | **0.52** | 0.37 | 6 | 0 | 0% | 0.45 | 0.04 | 0.74 |
| all [det] | hier t=0.7 | 112 | 5% | 15% | 0.88 | 0.25 | **0.39** | 0.13 | 0 | 2 | 40% | 0.12 | 0.00 | 0.87 |
| all [det] | louvain k=10 γ=1.5 | 13 | 14% | 0% | 0.51 | 0.59 | **0.55** | 0.35 | 2 | 0 | 0% | 0.49 | 0.04 | 0.79 |
| all+title [det] | hier t=0.85 | 47 | 8% | 1% | 0.67 | 0.41 | **0.51** | 0.24 | 4 | 2 | 3% | 0.28 | 0.01 | 0.74 |
| all+title [det] | hier t=0.95 | 13 | 20% | 0% | 0.49 | 0.64 | **0.55** | 0.39 | 4 | 0 | 0% | 0.56 | 0.06 | 0.75 |
| all+title [det] | hier t=0.9 | 27 | 16% | 0% | 0.57 | 0.56 | **0.56** | 0.33 | 4 | 0 | 0% | 0.48 | 0.03 | 0.75 |
| all+title [det] | hier t=0.7 | 137 | 3% | 14% | 0.87 | 0.19 | **0.32** | 0.13 | 0 | 2 | 31% | 0.05 | 0.00 | 0.86 |
| all+title [det] | louvain k=10 γ=1.5 | 14 | 16% | 0% | 0.52 | 0.61 | **0.56** | 0.35 | 3 | 0 | 0% | 0.52 | 0.04 | 0.82 |

## 5. Per-chunk language detection (secondary), hierarchical t=0.85

| method | setting | groups | largest | unsorted | B³ P | B³ R | **B³ F** | intruders | catch-alls | 1-lang residue | one-offs unsorted | same subject, other lang | diff subject, same lang | stability |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| hierarchical @ all [detc] | t=0.85 | 39 | 11% | 1% | 0.37 | 0.63 | **0.47** | 0.54 | 16 | 0 | 5% | 0.50 | 0.04 | – |

## 6. Scale: random subsets of the test set, hierarchical @ all+title [det]

| n | draw | oracle t | B³ F oracle | (c) t | B³ F (c) | B³ F t=0.85 | B³ F k-means | groups (c) | unsorted (c) |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 1 | 0.75 | 0.74 | 0.8 | 0.69 | 0.62 | 0.26 | 32 | 13% |
| 100 | 2 | 0.75 | 0.71 | 0.85 | 0.62 | 0.62 | 0.26 | 26 | 7% |
| 100 | 3 | 0.7 | 0.62 | 0.8 | 0.59 | 0.54 | 0.22 | 28 | 18% |
| 200 | 1 | 0.75 | 0.58 | 0.75 | 0.58 | 0.53 | 0.19 | 54 | 17% |
| 200 | 2 | 0.75 | 0.57 | 0.75 | 0.57 | 0.54 | 0.20 | 57 | 18% |
| 200 | 3 | 0.8 | 0.54 | 0.75 | 0.54 | 0.50 | 0.22 | 49 | 19% |
| 300 | 1 | 0.8 | 0.52 | 0.7 | 0.49 | 0.49 | 0.17 | 85 | 21% |
| 300 | 2 | 0.75 | 0.53 | 0.7 | 0.52 | 0.49 | 0.19 | 80 | 21% |
| 300 | 3 | 0.75 | 0.54 | 0.7 | 0.51 | 0.48 | 0.19 | 79 | 21% |
| 453 | all | 0.8 | 0.50 | 0.7 | 0.47 | 0.49 | 0.16 | 117 | 16% |

## 7. Timing on resampled vectors with noise (timing only, not quality)

| n | k-means (production) | average linkage (NN-chain) + cut | kNN graph (k=10) + Louvain |
|---|---|---|---|
| 500 | 75 ms | 126 ms | 184 ms |
| 2000 | 718 ms | 1174 ms | 2879 ms |
| 5000 | 1216 ms | 7026 ms | 21841 ms |

Average linkage holds one Float64Array of n² distances: 191 MiB at n = 5,000 (Float32 would halve it).
