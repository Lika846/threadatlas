# ADR 0001: Stack and privacy architecture

- **Status:** Accepted (2026-11-07, at the M1 exit check). Proposed 2026-11-03 at the end
  of M0; updated 2026-11-07 to describe the architecture as built in M1.
- **Deciders:** project owner; drafted with Claude Code
- **Related:** `CLAUDE.md`, `PROJECT_PLAN.md`, `docs/IMPLEMENTATION_PLAN.md` (§1, §8
  amendments A1–A83), `docs/PROGRESS.md`, `docs/import-format.md`

## Context

ThreadAtlas imports personal ChatGPT conversation exports so they can be browsed and
searched locally. That data is private and must be treated as untrusted input. The
project constraints (`CLAUDE.md`) are:

- single-user, local-first;
- no cloud services, authentication, Docker, Python, paid APIs or vector infrastructure
  without an approved decision;
- imported data must never leave the machine without explicit approval.

This ADR records the stack and the privacy and security controls. It was first written
at the end of Milestone 0, including choices made during implementation that the
original plan did not specify. It now also records the architecture built in Milestone 1
(import, browse, delete-all). Each decision is traced to its plan amendment (A#).

## Decision

### Stack

| Concern | Choice | Version (pinned) |
| --- | --- | --- |
| Runtime | Node.js LTS (`.nvmrc`, `engines`, `engine-strict`) | 24.x |
| Framework | Next.js App Router, Turbopack | 16.4.6 |
| UI | React; Tailwind CSS | 19.3.0; 4.3.4 |
| Language | TypeScript `strict` + `noUncheckedIndexedAccess` | 5.9.3 |
| Lint | ESLint with `eslint-config-next` | 9.39.5 |
| Unit and integration tests | Vitest (Node environment; `unit` and `int` projects) | 5.0.5 |
| E2E tests | Playwright, Chromium only, against a production build | 1.64.1 |
| Persistence | SQLite (3.53.2, bundled with `better-sqlite3`) via Prisma ORM and CLI, with the `@prisma/adapter-better-sqlite3` driver adapter (A46, D52) | `prisma`, `@prisma/client`, `@prisma/adapter-better-sqlite3` 7.10.1; `better-sqlite3` 12.11.1 |
| Validation | Zod at external input boundaries, version-tolerant schemas (A1, A17) | 4.6.7 |

All dependency versions are pinned exactly (`.npmrc` `save-exact`). New dependencies
require approval.

Next.js features deliberately **disabled**:

- **Cache Components** (`cacheComponents`). It would require `"use cache"` or Suspense
  boundaries around every database read, which is unnecessary for a single-user local app.
  It can be revisited if profiling shows a need.
- **`AGENTS.md` generation** (`agentRules: false`). `next dev` wrote that file
  unprompted; `CLAUDE.md` is the single source of project instructions.
- **Agent-upgrade check** (`experimental.agentUpgrade: false`, A49). By default
  `next build` and `next dev` query the npm registry for release and advisory metadata.
  Guarded by `tests/next-config.test.ts`.

`turbopack.root` is pinned to the project directory, so a stray lockfile in a parent
folder is never treated as the workspace root.

### M1 architecture

Details and measurements: `docs/import-format.md`.

- **Database.** One local SQLite file, `data/threadatlas.db` by default (folder 0700,
  file 0600, git-ignored). `DATABASE_URL` must be an absolute `file:` path. The app never
  creates the database; migrations are applied only with `migrate deploy`
  (`npm run db:deploy`) after their SQL has been reviewed (A47, A51). The Prisma CLI runs
  only through the npm scripts, which set `CHECKPOINT_DISABLE=1` and use a
  non-interactive stdin (A12, D17).
- **Schema.** Surrogate primary keys; conversation identity unique by (`source`,
  `sourceId`); each node unique within its conversation; the parent stored as a source
  node ID string, not a foreign key (plan §1, §4, A35, A47). Raw exports are never
  stored. The only exception is the raw payload of unsupported content types
  (`rawContentJson`, A28, A37), which routine queries never read.
- **Reader and writer connections** (A55). Pages read through the default client. Imports
  and delete-all write through a **dedicated writer connection** with
  `PRAGMA cache_spill = OFF`, so readers keep seeing the last committed state. The writer
  is never disconnected while the process runs.
- **Transactions.** One transaction per conversation, with the batch counters updated in
  the same transaction (A52, A53). Every interactive writer transaction runs through
  `runWriterTransaction` (A83). On failure it sends an explicit `ROLLBACK`, checks that no
  transaction is left open, and rethrows the original error. If that check fails, the
  writer is refused for the rest of the process (`DB_WRITER_UNUSABLE`): imports,
  delete-all and storage cleanup fail closed, and ThreadAtlas must be restarted. Closing
  the connection instead would change A55; that alternative is deferred.
- **Cross-process write lock** (A57). An exclusive SQLite transaction on
  `<database>.lock` (0600), held through recovery, the import and its finalisation, and
  through delete-all and storage cleanup. Atomic and fail closed, released by the OS if
  the process dies, never unlinked. Reliable on local filesystems only.
- **Uploads** (A10, A13, A14, A65–A68). `POST /api/import` is a Route Handler. It receives
  the raw file as the request body, requires `Content-Length`, and enforces the 50 MiB
  limit while reading. It parses in memory and never writes the upload to disk. It is
  excluded from the proxy (measured: the proxy silently truncated bodies at 10 MB) and
  performs the Host and Origin checks itself.
- **Delete-all** (A11, A76–A82). Two Server Actions on the Settings page:
  - **Delete all imported data** requires the typed phrase `DELETE`, checked again on the
    server. One transaction deletes every `Message`, `Conversation` and `ImportBatch`
    row, with `secure_delete` on.
  - Storage cleanup (`VACUUM` with `temp_store = MEMORY`, then checks) is reported
    separately. **Finish storage cleanup** repeats it and never deletes records.
  - Best effort: no guarantee against copies kept by the OS, the disk or backups.
- **Rendering** (A26, A27, A74). Server-rendered pages show imported values as escaped
  plain text: no Markdown, HTML, automatic links or remote images.
- **Synchronous driver.** `better-sqlite3` blocks the event loop while a statement runs.
  Inserts are chunked with yields (A56); the measured pauses are accepted. Worker threads
  need approval.

### Privacy and security controls

**Threat model in brief:** the data is personal, and the main risks are accidental
disclosure through:

1. other devices on the local network;
2. malicious websites the user visits (DNS rebinding, CSRF);
3. telemetry or third-party requests;
4. rendering untrusted content (XSS, exfiltration through images or links);
5. accidental Git commits.

| # | Control | Mitigates | Where | Verified by |
| --- | --- | --- | --- | --- |
| C1 | Dev and production servers bind to `127.0.0.1` only | 1 | `package.json` scripts | `lsof` (M0.1); LAN request refused |
| C2 | **Host-header allowlist** (`127.0.0.1`, `localhost`, any port) on every request, including static assets and POSTs; foreign `X-Forwarded-Host` rejected; rejected value never echoed. `/api/import` is excluded from the proxy and performs the same check itself (A14, A66) | 2 (DNS rebinding) | `src/proxy.ts`, `src/lib/host-validation.ts` | unit tests; raw-HTTP e2e; Chromium rebinding simulation (`--host-resolver-rules`); e2e proxy-coverage test of path variants |
| C3 | Host and Origin validation inside every state-changing Route Handler and Server Action: loopback Host, exact Origin, `Sec-Fetch-Site: same-origin` when sent; plus a custom header and content type for the upload route, and `Next-Action` (supplementary only) for Server Actions. Next.js's built-in Server Action check is not relied on alone (A6, A11, A14, A67, A81) | 2 (CSRF) | `src/lib/request-guards.ts`, `src/lib/import/http.ts`, `src/app/settings/actions.ts` | unit tests; route integration tests; e2e forged, cross-origin and malformed requests for both the upload route and the Server Actions |
| C4 | Next.js telemetry off (`NEXT_TELEMETRY_DISABLED=1` in every script); agent-upgrade check off (A49) | 3 | `package.json`, `next.config.ts` | `next telemetry status` → Disabled; `tests/next-config.test.ts` |
| C5 | No remote fonts or assets (no `next/font/google`, no CDNs) | 3 | — | e2e guard: no foreign requests |
| C6 | **Content-Security-Policy** restricting all fetch-like directives to `'self'`; `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`; plus `Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options: DENY`, restrictive `Permissions-Policy`; `X-Powered-By` removed | 3, 4 | `src/lib/security-headers.ts`, `next.config.ts` | unit tests; e2e header test |
| C7 | E2E privacy guards: every page test fails on console errors (including CSP violations), page errors, or any request to a non-local origin | 3, 4 | `e2e/support/guards.ts` | negative tests (M0.2) |
| C8 | Imported content rendered as plain text only; never `dangerouslySetInnerHTML` | 4 | `src/components/message-view.tsx`, conversation pages | component tests; e2e: an export full of markup renders as literal text, with no requests or scripts |
| C9 | `.gitignore` excludes databases, `data/`, `exports/`, `imports/`, `conversations*.json`, `chat.html`, `*.zip`, `.env*` (except `.env.example`) | 5 | `.gitignore` | `git check-ignore` |
| C10 | Test fixtures are hand-authored synthetic data; a `_synthetic` marker is enforced by an automated check in `npm test`; no custom Git hook for now. **The marker is a safeguard, not proof** (A7, A18) | 5 | `tests/fixture-policy.test.ts` | runs in every `npm test` |
| C11 | No raw export is persisted; uploads are size-limited while being read (50 MiB) (A4, A10). Narrow exception: raw payloads of unsupported content only (A28) | 1–5 | `src/lib/import/` | integration test that unknown fields and rejected entries never reach the database file; e2e 12 MiB upload |
| C12 | Normal operation sends no imported content, metadata or usage analytics externally. Prisma's telemetry and network behaviour verified before and after installation (A12, A40) | 3 | Prisma npm scripts | *Prisma verification* in `docs/PROGRESS.md`; `lsof` sampling of test runs (see the note below) |
| C13 | Database errors sanitised centrally into fixed codes; raw messages, `meta`, query arguments and stack traces never logged, returned or stored (A50, A59). No application logging (A69) | 3 | `src/lib/db/errors.ts` | marker-string tests on errors, responses, console output and the database file |
| C14 | Tests never touch the real database: temporary databases only, no server reuse, path/symlink/hard-link checks, fail closed (A8, A41) | 5 | `src/lib/db/path.ts`, `prisma.config.ts`, `playwright.config.ts` | integration tests; the real database's files compared (size, mtime, inode) before and after each verification run |
| C15 | Delete-all with typed confirmation checked on the server, one transaction, `secure_delete` and `VACUUM` with verification; deletion and cleanup reported separately; best effort (A76–A82) | 1–5 | `src/lib/data/`, `src/app/settings/` | unit, integration, SIGKILL crash and e2e tests |

Host validation (C2) accepts **any port** on loopback host names. A DNS-rebinding attack
is identified by the host *name* the browser sends, and ports vary legitimately (dev 3000,
e2e 3100, `--port`). IPv6 `[::1]` is not accepted because the server does not listen on
it.

**Network observations are evidence, not proof.** The guarantee that imported data stays
on the machine rests on the design: no network code in the app, CSP, telemetry off, and
the Prisma CLI only through the scripts. Tests add evidence for it. The e2e guards see
only browser requests. `lsof` sampling of the test process tree every 0.1 s found no
non-loopback connection, but sampling can miss very short connections.

### Keyword search (M2): FTS5 spike

M2 starts with a spike (D9). The bundled SQLite includes FTS5 (verified in
`src/lib/db/schema.int.test.ts`). Prisma's schema language can't describe virtual tables.
The spike may therefore use hand-written migration SQL and raw queries, or a
supplementary indexing mechanism kept alongside the Prisma-managed tables. Neither
requires replacing the database layer wholesale. Whether `prisma migrate` drift detection
tolerates FTS5 tables is still unknown and is part of the spike.

This ADR does **not** decide the spike's outcome. Any change of data layer would need its
own approved ADR.

## Consequences

**Positive**

- The browser cannot contact third-party hosts even if rendered content tries to (C6),
  and the e2e guards catch regressions (C7).
- Pages and data cannot be read through a rebound domain (C2). This is tested end to end
  in a real browser.
- Imports are idempotent and atomic per conversation, survive crashes, and are serialised
  across processes (A52–A58, A83).
- The plan, decisions and verification are traceable in the repository.

**Negative and known limitations**

- The CSP allows `'unsafe-inline'` scripts, which App Router hydration needs without a
  nonce setup. XSS prevention therefore relies on never rendering untrusted HTML (C8).
  Revisit with nonces if Markdown rendering is introduced (R7, deferred until then).
- **The proxy buffers request bodies.** When `proxy.ts` runs, Next.js clones and buffers
  the request body in memory, up to `experimental.proxyClientMaxBodySize` (default 10 MB),
  and **silently truncates** anything larger (Next.js 16.4 docs; measured in M1.5 step 0).
  That conflicts with A10 (50 MiB limit, no full buffering). **Decision (A14, A66):**
  exactly `/api/import` is excluded from the proxy, and the route enforces Host and Origin
  itself. The exclusion shipped together with the route (M1.5), so there was never an
  import endpoint without Host validation.
- Server Functions and Route Handlers must repeat Host and Origin checks themselves. The
  Next.js docs warn that proxy coverage can silently change when a matcher or route
  changes; `e2e/import.spec.ts` pins the measured coverage.
- The synchronous SQLite driver pauses the server while statements run: up to about
  0.6 s for a very large conversation. If another program holds a read transaction,
  writes can wait up to the 5 s busy timeout.
- An unusable writer (A83) needs a restart, and until then its open transaction keeps
  the database locked for other connections. Deferred by decision; fail closed.
- The write lock is reliable on local filesystems only.
- Delete-all is best effort against copies outside the database file. Text replaced by a
  re-import can remain in free pages until the space is reused or delete-all compacts
  the file (import-time `secure_delete` deferred, A79).
- `next dev` makes one anonymous GET to the npm registry (version check). It carries no
  app data.
- The npm scripts use POSIX inline environment syntax (macOS/Linux; Windows needs WSL).
- E2E tests cover Chromium only. There is no automated accessibility audit yet; landmark,
  skip-link and keyboard checks are hand-written.

## Alternatives considered

- **Python/FastAPI back end:** excluded by project constraints; a second runtime adds
  complexity.
- **Electron/Tauri desktop shell:** would isolate the app from websites, but adds a large
  dependency and packaging surface. A localhost web app with C1–C3 is enough for now.
- **Origin-only checks (no Host allowlist):** do not stop DNS rebinding *reads*, because
  the attacker's requests are same-origin.
- **Restricting the proxy to pages only (matcher):** smaller coverage. Assets and Server
  Function POSTs would be reachable through a rebound domain. Only the upload route is
  excluded (A14), and it repeats the checks itself.
- **Raising `proxyClientMaxBodySize` to 50 MiB:** would keep the upload route behind the
  proxy, but buffers whole uploads in memory, violating A10. Rejected (A14).
- **Server Action for uploads:** rejected; Next.js Server Actions default to a 1 MB body
  limit (plan §1 #6). Uploads are the raw file as a `fetch` body to the Route Handler
  (A65).
- **Drizzle, or better-sqlite3 alone, instead of Prisma:** not adopted. Prisma 7 with the
  better-sqlite3 adapter is used for M1. FTS5 is explored in the M2 spike (D9) without
  presuming a replacement (see *Keyword search (M2)*).
- **Closing the writer connection after an unrecoverable transaction** (instead of
  refusing it until restart): deferred; it would change A55 (A83).
