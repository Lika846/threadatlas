/**
 * Messages between the main thread (`embedder.ts`) and the inference worker
 * (`worker-core.ts`). Errors travel as codes only: no texts, paths, native messages or
 * stack traces cross the boundary.
 */
import type { Chunk, MessageInput } from "./chunker.ts";
import type { EmbeddingErrorCode } from "./errors.ts";
import type { TextKind } from "./pipeline.ts";

export type WorkerInit = {
  readonly modelDir: string;
  readonly verifyHashes: boolean;
};

export type WorkerReadyInfo = {
  readonly dimensions: number;
  readonly embeddingVersion: string;
  readonly chunkerVersion: string;
  readonly loadMs: number;
};

export type WorkerRequest =
  | { readonly type: "chunk"; readonly id: number; readonly messages: readonly MessageInput[] }
  | { readonly type: "encode"; readonly id: number; readonly kind: TextKind; readonly text: string }
  | {
      readonly type: "embed";
      readonly id: number;
      readonly kind: TextKind;
      readonly texts: readonly string[];
      /** Int32 flag on a SharedArrayBuffer; non-zero means "stop before the next batch". */
      readonly cancel: Int32Array;
    }
  | { readonly type: "shutdown" };

export type WorkerResponse =
  | { readonly type: "ready"; readonly info: WorkerReadyInfo }
  | { readonly type: "init-error"; readonly code: EmbeddingErrorCode }
  | { readonly type: "chunked"; readonly id: number; readonly chunks: Chunk[] }
  | { readonly type: "encoded"; readonly id: number; readonly ids: number[] }
  | { readonly type: "embedded"; readonly id: number; readonly data: Float32Array }
  | { readonly type: "error"; readonly id: number; readonly code: EmbeddingErrorCode }
  | { readonly type: "closed" };

/** Request limits, checked in the worker (and early in the client). */
export const LIMITS = {
  maxTextsPerCall: 10_000,
  maxMessagesPerCall: 10_000,
  maxTextLength: 1_000_000,
  /**
   * Total UTF-16 code units in one request to the inference child process (M5.1b-2). The
   * indexer's largest request is one page: ≤ 1,000,000 code points, so ≤ 2,000,000 units.
   */
  maxCharsPerCall: 2_000_000,
} as const;

// ---- Inference child process (M5.1b-2, docs/m5.1b-2-implementation-plan.md §3.2) ----
//
// The same messages as the worker thread, with two differences: memory cannot be shared
// across processes, so `embed` carries no cancel flag and cancellation is a message; and
// the start-up data arrives as the first message (`init`), never in argv or the environment.

export type ChildInit = {
  readonly type: "init";
  readonly modelDir: string;
  readonly verifyHashes: boolean;
  /** Read only by test entries (tests/helpers); the production entry ignores it. */
  readonly testOptions?: Readonly<Record<string, unknown>>;
};

export type ChildRequest =
  | ChildInit
  | { readonly type: "chunk"; readonly id: number; readonly messages: readonly MessageInput[] }
  | { readonly type: "embed"; readonly id: number; readonly kind: TextKind; readonly texts: readonly string[] }
  | { readonly type: "cancel"; readonly id: number }
  | { readonly type: "shutdown" };

/** Replies from the child are the worker's replies. */
export type ChildResponse = WorkerResponse;

/** Total UTF-16 code units of the texts a request carries. */
export function requestChars(texts: readonly string[]): number {
  let n = 0;
  for (const t of texts) n += t.length;
  return n;
}
