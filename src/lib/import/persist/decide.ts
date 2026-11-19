import { compareParserVersions, parseContentHash, parseParserVersion } from "./versions";

/**
 * What to do with one incoming conversation, given the stored copy (M1.4
 * state table, cases 5–13). Pure: no database, no clock.
 *
 * Newer data is never replaced by older data:
 * - a write needs either an identical source (equal hash) and a strictly
 *   newer parser (case 7), or a strictly newer valid `update_time` (case 8);
 * - missing, invalid or equal times with a different hash are flagged (A38);
 * - output of an older parser never replaces output of a newer one (case 12);
 * - unrecognised hash or parser versions are never compared (case 13).
 */

export type StoredSummary = {
  id: string;
  contentHash: string;
  updatedAtSec: number | null;
  parserVersion: string;
};

export type IncomingSummary = {
  contentHash: string;
  /** Validated `update_time` in epoch seconds, or null. */
  updatedAt: number | null;
  parserVersion: string;
};

export type Decision =
  | { kind: "add"; case: 5 }
  | { kind: "unchanged"; case: 6 }
  | { kind: "replace"; case: 7; code: "CONVERSATION_REPROCESSED" }
  | { kind: "replace"; case: 8 }
  | { kind: "older"; case: 9; code: "CONVERSATION_OLDER" }
  | { kind: "flagged"; case: 10 | 11; code: "CONVERSATION_VERSION_AMBIGUOUS"; field?: "update_time" }
  | { kind: "flagged"; case: 12; code: "CONVERSATION_PARSER_DOWNGRADE" }
  | {
      kind: "flagged";
      case: 13;
      code: "CONVERSATION_STATE_UNRECOGNISED";
      field: "contentHash" | "parserVersion";
    };

const validTime = (t: number | null): t is number => typeof t === "number" && Number.isFinite(t);

function unrecognised(field: "contentHash" | "parserVersion"): Decision {
  return { kind: "flagged", case: 13, code: "CONVERSATION_STATE_UNRECOGNISED", field };
}

export function decide(stored: StoredSummary | null, incoming: IncomingSummary): Decision {
  const inHash = parseContentHash(incoming.contentHash);
  const inParser = parseParserVersion(incoming.parserVersion);
  // Defensive: the service refuses to run with an invalid own parser version,
  // and normalisation always produces a v1 hash.
  if (!inHash) return unrecognised("contentHash");
  if (!inParser) return unrecognised("parserVersion");

  if (stored === null) return { kind: "add", case: 5 };

  const stHash = parseContentHash(stored.contentHash);
  const stParser = parseParserVersion(stored.parserVersion);
  if (!stHash) return unrecognised("contentHash");
  if (!stParser) return unrecognised("parserVersion");
  // Hashes of different versions are not comparable. Unreachable while only
  // v1 is known; kept so adding v2 cannot silently compare across versions.
  if (stHash.version !== inHash.version) return unrecognised("contentHash");

  const parserOrder = compareParserVersions(stParser, inParser);

  if (stHash.digest === inHash.digest) {
    // Identical source (hash v1 covers the raw source, I15): only the
    // parser's output can differ.
    return parserOrder < 0 ? { kind: "replace", case: 7, code: "CONVERSATION_REPROCESSED" } : { kind: "unchanged", case: 6 };
  }

  if (!validTime(stored.updatedAtSec) || !validTime(incoming.updatedAt)) {
    return { kind: "flagged", case: 11, code: "CONVERSATION_VERSION_AMBIGUOUS", field: "update_time" };
  }
  if (incoming.updatedAt === stored.updatedAtSec) {
    return { kind: "flagged", case: 10, code: "CONVERSATION_VERSION_AMBIGUOUS" };
  }
  if (incoming.updatedAt < stored.updatedAtSec) return { kind: "older", case: 9, code: "CONVERSATION_OLDER" };
  if (parserOrder > 0) return { kind: "flagged", case: 12, code: "CONVERSATION_PARSER_DOWNGRADE" };
  return { kind: "replace", case: 8 };
}
