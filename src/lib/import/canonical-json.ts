/**
 * Maximum JSON nesting depth (F2), counted in object/array levels from the
 * root of the value being measured: the root container is level 1, so `[]`
 * has depth 1 and `[[]]` depth 2. Primitives add no level. Branch length in
 * the message tree is unrelated: a conversation's mapping is flat.
 *
 * For an uploaded export the root is the file's top-level array, so each
 * conversation object starts at level 2 (see `CONVERSATION_MAX_DEPTH` in the
 * adapter). Real exports nest about 10 levels deep.
 */
export const MAX_JSON_DEPTH = 512;

/**
 * Thrown by `canonicalJson` for input nested deeper than `MAX_JSON_DEPTH`.
 * The message is static and never contains any of the input.
 */
export class JsonTooDeepError extends Error {
  constructor() {
    super("JSON value is nested too deeply to serialise.");
    this.name = "JsonTooDeepError";
  }
}

/**
 * True if `value` contains objects/arrays nested more than `limit` levels
 * deep (the value itself, if a container, is level 1). Iterative, so it
 * cannot overflow the call stack on hostile input, and it stops at the first
 * container past the limit. Runs before anything recursive touches imported
 * data (F2).
 */
export function exceedsJsonDepth(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== "object") return false;
  if (limit < 1) return true;
  const stack: Array<{ node: object; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const children: unknown[] = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (child === null || typeof child !== "object") continue;
      if (depth + 1 > limit) return true;
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Deterministic JSON serialisation shared by the derived conversation ID
 * (A20) and the content hash (A21). Rules (documented in
 * `docs/import-format.md`):
 *
 * - Object keys are sorted by UTF-16 code unit order (`Array.prototype.sort`),
 *   recursively. Keys whose value is `undefined` are omitted.
 * - Arrays keep their order.
 * - No whitespace.
 * - Strings and numbers use `JSON.stringify`, so numbers use the shortest
 *   round-trip form (`1.0` → `1`, `-0` → `0`) and strings are escaped
 *   identically every time.
 * - No Unicode normalisation: composed and decomposed forms stay distinct,
 *   because normalising could merge content that differs in the source.
 *
 * Depth (F2): the adapter rejects over-deep conversations with an iterative
 * check before this runs. As a backstop for any other caller, input nested
 * deeper than `MAX_JSON_DEPTH` throws `JsonTooDeepError` instead of
 * exhausting the call stack (recursion is bounded at 512 levels).
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, 0);
}

function serialise(value: unknown, depth: number): string {
  if (value === null || typeof value !== "object") {
    // JSON-parsed input only contains null, boolean, number and string here.
    return JSON.stringify(value) ?? "null";
  }
  if (depth >= MAX_JSON_DEPTH) throw new JsonTooDeepError();
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialise(v, depth + 1)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${serialise(obj[k], depth + 1)}`)
    .join(",")}}`;
}
