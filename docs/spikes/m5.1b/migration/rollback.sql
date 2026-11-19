-- Manual rollback of the M5.1b semantic-index migration (never run automatically).
-- The three tables hold only derived data, so dropping them returns the M2 schema
-- with no loss of imported data. Restoring the pre-migration backup remains the
-- primary path. Run with the server stopped and the write lock free.
BEGIN;
DROP TABLE "EmbeddingChunk";
DROP TABLE "EmbeddingStatus";
DROP TABLE "EmbeddingIndex";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261111120000_semantic_index';
COMMIT;
