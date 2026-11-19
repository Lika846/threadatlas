/**
 * Branch markers for the conversation view (M1.6, plan §3 "n versions exist").
 *
 * A branch point is a node with more than one child that leads to a real
 * message. Counting a displayed message's direct siblings is not enough:
 * structural nodes (no message) and hidden messages can sit between two
 * displayed messages, so the fork can be one or more levels above the
 * message the reader sees. Rule:
 *
 *   For each displayed path message M, walk up the stored path from M to
 *   (not including) the previous displayed message. At the first node X on
 *   that segment whose parent has more than one *alternative* child, M is
 *   marked with that number of versions.
 *
 * An alternative child is one whose subtree contains at least one
 * non-structural node (hidden messages count: they are content). Children
 * whose subtree is only structural nodes are not versions. Parents are taken
 * from `parentSourceNodeId` (A23); a dangling parent makes a root, and roots
 * are never treated as alternatives of each other. Cycles cannot loop.
 * Pure function; linear in the number of nodes.
 */

export type StructureNode = {
  sourceNodeId: string;
  parentSourceNodeId: string | null;
  isStructural: boolean;
};

/**
 * @param nodes every stored node of the conversation (structure columns only)
 * @param path  the stored visible path, all nodes (structural included), in pathIndex order
 * @param displayed the subset of `path` that is shown, in the same order
 * @returns versions per displayed message, only where > 1
 */
export function branchVersions(nodes: readonly StructureNode[], path: readonly string[], displayed: readonly string[]): Map<string, number> {
  const parentOf = new Map<string, string>();
  const ids = new Set(nodes.map((n) => n.sourceNodeId));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    const p = n.parentSourceNodeId;
    if (p === null || !ids.has(p) || p === n.sourceNodeId) continue;
    parentOf.set(n.sourceNodeId, p);
    let list = children.get(p);
    if (!list) children.set(p, (list = []));
    list.push(n.sourceNodeId);
  }

  // Mark every node whose subtree contains a non-structural node: walk up from
  // each such node until an already-marked node (also ends any cycle).
  const leadsToMessage = new Set<string>();
  for (const n of nodes) {
    if (n.isStructural) continue;
    let x: string | undefined = n.sourceNodeId;
    while (x !== undefined && !leadsToMessage.has(x)) {
      leadsToMessage.add(x);
      x = parentOf.get(x);
    }
  }
  const alternatives = (parent: string) => (children.get(parent) ?? []).filter((c) => leadsToMessage.has(c)).length;

  const position = new Map(path.map((id, i) => [id, i]));
  const result = new Map<string, number>();
  let previous = -1;
  for (const id of displayed) {
    const k = position.get(id);
    if (k === undefined) continue;
    for (let i = k; i > previous; i--) {
      const parent = parentOf.get(path[i]!);
      if (parent === undefined) continue;
      const count = alternatives(parent);
      if (count > 1) {
        result.set(id, count);
        break;
      }
    }
    previous = k;
  }
  return result;
}
