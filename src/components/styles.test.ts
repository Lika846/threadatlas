/**
 * Contrast of the shared colour roles (phase 3), measured from the installed Tailwind palette
 * (OKLCH → sRGB → WCAG 2 contrast ratio), in light and dark. Text needs 4.5:1, focus rings and
 * control borders 3:1 (WCAG 2.2 AA, 1.4.3 and 1.4.11).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const theme = fs.readFileSync(path.join(process.cwd(), "node_modules", "tailwindcss", "theme.css"), "utf8");

function colour(name: string): [number, number, number] {
  if (name === "white") return [1, 1, 1];
  const m = theme.match(new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+|none)\\)`));
  if (!m) throw new Error(`no colour ${name}`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  const h = m[3] === "none" ? 0 : (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  // OKLab → linear sRGB (Björn Ottosson's matrices).
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: [number, number, number] = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return rgb.map((x) => Math.min(1, Math.max(0, x))) as [number, number, number];
}
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b; // linear values already
const ratio = (fg: string, bg: string) => {
  const [x, y] = [luminance(colour(fg)), luminance(colour(bg))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("colour contrast of the shared roles", () => {
  it.each([
    ["body text, light", "neutral-900", "white", 4.5],
    ["body text, dark", "neutral-100", "neutral-950", 4.5],
    ["muted text, light", "neutral-600", "white", 4.5],
    ["muted text, dark", "neutral-400", "neutral-950", 4.5],
    ["links, light", "blue-700", "white", 4.5],
    ["links, dark", "blue-400", "neutral-950", 4.5],
    ["primary button text, light", "white", "blue-700", 4.5],
    ["primary button text, dark", "neutral-950", "blue-400", 4.5],
    ["warning note, light", "amber-950", "amber-50", 4.5],
    ["warning note, dark", "amber-100", "amber-950", 4.5],
    ["focus ring, light", "blue-600", "white", 3],
    ["focus ring, dark", "blue-400", "neutral-950", 3],
    ["danger button text, light", "white", "red-700", 4.5],
    ["danger button text, dark", "neutral-950", "red-500", 4.5],
  ] as const)("%s: %s on %s ≥ %d:1", (_label, fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it("neutral-500 alone fails on the dark page (why every use now has a dark variant)", () => {
    expect(ratio("neutral-500", "neutral-950")).toBeLessThan(4.5);
    expect(ratio("neutral-400", "neutral-950")).toBeGreaterThanOrEqual(4.5);
  });
});
