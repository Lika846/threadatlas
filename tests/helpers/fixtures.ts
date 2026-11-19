import { readFileSync } from "node:fs";
import path from "node:path";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "chatgpt");

export function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

export const ALL_FIXTURES = [
  "linear.json",
  "branching.json",
  "missing-fields.json",
  "content-types.json",
  "structural-anomalies.json",
  "duplicate-ids.json",
  "id-fallback.json",
  "invalid-entries.json",
  "unknown-fields.json",
  "regenerated.json",
  "path-fallback.json",
  "malformed-messages.json",
  "unsupported-content.json",
  "hidden-messages.json",
] as const;

// ---- Synthetic deep-nesting inputs (F2) --------------------------------

export const DEEP_CANARY = "synthetic deep canary";

/** `levels` nested arrays around `leaf`, built iteratively. */
export function nestedArrays(levels: number, leaf: unknown = DEEP_CANARY): unknown {
  let value = leaf;
  for (let i = 0; i < levels; i++) value = [value];
  return value;
}

/**
 * Deepest object/array nesting of a JSON text, counted by scanning brackets
 * outside strings. Independent of the code under test.
 */
export function jsonTextDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") max = Math.max(max, ++depth);
    else if (ch === "]" || ch === "}") depth--;
  }
  return max;
}

/**
 * A synthetic conversation whose deepest object/array is at exactly `depth`
 * levels **from the file root** once placed in the export array. Levels 1–7
 * are the export array, conversation, mapping, node, message, content and
 * `parts`; the rest are nested arrays inside the first part.
 */
export function deepConversation(depth: number, opts: { id?: string } = {}): Record<string, unknown> {
  if (depth < 7) throw new Error("deepConversation needs depth >= 7");
  return {
    ...(opts.id === undefined ? {} : { id: opts.id }),
    title: "Synthetic deep conversation",
    create_time: 1767225600,
    current_node: "node-a",
    mapping: {
      "node-a": {
        id: "node-a",
        parent: null,
        children: [],
        message: {
          id: "msg-a",
          author: { role: "user" },
          create_time: 1767225600,
          content: { content_type: "text", parts: [nestedArrays(depth - 7)] },
        },
      },
    },
  };
}

/** A shallow, valid synthetic conversation. */
export function shallowConversation(id: string): Record<string, unknown> {
  return {
    id,
    title: "Synthetic shallow conversation",
    mapping: {
      "node-a": {
        id: "node-a",
        parent: null,
        children: [],
        message: { id: "msg-a", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] } },
      },
    },
  };
}

/**
 * JSON text of a conversation nested `levels` deep inside its `metadata`
 * field, built as text so no serialiser is involved. Hostile-input shape.
 */
export function hostileConversationText(id: string, levels: number): string {
  return `{"id":${JSON.stringify(id)},"mapping":{},"metadata":${"[".repeat(levels)}${JSON.stringify(DEEP_CANARY)}${"]".repeat(levels)}}`;
}
