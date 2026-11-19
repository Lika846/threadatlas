/**
 * Constants of the persistent semantic index (M5.1b-1; design
 * `docs/m5.1b-semantic-index-design.md` §3–§7, decisions D123 and D124).
 *
 * Internal constants, not settings. Changing a value in `CODE_INDEX_CONFIG` makes every
 * stored vector unreadable at once (I7) and rebuilds the index at the next Start.
 */
import { CHUNKER_VERSION, DEFAULT_CHUNK_TOKENS } from "../chunker.ts";
import { E5_SMALL_SPEC, EMBEDDING_VERSION, INDEX_WINDOW_CHUNKS } from "../model-manifest.ts";
import { QUANTIZATION_VERSION } from "../quantize.ts";

/**
 * The id of the only `EmbeddingIndex` row. The schema cannot express "one row" (no
 * CHECK constraint in Prisma), so the store enforces it: every statement addresses this
 * id, the store is the only writer, any other row makes the index unreadable (reader)
 * and is removed by the next Reconcile, which then rebuilds the index.
 */
export const INDEX_ROW_ID = "main";

/** Attempts per conversation before it is `failed` (decision 3, §5.6). */
export const MAX_ATTEMPTS = 3;

/** Message text is read in pages at message boundaries (correction C, §5.4). */
export const PAGE_MAX_MESSAGES = 200;
/** Page budget, in characters as SQLite's `length()` counts them (code points). */
export const PAGE_MAX_CHARS = 1_000_000;

/** Chunks per embedding call (part of `EMBEDDING_VERSION`). */
export const WINDOW_CHUNKS = INDEX_WINDOW_CHUNKS;

/** Hard cap: a conversation with more chunks fails permanently with `CONVERSATION_TOO_LARGE` (D124). */
export const MAX_CHUNKS_PER_CONVERSATION = 20_000;

/** Rows per chunk INSERT statement (two parameters per statement: offsets as JSON, vectors as one blob). */
export const INSERT_ROWS_PER_STATEMENT = 1_000;

/** How long the indexer waits before trying a busy write lock again (§5.5). */
export const WRITE_LOCK_RETRY_MS = 1_000;

export const INDEX_STATES = ["pending", "running", "indexed", "failed"] as const;
export type IndexState = (typeof INDEX_STATES)[number];

/** The five fields that make stored vectors comparable (I7). */
export type IndexConfig = {
  readonly embeddingVersion: string;
  readonly chunkerVersion: string;
  readonly chunkTokens: number;
  readonly quantization: string;
  readonly dimensions: number;
};

export const CODE_INDEX_CONFIG: IndexConfig = {
  embeddingVersion: EMBEDDING_VERSION,
  chunkerVersion: CHUNKER_VERSION,
  chunkTokens: DEFAULT_CHUNK_TOKENS,
  quantization: QUANTIZATION_VERSION,
  dimensions: E5_SMALL_SPEC.dimensions,
};

export function sameIndexConfig(a: IndexConfig, b: IndexConfig): boolean {
  return (
    a.embeddingVersion === b.embeddingVersion &&
    a.chunkerVersion === b.chunkerVersion &&
    a.chunkTokens === b.chunkTokens &&
    a.quantization === b.quantization &&
    a.dimensions === b.dimensions
  );
}

/**
 * Static messages of the index codes (as for import issues: never built from content,
 * paths or native errors).
 */
export const INDEX_ERRORS = {
  CONVERSATION_TOO_LARGE: "This conversation is too large to index semantically. Keyword search still finds it.",
  INDEX_CONFIG_MISMATCH: "The embedding worker runs a different model configuration than the server. Restart ThreadAtlas.",
  INDEXER_BUSY: "Another ThreadAtlas process is already indexing this database.",
  INDEXER_LOCK_FAILED: "The indexing lock could not be taken safely, so indexing did not start.",
  WRITE_LOCK_FAILED: "The database write lock could not be taken safely, so indexing stopped.",
  INDEX_EMPTY: "The semantic index has not been built yet.",
  INDEX_INCOMPATIBLE: "The semantic index needs rebuilding. It will be rebuilt at the next Start.",
} as const;

export type IndexErrorCode = keyof typeof INDEX_ERRORS;
