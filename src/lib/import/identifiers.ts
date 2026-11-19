/**
 * Length limit for externally supplied identifiers (Q12): conversation IDs,
 * mapping node keys and node references (`parent`, `children[]`,
 * `message.id`, `current_node`).
 *
 * Counted in Unicode code points, so 512 emoji are allowed although they take
 * 1,024 UTF-16 code units. A lone surrogate counts as one code point.
 * Oversized identifiers are never truncated: depending on the field, the
 * conversation is skipped, the node dropped or the reference ignored, always
 * with a coded issue that does not contain the identifier.
 */
export const MAX_ID_LENGTH = 512;

/** True if `s` has more than `max` code points. O(min(n, 2·max)), no allocation. */
export function exceedsIdLength(s: string, max: number = MAX_ID_LENGTH): boolean {
  // Each code point takes one or two UTF-16 code units.
  if (s.length <= max) return false;
  if (s.length > 2 * max) return true;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    if (++count > max) return true;
  }
  return false;
}
