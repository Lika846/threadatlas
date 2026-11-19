/**
 * Source timestamp rule (A22, A30). One implementation, used by duplicate
 * resolution (adapter) and tree parsing (M1.2), so both agree on what counts as
 * a valid time.
 *
 * - Numbers: epoch **seconds** (floats allowed). Valid when finite and
 *   representable as a JavaScript Date (|ms| ≤ 8.64e15). Precision is kept
 *   exactly as given.
 * - Strings: strict ISO 8601 only, validated field by field (no calendar
 *   roll-over such as 30 February, no 24:00, no leap second):
 *   `YYYY-MM-DD` (UTC midnight), or
 *   `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by `Z` or `±HH:MM`.
 *   A date-time **without** an offset is rejected rather than guessed, because
 *   its meaning would depend on the machine's time zone.
 * - `null` and absent values are "missing". Anything else is "invalid"; the
 *   caller treats it as missing and adds a warning.
 * - No historical cutoff rejects a value. A valid value is marked `unusual`
 *   (warning only) when it is before 2000-01-01T00:00:00Z or more than one day
 *   after the import time.
 */

export type TimestampResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; seconds: number; unusual: boolean };

export const MAX_DATE_MS = 8.64e15;
export const UNUSUAL_BEFORE_SECONDS = 946_684_800; // 2000-01-01T00:00:00Z
export const UNUSUAL_FUTURE_MARGIN_SECONDS = 86_400;

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Date.UTC maps years 0–99 to 1900–1999, so set the full year explicitly. */
function utcMs(year: number, monthIndex: number, day: number, h = 0, m = 0, s = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  d.setUTCHours(h, m, s, 0);
  return d.getTime();
}

function daysInMonth(year: number, month: number): number {
  return new Date(utcMs(year, month, 0)).getUTCDate();
}

/** Returns epoch seconds, or null when the string is not strict ISO 8601. */
export function parseIsoTimestamp(text: string): number | null {
  const m = ISO_PATTERN.exec(text);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, frac, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = hh === undefined ? 0 : Number(hh);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = ss === undefined ? 0 : Number(ss);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== undefined && zone !== "Z") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (oh * 60 + om);
  }
  const ms = utcMs(year, month - 1, day, hour, minute, second);
  const seconds = ms / 1000 - offsetMinutes * 60 + (frac === undefined ? 0 : Number(frac));
  return Number.isFinite(seconds) && Math.abs(seconds * 1000) <= MAX_DATE_MS ? seconds : null;
}

export function normalizeTimestamp(value: unknown, nowMs: number = Date.now()): TimestampResult {
  if (value === undefined || value === null) return { status: "missing" };
  let seconds: number | null = null;
  if (typeof value === "number") {
    seconds = Number.isFinite(value) && Math.abs(value * 1000) <= MAX_DATE_MS ? value : null;
  } else if (typeof value === "string") {
    seconds = parseIsoTimestamp(value);
  }
  if (seconds === null) return { status: "invalid" };
  const unusual =
    seconds < UNUSUAL_BEFORE_SECONDS ||
    seconds > nowMs / 1000 + UNUSUAL_FUTURE_MARGIN_SECONDS;
  return { status: "valid", seconds, unusual };
}

/** Seconds when valid, otherwise undefined (for comparisons that need both sides valid). */
export function validSeconds(value: unknown): number | undefined {
  const r = normalizeTimestamp(value);
  return r.status === "valid" ? r.seconds : undefined;
}
