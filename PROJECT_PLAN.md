# ThreadAtlas — Implementation Plan

> **Note (2026-11-03):** This document is the high-level roadmap. The authoritative
> detailed plan is [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). It
> **supersedes** the provisional data model and the Milestone 1 task ordering below.
> Progress, confirmed decisions and open questions are tracked in
> [`docs/PROGRESS.md`](docs/PROGRESS.md).

> **Execution order (2026-11-09):** after Milestone 2 the milestones are executed in the
> order **M2 → M5 → M3 → M4 → M6 → M7**. Semantic retrieval comes first so that topic
> grouping, the map and later rediscovery features can build on it. The milestone IDs
> and their content below are unchanged, and established decisions keep their
> references (IMPLEMENTATION_PLAN A108).

## Product vision
A private, local-first tool that turns exported ChatGPT conversations into a browsable and eventually searchable knowledge base, with topic grouping and an interactive relationship graph.

## MVP boundary
Single-user, local development application. No account creation, cloud sync, third-party model calls, or public hosting with personal data. Import JSON, browse conversations, view messages, keyword search. The AI and graph features come later.

## Proposed stack
- Next.js App Router, TypeScript strict, Tailwind CSS
- SQLite with Prisma
- SQLite FTS5 for keyword search, introduced in phase 2 (Prisma may require raw SQL migrations/queries for FTS5)
- Vitest for unit/integration tests; Playwright for critical UI flows
- React Flow for graph UI in phase 4
- Local embeddings for semantic search in phase 5, with model and runtime chosen after benchmarking

## Data model (provisional)
- ImportBatch: id, importedAt, sourceFilename, status, counts
- Conversation: id (stable source ID), title, createdAt, updatedAt, importBatchId
- Message: id (stable source ID), conversationId, parentId nullable, role, contentText, createdAt, metadataJson nullable
- Category: id, name, assignmentMethod, description nullable
- ConversationCategory: conversationId, categoryId, score nullable, explanation nullable
- ConversationLink: sourceConversationId, targetConversationId, score, method, explanation nullable

Review source IDs, branching, duplicates, content types, import batch lineage and cascade-delete behavior before implementing schema. Avoid persisting sensitive raw exports unnecessarily.

> **Superseded (2026-11-03):** The model above is replaced by `docs/IMPLEMENTATION_PLAN.md`
> §4. In particular:
> - surrogate primary keys with `@@unique([source, sourceId])` and
>   `@@unique([conversationId, sourceNodeId])`, instead of source IDs as primary keys;
> - `firstImportBatchId` / `lastImportBatchId`, instead of a single `importBatchId`;
> - the parent stored as a `parentSourceNodeId` string, instead of a self-referential FK;
> - Category, ConversationCategory and ConversationLink deferred to M3/M4 (not in the M1
>   schema).
>
> Raw exports are not persisted (decision A4).

## Milestone 0 — Architecture and scaffold
Deliverables: project structure, ADR for stack and privacy, README, quality scripts, basic UI shell.
Acceptance: app starts locally, typecheck/lint/test scripts run, initial Playwright smoke test passes.

## Milestone 1 — Import and browse

> **Superseded task order (2026-11-03):** M1 is implemented parser-first, as tasks
> M1.1–M1.7 in `docs/IMPLEMENTATION_PLAN.md` §5: fixtures and validation → tree and
> content extraction → schema → import service → import UI → browse → delete-all. The
> acceptance criteria below still apply.
1. Implement schema and migrations with synthetic test data.
2. Implement ChatGPT JSON import parser/validator and fixture tests.
3. Implement idempotent import transaction and clear error messages.
4. Build import UI with progress/feedback, size limit and supported-format note.
5. Build conversation list and message detail view with empty states.
6. Add delete-all-data control with explicit confirmation.
Acceptance: import a synthetic JSON export twice without duplicate conversations; browse messages in correct order; handle branches/missing metadata; invalid file is rejected safely; no network transmission of conversation data.

## Milestone 2 — Keyword search
1. Add SQLite FTS5 index with migration and synchronization strategy.
2. Search titles and message text; return conversation-level results with snippets.
3. Add filters for role/date and clear no-results states if straightforward.
4. Test search correctness, updates and special characters.
Acceptance: search finds fixture terms and navigates to relevant conversation; index remains consistent after import and deletion.

## Milestone 3 — Theme grouping
Begin with user-editable rules/keywords or a transparent deterministic baseline. Evaluate quality on synthetic and optionally explicitly approved real samples. Store category assignment method and reason. Avoid assuming LLM classification is required.
Acceptance: conversations can be grouped and manually corrected; explanations are visible.

## Milestone 4 — Interactive map
Use React Flow for a graph of conversations/themes. Start with explicitly assigned relationships or explainable keyword similarity; add automatic similarity only when measured useful. Add graph filters, node click-through, and controls to limit clutter.
Acceptance: graph remains navigable on a representative dataset; relationships have explanations.

## Milestone 5 — Semantic retrieval
Benchmark local embedding options on privacy, hardware, quality, speed, and maintenance. Chunk messages/conversations with provenance; store model/version; build a reproducible embedding pipeline. Evaluate on a small set of human-authored search questions and expected results. No external API by default.
Acceptance: semantic retrieval outperforms or complements keyword search on evaluation queries; sources are linked.

## Milestone 6 — RAG assistant
Answer questions only from retrieved conversations, provide links to source conversations/messages, and distinguish unsupported answers. Use local inference or ask for explicit approval before using a remote model.
Acceptance: cited answers, explicit abstention when evidence is missing, injection-resistant handling of imported content.

## Milestone 7 — Portfolio release
Documentation, architecture diagram, demo with synthetic data, screenshots, CI, license and privacy statement. Never publish actual chat exports or secrets.

## Risks and design checks
- Export schema variability, branching threads, deleted messages, multimodal content
- Import limits and memory pressure; choose size limits after testing
- Duplicate IDs, partial imports, timestamp consistency
- XSS, prompt injection from imported text, unsafe file handling
- FTS5/Prisma integration and index consistency
- Privacy: accidental logs, telemetry, cloud requests, screenshots and Git commits
- Large graph usability and performance

## Claude Code workflow
For each task: (1) inspect existing files, (2) propose plan and acceptance tests, (3) await approval, (4) implement only agreed scope, (5) run checks, (6) summarize diff and risks. Commit only with user approval.
