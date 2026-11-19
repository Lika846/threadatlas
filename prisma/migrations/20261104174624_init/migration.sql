-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "sourceBytes" INTEGER NOT NULL,
    "conversationsSeen" INTEGER NOT NULL DEFAULT 0,
    "conversationsAdded" INTEGER NOT NULL DEFAULT 0,
    "conversationsUpdated" INTEGER NOT NULL DEFAULT 0,
    "conversationsUnchanged" INTEGER NOT NULL DEFAULT 0,
    "conversationsOlder" INTEGER NOT NULL DEFAULT 0,
    "conversationsFlagged" INTEGER NOT NULL DEFAULT 0,
    "conversationsSkipped" INTEGER NOT NULL DEFAULT 0,
    "warningsJson" TEXT,
    "errorCode" TEXT
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "idSource" TEXT NOT NULL,
    "title" TEXT,
    "createdAtSec" REAL,
    "updatedAtSec" REAL,
    "currentNodeSourceId" TEXT,
    "pathStrategy" TEXT NOT NULL,
    "visibleMessageCount" INTEGER NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "firstImportBatchId" TEXT,
    "lastImportBatchId" TEXT,
    CONSTRAINT "Conversation_firstImportBatchId_fkey" FOREIGN KEY ("firstImportBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Conversation_lastImportBatchId_fkey" FOREIGN KEY ("lastImportBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "parentSourceNodeId" TEXT,
    "siblingIndex" INTEGER NOT NULL,
    "pathIndex" INTEGER,
    "isStructural" BOOLEAN NOT NULL DEFAULT false,
    "isMalformed" BOOLEAN NOT NULL DEFAULT false,
    "role" TEXT,
    "authorName" TEXT,
    "contentType" TEXT,
    "contentText" TEXT NOT NULL DEFAULT '',
    "codeLanguage" TEXT,
    "hasUnsupportedParts" BOOLEAN NOT NULL DEFAULT false,
    "rawContentJson" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,
    "createdAtSec" REAL,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ImportBatch_sourceSha256_idx" ON "ImportBatch"("sourceSha256");

-- CreateIndex
CREATE INDEX "ImportBatch_startedAt_idx" ON "ImportBatch"("startedAt");

-- CreateIndex
CREATE INDEX "Conversation_updatedAtSec_idx" ON "Conversation"("updatedAtSec");

-- CreateIndex
CREATE INDEX "Conversation_firstImportBatchId_idx" ON "Conversation"("firstImportBatchId");

-- CreateIndex
CREATE INDEX "Conversation_lastImportBatchId_idx" ON "Conversation"("lastImportBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_source_sourceId_key" ON "Conversation"("source", "sourceId");

-- CreateIndex
CREATE INDEX "Message_conversationId_pathIndex_idx" ON "Message"("conversationId", "pathIndex");

-- CreateIndex
CREATE INDEX "Message_conversationId_parentSourceNodeId_idx" ON "Message"("conversationId", "parentSourceNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_sourceNodeId_key" ON "Message"("conversationId", "sourceNodeId");
