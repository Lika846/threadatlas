-- M2.1: full-text search index (SQLite FTS5). Decisions A85–A92; design in
-- docs/import-format.md, "Search index".
--
-- External-content FTS5 tables: the index stores terms and positions only and
-- reads text from "Message"."contentText" and "Conversation"."title" by rowid.
-- No second copy of the text is stored. Tokenizer: unicode61 with diacritics
-- removed, no stemming.
--
-- Prisma cannot describe virtual tables, so they are not in schema.prisma.
-- `npm run db:check-migrations` allows exactly these tables and their shadow
-- tables as the only difference (scripts/check-migrations.mjs). Prisma does not
-- see triggers; src/lib/db/schema.int.test.ts lists them.
--
-- The index is kept in sync by the triggers below, inside the same transaction
-- as the row change, so it commits and rolls back with it. They also fire for
-- rows removed by ON DELETE CASCADE. FTS5 "delete" requires the old values, so
-- delete and update triggers pass old.rowid with the old text.
--
-- The app's write paths never update "Message"."contentText" (a replacement
-- deletes and re-inserts the messages), but the update trigger keeps the index
-- correct if one ever does.
--
-- Additive only: no statement changes or removes existing rows
-- (tests/search-migration.test.ts checks every statement).
--
-- Explicit transaction: Prisma does not wrap SQLite migrations in one (measured
-- 2026-11-08: a failure at the last statement left all tables and triggers in
-- place). With BEGIN/COMMIT, a failure anywhere rolls the whole migration back.
-- Prisma then records the attempt as failed: recover by restoring the backup
-- taken before the migration (or `prisma migrate resolve`), never by editing
-- the database by hand.

BEGIN;

CREATE VIRTUAL TABLE "message_fts" USING fts5(
    "contentText",
    content='Message',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE "conversation_fts" USING fts5(
    "title",
    content='Conversation',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER "message_fts_after_insert" AFTER INSERT ON "Message" BEGIN
    INSERT INTO "message_fts"(rowid, "contentText") VALUES (new.rowid, new."contentText");
END;

CREATE TRIGGER "message_fts_after_delete" AFTER DELETE ON "Message" BEGIN
    INSERT INTO "message_fts"("message_fts", rowid, "contentText") VALUES ('delete', old.rowid, old."contentText");
END;

CREATE TRIGGER "message_fts_after_update" AFTER UPDATE OF "contentText" ON "Message" BEGIN
    INSERT INTO "message_fts"("message_fts", rowid, "contentText") VALUES ('delete', old.rowid, old."contentText");
    INSERT INTO "message_fts"(rowid, "contentText") VALUES (new.rowid, new."contentText");
END;

CREATE TRIGGER "conversation_fts_after_insert" AFTER INSERT ON "Conversation" BEGIN
    INSERT INTO "conversation_fts"(rowid, "title") VALUES (new.rowid, new."title");
END;

CREATE TRIGGER "conversation_fts_after_delete" AFTER DELETE ON "Conversation" BEGIN
    INSERT INTO "conversation_fts"("conversation_fts", rowid, "title") VALUES ('delete', old.rowid, old."title");
END;

CREATE TRIGGER "conversation_fts_after_update" AFTER UPDATE OF "title" ON "Conversation" BEGIN
    INSERT INTO "conversation_fts"("conversation_fts", rowid, "title") VALUES ('delete', old.rowid, old."title");
    INSERT INTO "conversation_fts"(rowid, "title") VALUES (new.rowid, new."title");
END;

-- Backfill: index every existing row (about 0.7 s per 52,000 messages, measured
-- in M2.0). Reads "Message" and "Conversation"; writes only the index.
INSERT INTO "message_fts"("message_fts") VALUES ('rebuild');
INSERT INTO "conversation_fts"("conversation_fts") VALUES ('rebuild');

COMMIT;
