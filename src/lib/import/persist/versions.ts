/**
 * Strict grammars for the two version markers stored on every conversation
 * (M1.4, refinement C). Only recognised, well-formed values are ever
 * compared; anything else is "unrecognised" and the caller fails safe (the
 * conversation is flagged and nothing is written).
 */

/** `major.minor.patch`, each 0 or 1–6 digits without a leading zero. No pre-release or build suffixes. */
const PARSER_VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export type ParserVersion = readonly [major: number, minor: number, patch: number];

export function parseParserVersion(value: unknown): ParserVersion | null {
  if (typeof value !== "string") return null;
  const m = PARSER_VERSION_RE.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareParserVersions(a: ParserVersion, b: ParserVersion): number {
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Content-hash versions this build understands. v1 is frozen (A34). A future
 * v2 is added here together with a rule for comparing across versions; until
 * then, hashes are compared only within one version.
 */
export const KNOWN_CONTENT_HASH_VERSIONS = ["v1"] as const;
export type ContentHashVersion = (typeof KNOWN_CONTENT_HASH_VERSIONS)[number];

const CONTENT_HASH_RE = /^(v[1-9]\d{0,2}):([0-9a-f]{64})$/;

export type ParsedContentHash = { version: ContentHashVersion; digest: string };

/** A recognised hash: a known version and exactly 64 lowercase hex digits. */
export function parseContentHash(value: unknown): ParsedContentHash | null {
  if (typeof value !== "string") return null;
  const m = CONTENT_HASH_RE.exec(value);
  if (!m) return null;
  const version = m[1] as string;
  if (!(KNOWN_CONTENT_HASH_VERSIONS as readonly string[]).includes(version)) return null;
  return { version: version as ContentHashVersion, digest: m[2]! };
}
