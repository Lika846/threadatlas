# Development

Setup details, scripts, the test suites and continuous integration. The short version of the
setup is in the [README](../README.md#installation).

## Requirements

- Node.js **24+** (`.nvmrc`; enforced via `engines` + `engine-strict`)
- npm 11+
- macOS or Linux shell (see [limitations.md](limitations.md))

## Setup

```bash
cp .env.example .env.local        # optional; documented settings
npm ci                            # exact versions from package-lock.json
npm run db:generate               # generate the Prisma Client (also run by build/typecheck/test)
npm run db:deploy                 # create/migrate the local database (data/threadatlas.db)
npx playwright install chromium   # one-time, ~150 MB, for e2e tests
npm run dev                       # http://127.0.0.1:3000
```

The database is a local SQLite file at `data/threadatlas.db` (git-ignored; folder
0700, file 0600). Set `DATABASE_URL=file:/absolute/path.db` to use another location;
relative paths are rejected. The app never creates the database itself, so run
`npm run db:deploy` after installing and after pulling new migrations.

**Dependency install scripts.** Four dependencies need an install script, and
`package.json` approves exactly these versions in `allowScripts` (npm 11's
install-script approvals):

| Package | What its script does |
| --- | --- |
| `better-sqlite3` | Fetches a prebuilt SQLite native module (or builds one) |
| `prisma` | A setup check; downloads nothing |
| `@prisma/engines` | Fetches the Prisma schema engine, used by migrations |
| `onnxruntime-node` | Nothing on macOS and Windows; on Linux x64, fetches GPU add-ons ThreadAtlas doesn't use, unless `ONNXRUNTIME_NODE_INSTALL=skip` is set |

`fsevents` (macOS only, used by the test runner's file watcher) is denied explicitly: it
ships a prebuilt binary, and its only possible script would rebuild that from source.

The hosts are listed under [*Known outbound requests*](privacy.md#known-outbound-requests-no-user-data); no app data is sent. After
upgrading one of these packages, review its script and run
`npm install-scripts approve <package>`; `npm install-scripts ls` lists anything
unapproved. Without an approval, npm may skip the script, and the database or the
semantic index then won't work.

## Scripts

| Script              | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Dev server, bound to `127.0.0.1` only                 |
| `npm run build`     | Production build                                     |
| `npm run start`     | Serve the production build on `127.0.0.1` only       |
| `npm run typecheck` | Generate Prisma Client and route types, then `tsc --noEmit` |
| `npm run lint`      | ESLint (Next.js core-web-vitals + TypeScript rules)  |
| `npm run test`      | All Vitest tests: `unit` and `int` projects          |
| `npm run test:unit` | Unit tests only (no database)                        |
| `npm run test:int`  | Database integration tests (`*.int.test.ts`), temporary databases only |
| `npm run test:model`| Real-model tests (`*.model.test.ts`); needs `npm run model:fetch` first; about 20 s |
| `npm run test:watch`| Vitest in watch mode                                 |
| `npm run test:e2e`  | Playwright e2e tests (`e2e/`) on a production build  |
| `npm run check`     | `typecheck` + `lint` + `test`                        |
| `npm run db:generate` | Generate the Prisma Client into `src/generated/prisma` (git-ignored) |
| `npm run db:validate` | Validate `prisma/schema.prisma`                    |
| `npm run db:check-migrations` | Fail if the migrations and the schema differ by anything other than the search-index tables |
| `npm run db:deploy` | Apply migrations to the database (`migrate deploy`; never `migrate dev`) |
| `npm run model:fetch` | Download and verify the semantic model (135 MB); see [guide.md](guide.md#the-semantic-model) |

Run the Prisma CLI **only through these scripts**. They turn off its telemetry
(`CHECKPOINT_DISABLE=1`) and give it a non-interactive stdin, which prevents its
survey, "install agent skills" and error-report prompts. Never run `prisma init`,
`prisma dev`, `prisma studio` or `prisma migrate dev` against the real database.

## Testing

- **Unit tests** (Vitest, Node environment) live next to the code as
  `*.test.ts`.
- **E2E tests** (Playwright, Chromium only) live in `e2e/`. `test:e2e` builds
  the app and serves it on `127.0.0.1:3100`, so the *production* headers and
  CSP are exercised. An already-running server is never reused: the run fails
  instead, so tests can't attach to a dev server using the real database.
  `e2e/dev-logging.spec.ts` also starts its own `next dev` on `127.0.0.1:3101` with its
  own temporary database, to check that searches leave nothing in the dev server's output.
  Next.js allows one `next dev` per project, so **stop `npm run dev` before
  `npm run test:e2e`**. That dev server makes the anonymous version check listed under
  [*Known outbound requests*](privacy.md#known-outbound-requests-no-user-data) (a GET to `registry.npmjs.org`, no app data).
- **Database isolation.** Integration tests (`npm run test:int`) migrate one
  template database in a fresh temp directory and give each test its own copy.
  E2E runs get their own temporary database, which is migrated by the web server
  command and deleted afterwards. Under any test runner (`THREADATLAS_TEST=1`,
  Vitest, `NODE_ENV=test`), `src/lib/db/path.ts` refuses every database that is
  not a file inside the system temp directory, and always refuses the real one,
  by path, symlink or hard link. It compares the real path as a string first and never
  stats, opens or resolves the real database, its lock, `data/backups/` or the backup
  manifest; any test database that is a symlink or has a second hard link is refused.
  Tests never target the real path, not even to check that it is refused: they use a
  decoy project root in the temp directory. The Prisma CLI config applies the same
  guard. If isolation can't be confirmed, the test run fails (fail closed).
- **Import persistence tests** (M1.4) run against temporary databases only. Crash
  recovery and cross-process locking are tested with real child processes
  (`tests/helpers/child/`): a child imports and kills itself with `SIGKILL` at a chosen
  point, or holds the write lock while the test process tries to take it. Privacy tests
  plant synthetic canaries in content and unknown fields and check that none reaches
  error codes, logs, console output or the database file.
- **E2E database order.** The e2e server has one temporary database. Specs that depend on
  or change its contents run in a fixed order through Playwright project dependencies:
  `empty-state` → `import` → `conversations`, then `delete-all`, which empties the
  database and therefore runs last (after `conversations` and the general `chromium`
  project). The other specs only read and run in parallel, alongside the ordered chain.
- **Conversation pages** (M1.6): `src/lib/conversations/*.test.ts` covers ordering,
  pagination, hidden filtering, branch markers and that raw payloads are never read;
  `e2e/conversations.spec.ts` checks list order and paging, message order against the
  parser (fixture `branching.json`), the hidden toggle, markers, 1,000-message pages, a
  markup-filled export rendered as literal text, and 404s.
- **Import route and page** (M1.5): `src/lib/import/http.int.test.ts` covers every
  response status and canary privacy; `e2e/import.spec.ts` runs against the production
  build: upload, pending state, summary and focus, errors, the browser-side size check, an
  unfinished batch's accounting, a 12 MiB upload (proves the proxy exclusion), the route's
  own Host/Origin/CSRF checks, proxy coverage of path variants, and requests from another
  origin in Chromium.
- **Delete-all** (M1.7): `src/lib/data/*.test.ts` and `delete-all.int.test.ts` cover the
  confirmation phrase, the messages, both phases, the lock being held throughout, a busy
  COMMIT or VACUUM, failed checks and *Finish storage cleanup* never deleting records;
  `delete-all.crash.int.test.ts` kills a child process (`SIGKILL`) inside the delete
  transaction, after its commit, and during VACUUM;
  `e2e/delete-all.spec.ts` covers Cancel, confirm, cleanup, and forged, cross-origin and
  malformed Server Action requests.
- **Writer recovery** (A83): `src/lib/import/import-recovery.int.test.ts` makes an import's
  COMMIT fail by holding a read transaction on another connection, and checks that
  nothing is left open; `src/lib/db/transaction-recovery.test.ts` covers the case where
  recovery cannot be confirmed.
- **Search index** (M2.1): `src/lib/search/fts-index.int.test.ts` checks that the index
  stays consistent with the conversations after an add, an unchanged re-import, a
  replacement with title changes, a rolled-back conversation, a failed COMMIT, a
  `SIGKILL` mid-import, a cascade delete and delete-all. Consistency means FTS5's
  integrity check, the indexed rows, and probe searches compared with a freshly built
  index. It also covers the migration's backfill, rebuilding, and a database without
  the migration. `tests/migration-drift.test.ts` covers the strict drift check, and
  `tests/vacuum-guard.test.ts` rejects any VACUUM outside the sanctioned helper.
- **Search queries** (M2.2): `src/lib/search/query.test.ts` covers query parsing (FTS5
  operators and special characters as plain words, quotes, normalisation, limits, and
  3,000 generated hostile inputs). `snippet.test.ts` covers forged and malformed markers
  and long tokens. `search.int.test.ts` covers matching, ranking, deterministic pages,
  visibility, links opened through the detail-page query, re-import, delete-all, a
  missing index, and that nothing is logged.
- **Search page** (M2.3): `e2e/search.spec.ts` covers results, title-only matches,
  highlighting, opening the matching message (including page 2 of a long conversation),
  validation, no results, loading, a failed request, keyboard-only use and pagination,
  overlapping searches, Back with a fresh search, no search terms in URLs, history state,
  cookies or browser storage, the no-store cache headers, and refused Server Action
  requests. `e2e/dev-logging.spec.ts` checks the dev server's output.
  `e2e/delete-all.spec.ts` opens a stale result after delete-all. Unit tests cover the
  action's request check and arguments, the messages, the highlighting component and the
  "latest response wins" rule.
- **Semantic index** (M5.1b-1): `src/lib/semantic/index/*.int.test.ts` run the real import,
  delete-all and keyword search with a deterministic fake embedder in a real worker thread
  (`tests/helpers/fake-index-worker.mts`): invalidation for every import decision and on
  rollback, stale commits after a replacement, reprocessing or delete-all during inference,
  pages and windows, zero-chunk conversations, the 20,000-chunk cap (commit time and memory
  measured; `THREADATLAS_INDEX_REPORT=<file>` saves them), failure classes and attempts,
  pause and resume, write-lock contention, the singleton index row, the reader's
  compatibility checks and the status. `indexer.crash.int.test.ts` kills a child indexer
  (`SIGKILL`) at every crash point and covers a second process and the indexer lock.
  `tests/semantic-migration.test.ts` pins the reviewed migration's SHA-256.
- **Inference process and Settings** (M5.1b-2): `src/lib/semantic/inference-process*.test.ts`
  start the real IPC host with a fake child (`tests/helpers/fake-inference-child.mts`,
  whose batches block the event loop as ONNX Runtime does): cancellation during a batch,
  crash and hang isolation, the parent dying by SIGTERM, SIGINT or SIGKILL (the child
  always drains, no orphan), the orphan backstop, bounds and privacy.
  `index/indexer-host.int.test.ts` covers the indexer lock, interrupted attempts and
  repeatedly crashing conversations. `server-boundary.test.ts` keeps ONNX Runtime out of
  the Next.js server. `e2e/semantic-index.spec.ts` drives the Import page's panel on the shared server;
  `e2e/semantic-lifecycle.spec.ts` starts its own production servers and stops them
  normally, kills them and crashes their inference (`THREADATLAS_E2E_REAL_MODEL=1` runs it
  with the installed model). Tests that make a real native abort leave a macOS crash
  report, so they are opt-in: `THREADATLAS_NATIVE_CRASH_TESTS=1`.
- **Search by meaning** (M5.2):
  - **Fake query child:** `src/lib/semantic/search/*.test.ts` cover fusion, the vector
    cache, passages, links, the 50-conversation cap and pages, stale-vector exclusion after
    a replacement or delete-all, every fallback, the partial-index notice and the query
    process's idle exit.
  - **Real model:** `meaning-search.model.test.ts` measures relevance (nDCG@10) and
    latency through the full search path.
  - **E2E:** `e2e/semantic-index.spec.ts` and `semantic-lifecycle.spec.ts` drive the
    Search page in a production build.
  - **Measurement mode:** `THREADATLAS_SEARCH_PERF=1` asserts the 300 ms p95 budget at
    50,000 chunks (run that test alone).
- The migration rehearsal is opt-in (about 25 s):
  `THREADATLAS_REHEARSAL=1 npx vitest run --project int tests/semantic-migration-rehearsal.int.test.ts`.
  `npm run test:model` also indexes the research sets with the real model.
- **Performance measurements** are opt-in (about a minute each):
  `THREADATLAS_PERF=1 npx vitest run --project int src/lib/import/import-perf.int.test.ts`
  and `src/lib/search/search-perf.int.test.ts` (add `PERF_OUT=<file>` to save the numbers).
- Page tests fail on any console error (including CSP violations), uncaught
  page error, or **any browser request to a non-local origin**
  (`e2e/support/guards.ts`). This guards the "no data leaves the machine" rule.
- `e2e/host-validation.spec.ts` sends raw HTTP requests with forged `Host`
  headers; `e2e/dns-rebinding.spec.ts` simulates a rebinding attack in Chromium
  with `--host-resolver-rules` (resolved locally; nothing leaves the machine).
- `e2e/navigation.spec.ts` covers navigation, landmarks, the skip link and
  keyboard order.
- Import fixtures in `tests/fixtures/chatgpt/` are **hand-written synthetic data only**.
  `tests/fixture-policy.test.ts` enforces a `_synthetic` marker and a size cap (a
  safeguard, not proof). Never add real exports.
- Test artefacts (`test-results/`, `playwright-report/`) are git-ignored;
  traces are kept only for failed tests. Tests must use synthetic data only.
- **Continuous integration** (`.github/workflows/ci.yml`, GitHub Actions on Ubuntu) runs
  two jobs on every push to `main` and every pull request: `npm ci` then `npm run check`;
  and the e2e suite (`npm run test:e2e`, Chromium), which uploads the Playwright report
  if it fails. No secrets and read-only repository access. It never downloads the model:
  the e2e suite uses the fake inference child, and `test:model` isn't run.
  Playwright retries a failed test once on CI.
