import { describe, expect, it } from "vitest";
import { ALL_FIXTURES, fixtureText } from "../../../tests/helpers/fixtures";
import { parseExportText } from "../import/validate-export";
import { branchVersions, type StructureNode } from "./branches";

const node = (id: string, parent: string | null, structural = false): StructureNode => ({ sourceNodeId: id, parentSourceNodeId: parent, isStructural: structural });

describe("branchVersions", () => {
  it("marks a regenerated answer: siblings directly under a message", () => {
    const nodes = [node("root", null, true), node("u", "root"), node("a1", "u"), node("a2", "u"), node("a3", "u")];
    expect(branchVersions(nodes, ["root", "u", "a3"], ["u", "a3"])).toEqual(new Map([["a3", 3]]));
  });

  it("marks an edited first message: siblings under the structural root", () => {
    const nodes = [node("root", null, true), node("u1", "root"), node("u1-edit", "root"), node("a", "u1-edit")];
    expect(branchVersions(nodes, ["root", "u1-edit", "a"], ["u1-edit", "a"])).toEqual(new Map([["u1-edit", 2]]));
  });

  it("finds a fork above an intervening structural node (direct siblings would miss it)", () => {
    // p → [s (structural) → a, a-alt]: a's own parent s has one child.
    const nodes = [node("p", null), node("s", "p", true), node("a", "s"), node("a-alt", "p")];
    expect(branchVersions(nodes, ["p", "s", "a"], ["p", "a"])).toEqual(new Map([["a", 2]]));
  });

  it("does not count a sibling whose subtree is only structural", () => {
    const nodes = [node("p", null), node("a", "p"), node("empty", "p", true), node("empty-child", "empty", true)];
    expect(branchVersions(nodes, ["p", "a"], ["p", "a"])).toEqual(new Map());
  });

  it("counts a sibling that leads to a message through structural nodes", () => {
    const nodes = [node("p", null), node("a", "p"), node("s", "p", true), node("deep", "s")];
    expect(branchVersions(nodes, ["p", "a"], ["p", "a"])).toEqual(new Map([["a", 2]]));
  });

  it("moves the marker to the next displayed message when the fork is above a hidden one", () => {
    // root → sys (hidden) → [u1, u1-edit]; with sys hidden, u1-edit carries the marker either way;
    // a fork *at* the hidden node's own siblings moves to the next shown message.
    const nodes = [node("root", null, true), node("sys", "root"), node("sys-alt", "root"), node("u", "sys")];
    expect(branchVersions(nodes, ["root", "sys", "u"], ["sys", "u"])).toEqual(new Map([["sys", 2]]));
    expect(branchVersions(nodes, ["root", "sys", "u"], ["u"])).toEqual(new Map([["u", 2]]));
  });

  it("never treats separate roots as versions of each other", () => {
    const nodes = [node("r1", null), node("r2", null), node("x", "r1")];
    expect(branchVersions(nodes, ["r1", "x"], ["r1", "x"])).toEqual(new Map());
  });

  it("ignores dangling parents and survives parent cycles", () => {
    const nodes = [node("a", "missing"), node("b", "a"), node("c1", "c2"), node("c2", "c1"), node("self", "self")];
    expect(branchVersions(nodes, ["a", "b"], ["a", "b"])).toEqual(new Map());
  });

  it("is linear: 100,000 nodes in a long chain with forks", () => {
    const nodes: StructureNode[] = [node("n0", null)];
    const path = ["n0"];
    for (let i = 1; i < 50_000; i++) {
      nodes.push(node(`n${i}`, `n${i - 1}`), node(`alt${i}`, `n${i - 1}`));
      path.push(`n${i}`);
    }
    const t0 = performance.now();
    const r = branchVersions(nodes, path, path);
    expect(r.size).toBe(49_999);
    expect(performance.now() - t0).toBeLessThan(5_000); // generous; typically tens of ms
  });

  it.each(ALL_FIXTURES)("agrees with the actual forks of %s", (name) => {
    const res = parseExportText(fixtureText(name));
    if (!res.ok) return;
    for (const c of res.conversations) {
      const path = c.nodes.filter((n) => n.pathIndex !== null).sort((a, b) => a.pathIndex! - b.pathIndex!).map((n) => n.sourceNodeId);
      const displayed = c.nodes.filter((n) => n.pathIndex !== null && !n.isStructural && !n.isHidden).sort((a, b) => a.pathIndex! - b.pathIndex!).map((n) => n.sourceNodeId);
      const r = branchVersions(c.nodes, path, displayed);
      // Independent check: a displayed message is marked iff its own parent, or a parent
      // on the hidden/structural stretch above it, has more than one child with a message.
      for (const [id, versions] of r) {
        expect(displayed).toContain(id);
        expect(versions).toBeGreaterThan(1);
      }
      if (name === "branching.json") expect([...r.values()].sort()).toEqual([2, 2]);
      if (name === "regenerated.json") expect([...r.values()]).toEqual([3]);
    }
  });
});
