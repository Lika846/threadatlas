# ThreadAtlas — Detailed Implementation Plan

> **Status:** Authoritative detailed plan. Supersedes the provisional data model and
> Milestone 1 task order in `PROJECT_PLAN.md`. Progress and open questions:
> `docs/PROGRESS.md`.

## Provenance and review markers (temporary)

- **Original:** the architecture proposal from the first planning session, saved by the
  user as `IMPLEMENTATION_PLAN.md` (repo root) from a terminal copy-paste. Preserved
  verbatim at `docs/archive/IMPLEMENTATION_PLAN.original.md`,
  SHA-256 `cf3332c27be794cb1615bb2faaa0b9c6ad588a90af490e6d3df55be3082d8327`
  (checksum file alongside).
- **Repair (2026-11-03):** about 60 passages were truncated mid-sentence. They are
  reconstructed **only** from evidence elsewhere in this plan, `PROJECT_PLAN.md` or
  `CLAUDE.md`. Formatting was normalised (the §1 table became a list), missing spaces at
  paste joins were restored ("arrayis" → "array is"), and the captured terminal UI at the
  end of the original (original lines 353–364) was dropped. Nothing else was changed.
- **Three kinds of content are kept apart:**
  1. **Original proposal:** plain text.
  2. **Confirmed amendments:** `> **Amended (A#, 2026-11-03):** …` blocks. Original text
     is kept above them.
  3. **Reconstructed content:** inline markers:

| Marker | Meaning |
| --- | --- |
| `⟦R#: text⟧` | Reconstructed, **high confidence**: the same fact appears elsewhere in the source documents |
| `⟦R#?: text⟧` | Reconstructed, **low confidence**: a plausible reading only |
| `⟦R#: lost⟧` | Unrecoverable. Nothing invented |
| `⚑` after the ID | **Material**: affects data integrity, security or conversation parsing |

> **Review rule:** A reconstruction is **not** an approved decision, however confident it
> is. Every ⚑ item needs explicit confirmation before the task that implements it. The
> markers and the Reconstruction log (Appendix) are **temporary review annotations**.
> Remove them once each item is confirmed or corrected; any that are still unresolved
> belong in `docs/PROGRESS.md` (Q1–Q8).
>
> **Resolved so far (2026-11-03):** R1 → A10, R2 → A11, R3 → A12 (revised), R54 → A13,
> R9 → A15 (rejected), R20 → A16, R31 → A22, R32 → A21, R17–R19, R22, R23, R25,
> R26, R28, R46 → A23, R21 → A24, R24 → A25, R27 → A26, R29 → A27, R30 → A28,
> R39 → A29.
> Their markers are removed. The confirming amendment sits next to each passage, and the
> Appendix keeps a short provenance table.

---

## 1. Review of the stack and MVP scope

The stack is reasonable for a local, single-user app. Here are the risks and the places
where I'd simplify:

1. **Node 20.15 is end-of-life** (Node 20 EOL was April 2026).
   *Why:* current Prisma, Vite/Vitest, and Next releases need Node ≥ 20.19 or newer.
   *Recommendation:* install Node 24 LTS before scaffolding and pin it with `.nvmrc` and
   `engines`. You do the install (nvm, fnm, or Homebrew).

2. **Plan uses source IDs as primary keys** (`Message.id` = stable source ID).
   *Why:* the export doesn't guarantee globally unique node IDs, and colliding IDs across
   conversations would corrupt data.
   *Recommendation:* use surrogate PKs plus `@@unique([source, sourceId])` and
   `@@unique([conversationId, sourceNodeId])`.

3. **`Conversation.importBatchId` (single link).**
   *Why:* loses lineage when a conversation is re-imported.
   *Recommendation:* store `firstImportBatchId` and `lastImportBatchId`.

4. **Self-referential FK for `parentId`.**
   *Why:* forces insert ordering (parents first), breaks when a parent is missing from the
   export, and is awkward in Prisma.
   *Recommendation:* store the parent as the source node ID string
   (`parentSourceNodeId`). It's joinable through the composite unique key, and a dangling
   parent is still recorded.

5. **Prisma + FTS5 (Milestone 2).**
   *Why:* Prisma can't model virtual tables. A later `migrate dev` may try to drop tables
   it doesn't know about.
   *Recommendation:* keep Prisma for M1. At the start of M2, run a one-session spike: FTS5
   through a hand-edited migration plus `$queryRaw`. If it fights us, we write an ADR about
   switching the data layer (for example Drizzle or better-sqlite3). I'm not proposing that
   switch now.

6. **Large uploads.**
   *Why:* `JSON.parse` on a 200 MB string can use more than 1 GB of heap. Next Server
   Actions default to a 1 MB body limit.
   *Recommendation:* use a Route Handler for uploads, with an explicit size limit
   (default 50 MB, see decisions), and in-memory parsing only (never written to disk).
   Streaming parsing (stream-json) waits until measurements show we need it.

   > **Amended (A2, 2026-11-03):** Upload limit confirmed at 50 MiB (52,428,800 bytes),
   > overridable via `IMPORT_MAX_BYTES`.
   > **Amended (A4, 2026-11-03):** No raw export file is persisted.
   > **Amended (A10, 2026-11-03; confirms reconstruction R1, with clarifications):**
   > ChatGPT JSON uploads use a Next.js Route Handler. The limit is 50 MiB
   > (52,428,800 bytes), configurable through `IMPORT_MAX_BYTES`. It is **enforced while
   > the request is being read**, so an oversized file is never fully buffered in memory.
   > Raw uploaded files are not persisted. Reading the request incrementally is required.
   > Streaming *parsing* stays deferred, as above.

7. **Localhost attack surface.**
   *Why:* `next dev` binds to all interfaces by default, so other devices on your network
   can reach your data. Any website you visit can also POST to `localhost:3000` (CSRF
   against import or delete-all).
   *Recommendation:* bind to `127.0.0.1`. Run delete-all through a Server Action (Next
   checks Origin for those). The import Route Handler gets an explicit Origin/Host check.

   > **Amended (A6, 2026-11-03):** Host-header validation applies to **all** routes
   > (allowlist of loopback hosts and ports) to defend against DNS rebinding, which
   > otherwise lets a malicious site *read* local pages. It is implemented in M0.3 via
   > Next.js `src/proxy.ts`. Origin checks are retained for every state-changing request.
   > **Amended (A11, 2026-11-03; confirms reconstruction R2, with security
   > requirements):** Delete-all is a Server Action. It requires **explicit user
   > confirmation** and performs **its own Host and Origin validation**. Next.js's
   > built-in Server Action Origin check is not relied on as the only control. It deletes
   > application-owned conversation data **in a single transaction**. The application
   > remains localhost-only. (The confirmation UX was resolved later by A76: type `DELETE`.)

8. **Unintended network traffic.**
   *Why:* Next telemetry, Prisma CLI telemetry, and `next/font/google` (fetches from
   Google) in the create-next-app template.
   *Recommendation:* set `NEXT_TELEMETRY_DISABLED=1`, use a system font stack, and add a
   Playwright guard that fails on any non-localhost request.

   > **Amended (A12, 2026-11-03; revises reconstruction R3):** Keep
   > `NEXT_TELEMETRY_DISABLED=1`. The reconstructed claim that `CHECKPOINT_DISABLE=1`
   > disables Prisma telemetry was **removed as unsupported**. Before integrating Prisma
   > (M1.3), verify the installed version's documented telemetry and network behaviour
   > and record the findings, rather than assuming any setting.
   > **Requirement:** normal ThreadAtlas operation must not send imported conversation
   > content, metadata or usage analytics to external services.

9. **"Import progress" UI.**
   *Why:* real progress for a single-request upload needs streaming or polling, which adds
   complexity.
   *Recommendation:* M1: a pending state, then a ⟦R4: summary (counts and⟧ warnings). True
   progress only if imports turn out slow.

10. **Category and ConversationLink models.**
    *Why:* they belong to M3/M4, so cre⟦R5: ating them now is speculat⟧ive.
    *Recommendation:* leave them out of the M1 schema.

11. **Rendering message content.**
    *Why:* XSS risk.
    *Recommendation:* M1 renders plain text only (⟦R6: `whitespace`⟧`-pre-wrap`). Never
    `dangerouslySetInnerHTML`. Markdown rendering later, behind a sanitizer, with
    it⟦R7?⚑: s own XSS tests⟧.

12. **Task order: schema before parser.**
    *Why:* we'd design the schema befor⟦R8: e knowing what the parser⟧ produces.
    *Recommendation:* build the parser first as pure functions with no DB. It's the
    riskiest part and the easiest to test. The schema follows from its output types.

Everything else (Tailwind, Vitest, Playwright, SQLite) is the right size. No extra
dependencies are needed beyond what's listed in §6.

---

## 2. Directory structure

```
threadatlas/
├── docs/
│   ├── adr/0001-stack-and-privacy.md
│   └── import-format.md            # adapter behavior + visible-path algorithm
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── app/
│   │   ├── layout.tsx              # shell + nav
│   │   ├── page.tsx                # landing page (A15; original: "redire…", R9 rejected)
│   │   ├── conversations/page.tsx  # list
│   │   ├── conversations/[id]/page.tsx
│   │   ├── import/page.tsx
│   │   ├── settings/page.tsx       # delete⟦R13: -all⟧
│   │   └── api/import/route.ts     # upload endpoint
│   ├── lib/
│   │   ├── db.ts                   # Prisma client singleton
│   │   ├── import/
│   │   │   ├── errors.ts           # error/warning codes (no content in messages)
│   │   │   ├── types.ts            # Normal⟦R10?: ized* types (parser outpu⟧t)
│   │   │   ├── read-upload.ts      # size/type/JSON.parse → unknown
│   │   │   ├── chatgpt/
│   │   │   │   ├── adapter.ts      # detect + parse → NormalizedConversation[]
│   │   │   │   ├── tree.ts         # roots, ⟦R11?: branches, visible path⟧
│   │   │   │   └── content.ts      # content_type → text/placeholder
│   │   │   └── persist.ts          # idempo⟦R12: tent import transaction⟧
│   │   └── conversations/queries.ts
│   └── components/
├── tests/
│   ├── fixtures/chatgpt/*.json     # synthe⟦R14: tic only⟧
│   └── helpers/test-db.ts          # temp SQLite per test file
├── e2e/                            # Playwr⟦R15: ight tests⟧
└── data/                           # gitignored; threadatlas.db lives here
```

Unit tests sit next to their code (`*.test.ts`). DB integration tests use `*.int.test.ts`.

> **Amended (A7, 2026-11-03), test fixtures:** Fixtures must be **manually authored
> synthetic data**. Real ChatGPT exports, or excerpts of them, must never be committed as
> fixtures. Every fixture carries a `_synthetic` marker, and an automated check (M1.1)
> fails if one is missing. The marker and the check are safeguards only: **they do not
> prove the data is fictional.** The author is responsible for that.
>
> **Amended (A8, 2026-11-03):** Before any database integration, Playwright must be
> isolated from the real application database. That means a temporary `DATABASE_URL`, no
> reuse of an already-running server, and a refusal to run against `data/threadatlas.db`.
> `*.int.test.ts` runs as its own Vitest project.
>
> **Amended (A18, 2026-11-03; resolves Q8):** The safeguard is the `_synthetic` marker
> plus an automated check that runs in `npm test`. **No custom Git hook** at this stage.
>
> **Amended (A15, 2026-11-03; resolves Q10):** `/` stays a landing page. It will later
> become a dashboard (conversation statistics, recent activity, knowledge-map
> navigation). A simple landing page is enough until then. The reconstructed
> "redirect to /conversations" (R9) is rejected.

---

## 3. Parsing a ChatGPT `conversations.json` safely

**Principle:** treat the file as untrusted, unknown data. The adapter reads only the
fields it needs, narrows every one at runtime, and ignores unknown fields. All
fix⟦R16: tures will b⟧e written to match the commonly observed shape: an array of
conversations, each with `title`, `create_time`/`update_time` (epoch seconds), `mapping`
(nodeId → `{id, message|null, parent, children[]}`), and
`current_node`. Until a fixture or approved sample shows otherwise, each of these
is an assumption. Each assumption is checked, and a failure produces a coded error or
warning instead of a crash.

> **Amended (A1, 2026-11-03):** Runtime validation at external input boundaries uses
> **Zod**, replacing the hand-written type guards recommended in §6 #2. To stay
> version-tolerant, schemas must accept unknown fields and report problems as coded
> errors or warnings, not throw.
>
> **Amended (A17, 2026-11-03; resolves Q6):** Installing Zod is approved. Schemas at
> external input boundaries are **version-tolerant**: unknown optional fields never make
> an otherwise valid export fail.

**Three error levels.** No error or log line ever includes message content. They contain
codes, indices, and IDs only.

1. **File-level** (fatal, nothing imported): too large, wrong content type,
   invalid JSON, unsupported top-level shape (initially only a top-level array is
   accepted), empty array. The UI shows a clear message.
2. **Conversation-level** (skip that conversation and add a warning): not an
   object, no usable ID (`conversation_id` → `id` → … otherwise skip; we never invent an
   identity), mapping missing or not an object.

   > **Amended (A16, 2026-11-03; resolves Q5 and the lost text R20; supersedes "we never
   > invent an identity"):** Use `conversation_id`, falling back to `id`. If both are
   > missing, **derive a deterministic identifier from canonicalised conversation
   > content**, but only where this can be done **without ambiguous merging**. Ambiguous
   > cases are **flagged** (coded warning) and never silently merged or discarded. The
   > canonical form and the ambiguity rules are designed in M1.1 and need user review
   > (open question Q11).
   >
   > **Amended (A20, 2026-11-03; resolves Q11):**
   > (a) The versioned SHA-256 derived ID (`derived:v1:<hex>`) is accepted as a
   > **provisional v1 fallback**. It is computed over **canonical raw source content**
   > (conversation `create_time`; per mapping entry its key, `parent`, `message.id`,
   > `message.author.role`, `message.create_time`, `message.content`), not over M1.2's
   > extracted text.
   > (b) Identical derived IDs within one export are **flagged**, never silently merged.
   > (c) No fuzzy matching of edited ID-less conversations in M1. **Documented
   > limitation:** a changed ID-less conversation may receive a new derived ID and become
   > a duplicate on re-import. Conservative identity matching is revisited in a later
   > milestone.

> **Amended (A19, 2026-11-03; confirms the M1.1 interpretations I1–I8, see
> `docs/PROGRESS.md`):** File-level fatal codes, non-fatal "all skipped" results,
> `conversation_id` precedence on mismatch, the reserved `derived:` prefix, in-file
> duplicate handling, skipping underivable ID-less conversations, and not importing
> flagged conversations are confirmed as implemented in M1.1. **Clarification for I3:**
> malformed optional fields are dropped with warnings, but **structural nodes and
> recoverable messages must be preserved**, and **missing parent relationships are
> never invented**.

3. **Node-level** (tolerated, add a warning): …ment_type (start of the list lost;
   replaced by A24), bad timestamps, dangling parent, a child that isn't in the mapping,
   a mapping key that differs from `node.id` (the key wins).

> **Amended (A23, 2026-11-03; confirms R17, R18, R19, R22, R23, R25, R26, R28, R46):**
> The reconstructed wording of these passages is approved, with the documented warnings
> and deterministic fallbacks. Clarifications: an "approved sample" (R17) is a structure
> the user describes, never a committed real export. For R23, `parent` is the **only**
> source of a node's parent; `children[]` sets sibling order and triggers warnings, and a
> parent is never inferred from it. Nodes their parent does not list come after the
> listed ones, in mapping order.
>
> **Amended (A24, 2026-11-03; replaces the lost list R21):** Node-level problems never
> skip a conversation. A mapping entry that is not an object is dropped with a warning
> naming its key. A **malformed message** (message present but unusable: not an object,
> or content missing or unreadable) is **preserved as a message, distinct from structural
> nodes**: it is marked malformed, keeps any safely recoverable text, and adds a warning.
> Missing content and missing parent relationships are **never invented**. Further
> warnings: invalid or unusual timestamps (A22, A30), dangling parent, listed child
> missing from the mapping, key ≠ `node.id` (key wins), parent/children disagreement,
> multiple roots, cycles, missing role (A29).

**Tree and visible path** (documented in `docs/import-format.md`).

- Store every mapping node, including nodes whose `message` is null and nodes off
  the default path, so no data is lost.
- Roots are nodes whose `parent` is null or missing from the mapping. Multiple roots
  produce a warning.
- Each node's parent comes from `parent`. If parent and the parent's `children[]`
  disagree, `parent` wins and a warning is added. `siblingIndex` is the node's position in
  its parent's `children`.
- Choosing the default visible leaf:
  - a. Use `current_node` if it exists in the mapping (strategy `current_node`).
  - b. Otherwise, use the leaf node with a message and the latest
    `create_time` (strategy `latest_leaf`). Ties go to the later mapping order.
  - c. Otherwise, start at the first root and repeatedly follow the last child
    (strategy `last_child`).
- Walk from the leaf up through `parent` with a visited set. A cycle stops the walk with a
  warning. Reverse the result to get `pathIndex` 0..n. Off-path nodes get
  `pathIndex = null`.
- The strategy used is stored on the Conversation, so the UI can explain itself.
- The display filters out nodes with no message. A node is hidden if
  `metadata.is_visually_hidden_from_conversation` is set, or if it's a system message with
  empty content. The rule is documented and tested.
- Branch points (a parent with more than one child) show an "n versions exist" marker. You
  can't navigate between branches in M1.

> **Amended (A5, 2026-11-03):** Hidden and system messages are **preserved in the
> database** (`isHidden` flag). The UI hides them by default.
>
> **Amended (A25, 2026-11-03; modifies R24):** `latest_leaf` considers leaves (nodes
> without children) that have a message **and a valid timestamp** (A22); the latest
> wins, and ties go to the later mapping order. If there is no such candidate,
> `last_child` is used. Whenever `current_node` is not used, the selected strategy is
> recorded and a warning says the path **may not be the user's last-viewed branch**. If
> no path can be built at all (empty mapping, or no root because of a cycle), the
> strategy is `none`.
>
> **Amended (A26, 2026-11-03; modifies R27; supersedes "a system message with empty
> content"):** **All system messages** and messages **explicitly** marked
> `metadata.is_visually_hidden_from_conversation === true` are hidden by default. They
> are stored and can be revealed with a UI toggle. **Structural nodes are never
> displayed as messages.**

**Content types.** Text is extracted with a small, explicit set of rules:

- `text`: join the string parts with blank lines.
- `code` and similar types with a `text` field: use that field.
- `multimodal_text`: keep string parts and replace object parts with `[image]` or
  `[attachment: <type>]`.
- Anything else: extract string parts or text if present; otherwise
  insert `[unsupported content: <type>]` and set `hasUnsupportedParts = true`.

The raw `content_type` is always stored, and an unknown type never fails the import.

> **Amended (A27, 2026-11-03; modifies R29):** Code text is preserved **exactly**, and
> the language identifier is kept where available. Untrusted code is never rendered as
> HTML.
>
> **Amended (A28, 2026-11-03; modifies R30; narrow exception to A4):** For
> **unsupported content only**, the message's raw `content` payload is preserved
> alongside the placeholder or best-effort text. Entire raw export files are still
> never stored. The parser version is stored so later versions can reprocess
> unsupported content. These payloads follow the same privacy, retention and delete-all
> rules as all other conversation content (they live on the message row and are deleted
> with it).

**Timestamps.** Epoch numbers (including floats) are accepted, ISO strings are tolerated,
and anything else becomes null with a warning. A sanity range rejects
nonse… (text lost; replaced by A22).

> **Amended (A22, 2026-11-03; resolves Q3 and the lost text R31):** Accept **finite,
> representable** source timestamps. Malformed optional timestamps are treated as
> **missing, with a warning**. **No arbitrary historical date cutoffs.** Unusually old or
> future timestamps may produce a warning but are kept. Timestamps are compared for
> newer-wins decisions **only when both values are valid**.
>
> **Amended (A30, 2026-11-03):** The same finite-and-representable rule is applied
> **consistently** in duplicate resolution (M1.1 adapter) and tree parsing (M1.2), using
> one shared implementation.

**Duplicates.**

- Within one file: same source ID twice → keep the one with the later `update_time`, plus
  a warning.
- Across imports: compute a `contentHash` of t… (text lost; replaced by A21).
  - Hash matches the stored conversation → unchanged.
  - Hash differs and the incoming `updatedAt` ⟦R33: is newer (or ei⟧ther is missing) →
    updated: messages are replaced in the transaction, `firstImportBatchId` is kept.
  - Incoming `updatedAt` is older → skipped (o⟦R34: lost⟧.
- The file's SHA-256 is recorded on the batch, so the UI can say "this exact file was
  already imported". Correctness doesn't depend on it.

> **Amended (A3, 2026-11-03):** Content-hash-based idempotent imports with the newer-wins
> policy are confirmed. The hash inputs (Q2), the "missing `updatedAt`" case and how older
> versions are reported (Q4) remain open.
>
> **Amended (A21, 2026-11-03; resolves Q2 and the lost text R32):** `contentHash` is a
> **versioned** hash over a **canonical representation of the validated source
> conversation**, including title, timestamps, mapping, message content and relevant
> source metadata. **Import-specific metadata is excluded** (e.g. batch IDs, import
> times, file name and hash). The canonicalisation rules must be **deterministic,
> specified** (in `docs/import-format.md`) **and tested**.
>
> Note: A22 constrains Q4. Under A22, `updatedAt` values are compared only when both are
> valid; what happens otherwise is still Q4.

---

## 4. Milestone 1 schema (Prisma / SQLite)

```prisma
model ImportBatch {
  id                     String    @id @defa⟦R35: ult(cuid())⟧
  startedAt              DateTime  @default(now())
  finishedAt             DateTime?
  status                 String    // running | succeeded | succeeded_with_warnings | failed
  adapter                String    // "chatg⟦R35: pt"⟧
  adapterVersion         String
  sourceFilename         String
  sourceSha256           String
  sourceBytes            Int
  conversationsSeen      Int       @default(0)
  conversationsAdded     Int       @default(⟦R35: 0)⟧
  conversationsUpdated   Int       @default(0)
  conversationsUnchanged Int       @default(⟦R35: 0)⟧
  conversationsSkipped   Int       @default(0)
  warningsJson           String?   // capped ⟦R36?: list of {code, conversationSourceId?, ⟧nodeId?}; no content
  errorCode              String?
  firstImported          Conversation[] @rel⟦R35: ation("FirstImport")⟧
  lastImported           Conversation[] @relation("LastImport")
}

model Conversation {
  id                  String    @id @default(cuid())
  source              String    // "chatgpt"
  sourceId            String
  title               String?   // UI shows ⟦R37?: an "Untitled" fallback⟧
  createdAt           DateTime?
  updatedAt           DateTime?
  currentNodeSourceId String?
  pathStrategy        String    // current_n⟦R38: ode | latest_leaf | last_c⟧hild
  visibleMessageCount Int
  nodeCount           Int
  contentHash         String
  firstImportBatchId  String?
  lastImportBatchId   String?
  firstImportBatch    ImportBatch? @relation⟦R35: ("FirstImport", fields: [f⟧irstImportBatchId], references: [id], onDelete: SetNull)
  lastImportBatch     ImportBatch? @relation⟦R35: ("LastImport", fields: [l⟧astImportBatchId],  references: [id], onDelete: SetNull)
  messages            Message[]
  @@unique([source, sourceId])
  @@index([updatedAt])
}

model Message {            // one row per mapping node
  id                  String    @id @default⟦R35: (cuid())⟧
  conversationId      String
  conversation        Conversation @relation⟦R35: (fields: [conversationId],⟧ references: [id], onDelete: Cascade)
  sourceNodeId        String    // mapping key
  sourceMessageId     String?   // message.i⟦R35: d⟧
  parentSourceNodeId  String?   // as exported; may dangle
  siblingIndex        Int
  pathIndex           Int?      // null = off default path
  role                String?   // user|assistant|system|tool; null = structural node
  authorName          String?
  contentType         String?
  contentText         String    @default("")
  hasUnsupportedParts Boolean   @default(fal⟦R35: se)⟧
  isHidden            Boolean   @default(false)
  status              String?
  createdAt           DateTime?
  @@unique([conversationId, sourceNodeId])
  @@index([conversationId, pathIndex])
}
```

Notes:

- Roles are strings, not enums, so an unknown role from a newer export doesn't break the
  import. They are validated in TypeScript.
- Deleting a Conversation cascades to its Messages.
- Delete-all = `deleteMany` on Message, Conver⟦R40: sation and ImportBatch, in⟧ a single
  transaction. (Confirmed by A44.)
- No raw export is stored. Provenance comes from the batch metadata, the file hash, and
  the source IDs.

> **Amended (A29, 2026-11-03; modifies R39):** Roles are preserved **exactly as
> exported**, including unknown roles. The schema gains an **explicit structural-node
> indicator**; a missing role does **not** imply a structural node. The comment
> "null = structural node" on `role` is superseded.
>
> **Schema changes planned for M1.3 (from A24–A29; built in M1.3, not before):**
>
> - `Message.isStructural Boolean @default(false)`: the node has no message (A29).
> - `Message.isMalformed Boolean @default(false)` (A24).
> - `Message.codeLanguage String?` (A27).
> - `Message.rawContentJson String?`: only for unsupported content (A28); removed by
>   the cascade and by delete-all.
> - `Message.role`: exported value, unchanged; null means missing or invalid (A29).
> - `Conversation.parserVersion String`: the parser version that produced the stored
>   rows (A28).
> - `Conversation.pathStrategy`: add `none` (A25).
> - `contentHash` carries its version in the value (`v1:…`, A21); no extra column.
> - Open for M1.3: source timestamps may be finer than milliseconds, but `DateTime` keeps
>   milliseconds.

> **Note (2026-11-03):** The schema has a `conversationsSkipped` counter, but §3 also
> describes "older → skipped". Whether older versions share that counter is open
> question Q4.

> **M1.3 schema (2026-11-04): approved (A47), implemented in `prisma/schema.prisma`.**
> It applies A35–A42 and supersedes the block above. Strings stand in for enums (validated in TypeScript), as before.

```prisma
generator client {
  provider = "prisma-client"            // Prisma 7 default; `output` is required
  output   = "../src/generated/prisma"  // generated code, git-ignored
}

datasource db {
  provider = "sqlite"                   // URL comes from prisma.config.ts (Prisma 7)
}

/// One upload. Times generated by the app use DateTime (A36).
model ImportBatch {
  id                     String    @id @default(cuid())
  startedAt              DateTime  @default(now())
  finishedAt             DateTime?
  status                 String    // running | succeeded | succeeded_with_warnings | failed
  adapter                String    // "chatgpt"
  adapterVersion         String    // parser version, e.g. "0.2.0"
  sourceFilename         String
  sourceSha256           String
  sourceBytes            Int
  // seen = added + updated + unchanged + older + flagged + skipped (tested invariant)
  conversationsSeen      Int       @default(0)
  conversationsAdded     Int       @default(0)
  conversationsUpdated   Int       @default(0)
  conversationsUnchanged Int       @default(0)
  conversationsOlder     Int       @default(0)   // A38 (Q4)
  conversationsFlagged   Int       @default(0)   // I8, A38
  conversationsSkipped   Int       @default(0)
  warningsJson           String?   // versioned, bounded, content-free report (A39)
  errorCode              String?
  firstImported          Conversation[] @relation("FirstImport")
  lastImported           Conversation[] @relation("LastImport")

  @@index([sourceSha256])               // "this exact file was already imported"
  @@index([startedAt])                  // import history, newest first
}

model Conversation {
  id                  String   @id @default(cuid())  // internal key, never from the export (A35)
  source              String   // provider namespace, e.g. "chatgpt"
  sourceId            String   // provider's ID, or "derived:v1:<sha256>" (A20)
  idSource            String   // conversation_id | id | derived
  title               String?
  createdAtSec        Float?   // source epoch seconds, sub-millisecond kept (A36)
  updatedAtSec        Float?
  currentNodeSourceId String?  // as exported; may not be in the mapping
  pathStrategy        String   // current_node | latest_leaf | last_child | none
  visibleMessageCount Int
  nodeCount           Int
  contentHash         String   // "v1:<sha256 hex>", v1 frozen (A34)
  parserVersion       String   // A28
  firstImportBatchId  String?
  lastImportBatchId   String?
  firstImportBatch    ImportBatch? @relation("FirstImport", fields: [firstImportBatchId], references: [id], onDelete: SetNull)
  lastImportBatch     ImportBatch? @relation("LastImport", fields: [lastImportBatchId], references: [id], onDelete: SetNull)
  messages            Message[]

  @@unique([source, sourceId])          // source-aware identity (A35)
  @@index([updatedAtSec])               // list order (M1.6)
  @@index([firstImportBatchId])         // SQLite does not index foreign keys itself
  @@index([lastImportBatchId])
}

/// One row per mapping node, including structural nodes (R22).
model Message {
  id                  String   @id @default(cuid())
  conversationId      String
  conversation        Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sourceNodeId        String   // mapping key
  sourceMessageId     String?
  parentSourceNodeId  String?  // as exported; may dangle, so deliberately not a foreign key (A23)
  siblingIndex        Int
  pathIndex           Int?     // position on the default path; null = off the path
  isStructural        Boolean  @default(false)   // A29
  isMalformed         Boolean  @default(false)   // A24
  role                String?  // exactly as exported; null = missing or invalid (A29)
  authorName          String?
  contentType         String?
  contentText         String   @default("")
  codeLanguage        String?  // A27
  hasUnsupportedParts Boolean  @default(false)
  rawContentJson      String?  // opaque original payload, unsupported content only (A28, A37)
  isHidden            Boolean  @default(false)   // A26
  status              String?
  createdAtSec        Float?   // source epoch seconds (A36)

  @@unique([conversationId, sourceNodeId])  // also serves conversationId lookups
  @@index([conversationId, pathIndex])      // visible path in order (M1.6)
  @@index([conversationId, parentSourceNodeId]) // sibling counts for branch markers (M1.6)
}
```

> Deletion behaviour: deleting a Conversation cascades to its Messages, including
> `rawContentJson`. Deleting an ImportBatch keeps its conversations and sets their batch
> references to null. Delete-all (M1.7) removes all three tables in one transaction,
> subject to R40/D16. Foreign keys are enforced: `better-sqlite3` is built with
> `SQLITE_DEFAULT_FOREIGN_KEYS=1`, and an M1.3 integration test checks the cascade.
> No CHECK constraints: Prisma cannot express them, and it would silently drop
> hand-written ones when it next rebuilds a SQLite table.
>
> **Amended (A58, 2026-11-05; comment-only, no migration):** `ImportBatch.status` also
> takes `completed_with_errors` and `interrupted`, and `failed` now means a systemic error
> stopped processing. The counter invariant holds for the three completed statuses; for
> `failed` and `interrupted`, `seen − sum` is the number of conversations not accounted
> for.

---

## 5. Task breakdown (one Claude Code session each)

### Milestone 0 — Scaffold

**M0.1 Project scaffold & privacy config** *(completed 2026-11-03; see PROGRESS)*
- Scope: git init; create-next-app (TS stric⟦R41: t, Tailwind, ESLint, App R⟧outer, `src/`),
  scaffolded in the scratchpad and moved in so the existing docs are kept; remove
  boilerplate and `next/font/google`; `.nvmrc` and `engines`; scripts dev
  (`-H 127.0.0.1`), build, typecheck, lint; teleme⟦R41: try disabled; `.gitignore` c⟧overs
  `data/`, `*.db*`, `.env`, and any `conversations*.json` outside `tests/fixtures`;
  `.env.example`.
- Acceptance: the app serves on 127.0.0.1 on⟦R42: ly; typecheck and lint are⟧ clean; no
  real-data paths can be committed.
- Verify: `curl 127.0.0.1:3000` → 200; `lsof -iTCP:3000` shows only the loopback address;
  `npm run typecheck && npm run lint`; `git check-ignore data/x.db
  conversat⟦R43: ions.json .env⟧`.

**M0.2 Test tooling** *(completed 2026-11-03)*
- Scope: Vitest config with one trivial unit test; Playwright config (builds and runs on
  127.0.0.1, uses a test `DATABASE_URL` later); smoke e2e test; a sha⟦R44: red network
  guard that fails⟧ the test on any non-localhost request.
- Acceptance and verify: `npm test` and `npm run test:e2e` pass; a deliberate external
  fetch in a scratch test fails the guard.

**M0.3 UI shell + ADR + README**
- Scope: layout with a skip link and nav (Conversations / Import / Settings); placeholder
  pages with empty states; `docs/adr/0001-stack-and-privacy.md`;
  README⟦R45: updated with setup, scripts,⟧ privacy guarantees, and limitations.
- Tests: an e2e check that each nav link renders its heading. A basic keyboard-nav and
  landmark check.

> **Amended (A6, 2026-11-03):** M0.3 also adds Host-header validation for all routes
> (`src/proxy.ts`), with tests for allowed and rejected Host values.

### Milestone 1 — Import & browse

**M1.1 Fixtures + file/conversation-level validation (pure, no DB)**
- Scope: synthetic fixtures (linear, branching, … (rest lost; see A23), missing `current_node`,
  missing title and timestamps, null-message root, multimodal/code/unknown content, hidden
  system message, duplicate IDs in one file, dangling parent, cycle, a non-array top
  le⟦R47?: vel, lost); read⟧-upload.ts; error codes; adapter skeleton producing
  conversation-level results.
- Tests: every fatal case yields its error c⟦R48?: ode; conversation-level problems⟧ are
  reported with codes; no content appears in error strings.

> **Amended (A1, A7, A16–A18, 2026-11-03):** Install Zod (approved, A17; exact version
> confirmed at install time) and use it at the upload/file boundary with version-tolerant
> schemas. Fixtures are manually authored synthetic data with a `_synthetic` marker
> enforced by an automated check in `npm test`, with no Git hook (A18). The conversation
> ID rules follow A16, including tests for derived IDs and flagged ambiguous cases.

**M1.2 Tree reconstruction + content extraction + `docs/import-format.md`**
- Scope: `tree.ts` and `content.ts` per §3; comp⟦R49?: lete the adapter's normalized⟧
  output; `contentHash`.
- Tests: the visible path matches the hand-computed expected order for each fixture; all
  3 strategies are covered; the cycle and dangling cases terminate with
  wa⟦R50?: rnings; content extraction⟧ holds per type; hashing is deterministic.

> **Amended (A19–A22, 2026-11-03):** `contentHash` follows A21 (versioned; canonical
> validated source; import metadata excluded; rules specified and tested). Timestamps
> follow A22. Node-level handling preserves structural nodes and recoverable messages and
> never invents parent links (A19, I3 clarification). `docs/import-format.md` documents
> the A20(c) duplicate-on-re-import limitation. The parsing ⚑ items R17–R30, R39 and R46
> need confirmation before this task starts.

**M1.3 Prisma schema + migration + test-DB har⟦R51: ness⟧**
- Scope: the §4 schema, initial migration, `db.ts` singleton, `tests/helpers/test-db.ts`
  (temp file DB plus `migrate deploy`).
- Tests: integration tests cover the unique constraints and the cascade delete.

> **Amended (A8, 2026-11-03):** Before any database integration, isolate Playwright from
> the real DB and split `*.int.test.ts` into its own Vitest project (see §2 amendment).

**M1.4 Idempotent import service**
- Scope: `import-service.ts` and `persist/` (confirmed wording, A52–A58; R52 resolved).
  Creates the batch row, then persists each conversation in its own transaction on a
  dedicated writer connection, with the batch counters for added/updated/unchanged/older
  updated in the same transaction, and finalises the counts. On a conversation's failure
  its transaction rolls back; a systemic failure stops the import and the batch is
  marked failed; a crash leaves it to be marked interrupted.
- Database errors (A50): one central function maps Prisma/SQLite exceptions to static
  codes. Raw errors, their messages, `meta`, query arguments and stack traces are never
  logged, returned in a response or stored in `warningsJson`/`errorCode`. Tested with a
  synthetic canary in a failing write.
- Tests: importing the same fixture twice → identical row counts, and the second batch
  reports all accepted conversations unchanged, with identical flagged and skipped counts
  (C5); a modified fixture → updated, with messages replaced and none left orphaned (R53,
  A53); an older version → counted as older, stored data kept (C2, A38); an injected
  failure → no partial conversation (C1, A52).

> **Amended (A52–A64, 2026-11-05):** M1.4 as implemented follows the approved design and
> Step 0 measurements; details are in `docs/import-format.md` (*Persistence*).

**M1.5 Import route + UI**
- Scope: `POST /api/import` (Origin check, size limit, content-type check, never writes to
  disk, logs counts only); an import page with the size limit and supported-format note, a
  pending state, a summary of counts and warnings, and accessible error messages.
- Tests: Route Handler tests for oversized, non-JSON, bad Origin, and a valid file; e2e:
  upload a fixture → see the summary.

> **Amended (A13, 2026-11-03; confirms reconstruction R54, with clarifications):** The
> route validates **upload size** (enforced while reading, A10), **parseability** and
> **supported JSON structure**. MIME type and filename extension are never relied on
> alone. Validation is **version-tolerant**: unknown optional fields must not make an
> otherwise valid export fail (see A1, Q6). Validation errors are clear to the user and
> **never log or echo private conversation content**. Host validation (A6) applies.
>
> **Amended (A65–A70, 2026-11-05):** M1.5 as implemented follows the approved design and
> its Step 0 measurements; details in `docs/import-format.md` (*Upload route*). The route
> logs nothing (stricter than "logs counts only", C1); "Route Handler tests" test the
> handler function, and the real route is covered end to end (C3); "never writes to disk"
> refers to the upload itself (C4).
>
> **Amended (A14, 2026-11-03; resolves Q9):** `/api/import` is **excluded from
> `src/proxy.ts`**, because the proxy buffers request bodies (default 10 MB) and may
> silently truncate them. The import Route Handler therefore **enforces Host and Origin
> validation itself**. **Before implementing uploads**, verify the actual Next.js
> behaviour with a test using a request body larger than 10 MiB. The 50 MiB limit stays
> and is enforced without buffering the whole file (A10). The matcher change ships in M1.5
> together with the route, so no gap exists before the handler's own checks do.

**M1.6 Conversation list + detail**
- Scope: the list sorted by `updatedAt` desc, with a simple limit/offset (50) and an empty
  state that links to Import; detail view showing the visible path in
  order, with roles and timestamps (R55 confirmed, A71), plain-text content, unsupported-content
  placeholders, branch markers, a "path strategy" note, and a 404 for unknown IDs.
- Tests: query unit tests for ordering; e2e: import a fixture and check the
  message order (R56 confirmed, A71); an XSS fixture (`<script>` and `<img onerror>` in content) renders as
  literal text.

> **Amended (A71–A75, 2026-11-05):** M1.6 as implemented: the detail view paginates the
> visible path server-side, 1,000 displayed messages per page, after filtering structural
> and hidden messages; URLs use the internal `Conversation.id`; branch markers come from
> the nearest fork between displayed messages. Details in `docs/import-format.md`
> (*Viewing conversations*).

**M1.7 Delete-all**
- Scope: a Settings page; a Server Action that deletes all imported data, after
  explicit confirmation, in a single transaction; a success message.
- Tests: an integration test that all three tables are empty afterwards; e2e covering
  cancel (nothing deleted) and confirm (empty state shown).

> **Amended (A76–A82, 2026-11-06):** M1.7 as implemented: typed `DELETE` confirmation,
> checked again on the server; logical deletion (one transaction, `secure_delete`
> verified) and storage cleanup (`VACUUM` with `temp_store = MEMORY`, then checks)
> reported separately; a repeatable *Finish storage cleanup* action that never deletes
> records; independent Host/Origin/Sec-Fetch-Site checks plus `Next-Action` in both
> Server Actions. Design, measurements and limitations in `docs/import-format.md`
> (*Deleting imported data*).

**M1 exit check:** the full PROJECT_PLAN M1 acce⟦R58: ptance criteria re-verifi⟧ed, with
README limitations updated.

> **Done (A84, 2026-11-07):** read-only audit against the acceptance criteria; all five
> met; README limitations, PROGRESS and ADR 0001 updated in the closure commit. Results:
> `docs/PROGRESS.md`, *M1 exit audit*.


### Milestone 2 — Keyword search

Stages from the M2 planning brief (2026-11-07); each needs its own approval.

**M2.0 FTS5 spike** *(done 2026-11-07; research only)*: storage options, Prisma
compatibility, sync strategy, tokenizer, measurements. Results in `docs/PROGRESS.md`,
*M2.0 spike*; decisions A85–A92.

**M2.1 Search index and synchronisation** *(done 2026-11-08; migration applied to the real
database, which held no conversations at the time)*: the
migration (FTS5 tables, triggers, backfill), strict drift check, delete-all clearing and
verifying the index, optimize after replacing imports, the VACUUM rule, consistency tests.
Design in `docs/import-format.md`, *Search index*.

**M2.2 Query layer** *(done 2026-11-08)*: safe query parsing with
typed rejections, ranked conversation-level results over titles and visible messages,
snippet segments, links to the displayed message, tests and an opt-in performance test.
No UI, route, migration, schema change or dependency. Design in `docs/import-format.md`,
*Search queries*.

**M2.3 Search UI** *(done 2026-11-09)*: `/search` with a guarded
Server Action called with plain values, search terms kept out of URLs, logs and browser
storage, in-memory query and page for Back, validation, loading and error states,
highlighted snippets, pagination, accessible focus and live regions, a conversation
not-found page. No dependency, schema change or migration. Design in
`docs/import-format.md`, *Search page*.

**M2.3 polish** *(approved and committed 2026-11-09)*: the linked message is
outlined after in-app navigation, Back and Forward; results show the best match's
position (A107).

**M2.4 Filters (optional)**: **not pursued** (decision 2026-11-09). The roadmap is
redirected towards semantic discovery (A108).

**M2 exit check** *(accepted 2026-11-09: M2 complete)*: the PROJECT_PLAN M2 acceptance
criteria re-verified with isolated synthetic data, including a temporary end-to-end
walk-through (import, re-import, browse, search, result navigation, changed re-import,
delete-all). Results: `docs/PROGRESS.md`, *M2 exit check*.

### Execution order after M2 (A108, 2026-11-09)

Milestones keep their IDs; they are executed in the order **M2 → M5 → M3 → M4 → M6 →
M7**. Established decisions and amendments are not renumbered.

### Milestone 5 — Semantic retrieval (executed next)

**M5.0 Research preparation** *(done and accepted for commit 2026-11-09; A109)*: hardware
inspection, synthetic multilingual evaluation set (v0), keyword-only baseline, model,
runtime and licence research, benchmark method and proposed acceptance criteria, draft
ADR 0002. No downloads, installs, application code or schema changes. Report:
`docs/spikes/m5.0/README.md`; draft: `docs/adr/0002-local-semantic-retrieval.md`.

**M5.0 benchmarks**: Experiment 1 (2026-11-09) and Experiment 2 (2026-11-10), both
accepted (D120, D122): multilingual-e5-small, direct ONNX Runtime 1.23.2 with
`@huggingface/tokenizers`, 64-token sentence chunks, a plain SQLite vector table, a
generation/epoch indexing lifecycle. Reports in `docs/spikes/m5.0/`; bounded M5.1
proposal in `docs/spikes/m5.0/m5.1-proposal.md`. Larger models need separate approval.
**M5.1a** (embedder, tokenizer, chunker, model-fetch command; no schema change):
approved 2026-11-10 (D122), accepted and committed `d5dc87d` (D123; `src/lib/semantic/`,
`scripts/model-fetch.ts`). **M5.1b** (migration, indexing lifecycle, Settings status):
design decisions approved 2026-11-10 (D123). Integration spike done
(`docs/spikes/m5.1b/integration/`). The revised design
(`docs/m5.1b-semantic-index-design.md`) has the review decisions in §13 (D124).
M5.1b-1 (index core) was approved on 2026-11-11 (D125; reviewed SQL, rehearsal and plan in
`docs/spikes/m5.1b/migration/` and `docs/m5.1b-1-implementation-plan.md`) and is
implemented, verified and committed; the real database was migrated on 2026-11-12. M5.1b-2
(inference child process, Next.js service, Settings) is implemented and committed
(`docs/m5.1b-2-implementation-plan.md`; inference in a child process, as the shutdown
comparison in `docs/spikes/m5.1b/shutdown/` recommended). **M5.2 onwards** (hybrid search, related conversations, rediscovery):
after M5.1.

---

## 6. Decisions I need from you (with recommendations)

1. **Node version:** upgrade to Node 24 LTS (rec⟦R59: ommended); yo⟧u install it with
   nvm, fnm, or Homebrew.
   > **Resolved:** Node 24.22.2 installed.
2. **Dependencies to approve:** next, react, react-dom, typescript, tailwindcss, eslint
   (through create-next-app), prisma + @prisma/client (plus the SQLite driver
   ⟦R60?: adapter if the Pri⟧sma major needs one; I'll confirm the exact versions at
   install time), vitest, @playwright/test. Optional: zod for boundary validation. I
   recommend hand-written type guards instead, because ⟦R61: lost⟧ read and it saves a
   dependency. Choose zod if you'd rather learn it.
   > **Amended (A1, 2026-11-03):** Zod chosen for validation at external input
   > boundaries.
3. **Upload size cap:** default 50 MB, overridab⟦R62: le via `IMPORT_MAX_BYTE`⟧S. If
   you're comfortable, run `ls -lh` on your real export (filename and size only, no
   contents) so we can calibrate.
   > **Amended (A2, A10, 2026-11-03):** Confirmed as 50 MiB (52,428,800 bytes), enforced
   > while the request is read.
4. **Re-import policy:** content-hash plus "newe⟦R63: r wins" (recommend⟧ed), or
   alternatively always overwrite.
   > **Amended (A3, 2026-11-03):** Content hash + newer-wins confirmed.
5. **Raw export storage:** none (recommended).
   > **Amended (A4, 2026-11-03):** Confirmed, none.
6. **Hidden/system messages:** hidden by default⟦R64: ; a "show hi⟧dden" toggle can come
   later.
   > **Amended (A5, 2026-11-03):** Preserved in the DB, hidden by default in the UI.
7. **Git:** run git init in M0.1, and I commit only when you ask, at the end of each task
   (recommended).
   > **Resolved:** Repository initialised 2026-11-03 (after M0.2). First commit `84e2e3a`
   > (M0.1–M0.2); since then each task is committed only with the user's approval.
8. **CLI importer** (`npm run import -- file.json`⟦R65: ): not now; ad⟧d it only if UI
   upload limits become a problem.
9. **FTS5 / Prisma:** no decision now; spike at the start of M2.

---

## 7. Original first task (historical, completed as M0.1)

*Recommended first implementation task: M0.1 Project scaffold & privacy config.*

Precondition: Node 24 LTS installed by you (`node -v` shows v24.x).

Exact scope (nothing more):
- git init (no commit until you approve)
- Run create-next-app in the scratchpad with TS, Tailwind, ESLint, App Router, `src/`,
  `@/*` alias, npm (check flags with `--help` first), then copy it into the repo
  ⟦R66: without overwriting CLAUDE.md⟧, FIRST_PROMPT.md, or PROJECT_PLAN.md
- Confirm `strict: true` in tsconfig; remove the template's demo assets and the
  `next/font/google` usage
- package.json: `engines.node`, scripts dev / typecheck (`tsc --noEmit`), lint
- `.nvmrc`, `.env.example` (`DATABASE_URL`, `IMPORT_MAX_BYTES`,
  `NEXT_TELEMETRY_DISABLED=1`, `CHECKPOINT_DISABLE=1`), `.gitignore` additions for
  real-data paths
- A minimal home page with the heading "ThreadAtlas". No DB, no Prisma, no tests yet
  (those come in M0.2).

> **Note (A12, 2026-11-03):** `CHECKPOINT_DISABLE=1` in the `.env.example` list above is
> original historical text. It was **not** added to `.env.example`, because its effect on
> Prisma telemetry is unverified.

Verification (I run and report the actual output):
1. `npm run typecheck` and `npm run lint` → exit ⟦R67: 0⟧
2. `npm run dev`, then `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000` → 200
3. `lsof -nP -iTCP:3000 -sTCP:LISTEN` → only 1⟦R67: 27.0.0.1⟧
4. `git check-ignore -v data/threadatlas.db conversations.json .env` → all ignored
5. `git status` → only the expected scaffold f⟦R67: iles⟧

Afterwards I'll summarize the changes and ri⟦R67: sks, then⟧ wait for your go-ahead.

---

## 8. Confirmed amendments (2026-11-03)

Decisions confirmed by the user after the M0 review. Each one overrides the original text
where they conflict; the original text is kept above for traceability.

| ID | Decision | Affects |
| --- | --- | --- |
| A1 | Zod for validation at external input boundaries | §3 principle, §6 #2, M1.1 |
| A2 | Initial upload limit 50 MiB / 52,428,800 bytes (`IMPORT_MAX_BYTES`) | §1 #6, §6 #3, M1.5 |
| A3 | Content-hash idempotent imports, newer-wins | §3 duplicates, §6 #4, M1.4 |
| A4 | Raw export files are never persisted | §1 #6, §4 notes, §6 #5 |
| A5 | Hidden/system messages preserved in DB, hidden by default in UI | §3 tree, §6 #6, M1.6 |
| A6 | Host-header validation on all routes (DNS rebinding) in M0.3; Origin checks retained for state-changing requests | §1 #7, M0.3, M1.5, M1.7 |
| A7 | Safeguards against committing real exports as fixtures. Fixtures must be manually authored synthetic data; `_synthetic` marker + automated check are safeguards, not proof | §2, M1.1 |
| A8 | Playwright isolated from the real DB before database integration; `*.int.test.ts` split | §2, M1.3 |
| A9 | `.nvmrc` and `.env.example` added (closes an M0.1 gap) | M0.1 |
| A10 | Uploads via a Route Handler; 50 MiB limit (`IMPORT_MAX_BYTES`) enforced while reading, so no full buffering of oversized files; no raw upload persisted. Confirms R1 | §1 #6, M1.5 |
| A11 | Delete-all via a Server Action with explicit confirmation **and its own Host/Origin validation** (not only Next's built-in check); transactional deletion of application-owned conversation data; localhost-only. Confirms R2 | §1 #7, M1.7 |
| A12 | Keep `NEXT_TELEMETRY_DISABLED=1`; no assumption that `CHECKPOINT_DISABLE=1` disables Prisma telemetry; verify the installed Prisma's documented telemetry/network behaviour before M1.3. **Requirement:** normal operation sends no imported content, metadata or usage analytics externally. Revises R3 | §1 #8, §7, M1.3 |
| A13 | Upload validation covers size, parseability and supported JSON structure; never MIME type/extension alone; version-tolerant (unknown optional fields accepted); clear errors that never log private content. Confirms R54 | M1.5 |
| A14 | `/api/import` excluded from `src/proxy.ts` (body buffering/truncation); the import Route Handler enforces Host and Origin itself; verify Next.js behaviour with a > 10 MiB request before implementing uploads; 50 MiB limit without full buffering. Resolves Q9 | §1 #7, M1.5 |
| A15 | `/` stays a landing page; becomes a dashboard (statistics, recent activity, knowledge-map navigation) later. Resolves Q10; rejects R9 | §2 |
| A16 | Conversation ID: `conversation_id`, then `id`; if both missing, a deterministic ID derived from canonicalised content, only without ambiguous merging; ambiguous cases flagged, never silently merged or discarded. Resolves Q5 and R20; **supersedes** "we never invent an identity" | §3, M1.1 |
| A17 | Zod installation approved; version-tolerant schemas at external input boundaries; unknown optional fields never fail an otherwise valid export. Resolves Q6 | §3, §6 #2, M1.1 |
| A18 | Fixture safeguard = hand-authored synthetic data + `_synthetic` marker + automated check in `npm test`; no custom Git hook for now. Resolves Q8 | §2, M1.1 |
| A19 | M1.1 interpretations I1–I8 confirmed as implemented. I3 clarification: malformed optional fields dropped with warnings; structural nodes and recoverable messages preserved; missing parent relationships never invented | §3 error levels, M1.1, M1.2 |
| A20 | Derived ID `derived:v1:<sha256>` over canonical **raw source** content accepted as provisional v1 fallback; identical derived IDs in one export flagged, not merged; no fuzzy matching in M1, and the duplicate-on-re-import limitation is documented; conservative identity matching revisited later. Resolves Q11 | §3, M1.1, M1.2 docs, M1.4 |
| A21 | `contentHash`: versioned hash over a canonical representation of the validated source conversation (title, timestamps, mapping, message content, relevant source metadata); import-specific metadata excluded; deterministic canonicalisation specified and tested. Resolves Q2, R32 | §3 duplicates, M1.2, M1.4 |
| A22 | Timestamps: finite, representable values accepted; malformed optional values → missing + warning; no arbitrary historical cutoffs; unusually old/future values may warn; newer-wins compares only when both values are valid. Resolves Q3, R31 | §3 timestamps, M1.2, M1.4 |
| A23 | Reconstructed parsing rules R17, R18, R19, R22, R23, R25, R26, R28, R46 approved with documented warnings and deterministic fallbacks; `parent` is the only parent source (R23) | §3, M1.1, M1.2 |
| A24 | Node-level handling (replaces lost R21): malformed messages preserved, distinct from structural nodes, marked malformed, recoverable text kept, warning; nothing invented | §3, M1.2, M1.3 schema |
| A25 | Path fallback (modifies R24): `latest_leaf` needs a valid timestamp; otherwise `last_child`; strategy recorded; warning that the path may not be the last-viewed branch; `none` when no path exists | §3, M1.2, M1.3 schema |
| A26 | Hidden messages (modifies R27): all system messages and explicitly visually hidden messages hidden by default, stored, revealable; structural nodes never displayed as messages | §3, M1.2, M1.6 |
| A27 | Code content (modifies R29): text exact, language kept, never rendered as HTML | §3, M1.2, M1.3 schema, M1.6 |
| A28 | Unsupported content (modifies R30): raw content payload kept for unsupported content only, narrow exception to A4; parser version stored for reprocessing; same privacy/retention/delete-all rules | §3, §4, M1.2–M1.4, M1.7 |
| A29 | Roles (modifies R39): preserved exactly; explicit structural-node indicator in the M1.3 schema; missing role ≠ structural | §4, M1.2, M1.3 |
| A30 | One shared timestamp rule (A22) for duplicate resolution and tree parsing | §3, M1.1, M1.2 |
| A31 | (2026-11-04, F1) Tree reconstruction is linear: Set-based sibling placement and an index-based reachability queue; output identical to the previous algorithm; regression and large-mapping tests without wall-clock assertions | §3, M1.2 |
| A32 | (2026-11-04, F2) Maximum JSON nesting depth 512 object/array levels, counted from the file root; enforced by an iterative check before any recursive canonicalisation or hashing (content hash and derived ID, including M1.1 code); an over-deep conversation is skipped with `CONVERSATION_TOO_DEEP`; nesting that prevents parsing → `FILE_TOO_DEEP`; no raw content or stack traces in reports; boundary tests at 511/512/513 and hostile input | §3, M1.1, M1.2 |
| A33 | (2026-11-04, F3) Duplicate-ID resolution is linear (Map grouping, one-pass newest copy); semantics unchanged (strictly newer valid `update_time` wins; ties or missing/invalid times ambiguous); one issue per group with ID, occurrence count, at most 10 sample indices, truncation flag and kept index; per-copy `skipped`/`flagged` entries keep exact counts; `ImportIssue.relatedIndices` replaced by `duplicateGroup` | §3 duplicates, M1.1, M1.4, M1.5 |
| A34 | (2026-11-04) M1.2 interpretations I9–I17 approved as the M1 baseline. Content hash v1 **frozen** as implemented; limitation: changes only to excluded conversation-level fields are not detected; a future schema change may require hash v2 | §3, M1.2, M1.4 |
| A35 | (2026-11-04, S1) Planned column changes approved, plus `Conversation.idSource`, `ImportBatch.conversationsFlagged` and `ImportBatch.conversationsOlder`. Internal primary keys are independent of external IDs; conversation identity is source-aware: unique (`source`, `sourceId`) | §4, M1.3 |
| A36 | (2026-11-04, S2) Source timestamps stored as `Float` epoch seconds; app-generated times as `DateTime` | §4, M1.3 |
| A37 | (2026-11-04, S3) `rawContentJson` is an opaque `String`, no per-message truncation; never in routine queries, logs, errors or ordinary API responses; removed by delete-all | §4, M1.3, M1.4, M1.6, M1.7 |
| A38 | (2026-11-04, S4; resolves Q4) Valid older incoming time → `conversationsOlder`; missing/invalid time on either side, or equal valid times, with a different hash → incoming copy flagged; stored data unchanged in all three cases | §3 duplicates, §4, M1.4 |
| A39 | (2026-11-04, S5) `warningsJson`: versioned; exact per-code counts; at most 500 samples; bounded serialised byte size with deterministic truncation that never loses counts | §4, M1.4 |
| A40 | (2026-11-04, S6) Prisma verification/research only; no installation until versions, installation requirements, telemetry/network behaviour and FTS5 compatibility are reported and approved | M1.3 |
| A41 | (2026-11-04, S7) Tests never touch the real database: temporary e2e database, `reuseExistingServer: false`, startup guard, separate Vitest project for `*.int.test.ts` with a temporary database per test file | §2, M1.3 |
| A42 | (2026-11-04, S8) Reconstructed schema defaults and relations (R35–R38) provisionally approved, subject to review of the complete proposed schema (§4) | §4, M1.3 |
| A43 | (2026-11-04, Q12) External conversation IDs and mapping node IDs (and their references) limited to 512 Unicode code points; never truncated or replaced by derived IDs; coded issues; recoverable conversations kept where structurally safe | §3, M1.1, M1.2 |
| A44 | (2026-11-04) Delete-all deletes ImportBatch, Conversation and Message together in one transaction; deleting an individual batch never deletes conversations. Resolves R40 and the R40/A11 scope question | §4, M1.7 |
| A45 | (2026-11-04) Warning report: exact per-code counts, ≤ 500 samples, 128 KiB serialised limit, bounded against long identifiers | §4, M1.4 |
| A46 | (2026-11-04) Install approved: `prisma` 7.10.1, `@prisma/client` 7.10.1, `@prisma/adapter-better-sqlite3` 7.10.1, `better-sqlite3` 12.11.1 (exact pins); compatibility, CLI behaviour, telemetry controls and FTS5 to be verified; installation downloads distinguished from unexpected connections | M1.3 |
| A47 | (2026-11-04) Schema of §4 approved as proposed (supersedes the original §4 block); local database `data/threadatlas.db`; source timestamps in `…Sec` columns; real database migrated only after the migration SQL is approved | §4, M1.3 |
| A48 | (2026-11-04, refines A43) Reconstructions are never presented as complete when they are not: an oversized mapping key or `parent` skips the whole conversation (`CONVERSATION_NODE_ID_TOO_LONG`) instead of dropping the node or nulling the reference. Oversized child entries, `message.id` and `current_node` cannot change the tree and stay warnings | §3, M1.1, M1.2 |
| A49 | (2026-11-04, N1) `experimental.agentUpgrade: false` in `next.config.ts`: `next build`/`next dev` make no registry query for upgrade/advisory metadata; guarded by a unit test | M0 config, M1.3 |
| A50 | (2026-11-04) Database errors are sanitised **centrally**: Prisma/SQLite exceptions are mapped to static codes in one place; raw database errors, messages, `meta`, query arguments and stack traces are never logged, returned or stored (they can contain conversation content) | M1.4, M1.5 |
| A51 | (2026-11-04) Initial migration applied to the real database with `migrate deploy` (`npm run db:deploy`) after review of its SQL | M1.3 |
| A52 | (2026-11-05, Q1, C1) One transaction per conversation. "No partial data" means no incomplete or mixed-version conversation; a batch may be partial and says so in its status and counts. Batch counters are updated in the same transaction as the write they describe. Resolves Q1 and R52 | §5 M1.4 |
| A53 | (2026-11-05, R53) Updates replace all message rows atomically inside the conversation transaction (guarded `updateMany` on the stored hash and parser version → delete → insert the full tree), preserving `Conversation.id` and `firstImportBatchId`. Resolves R53 | §4, §5 M1.4 |
| A54 | (2026-11-05) Parser-version reprocessing: identical source hash and a newer, valid incoming parser version → rows replaced, counted as updated, info code `CONVERSATION_REPROCESSED`. Newer source data is never overwritten by an older export solely because the parser version changed. Output of an older parser never replaces a newer one (`CONVERSATION_PARSER_DOWNGRADE`, flagged). Closes C8 | §3, M1.4 |
| A55 | (2026-11-05, F4, C10) Dedicated SQLite writer connection, separate from readers, with `PRAGMA cache_spill = OFF`; never disconnected during an import. Architecture change | M1.4, M1.7 |
| A56 | (2026-11-05) Message inserts in chunks of 500 rows, yielding to the event loop between chunks (and, as measured during implementation, after normalisation and between conversations). Prisma transaction timeout 300 s, `maxWait` 10 s, documented as backstops only. Just-in-time normalisation and release of upload references. No worker threads without approval | M1.4 |
| A57 | (2026-11-05) Cross-process write lock: exclusive SQLite transaction on `<database>.lock` (0600), no new dependency; atomic, fail closed, held through recovery, processing and finalisation; never unlinked; released by the OS on SIGKILL; local filesystems only | M1.4, M1.7 |
| A58 | (2026-11-05) Batch statuses `running`, `succeeded`, `succeeded_with_warnings`, `completed_with_errors`, `failed`, `interrupted`; durable counters with checkpoints describing an unbroken prefix; `seen` = discovered, `accounted` = sum of outcomes; interrupted and failed batches show "Accounted for X of Y; Z not accounted for." and never claim that unaccounted conversations were unexamined; stale `running` batches become `interrupted` under the lock; re-import is safe and idempotent. Closes C3, C4 | §4 comment, M1.4, M1.5 |
| A59 | (2026-11-05, D56) Prisma exceptions sanitised centrally into fixed codes, reading only class, `code`, `kind` and `originalCode`. Source identifiers may appear in bounded local diagnostic reports (500 samples, 128 KiB, 512-character IDs), never in generic error messages or logs. Closes C6 | M1.4, M1.5 |
| A60 | (2026-11-05) Strict parser-version and content-hash grammars; only recognised versions are compared; unknown or malformed versions are flagged (`CONVERSATION_STATE_UNRECOGNISED`) and nothing is written | M1.4 |
| A61 | (2026-11-05) Conflicts C2 (older → `conversationsOlder`, per A38), C5 (re-import wording) and C7 (message IDs change on replacement) adopted as proposed | §5 M1.4 |
| A62 | (2026-11-05, C7) Future features refer to messages by (`conversationId`, `sourceNodeId`), never by the generated `Message.id`; references to nodes removed by a later import are dangling and validated on read; derived data is rebuilt in the replacement transaction | M2, M4, M5 |
| A63 | (2026-11-05, C9) Conservative rule kept: changed conversations with missing or invalid comparison timestamps are flagged and not overwritten. A future user-confirmed conflict-resolution flow is needed | M1.4, later |
| A65 | (2026-11-05, U1, C5) Uploads are the raw file as the `fetch` request body (not multipart, not a Server Action); JavaScript required, with a `<noscript>` note | M1.5 |
| A66 | (2026-11-05, U2, C6) Exactly `/api/import` excluded from `src/proxy.ts` (`/((?!api/import$).*)`), shipped with the route's own checks and an e2e test of path-variant coverage. Step 0 measured silent truncation to 10 MB with the proxy | M1.5 |
| A67 | (2026-11-05, U3, C2) Header-only request checks before the body is read: loopback Host, exact same Origin, `Sec-Fetch-Site: same-origin` when sent, custom header, `application/json` (CSRF hardening, not validation); shared module `src/lib/request-guards.ts` for M1.7 | M1.5, M1.7 |
| A68 | (2026-11-05, U4) `Content-Length` required (411); bytes read must equal it (`FILE_INCOMPLETE`); browser-set value verified in Chromium | M1.5 |
| A69 | (2026-11-05, U5–U7) Status mapping as in `docs/import-format.md`; bounded local details rendered as plain text; no application logging (C1) | M1.5 |
| A70 | (2026-11-05, U8–U10) Pending state with elapsed time and the message "Importing… This may take up to a minute. Keep this tab open to see the result."; read-only *Last import* panel; an import continues after the browser disconnects; no prominent Conversations link before M1.6; incomplete batches show durable accounting | M1.5 |
| A71 | (2026-11-05) Reconstructions R55 (detail shows the visible path in order, with roles and timestamps) and R56 (e2e imports a fixture and checks the message order) confirmed | §5 M1.6 |
| A72 | (2026-11-05) Conversation URLs use the internal `Conversation.id`; ChatGPT source IDs are not shown or put in URLs | M1.6 |
| A73 | (2026-11-05) Detail view paginated server-side: 1,000 displayed messages per page, structural and hidden messages filtered before pagination, `pathIndex` order, accessible Previous/Next with page indicators, invalid pages → 1, past the end → last page, accurate hidden counts and branch markers, no `rawContentJson` | M1.6 |
| A74 | (2026-11-05) Conversation list, plain-text rendering (no Markdown, HTML, automatic links or remote images), server-rendered hidden-message toggle (`?hidden=show`), path-strategy notes, and a "View conversations" link after an import | M1.6 |
| A75 | (2026-11-05) Branch markers: a displayed message shows "n versions" for the nearest fork on the path segment since the previous displayed message, counting only alternatives whose subtree contains a real message (structural nodes and hidden messages can sit between displayed messages) | M1.6 |
| A64 | (2026-11-05) Data remanence (replaced or deleted text in SQLite free pages and leftover rollback journals): `secure_delete`, `VACUUM` and journal handling are a **required M1.7 design decision** | M1.7 |
| A76 | (2026-11-06, Q7) Delete-all confirmation: type exactly `DELETE` (case-sensitive, no trimming); the button stays disabled until then and the Server Action checks the phrase again. Resolves Q7 | M1.7 |
| A77 | (2026-11-06, R57) Confirmed: a Server Action deletes all imported data after explicit confirmation, Message, Conversation and ImportBatch together in one transaction; schema and migration history kept | M1.7 |
| A78 | (2026-11-06, A64) Two phases under the write lock (A57), held through deletion, VACUUM and verification: (1) logical deletion with `secure_delete = ON` read back; rollback on failure, including an explicit ROLLBACK after a failed COMMIT; (2) VACUUM with `temp_store = MEMORY`, then checks (tables empty, `freelist_count = 0`, `quick_check`, no journal/WAL). Outcomes `complete`, `deleted_cleanup_incomplete`, `not_deleted`; full success only after the checks pass. Writer pragmas restored afterwards; a restore failure is reported and never changes the outcome. Best effort: no guarantee against APFS snapshots, SSD blocks, unlinked journals or backups. Resolves A64 | M1.7 |
| A79 | (2026-11-06) Import-time `secure_delete` deferred; the remanence risk for replaced conversations stays documented. Imports reset `secure_delete` and `temp_store` to their defaults before starting | M1.7 |
| A80 | (2026-11-06) *Finish storage cleanup*: a separate Server Action without the phrase, offered whenever all imported tables are empty; takes the write lock; issues no DELETE and refuses if imported rows exist; repeatable. "Cleanup may be incomplete" is shown on physical evidence (free pages, leftover journal/WAL); its absence is not treated as proof of success. No persistent marker or schema change | M1.7 |
| A81 | (2026-11-06) Server Action request checks: loopback Host, exact Origin and `Sec-Fetch-Site` (shared with the import route), plus `Next-Action` as a supplementary check, never alone. The 5 s SQLite busy timeout is kept; SQLITE_BUSY becomes a sanitised, retryable result | M1.7 |
| A82 | (2026-11-06) Test-only filler table in isolated temporary databases for the SIGKILL-during-VACUUM test | M1.7 |
| A83 | (2026-11-06) Writer transaction recovery: every interactive transaction on the writer (import per conversation, delete-all) runs through `runWriterTransaction`: on failure an explicit ROLLBACK, a deferred BEGIN/ROLLBACK probe, and the original error rethrown. If no clean state can be shown, the writer is marked unusable for the process (`DB_WRITER_UNUSABLE`, systemic): no finalisation through it; imports, delete-all and cleanup refuse until restart. The writer is still never disconnected (A55). Fixes the busy-COMMIT issue found in M1.7 | M1.4, M1.7 |
| A84 | (2026-11-07) M1 exit check approved: M1 complete. ADR 0001 accepted and updated to the M1 architecture; the M2 FTS5 spike may use raw SQL or a supplementary indexing mechanism without a wholesale data-layer replacement, its outcome not decided. Deferred: closing the writer instead of the A83 fail-closed refusal + restart; R7 until Markdown rendering is introduced. Inline reconstruction markers kept (not bulk-removed) | M1, M2 |
| A85 | (2026-11-07) M2.0 spike accepted. Search index = external-content FTS5 (option A) over `Message.contentText` and `Conversation.title`, keyed by rowid; no second copy of the text | M2 |
| A86 | (2026-11-07) The index is kept in sync by SQLite triggers (insert, delete, update; cascaded deletes included), created by the migration, inside the row change's transaction | M2.1 |
| A87 | (2026-11-07) Tokenizer `unicode61 remove_diacritics 2`, no stemming; titles indexed separately, title updates synchronised | M2.1 |
| A88 | (2026-11-07) After an import that replaced conversations, `optimize` runs under the write lock; a failure leaves a correct, unmerged index. The measured replacement overhead (+36%) is accepted for M2 | M2.1 |
| A89 | (2026-11-07) Delete-all empties the index in its transaction (after the row deletes) and storage cleanup verifies it (empty, integrity check); cleanup empties leftovers while the tables are empty; leftover entries are cleanup evidence | M2.1 |
| A90 | (2026-11-07) No VACUUM of a non-empty database without a rebuild and integrity check of the index: the only sanctioned VACUUM is `vacuumDatabase`; a guard test rejects any other. **Tightened 2026-11-08 (approved):** `vacuumDatabase` refuses whenever `Message` or `Conversation` has rows; compacting a non-empty database is offline maintenance only (app stopped, backup, VACUUM, rebuild, integrity check), not implemented | M2.1 |
| A91 | (2026-11-07) `db:check-migrations` permits exactly the 10 search-index tables (2 virtual, 8 shadow) as the difference between migrations and schema, and rejects any other drift, including a missing index migration | M2.1 |
| A92 | (2026-11-07) Reviewed SQL migration with a `rebuild` backfill; applied to the real database only after approval; Prisma 7 and the writer architecture kept; no new dependencies | M2.1 |
| A93 | (2026-11-08) Query syntax: ordinary words, quoted phrases, a trailing prefix `*` on the last unquoted word; implicit AND; no FTS5 operators exposed (each term sent as one quoted FTS5 string) | M2.2 |
| A94 | (2026-11-08) Limits 256 code points (trimmed input) and 16 terms, prefix at least 2 letters or digits; no silent truncation: typed rejections `empty`, `no_terms`, `too_long`, `too_many_terms`, `prefix_too_short` | M2.2 |
| A95 | (2026-11-08) Ranking: bm25 (lower is better); a conversation's best visible-message match or its title match × 2; ties by update time (newest first, missing last), then id descending | M2.2 |
| A96 | (2026-11-08) Visibility: index unchanged; only conversations with a title match or a visible (on the path, non-hidden, non-structural) message match are returned; hidden- and branch-only matches are neither returned nor counted | M2.2 |
| A97 | (2026-11-08) Snippets: structured text/match segments from `snippet()`/`highlight()` with per-search random private-use markers; malformed markers fall back to plain text; segments capped; never rendered as HTML | M2.2 |
| A98 | (2026-11-08) Links: the best visible message's position in `getConversationDetail`'s default ordering gives page (÷ 1,000) and anchor `#m-<n>`; title-only matches link to the top | M2.2 |
| A99 | (2026-11-08) 20 conversations per page, `parsePage` rules; all matching conversations ranked per search, details for the requested page only | M2.2 |
| A100 | (2026-11-08) Typed outcomes and `sanitizeDbError` (missing index → `DB_NOT_MIGRATED`); bound parameters only; no logging of queries or content; `rawContentJson` never selected; reader connection without a transaction | M2.2 |
| A101 | (2026-11-08) Search through a guarded Server Action called with plain `(query, page)`; never `useActionState`, no previous results as arguments; `logging.serverFunctions: false` with a config guard test and a dev-mode output test | M2.3 |
| A102 | (2026-11-08) The action returns only what the page shows (segments, link, counts, date; no scores or raw titles); fixed error codes | M2.3 |
| A103 | (2026-11-08) Search terms kept out of URLs, cookies, localStorage, sessionStorage and IndexedDB; query and page in client memory only; Back re-runs the search (no stored results); reload clears; JavaScript required with a no-script note | M2.3 |
| A104 | (2026-11-08) Search UX: Search between Conversations and Import; labelled search landmark, `autocomplete="off"`, no `maxLength`; client pre-validation with the shared parser; focus to the results heading; live region with counts and positions only; latest response wins | M2.3 |
| A105 | (2026-11-08) Friendly conversation not-found page; `:target` outline and scroll margin in CSS only (applies to directly loaded links; in-app navigation scrolls without the outline) | M2.3 |
| A106 | (2026-11-08) Documented privacy guarantee: queries are not intentionally persisted, logged or placed in URLs; no claim about developer tools or request bodies | M2.3 |
| A107 | (2026-11-09) Search polish: the linked message is outlined after in-app navigation, Back and Forward (`LinkedMessageMarker`, `data-linked`; CSS `:target` kept for direct loads); results show the best match's message position. Other optional search improvements and the M2.4 role/date filters are not pursued (roadmap redirected to semantic discovery) | M2.3 |
| A108 | (2026-11-09) Execution order after M2: M2 → M5 → M3 → M4 → M6 → M7. Milestone IDs, their content and established decision numbers unchanged; recorded in PROJECT_PLAN and §5 | All |
| A109 | (2026-11-09) M5.0 approved for research preparation only (hardware via sysctl, synthetic multilingual evaluation set, keyword baseline, model/runtime/licence research, benchmark method and criteria, draft ADR 0002). Spike adjustments: small model first; categories paraphrase, cross-lingual, buried ideas, keyword decoys, unfinished projects; message-, chunk- and turn-level representations; chunk-based topic grouping and aggregated conversation vectors, keeping several topics per conversation possible; query embedding, retrieval, fusion and end-to-end latency measured separately; actual chunk counts, throughput, memory and disk measured; aggregate improvement with category regression analysis instead of zero regressions; ordinary SQLite vector storage compared with sqlite-vec without assuming either; Ollama only as an optional benchmark. No downloads or installs before explicit approval | M5 |

Implementation choices made during M0.1/M0.2 that the original plan did not specify (CSP
and security headers, Cache Components disabled, `agentRules: false`, `turbopack.root`,
`noUncheckedIndexedAccess`, exact version pinning, e2e on a production build on port
3100) are recorded in `docs/PROGRESS.md` and will be captured in the M0.3 ADR.

---

## Appendix: Reconstruction log (temporary review annotation)

### Resolved reconstructions (provenance only, no longer under review)

These passages no longer carry markers. The text now in the plan is the user-confirmed
wording; the original fragments remain in `docs/archive/IMPLEMENTATION_PLAN.original.md`.

| ID | § | Orig fragment | Reconstruction proposed | Decision (2026-11-03) |
| --- | --- | --- | --- | --- |
| R1 | 1 #6 | "Route Handler for uplop (default 50 MB" | "uploads, with an explicit size limit" | **Approved with clarifications** → A10 |
| R2 | 1 #7 | "Run deletNext checks Origin for those)" | "delete-all through a Server Action (Next checks…" | **Approved with security requirements** → A11 |
| R3 | 1 #8 | "NEXT_TELEMETRY_DISABLED=, use" | "=1 and CHECKPOINT_DISABLE=1" | **Revised**: `=1` kept; `CHECKPOINT_DISABLE=1` removed as unsupported → A12 |
| R54 | 5 M1.5 | "Origin check, siz content-type" | "size limit," | **Approved with clarifications** → A13 |
| R9 | 2 | "# redire" | "redirect to /conversations" (low confidence) | **Rejected**: `/` stays a landing page → A15 |
| R20 | 3 | "conversation_id → id →otherwise skip" | lost (possibly a further fallback) | **Resolved by decision**: `conversation_id` → `id` → content-derived ID without ambiguous merging → A16 |
| R31 | 3 | "rejects nonse" | "nonsense values"; bounds and handling lost | **Resolved by decision**: finite, representable timestamps; no arbitrary cutoffs → A22 |
| R32 | 3 | "contentHash of t." | lost | **Resolved by decision**: versioned hash over canonical validated source → A21 |
| R17 | 3 | "and currshows otherwise" | "current_node. Until a fixture or approved sample shows otherwise" | **Approved** → A23 |
| R18 | 3 | "toop-level shape" | "too large, wrong content type, invalid JSON, unsupported top-level shape" | **Approved** (= I1) → A23 |
| R19 | 3 | "(skip that conversatioobject" | "conversation and add a warning): not an object" | **Approved** → A23 |
| R21 | 3 | "warning): ment_type," | lost (possibly "unknown content_type") | **Resolved by decision** (malformed messages preserved) → A24 |
| R22 | 3 | "including nodes no data is lost" | "whose message is null and nodes off the default path, so" | **Approved** → A23 |
| R23 | 3 | "If pe, parent wins" | "If parent and the parent's children[] disagree" | **Approved** (`parent` only source) → A23 |
| R24 | 3 | "leaf node with a mes_time" | "message and the latest create_time" | **Modified**: valid timestamp required, `last_child` fallback, warning → A25 |
| R25 | 3 | "first root and  child" | "repeatedly follow the last child" | **Approved** → A23 |
| R26 | 3 | "Off-path nodes get" | "pathIndex = null" | **Approved** → A23 |
| R27 | 3 | "no messde is hidden if" | "message. A node is hidden if" | **Modified**: all system + explicitly hidden → A26 |
| R28 | 3 | "with a smal" | "small, explicit set of rules" | **Approved** → A23 |
| R29 | 3 | "with a text field:" | "use that field" | **Modified**: exact text + language → A27 |
| R30 | 3 | "string parts or texsert [unsupported" | "text if present; otherwise insert" | **Modified**: raw payload kept for unsupported content → A28 |
| R39 | 4 | "// user\ | assi null = structural node" | **Modified**: roles exact; structural flag → A29 |
| R46 | 5 M1.1 | "linear, branchie, missing" | "branching, " + lost items | **Approved** → A23 |
| R52 | 5 M1.4 | "batch row,  a raised timeout) for" | lost (transaction granularity) | **Resolved by decision** (2026-11-05): one transaction per conversation → A52 |
| R53 | 5 M1.4 | "updated, wnone left orphaned" | "with messages replaced and none left orphaned" | **Approved** (2026-11-05): atomic full replacement → A53 |
| R55 | 5 M1.6 | "visible path in or stamps" | "order, with roles and timestamps" | **Approved** (2026-11-05) → A71 |
| R56 | 5 M1.6 | "e2e:ture and check" | "import a fixture and check" | **Approved** (2026-11-05) → A71 |
| R57 | 5 M1.7 | "a Server Action th a single transaction" | "that deletes all imported data, after explicit confirmation, in" | **Approved** (2026-11-06) → A77; confirmation UX → A76 |

### Resolved by decision, inline markers kept

These reconstructions were resolved by later decisions, as recorded in
`docs/PROGRESS.md`. Their inline `⟦R#⟧` markers in §3 and §4 are kept as provenance
(not bulk-removed, M1 exit check 2026-11-07). The confirming amendment governs where it
differs from the reconstructed text.

| ID | § | Orig fragment | Decision |
| --- | --- | --- | --- |
| R33 | 3 | "updatedAt ther is missing)" | **Resolved by decision** (2026-11-04, Q4): a valid older incoming time → `conversationsOlder`; missing/invalid times, or equal valid times, with a different hash → flagged; stored data unchanged → A38/D43 |
| R34 | 3 | "older → skipped (o" | **Resolved by decision** (2026-11-04, Q4): older copies are counted as `older`, not skipped → A38/D43 |
| R35 | 4 | Prisma tokens (`@defa`, `"chatg`, `@rel`, …) | **Provisionally approved** (2026-11-04) → A42/D47; superseded by the approved §4 schema → A47 |
| R36 | 4 | "// capped nodeId?}; no content" | **Provisionally approved** (2026-11-04) → A42/D47; warning report format → A39, A45 |
| R37 | 4 | "// UI shows" | **Provisionally approved** (2026-11-04) → A42/D47; implemented as "Untitled conversation" (M1.6) |
| R38 | 4 | "// current_nhild" | **Provisionally approved** (2026-11-04) → A42/D47; strategies as in A25 |
| R40 | 4 | "deleteMany on Message, Conver a single transaction" | **Resolved by decision** (2026-11-04): ImportBatch, Conversation and Message deleted together in one transaction → A44/D50; implemented in M1.7 (A77) |

### Open reconstructions (still require review)

Conf: **H** = high, **L** = low, **—** = lost. ⚑ = material (data integrity, security or
parsing); needs explicit confirmation. "Orig" quotes the surviving fragment.

| ID | § | Orig fragment | Reconstruction | Evidence | Conf | ⚑ |
| --- | --- | --- | --- | --- | --- | --- |
| R4 | 1 #9 | "then a  warnings)" | "summary (counts and warnings)" | §5 M1.5 | H | |
| R5 | 1 #10 | "so creive" | "creating them now is speculative" | sense of sentence | H | |
| R6 | 1 #11 | "(-pre-wrap)" | "whitespace-pre-wrap" | Tailwind class name | H | |
| R7 | 1 #11 | "with it" | "its own XSS tests" | none: guess | L | ⚑ security |
| R8 | 1 #12 | "befor produces" | "before knowing what the parser produces" | "schema follows from its output types" | H | |
| R10 | 2 | "# Normalt)" | "Normalized* types (parser output)" | `NormalizedConversation[]` in adapter.ts | L | |
| R11 | 2 | "# roots," | "branches, visible path" | §3 Tree section | L | |
| R12 | 2 | "# idempo" | "idempotent import transaction" | §5 M1.4 | H | |
| R13 | 2 | "# delete" | "delete-all" | §5 M1.7 Settings page | H | |
| R14 | 2 | "# synthe" | "synthetic only" | CLAUDE.md; M1.1 | H | |
| R15 | 2 | "# Playwr" | "Playwright tests" | §5 M0.2 | H | |
| R16 | 3 | "All fixe written" | "fixtures will be written" | M1.1 "synthetic fixtures" | H | |
| R41 | 5 M0.1 | "TS stricouter"; "telemeovers" | "strict, Tailwind, ESLint, App Router"; "telemetry disabled; .gitignore covers" | §7 scope list | H | |
| R42 | 5 M0.1 | "127.0.0.1 on clean" | "only; typecheck and lint are clean" | §7 verification | H | |
| R43 | 5 M0.1 | "conversat" | "conversations.json .env" | §7 step 4 | H | |
| R44 | 5 M0.2 | "a sha the test" | "shared network guard that fails the test" | §1 #8 "Playwright guard that fails" | H | |
| R45 | 5 M0.3 | "READMEprivacy guarantees" | "README updated with setup, scripts, privacy guarantees" | Definition of done (CLAUDE.md) | H | |
| R47 | 5 M1.1 | "a non-array top le-upload.ts" | "top level, lost); read-upload.ts" | §2 `read-upload.ts` | L | |
| R48 | 5 M1.1 | "error c are reported" | "code; conversation-level problems are reported" | §3 error levels | L | |
| R49 | 5 M1.2 | "compn output" | "complete the adapter's normalized output" | §2 adapter.ts | L | |
| R50 | 5 M1.2 | "terminate with wa holds per type" | "warnings; content extraction holds per type" | §3 | L | |
| R51 | 5 M1.3 | "test-DB har" | "harness" | `tests/helpers/test-db.ts` | H | |
| R58 | 5 | "M1 acced" | "acceptance criteria re-verified" | PROJECT_PLAN M1 "Acceptance" | H | |
| R59 | 6 #1 | "(recu with nvm" | "(recommended); you install it with" | §1 #1 | H | |
| R60 | 6 #2 | "SQLite driver sma major needs one" | "adapter if the Prisma major needs one" | "sma" = "Prisma"; "adapter" is a guess | L | |
| R61 | 6 #2 | "because read and it saves" | lost (superseded by A1) | — | — | |
| R62 | 6 #3 | "overridabS" | "overridable via IMPORT_MAX_BYTES" | §7 `.env.example` | H | |
| R63 | 6 #4 | ""neweded)" | ""newer wins" (recommended)" | A3 wording | H | |
| R64 | 6 #6 | "hidden by defaultdden" toggle" | "; a "show hidden" toggle" | sentence structure | H | |
| R65 | 6 #8 | "file.jsond it only if" | "): not now; add it only if" | sentence structure | H | |
| R66 | 7 | "into the repo , FIRST_PROMPT.md" | "without overwriting CLAUDE.md" | the three pre-existing files | H | |
| R67 | 7 | "→ exit", "→ only 1", "scaffold f", "changes and ri" | "0", "127.0.0.1", "files", "risks, then" | sense; M0.1 verification as executed | H | |
