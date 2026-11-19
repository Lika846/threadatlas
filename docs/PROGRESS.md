# ThreadAtlas — Progress

A summary of where ThreadAtlas stands, the main design decisions and the known issues.
Plans: `PROJECT_PLAN.md` (original roadmap) and `docs/IMPLEMENTATION_PLAN.md` (detailed plan).
Design records: `docs/adr/`. Experiments and evaluation reports: `docs/spikes/`.

The task-by-task development log is kept privately. Older documents refer to its entries:
tasks (M1.4, M5.1b-2…), amendments and decisions (A…, D…), questions (Q…) and
reconstructed rules (R…). The decisions that shaped the product are summarised below, and
the sections that other documents cite (*M1 exit audit*, *M2.0 spike*, *M2 exit check*,
*Prisma verification*, *Migrating an existing database*) are kept here in short form.

_Last updated: 2026-11-19_

## Status

| Milestone | Status |
| --- | --- |
| M0 — Architecture and scaffold | ✅ Done (2026-11-03). ADR 0001 |
| M1 — Import and browse | ✅ Done (2026-11-07). See *M1 exit audit* |
| M2 — Keyword search (SQLite FTS5) | ✅ Done (2026-11-09). See *M2 exit check* |
| M3 — Theme grouping | ⚪ Not started (after M5) |
| M4 — Interactive map | 🟡 Map-first layout: themes and topics in a synchronized outline, map and panel, state in the URL, keyboard-accessible, list-first on phones (2026-11-19). Experimental: settings chosen on synthetic data |
| M5 — Semantic retrieval | 🟡 Search by meaning done (2026-11-12); related conversations (2026-11-18). Open: a larger model for cross-language search, independent relevance judgements |
| M6 — Assistant over your archive | ⚪ Not started |
| M7 — Portfolio release | 🟡 Release review done (2026-11-19): verification, privacy audit, clean installs, documentation. Not published yet |

## What works

- **Import** a ChatGPT `conversations.json` export through the browser: version-tolerant
  parsing with clear errors, branching threads reconstructed with a documented visible
  path, idempotent re-imports (unchanged conversations are skipped, changed ones updated),
  upload size limits. Details: `docs/import-format.md`.
- **Getting started:** the home page guides a first run (get the export, import, index, explore),
  checking itself off from the archive's state, with model installation guidance when needed.
- **Browse** conversations and messages in order, with branch markers and provenance. Assistant
  messages are rendered from their Markdown by a small, safe renderer: no HTML, links only to
  http(s)/mailto, images never loaded. Related conversations sit beside the conversation on wide
  screens and after it on phones.
- **Search by keyword** (SQLite FTS5): titles and message text, accent folding,
  conversation-level results with snippets that open the matching message.
- **Search by meaning:** a local multilingual model (`multilingual-e5-small`, run with ONNX
  Runtime in a separate process) indexes the conversations on request. Results combine
  exact-word and meaning matches. Nothing leaves the machine.
- **Map** (experimental): conversations grouped into themes and, within them, topics. Wide
  screens show an outline, a React Flow map and the selection's conversations side by side,
  from the same data; the selection is in the URL (Back and reload keep it). Small screens and
  200% zoom show the list first. The grouping corrects
  for language, so conversations on one subject in English, Norwegian and Russian can group
  together. The earlier k-means map stays available as a baseline (`/map?method=kmeans`).
- **Related conversations** (experimental) on each conversation page, with a passage from
  each side that explains the link.
- **Delete all imported data** with confirmation, including the search and semantic
  indexes.

## Main decisions

- **Local-first and private by design** (ADR 0001): Next.js bound to `127.0.0.1`, a strict
  Content Security Policy (`'self'`), telemetry off for Next.js and Prisma, no network code
  in the app, a Host-header check against DNS rebinding. The test suites check this by
  observation (a browser request guard, connection sampling), which can't prove zero
  traffic.
- **Storage:** one SQLite file through Prisma 7 with the better-sqlite3 adapter. The app
  never creates or migrates the database by itself; `npm run db:deploy` does. Tests run
  only on temporary databases, and a path guard refuses the real one under any test runner.
- **Keyword search:** FTS5 with external content and triggers (see *M2.0 spike*), the
  `unicode61` tokenizer with diacritic folding. Every word must match; no stemming.
- **Semantic retrieval** (ADR 0002): `multilingual-e5-small` at a pinned, checksummed
  revision, downloaded only by `npm run model:fetch`. Inference runs in a child process, so a
  native crash can't take the server down. Vectors are stored as int8 in SQLite and searched
  in memory; no vector database.
- **Grouping:** language is the strongest signal in these vectors, so the map removes each
  language's average before comparing conversations (`docs/spikes/mindmap/`). Average-linkage
  hierarchical clustering beat k-means on held-out synthetic data (B³ F 0.53 against 0.16). One
  tree is cut twice: topics at the existing rule, themes at the finest cut that leaves at most
  15 (spike v3). Themes are named from a fixed vocabulary of everyday subjects matched by the
  local model (precomputed vectors, checked against the model version); topics by their two most
  typical titles. The result is cached in memory per index state and titles; nothing is stored.
- **Search ranking (experimental until checked on real data):** each passage's score is reduced
  by half its mean similarity to those everyday subjects, so generic passages don't crowd out
  real matches (`docs/spikes/search-v3/`). Applied only when search runs the production model, a
  deterministic check of the configured inference.
- **Map computation off the request path:** the O(n²) tree runs in a worker thread, concurrent
  requests share one computation, and an indexing run prepares the map in the background.
  Nothing new is stored and no dependency is added.
- **Related conversations:** cosine similarity of language-corrected, centred conversation
  vectors, top 5 at ≥ 0.35, no forced matches. Repeated boilerplate is recognised by its text
  and doesn't count toward meaning (`docs/spikes/graph/`).
- **Tests:** synthetic fixtures only, never real exports (`tests/fixture-policy.test.ts`).

## Verification records

### M1 exit audit (2026-11-07)

Read-only audit against the M1 acceptance criteria: security, privacy, import correctness,
browsing, deletion, tests and documentation. **No functional blocker.** Re-importing a
file twice creates no duplicates; messages browse in path order; branches and missing
metadata are handled; invalid files are rejected with nothing written; no network
transmission was observed (`lsof` sampling of the test processes every 0.1 s; an
observation, not a proof). `npm run check`: 912 passed; e2e: 47 passed.

Accepted limitations (user-facing ones are in README *Limitations*): delete-all storage
cleanup is best effort; text replaced by a re-import stays in free pages until reused;
busy waits of up to 5 s when another program holds a read transaction; about 0.7 GiB of
server memory for a 50 MiB upload; the write lock is reliable on local filesystems only;
the CSP allows `'unsafe-inline'` scripts (App Router hydration).

### M2.0 spike (2026-11-07)

Keyword-search research on synthetic data (2,000 conversations, 52,200 nodes, 20.6 MB of
text) in temporary databases.

- **Chosen:** FTS5 with external content and triggers. First import +23%, unchanged
  re-import +4%, replacing every conversation +36%. Index size 0.51× the text. End-to-end
  latency at most 124 ms median, 161 ms worst.
- **Rejected:** a separate text copy (1.66× the text; replace +290%), contentless tables
  (event-loop pauses of 600–680 ms), FTS5 `secure-delete` (replace +526%), trigram (3.05× the
  text; can't match 1–2 character terms).
- **Consistency:** every variant survived add, re-import, replace, rollback, failed COMMIT
  and SIGKILL; app-managed sync broke on cascaded deletes, triggers didn't.
- **Deletion:** triggers alone left words in the file after delete-all; an explicit FTS5
  `delete-all` leaves nothing.
- **Hostile input:** 3,059 queries, no errors; snippet markers can't be forged.

### M2 exit check (2026-11-09)

Acceptance check with isolated synthetic data. **No functional blocker.** A temporary
end-to-end walk-through (three runs, each on a fresh database) covered import, re-import,
search with accents, Norwegian and Russian words, phrases, prefixes and FTS operator
characters, opening a result, Back, a changed re-import and delete-all. `npm run check`:
1,140 passed; e2e: 65 passed. Not pursued: role and date filters.

### Prisma verification (2026-11-04)

Prisma 7.10.1's network behaviour, read in its source and then measured with a logging
proxy and `lsof` sampling:

- **Install:** the npm registry; `binaries.prisma.sh` for the schema engine (used by
  migrations); GitHub releases for the better-sqlite3 prebuilt binary.
- **Runtime:** the Prisma Client and the SQLite adapter contain no network code.
- **CLI:** telemetry and the update check (`checkpoint.prisma.io`) are skipped when
  `CHECKPOINT_DISABLE` is set. A survey, an "install agent skills" offer and an error-report
  prompt appear only in an interactive terminal; the npm scripts give the CLI a
  non-interactive stdin. Through the scripts, `validate`, `generate`, `migrate diff` and
  `migrate deploy` made no network attempt.
- **Next.js 16.4:** `next build` and `next dev` queried `registry.npmjs.org` for upgrade
  advisories (`experimental.agentUpgrade`). It's turned off in `next.config.ts`, and
  `tests/next-config.test.ts` keeps it off. `next dev`'s own "outdated version" check remains
  ([privacy.md](privacy.md), *Known outbound requests*).

### Migrating an existing database

Each migration that touched an existing database followed the same procedure, rehearsed
first on synthetic databases in a guarded temporary directory: stop the server and confirm
nothing holds the database or its lock; back it up with SQLite's online backup API into
`data/backups/` (git-ignored, mode 0600) and verify the backup (integrity, row fingerprint,
migration history); run `npm run db:deploy`; verify the result (integrity, the expected
tables, indexes and triggers, unchanged data, `migrate status`, `npm run db:check-migrations`).

### Map data and search quality (2026-11-19)

- **Themes → topics** (`docs/spikes/mindmap/v3/`), on a held-out set of 453 synthetic
  conversations:
  - 15 themes and 94 topics;
  - theme-level B³ F 0.53, stability 0.75, 14–15 themes at every archive size;
  - names that match the label for 9 of 9 clear themes and 58% of topics.
- **Search** (`docs/spikes/search-v3/`), real-model test, before → after:
  - nDCG@10 0.840 → 0.852 and 0.828 → 0.866 on the research sets;
  - 0.556 → 0.596 on natural-language queries over the 453 conversations;
  - the chatter-archive regression queries still find their conversation first.
- **3,000 synthetic conversations:** import 17–20 s; indexing 2.5–3.5 min.
  - **Before the worker:** first map after indexing 3.9 s, then about 30 ms.
  - **With the worker and warm-up:** the first map right after indexing takes about 3 s, and
    other pages answer within 62 ms meanwhile.
  - **After a server restart:** about 6 s, and other pages wait up to 1.5 s.

### Release review (2026-11-19)

- **Markdown renderer:** a crafted 100,000-character message took 20–40 s to parse (scans per
  bracket or unmatched emphasis marker, and backtracking regular expressions), which would have
  stalled the server on page load. Parsing is now linear, under 30 ms for the worst inputs found,
  and the tests time them. Also fixed: `***x***` and italic around bold, links inside link text
  (invalid HTML), and a table directly after a paragraph line. Supported syntax:
  [guide.md](guide.md#markdown-support).
- **Export instructions** follow OpenAI's wording and link to its help article.
- **Documentation:** the README is now an overview; the reference sections moved to
  `docs/guide.md`, `docs/development.md`, `docs/privacy.md` and `docs/limitations.md`, and
  `docs/evaluation.md` collects the evaluation results.
- **Clean installs** from the exported files: `npm ci`, migrations, the model download and its
  checksums, then the check, build, model tests and a full first run through the UI with outbound
  network denied, and the e2e suite.

### GitHub release preparation (2026-11-18)

- **History audit:** no databases, exports, model files, keys or tokens, and no personal
  paths, in any commit.
- **Added:** MIT licence; npm install-script approvals; Next.js 16.4.6 (security fixes); `.gitignore` rules for logs, model
  files and personal tool settings; GitHub Actions CI (`npm run check` and the e2e suite on
  Ubuntu); Claude Code quality hooks (`.claude/`).
- **Fresh clone:** install, `npm run check` and the e2e suite pass on macOS with Node 24.
  Not yet run on Linux.

## Known issues

- **Intermittent e2e failure: `e2e/semantic-lifecycle.spec.ts:148`** ("a normal shutdown
  during indexing refunds the attempt…"): "the server did not exit", seen once in about seven
  full runs. The spec sends SIGTERM to its own server during indexing; under the full suite's
  load the exit took longer than the spec waits. Playwright retries once on CI. If it
  recurs, measure the shutdown time before raising the timeout, since a slow graceful
  shutdown is what the spec guards against.
- **Fixed 2026-11-18:** `e2e/search.spec.ts` (a race after Back),
  `src/lib/semantic/inference-process.int.test.ts` (timer margin under load) and
  `src/lib/semantic/index/indexer.crash.int.test.ts` (the probe race now waits for the other
  process's signal instead of fixed delays). All test-only.
- **Search before hydration:** until the page hydrates, the Search button is disabled and
  Enter does nothing. A brief, safe state.
- **Grouping, names and related conversations** are tuned on synthetic conversations only; the
  thresholds and the subject vocabulary may need adjusting on a real or much larger archive
  ([limitations.md](limitations.md)). With at most 15 themes, some are broad (career, study and family
  together on one test set). Theme names are English.
- **First map after a server restart** takes a few seconds on a large archive (about 6 s at
  3,000 conversations). Other pages wait up to 1.5 s meanwhile, while the vectors and message
  languages are read on the main thread; the tree itself runs in a worker. After indexing, the
  map is prepared in the background.
- **Search close matches:** for vague queries in an archive full of near-identical template
  conversations, the close-match tier grows (4 → 15 on one test query).
- **npm audit** (2026-11-19): 9 advisories, none reachable at runtime. In production
  dependencies: `adm-zip`, which only onnxruntime-node's install script uses, to unpack Linux GPU
  add-ons that ThreadAtlas skips; its fix needs onnxruntime-node 1.31, which has no Intel macOS
  binary. The rest is in lint tooling (typescript-eslint, minimatch).
- **Not yet done:** an automated accessibility audit (the tests check landmarks, the skip
  link, keyboard order, focus and colour contrast by hand or by measurement); a real screen
  reader, Safari, Firefox and touch devices.
- **Markdown:** a common subset only (no footnotes, reference links, maths or raw HTML, which
  stay as text), and only for assistant messages; your own messages are shown as typed.
- **ChatGPT's export menu** can change; the first-run steps link to OpenAI's instructions.
- **Interface review:** a baseline UI/UX review on synthetic data is in
  `docs/ui-review/2026-11-18/` (findings, screenshots, a proposed direction). Its main points:
  the map's topic names and keyboard navigation, map state lost on Back, related
  conversations placed before the messages, and the first-run path. Done: the map's data and
  names; the map-first layout with URL state, keyboard access and a list-first phone layout; the
  guided first run; the reading layout with safe Markdown; shared styles with measured contrast
  (all 2026-11-19).
