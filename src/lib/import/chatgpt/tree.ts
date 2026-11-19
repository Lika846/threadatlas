import { exceedsIdLength } from "../identifiers";
import type { ImportIssue, NormalizedNode, PathStrategy } from "../types";
import { parseMessage } from "./message";

/**
 * Tree reconstruction and default visible path (plan §3; A23–A26, A29).
 * The full algorithm is documented in `docs/import-format.md`.
 *
 * Invariants:
 * - Every mapping entry that is an object becomes exactly one node (R22).
 *   Non-object entries are dropped with NODE_NOT_OBJECT (A24).
 * - A node's parent comes **only** from its `parent` field (A23). `children[]`
 *   only orders siblings and triggers warnings; a parent is never inferred.
 * - The exported `parent` value is kept even when it dangles.
 * - "Mapping order" is the property order of the parsed JSON object. Note that
 *   JavaScript lists integer-like keys ("1", "2") first, in ascending order.
 * - Identifiers longer than MAX_ID_LENGTH (Q12) are never shortened. The
 *   adapter skips any conversation with an oversized mapping key or `parent`
 *   (CONVERSATION_NODE_ID_TOO_LONG), because dropping them would make an
 *   incomplete tree look complete; buildTree refuses such input
 *   (`OversizedNodeIdError`, fail closed). An oversized child entry,
 *   `message.id` or `current_node` cannot change the tree, so it is ignored
 *   with a warning. Issues never contain the identifier.
 */

/** Static message, no content: the input bypassed the adapter's Q12 check. */
export class OversizedNodeIdError extends Error {
  constructor() {
    super("A mapping key or parent reference exceeds the identifier limit; the adapter must skip this conversation.");
    this.name = "OversizedNodeIdError";
  }
}

type Issue = Omit<ImportIssue, "index" | "sourceId">;

export type TreeResult = {
  nodes: NormalizedNode[];
  pathStrategy: PathStrategy;
  issues: Issue[];
};

type RawNode = {
  key: string;
  parent: string | null;
  listedChildren: string[];
  message: unknown;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function get(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

export function buildTree(
  mapping: Record<string, unknown>,
  currentNode: string | null | undefined,
  nowMs: number,
): TreeResult {
  const issues: Issue[] = [];

  // 1. Read nodes in mapping order.
  const raw: RawNode[] = [];
  for (const key of Object.keys(mapping)) {
    if (exceedsIdLength(key)) throw new OversizedNodeIdError();
    const value = mapping[key];
    if (!isRecord(value)) {
      issues.push({ code: "NODE_NOT_OBJECT", nodeId: key });
      continue;
    }
    const id = get(value, "id");
    if (id !== undefined && id !== key) issues.push({ code: "NODE_ID_MISMATCH", nodeId: key });

    const p = get(value, "parent");
    let parent: string | null = null;
    if (typeof p === "string") {
      if (exceedsIdLength(p)) throw new OversizedNodeIdError();
      parent = p;
    } else if (p !== undefined && p !== null) issues.push({ code: "NODE_PARENT_INVALID", nodeId: key });

    const c = get(value, "children");
    let listedChildren: string[] = [];
    if (Array.isArray(c)) {
      const strings = c.filter((x): x is string => typeof x === "string");
      if (strings.length !== c.length) {
        issues.push({ code: "NODE_CHILDREN_INVALID", nodeId: key });
      }
      listedChildren = strings.filter((x) => !exceedsIdLength(x));
      if (listedChildren.length !== strings.length) {
        issues.push({ code: "NODE_REFERENCE_TOO_LONG", nodeId: key, field: "children" });
      }
    } else if (c !== undefined && c !== null) {
      issues.push({ code: "NODE_CHILDREN_INVALID", nodeId: key });
    }
    raw.push({ key, parent, listedChildren, message: get(value, "message") });
  }

  const byKey = new Map(raw.map((n) => [n.key, n]));

  // 2. Effective parent: the exported parent if it is in the mapping.
  const effectiveParent = new Map<string, string | null>();
  for (const n of raw) {
    if (n.parent !== null && byKey.has(n.parent)) {
      effectiveParent.set(n.key, n.parent);
    } else {
      if (n.parent !== null) issues.push({ code: "NODE_PARENT_NOT_IN_MAPPING", nodeId: n.key });
      effectiveParent.set(n.key, null);
    }
  }

  // 3. Children: listed ones first (if the child agrees), then unlisted ones in mapping order.
  // A node is only ever placed under its effective parent, so one set of placed
  // nodes answers "is it already in its parent's list?" in O(1) (F1).
  const childrenOf = new Map<string, string[]>();
  const placed = new Set<string>();
  for (const n of raw) childrenOf.set(n.key, []);
  for (const n of raw) {
    const ordered = childrenOf.get(n.key)!;
    const seen = new Set<string>();
    for (const child of n.listedChildren) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (!byKey.has(child)) {
        issues.push({ code: "NODE_CHILD_NOT_IN_MAPPING", nodeId: n.key, relatedNodeId: child });
      } else if (effectiveParent.get(child) !== n.key) {
        issues.push({ code: "NODE_CHILD_PARENT_MISMATCH", nodeId: child, relatedNodeId: n.key });
      } else {
        ordered.push(child);
        placed.add(child);
      }
    }
  }
  for (const n of raw) {
    const parent = effectiveParent.get(n.key);
    if (parent === null || parent === undefined) continue;
    if (!placed.has(n.key)) {
      childrenOf.get(parent)!.push(n.key);
      placed.add(n.key);
      issues.push({ code: "NODE_NOT_LISTED_BY_PARENT", nodeId: n.key, relatedNodeId: parent });
    }
  }

  // 4. Roots and sibling positions.
  const roots = raw.filter((n) => effectiveParent.get(n.key) === null).map((n) => n.key);
  if (roots.length > 1) issues.push({ code: "MULTIPLE_ROOTS" });
  const siblingIndex = new Map<string, number>();
  roots.forEach((k, i) => siblingIndex.set(k, i));
  for (const kids of childrenOf.values()) kids.forEach((k, i) => siblingIndex.set(k, i));

  // 5. Nodes that no root reaches are in, or below, a cycle.
  // Index-based queue: `shift()` is O(n) per call, and spreading a huge child
  // list into `push(...)` can exceed the engine's argument limit (F1).
  const reached = new Set<string>();
  const queue = [...roots];
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head]!;
    if (reached.has(k)) continue;
    reached.add(k);
    for (const child of childrenOf.get(k)!) queue.push(child);
  }
  const unreached = raw.find((n) => !reached.has(n.key));
  if (unreached) issues.push({ code: "TREE_CYCLE", nodeId: unreached.key });

  // 6. Messages (needed for latest_leaf).
  const messages = new Map(
    raw.map((n) => [
      n.key,
      parseMessage(n.message, nowMs, (code, field) =>
        issues.push(field === undefined ? { code, nodeId: n.key } : { code, nodeId: n.key, field }),
      ),
    ]),
  );

  // 7. Choose the end of the default path (A25).
  let leaf: string | null = null;
  let pathStrategy: PathStrategy = "none";
  if (typeof currentNode === "string" && exceedsIdLength(currentNode)) {
    issues.push({ code: "FIELD_TOO_LONG", field: "current_node" });
  } else if (typeof currentNode === "string") {
    if (byKey.has(currentNode)) {
      leaf = currentNode;
      pathStrategy = "current_node";
    } else {
      issues.push({ code: "CURRENT_NODE_NOT_IN_MAPPING" });
    }
  }
  if (leaf === null) {
    let best: { key: string; t: number } | null = null;
    for (const n of raw) {
      if (childrenOf.get(n.key)!.length > 0) continue;
      const m = messages.get(n.key)!;
      if (m.isStructural || m.createdAt === null) continue;
      // `>=` so that ties go to the later mapping order.
      if (best === null || m.createdAt >= best.t) best = { key: n.key, t: m.createdAt };
    }
    if (best !== null) {
      leaf = best.key;
      pathStrategy = "latest_leaf";
    }
  }
  if (leaf === null && roots.length > 0) {
    let cur = roots[0]!;
    const visited = new Set<string>([cur]);
    for (;;) {
      const kids = childrenOf.get(cur)!;
      const next = kids[kids.length - 1];
      if (next === undefined || visited.has(next)) break;
      visited.add(next);
      cur = next;
    }
    leaf = cur;
    pathStrategy = "last_child";
  }
  if (pathStrategy === "latest_leaf" || pathStrategy === "last_child") {
    issues.push({ code: "PATH_FALLBACK" });
  }
  if (pathStrategy === "none") issues.push({ code: "PATH_NONE" });

  // 8. Walk up from the leaf; a cycle stops the walk.
  const path: string[] = [];
  if (leaf !== null) {
    const seen = new Set<string>();
    let cur: string | null = leaf;
    while (cur !== null) {
      if (seen.has(cur)) {
        issues.push({ code: "PATH_CYCLE", nodeId: cur });
        break;
      }
      seen.add(cur);
      path.push(cur);
      cur = effectiveParent.get(cur) ?? null;
    }
    path.reverse();
  }
  const pathIndex = new Map(path.map((k, i) => [k, i]));

  const nodes: NormalizedNode[] = raw.map((n) => {
    const m = messages.get(n.key)!;
    return {
      sourceNodeId: n.key,
      sourceMessageId: m.sourceMessageId,
      parentSourceNodeId: n.parent,
      siblingIndex: siblingIndex.get(n.key) ?? 0,
      pathIndex: pathIndex.get(n.key) ?? null,
      isStructural: m.isStructural,
      isMalformed: m.isMalformed,
      role: m.role,
      authorName: m.authorName,
      contentType: m.contentType,
      contentText: m.contentText,
      codeLanguage: m.codeLanguage,
      hasUnsupportedParts: m.hasUnsupportedParts,
      rawContentJson: m.rawContentJson,
      isHidden: m.isHidden,
      status: m.status,
      createdAt: m.createdAt,
    };
  });
  return { nodes, pathStrategy, issues };
}
