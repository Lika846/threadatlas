1. Review of the stack and MVP scope

The stack is reasonable for a local, single-user app. Here are the risks and the places where I'd simplify:

#: 1
Issue: Node 20.15 is end-of-life (Node 20 EOL was April 2026)
Why it matters: Current Prisma, Vite/Vitest, and Next releases need Node ≥ 20.19 or newer
Recommendation: Install Node 24 LTS before scaffolding and pin it with .nvmrc and engines. You do the install (nvm, fnm,
or Homebrew).
────────────────────────────────────────
#: 2
Issue: Plan uses source IDs as primary keys (Message.id = stable source ID)
Why it matters: The export doesn't guarantee globally unique node IDs, and colliding IDs across conversations would
corrupt data
Recommendation: Use surrogate PKs plus @@unique([source, sourceId]) and @@unique([conversationId, sourceNodeId])
────────────────────────────────────────
#: 3
Issue: Conversation.importBatchId (single link)
Why it matters: Loses lineage when a conversation is re-imported
Recommendation: Store firstImportBatchId and lastImportBatchId
────────────────────────────────────────
#: 4
Issue: Self-referential FK for parentId
Why it matters: Forces insert ordering (parents first), breaks when a parent is missing from the export, and is awkward in
Prisma
Recommendation: Store the parent as the source node ID string (parentSourceNodeId). It's joinable through the composite
unique key, and a dangling parent is still recorded.
────────────────────────────────────────
#: 5
Issue: Prisma + FTS5 (Milestone 2)
Why it matters: Prisma can't model virtual tables. A later migrate dev may try to drop tables it doesn't know about.
Recommendation: Keep Prisma for M1. At the start of M2, run a 1-session spike: FTS5 through a hand-edited migration plus
$queryRaw. If it fights us, we write an ADR about switching the data layer (for example Drizzle or better-sqlite3). I'm
not proposing that switch now.
────────────────────────────────────────
#: 6
Issue: Large uploads
Why it matters: JSON.parse on a 200 MB string can use more than 1 GB of heap. Next Server Actions default to a 1 MB body
limit.                                                                                                                Recommendation: Use a Route Handler for uplop (default 50 MB, see decisions), and in-memory
parsing only (never written to disk). Streaming parsing (stream-json) waits until measurements show we need it.       ────────────────────────────────────────
#: 7                                                                                                                  Issue: Localhost attack surface
Why it matters: next dev binds to all interfaces by default, so other devices on your network can reach your data. Any
website you visit can also POST to localhost:3000 (CSRF against import or delete-all).
Recommendation: Bind to 127.0.0.1. Run deletNext checks Origin for those). The import Route
Handler gets an explicit Origin/Host check.
────────────────────────────────────────
#: 8
Issue: Unintended network traffic
Why it matters: Next telemetry, Prisma CLI telemetry, and next/font/google (fetches from Google) in the
create-next-app
template
Recommendation: Set NEXT_TELEMETRY_DISABLED=, use a system font stack, and add a Playwright
guard that fails on any non-localhost request
────────────────────────────────────────
#: 9
Issue: "Import progress" UI
Why it matters: Real progress for a single-request upload needs streaming or polling, which adds complexity
Recommendation: M1: a pending state, then a  warnings). True progress only if imports turnout
slow.
────────────────────────────────────────
#: 10
Issue: Category and ConversationLink models
Why it matters: They belong to M3/M4, so creive
Recommendation: Leave them out of the M1 schema
────────────────────────────────────────
#: 11
Issue: Rendering message content
Why it matters: XSS risk
Recommendation: M1 renders plain text only (-pre-wrap). Never dangerouslySetInnerHTML.Markdown
rendering later, behind a sanitizer, with it
────────────────────────────────────────
#: 12
Issue: Task order: schema before parser
Why it matters: We'd design the schema befor produces
Recommendation: Build the parser first as pure functions with no DB. It's the riskiest part and the easiest to test.
The
schema follows from its output types.

Everything else (Tailwind, Vitest, Playwright, SQLite) is the right size. No extra dependencies are needed beyond
what's listed in §6.

---

2. Directory structure

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
│   │   ├── page.tsx                # redire
│   │   ├── conversations/page.tsx  # list
│   │   ├── conversations/[id]/page.tsx
│   │   ├── import/page.tsx
│   │   ├── settings/page.tsx       # delete
│   │   └── api/import/route.ts     # upload endpoint
│   ├── lib/
│   │   ├── db.ts                   # Prisma client singleton
│   │   ├── import/
│   │   │   ├── errors.ts           # error/warning codes (no content in messages)
│   │   │   ├── types.ts            # Normalt)
│   │   │   ├── read-upload.ts      # size/type/JSON.parse → unknown
│   │   │   ├── chatgpt/
│   │   │   │   ├── adapter.ts      # detect + parse → NormalizedConversation[]
│   │   │   │   ├── tree.ts         # roots,
│   │   │   │   └── content.ts      # content_type → text/placeholder
│   │   │   └── persist.ts          # idempo
│   │   └── conversations/queries.ts
│   └── components/
├── tests/
│   ├── fixtures/chatgpt/*.json     # synthe
│   └── helpers/test-db.ts          # temp SQLite per test file
├── e2e/                            # Playwr
└── data/                           # gitignored; threadatlas.db lives here

Unit tests sit next to their code (*.test.ts). DB integration tests use *.int.test.ts.

---

3. Parsing a ChatGPT conversations.json safely

Principle: treat the file as untrusted, unknown data. The adapter reads only the fields it needs, narrows every one at
runtime, and ignores unknown fields. All fixe written to match the commonly observed shape: an array of conversations, each with title, create_time/update_time (epoch seconds), mapping (nodeId → {id,
message|null, parent, children[]}), and currshows otherwise, each of these is an assumption. Each assumption is checked, and a failure produces a coded error or warning instead of a crash.

Three error levels. No error or log line ever includes message content. They contain codes, indices, and IDs only.
1. File-level (fatal, nothing imported): toop-level shape (initially only a top-level arrayis accepted), empty array. The UI shows a clear message.
2. Conversation-level (skip that conversatioobject, no usable ID (conversation_id → id →otherwise skip; we never invent an identity), mapping missing or not an object.
3. Node-level (tolerated, add a warning): ment_type, bad timestamps, dangling parent, achild that isn't in the mapping, a mapping key that differs from node.id (the key wins).

Tree and visible path (documented in docs/import-format.md).
- Store every mapping node, including nodes no data is lost.
- Roots are nodes whose parent is null or missing from the mapping. Multiple roots produce a warning.
- Each node's parent comes from parent. If pe, parent wins and a warning is added.siblingIndex is the node's position in its parent's children.
- Choosing the default visible leaf:
  a. Use current_node if it exists in the mapping (strategy current_node).
  b. Otherwise, use the leaf node with a mes_time (strategy latest_leaf). Ties go to thelater mapping order.
  c. Otherwise, start at the first root and  child (strategy last_child).
- Walk from the leaf up through parent with a visited set. A cycle stops the walk with a warning. Reverse the result
  to get pathIndex 0..n. Off-path nodes get
- The strategy used is stored on the Conversation, so the UI can explain itself.
- The display filters out nodes with no messde is hidden ifmetadata.is_visually_hidden_from_conversation is set, or if it's a system message with empty content. The rule is
  documented and tested.
- Branch points (a parent with more than one child) show a "n versions exist" marker. You can't navigate between
  branches in M1.

Content types. Text is extracted with a smal
- text: join the string parts with blank lines.
- code and similar types with a text field:
- multimodal_text: keep string parts and replace object parts with [image] or [attachment: <type>].
- Anything else: extract string parts or texsert [unsupported content: <type>] and sethasUnsupportedParts = true.

The raw content_type is always stored, and an unknown type never fails the import.

Timestamps. Epoch numbers (including floats) are accepted, ISO strings are tolerated, and anything else becomes null
with a warning. A sanity range rejects nonse

Duplicates.
- Within one file: same source ID twice → keep the one with the later update_time, plus a warning.
- Across imports: compute a contentHash of t.
  - Hash matches the stored conversation → unchanged.
  - Hash differs and the incoming updatedAt ther is missing) → updated: messages arereplaced in the transaction, firstImportBatchId is kept.
  - Incoming updatedAt is older → skipped (o
- The file's SHA-256 is recorded on the batch, so the UI can say "this exact file was already imported". Correctness
  doesn't depend on it.

---

4. Milestone 1 schema (Prisma / SQLite)

prisma
model ImportBatch {
  id                     String    @id @defa
  startedAt              DateTime  @default(now())
  finishedAt             DateTime?
  status                 String    // running | succeeded | succeeded_with_warnings | failed
  adapter                String    // "chatg
  adapterVersion         String
  sourceFilename         String
  sourceSha256           String
  sourceBytes            Int
  conversationsSeen      Int       @default(0)
  conversationsAdded     Int       @default(
  conversationsUpdated   Int       @default(0)
  conversationsUnchanged Int       @default(
  conversationsSkipped   Int       @default(0)
  warningsJson           String?   // capped nodeId?}; no content
  errorCode              String?
  firstImported          Conversation[] @rel
  lastImported           Conversation[] @relation("LastImport")
}

model Conversation {
  id                  String    @id @default(cuid())
  source              String    // "chatgpt"
  sourceId            String
  title               String?   // UI shows
  createdAt           DateTime?
  updatedAt           DateTime?
  currentNodeSourceId String?
  pathStrategy        String    // current_nhild
  visibleMessageCount Int
  nodeCount           Int
  contentHash         String
  firstImportBatchId  String?
  lastImportBatchId   String?
  firstImportBatch    ImportBatch? @relationirstImportBatchId], references: [id], onDelete:SetNull)
  lastImportBatch     ImportBatch? @relationastImportBatchId],  references: [id], onDelete:SetNull)
  messages            Message[]
  @@unique([source, sourceId])
  @@index([updatedAt])
}

model Message {            // one row per mapping node
  id                  String    @id @default
  conversationId      String
  conversation        Conversation @relation references: [id], onDelete: Cascade)
  sourceNodeId        String    // mapping key
  sourceMessageId     String?   // message.i
  parentSourceNodeId  String?   // as exported; may dangle
  siblingIndex        Int
  pathIndex           Int?      // null = off default path
  role                String?   // user|assi null = structural node
  authorName          String?
  contentType         String?
  contentText         String    @default("")
  hasUnsupportedParts Boolean   @default(fal
  isHidden            Boolean   @default(false)
  status              String?
  createdAt           DateTime?
  @@unique([conversationId, sourceNodeId])
  @@index([conversationId, pathIndex])
}

Notes:
- Roles are strings, not enums, so an unknown role from a newer export doesn't break the import. They are validated in
  TypeScript.
- Deleting a Conversation cascades to its Messages.
- Delete-all = deleteMany on Message, Conver a single transaction.
- No raw export is stored. Provenance comes from the batch metadata, the file hash, and the source IDs.

---

5. Task breakdown (one Claude Code session each)

Milestone 0 — Scaffold

M0.1 Project scaffold & privacy config
- Scope: git init; create-next-app (TS stricouter, src/), scaffolded in the scratchpad andmoved in so the existing docs are kept; remove boilerplate and next/font/google; .nvmrc and engines; scripts dev (-H
  127.0.0.1), build, typecheck, lint; telemeovers data/, *.db*, .env, and anyconversations*.json outside tests/fixtures; .env.example.
- Acceptance: the app serves on 127.0.0.1 on clean; no real-data paths can be committed.
- Verify: curl 127.0.0.1:3000 → 200; lsof -iTCP:3000 shows only the loopback address; npm run typecheck && npm run
  lint; git check-ignore data/x.db conversat

M0.2 Test tooling
- Scope: Vitest config with one trivial unit test; Playwright config (builds and runs on 127.0.0.1, uses a test
  DATABASE_URL later); smoke e2e test; a sha the test on any non-localhost request.
- Acceptance and verify: npm test and npm run test:e2e pass; a deliberate external fetch in a scratch test fails the
  guard.

M0.3 UI shell + ADR + README
- Scope: layout with a skip link and nav (Conversations / Import / Settings); placeholder pages with empty states;
  docs/adr/0001-stack-and-privacy.md; READMEprivacy guarantees, and limitations.
- Tests: e2e checks that each nav link renders its heading. A basic keyboard-nav and landmark check.

Milestone 1 — Import & browse

M1.1 Fixtures + file/conversation-level validation (pure, no DB)
- Scope: synthetic fixtures (linear, branchie, missing current_node, missing title andtimestamps, null-message root, multimodal/code/unknown content, hidden system message, duplicate IDs in one file,
  dangling parent, cycle, a non-array top le-upload.ts; error codes; adapter skeletonproducing conversation-level results.
- Tests: every fatal case yields its error c are reported with codes; no content appears inerror strings.

M1.2 Tree reconstruction + content extraction + docs/import-format.md
- Scope: tree.ts and content.ts per §3; compn output; contentHash.
- Tests: the visible path matches the hand-computed expected order for each fixture; all 3 strategies are covered; the
  cycle and dangling cases terminate with waholds per type; hashing is deterministic.

M1.3 Prisma schema + migration + test-DB har
- Scope: the §4 schema, initial migration, db.ts singleton, tests/helpers/test-db.ts (temp file DB plus migrate
  deploy).
- Tests: integration tests cover the unique constraints and the cascade delete.

M1.4 Idempotent import service
- Scope: persist.ts. Creates the batch row,  a raised timeout) foradded/updated/unchanged/older, finalizes counts. On failure the transaction rolls back and the batch is marked
  failed.
- Tests: importing the same fixture twice → identical row counts and the second batch reports all conversations
  unchanged; a modified fixture → updated, wnone left orphaned; an older version → skipped;an injected failure → no partial data.

M1.5 Import route + UI
- Scope: POST /api/import (Origin check, sizcontent-type check, never writes to disk, logscounts only); an import page with the size limit and supported-format note, a pending state, a summary of counts and
  warnings, and accessible error messages.
- Tests: Route Handler tests for oversized, non-JSON, bad Origin, and a valid file; e2e: upload a fixture → see the
  summary.

M1.6 Conversation list + detail
- Scope: the list sorted by updatedAt desc, with a simple limit/offset (50) and an empty state that links to Import;
  detail view showing the visible path in orstamps, plain-text content, unsupported-contentplaceholders, branch markers, a "path strategy" note, and a 404 for unknown IDs.
- Tests: query unit tests for ordering; e2e:ture and check the message order; an XSS fixture (<script> and <img onerror> in content) renders as literal text.

M1.7 Delete-all
- Scope: a Settings page; a Server Action th a single transaction; a success message.
- Tests: integration test that all three tables are empty afterwards; e2e covering cancel (nothing deleted) and
  confirm (empty state shown).

M1 exit check: the full PROJECT_PLAN M1 acced, with README limitations updated.

---

6. Decisions I need from you (with recommend

1. Node version: upgrade to Node 24 LTS (recu with nvm, fnm, or Homebrew.
2. Dependencies to approve: next, react, react-dom, typescript, tailwindcss, eslint (through create-next-app), prisma
   + @prisma/client (plus the SQLite driver sma major needs one; I'll confirm the exactversions at install time), vitest, @playwright/test. Optional: zod for boundary validation. I recommend
   hand-written type guards instead, becauseread and it saves a dependency. Choose zod ifyou'd rather learn it.
3. Upload size cap: default 50 MB, overridabS. If you're comfortable, run ls -lh on yourreal export (filename and size only, no contents) so we can calibrate.
4. Re-import policy: content-hash plus "neweded), or alternatively always overwrite.
5. Raw export storage: none (recommended).
6. Hidden/system messages: hidden by defaultdden" toggle can come later.
7. Git: run git init in M0.1, and I commit only when you ask, at the end of each task (recommended).
8. CLI importer (npm run import -- file.jsond it only if UI upload limits become a problem.
9. FTS5 / Prisma: no decision now; spike at the start of M2.

---

7. Recommended first implementation task: M0.1 Project scaffold & privacy config

Precondition: Node 24 LTS installed by you (node -v shows v24.x).

Exact scope (nothing more):
- git init (no commit until you approve)
- Run create-next-app in the scratchpad with TS, Tailwind, ESLint, App Router, src/, @/* alias, npm (check flags with
  --help first), then copy it into the repo , FIRST_PROMPT.md, or PROJECT_PLAN.md
- Confirm strict: true in tsconfig; remove the template's demo assets and the next/font/google usage
- package.json: engines.node, scripts dev / typecheck (tsc --noEmit), lint
- .nvmrc, .env.example (DATABASE_URL, IMPORT_MAX_BYTES, NEXT_TELEMETRY_DISABLED=1, CHECKPOINT_DISABLE=1), .gitignore
  additions for real-data paths
- A minimal home page with the heading "ThreadAtlas". No DB, no Prisma, no tests yet (those come in M0.2).

Verification (I run and report the actual output):
1. npm run typecheck and npm run lint → exit
2. npm run dev, then curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000 → 200
3. lsof -nP -iTCP:3000 -sTCP:LISTEN → only 1
4. git check-ignore -v data/threadatlas.db conversations.json .env → all ignored
5. git status → only the expected scaffold f

Afterwards I'll summarize the changes and ri wait for your go-ahead.

⏺ Checking Node version and available version man
  ⎿  $ node -v; ls ~/.nvm 2>/dev/null | head -3; command -v fnm nvm brew volta 2>/dev/null

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Check Node version and available version manager
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │ node -v; ls ~/.nvm 2>/dev/null | head -3; comm2>/dev/null
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 This command requires approval
