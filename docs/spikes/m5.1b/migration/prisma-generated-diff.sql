-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "conversation_fts";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "conversation_fts_config";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "conversation_fts_data";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "conversation_fts_docsize";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "conversation_fts_idx";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "message_fts";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "message_fts_config";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "message_fts_data";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "message_fts_docsize";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "message_fts_idx";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "EmbeddingIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "epoch" INTEGER NOT NULL,
    "embeddingVersion" TEXT NOT NULL,
    "chunkerVersion" TEXT NOT NULL,
    "chunkTokens" INTEGER NOT NULL,
    "quantization" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "changeCounter" INTEGER NOT NULL,
    "lastErrorCode" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EmbeddingStatus" (
    "conversationId" TEXT NOT NULL PRIMARY KEY,
    "contentHash" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "claimToken" TEXT,
    "attempts" INTEGER NOT NULL,
    "chunkCount" INTEGER,
    "lastErrorCode" TEXT,
    "queuedAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmbeddingStatus_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmbeddingChunk" (
    "conversationId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "chunkKey" TEXT NOT NULL,
    "vector" BLOB NOT NULL,

    PRIMARY KEY ("conversationId", "sourceNodeId", "chunkIndex"),
    CONSTRAINT "EmbeddingChunk_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EmbeddingStatus_state_queuedAt_idx" ON "EmbeddingStatus"("state", "queuedAt");

-- CreateIndex
CREATE INDEX "EmbeddingChunk_epoch_idx" ON "EmbeddingChunk"("epoch");
