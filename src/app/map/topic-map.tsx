"use client";

import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { useTheme } from "@/components/theme-switch";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent } from "react";
import { FOCUS } from "@/components/styles";

/**
 * The map (phase 2): your conversations in the centre, the themes on both sides, and the
 * selected theme's topics beside it. Every node is a link; selecting changes the URL (`?theme=`,
 * `?topic=`), and the page shows the selection's conversations in the side panel, so Back and
 * reload restore it. Conversations are not drawn on the map: a large topic never shrinks the
 * view to unreadable labels.
 *
 * Keyboard and screen readers: the links inside the nodes are the only focus stops, in reading
 * order (centre, then each theme followed by its topics when selected). Edges and node wrappers
 * are not focusable, React Flow's own keyboard handling (selecting and moving nodes) is off, and
 * its announcements are replaced by ones that describe this map. A focused node that is out of
 * view is brought into view. With reduced motion, the view changes without animation; fitting a
 * selection never zooms out below `FIT_MIN_ZOOM`.
 *
 * Everything runs in the browser from the page's data; nothing is fetched.
 */

export type MapTopicNode = { id: string; label: string; fullName: string; count: number; href: string; selected: boolean };
export type MapTheme = { id: string; name: string; count: number; href: string; selected: boolean; topics: MapTopicNode[]; moreTopics: number; moreHref: string | null };
export type AtlasMapData = { total: number; homeHref: string; themes: MapTheme[] };

const THEME_X = 300;
const TOPIC_X = 330;
const ROW = 54;
const THEME_H = 60;
const GAP = 24;
/** Fitting a selection never zooms below this (labels stay at least ~11 px). */
export const FIT_MIN_ZOOM = 0.8;
/** Fitting the whole map never zooms below this. */
const FIT_ALL_MIN_ZOOM = 0.6;

const ARIA_LABELS = {
  "node.a11yDescription.default": "",
  "node.a11yDescription.keyboardDisabled": "",
  "node.a11yDescription.ariaLiveMessage": () => "",
  "edge.a11yDescription.default": "",
  "controls.ariaLabel": "Map zoom controls",
  "controls.zoomIn.ariaLabel": "Zoom in",
  "controls.zoomOut.ariaLabel": "Zoom out",
  "controls.fitView.ariaLabel": "Fit the whole map in view",
  "controls.interactive.ariaLabel": "Toggle interactivity",
  "minimap.ariaLabel": "Mini map",
  "handle.ariaLabel": "Connection point",
};

type Side = 1 | -1;
type RootData = { total: number; href: string };
type ThemeData = { theme: MapTheme; side: Side };
type TopicData = { topic: MapTopicNode; side: Side };
type MoreData = { count: number; href: string; side: Side };

const hidden = { opacity: 0, pointerEvents: "none" as const };

function RootNode({ data }: NodeProps<Node<RootData>>) {
  return (
    <div>
      <Link
        href={data.href}
        scroll={false}
        aria-label={`All themes, ${data.total.toLocaleString("en-US")} conversations`}
        className={`nodrag nopan pointer-events-auto block rounded-full bg-neutral-900 px-5 py-3 text-center text-sm font-semibold text-white shadow dark:bg-neutral-100 dark:text-neutral-900 ${FOCUS}`}
      >
        Your conversations
        <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs tabular-nums dark:bg-black/10">{data.total.toLocaleString("en-US")}</span>
      </Link>
      <Handle type="source" id="r" position={Position.Right} style={hidden} isConnectable={false} />
      <Handle type="source" id="l" position={Position.Left} style={hidden} isConnectable={false} />
    </div>
  );
}

function ThemeNode({ data }: NodeProps<Node<ThemeData>>) {
  const { theme, side } = data;
  return (
    <div>
      <Link
        href={theme.href}
        scroll={false}
        aria-current={theme.selected ? "true" : undefined}
        aria-label={`${theme.name}, ${theme.count.toLocaleString("en-US")} conversation${theme.count === 1 ? "" : "s"}${theme.selected ? ", selected" : ""}`}
        className={`nodrag nopan pointer-events-auto flex max-w-[18rem] items-center gap-2 rounded-xl border-2 px-3 py-2 text-sm font-medium shadow-sm ${FOCUS} ${
          theme.selected
            ? "border-blue-700 bg-blue-700 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-neutral-950"
            : "border-blue-300 bg-blue-50 text-blue-950 hover:border-blue-500 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-50"
        }`}
      >
        <span className="truncate">{theme.name}</span>
        <span className="shrink-0 rounded-full bg-black/10 px-2 py-0.5 text-xs tabular-nums dark:bg-white/15">{theme.count.toLocaleString("en-US")}</span>
      </Link>
      <Handle type="target" position={side === 1 ? Position.Left : Position.Right} style={hidden} isConnectable={false} />
      <Handle type="source" position={side === 1 ? Position.Right : Position.Left} style={hidden} isConnectable={false} />
    </div>
  );
}

function TopicNode({ data }: NodeProps<Node<TopicData>>) {
  const { topic, side } = data;
  return (
    <div>
      <Link
        href={topic.href}
        scroll={false}
        title={topic.fullName}
        aria-current={topic.selected ? "true" : undefined}
        aria-label={`Topic: ${topic.fullName}, ${topic.count.toLocaleString("en-US")} conversation${topic.count === 1 ? "" : "s"}${topic.selected ? ", selected" : ""}`}
        className={`nodrag nopan pointer-events-auto flex w-72 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm shadow-sm ${FOCUS} ${
          topic.selected
            ? "border-blue-700 bg-blue-50 font-semibold text-neutral-900 dark:border-blue-400 dark:bg-blue-950 dark:text-neutral-100"
            : "border-neutral-300 bg-white text-neutral-900 hover:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{topic.label}</span>
        <span className="shrink-0 text-xs text-neutral-600 tabular-nums dark:text-neutral-400">{topic.count.toLocaleString("en-US")}</span>
      </Link>
      <Handle type="target" position={side === 1 ? Position.Left : Position.Right} style={hidden} isConnectable={false} />
    </div>
  );
}

function MoreNode({ data }: NodeProps<Node<MoreData>>) {
  return (
    <div>
      <Link
        href={data.href}
        scroll={false}
        className={`nodrag nopan pointer-events-auto block w-72 rounded-lg border border-dashed border-neutral-400 px-3 py-1.5 text-sm text-blue-700 hover:bg-neutral-50 dark:text-blue-400 dark:hover:bg-neutral-800 ${FOCUS}`}
      >
        {data.count.toLocaleString("en-US")} more topic{data.count === 1 ? "" : "s"} in the list
      </Link>
      <Handle type="target" position={data.side === 1 ? Position.Left : Position.Right} style={hidden} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { root: RootNode, theme: ThemeNode, topic: TopicNode, more: MoreNode };

/**
 * Themes alternate right and left of the centre, each side a vertical stack; a selected theme
 * makes room for its topics. Nodes are listed in reading order (their DOM and Tab order).
 */
export function layout(data: AtlasMapData): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [{ id: "root", type: "root", position: { x: 0, y: 0 }, data: { total: data.total, href: data.homeHref } }];
  const edges: Edge[] = [];
  const sideOf = (i: number): Side => (i % 2 === 0 ? 1 : -1);
  const rows = (t: MapTheme) => t.topics.length + (t.moreTopics > 0 ? 1 : 0);
  const height = (t: MapTheme) => (rows(t) > 0 ? Math.max(THEME_H, rows(t) * ROW) : THEME_H);
  const ys = new Map<string, number>();
  for (const side of [1, -1] as const) {
    const column = data.themes.filter((_, i) => sideOf(i) === side);
    let y = -(column.reduce((s, t) => s + height(t), 0) + GAP * Math.max(0, column.length - 1)) / 2;
    for (const t of column) {
      ys.set(t.id, y);
      y += height(t) + GAP;
    }
  }
  data.themes.forEach((t, i) => {
    const side = sideOf(i);
    const h = height(t);
    const y = ys.get(t.id)!;
    const id = `theme:${t.id}`;
    nodes.push({ id, type: "theme", position: { x: side * THEME_X, y: y + h / 2 }, data: { theme: t, side } });
    edges.push({ id: `e:root:${t.id}`, source: "root", sourceHandle: side === 1 ? "r" : "l", target: id, focusable: false });
    const top = y + (h - rows(t) * ROW) / 2;
    t.topics.forEach((p, j) => {
      const pid = `topic:${p.id}`;
      nodes.push({ id: pid, type: "topic", position: { x: side * (THEME_X + TOPIC_X), y: top + ROW * (j + 0.5) }, data: { topic: p, side } });
      edges.push({ id: `e:${t.id}:${p.id}`, source: id, target: pid, focusable: false });
    });
    if (t.moreTopics > 0 && t.moreHref) {
      const mid = `more:${t.id}`;
      nodes.push({ id: mid, type: "more", position: { x: side * (THEME_X + TOPIC_X), y: top + ROW * (t.topics.length + 0.5) }, data: { count: t.moreTopics, href: t.moreHref, side } });
      edges.push({ id: `e:${t.id}:more`, source: id, target: mid, focusable: false });
    }
  });
  return { nodes, edges };
}

/** Approximate rendered sizes (width, height) by node type, for fitting before React Flow has measured them. */
const SIZE: Record<string, [number, number]> = { root: [220, 44], theme: [288, 44], topic: [288, 36], more: [288, 36] };

export type Viewport = { x: number; y: number; zoom: number };

/**
 * The viewport that shows the given nodes in a canvas of `width` × `height`: as large as fits
 * (at most `maxZoom`), never below `minZoom`. When they don't fit at `minZoom`, their top is
 * aligned with the top of the canvas, so a selected theme stays in view above its topics.
 * Positions are node centres (`nodeOrigin` [0.5, 0.5]).
 */
export function viewportFor(nodes: readonly Node[], width: number, height: number, opts: { minZoom: number; maxZoom: number; padding: number }): Viewport | null {
  if (nodes.length === 0 || width <= 0 || height <= 0) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const n of nodes) {
    const [w, h] = SIZE[n.type ?? ""] ?? [200, 40];
    left = Math.min(left, n.position.x - w / 2);
    right = Math.max(right, n.position.x + w / 2);
    top = Math.min(top, n.position.y - h / 2);
    bottom = Math.max(bottom, n.position.y + h / 2);
  }
  const pad = opts.padding;
  const fit = Math.min((width * (1 - 2 * pad)) / (right - left), (height * (1 - 2 * pad)) / (bottom - top));
  const zoom = Math.min(opts.maxZoom, Math.max(opts.minZoom, fit));
  const cx = (left + right) / 2;
  const x = width / 2 - cx * zoom;
  const fitsVertically = (bottom - top) * zoom <= height * (1 - 2 * pad);
  const y = fitsVertically ? height / 2 - ((top + bottom) / 2) * zoom : height * pad - top * zoom;
  return { x, y, zoom };
}

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeMotion(onChange: () => void) {
  const m = window.matchMedia(reducedMotionQuery);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
/** True when the user asks for reduced motion (and during server rendering, to be safe). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia(reducedMotionQuery).matches, () => true);
}

function Flow({ data }: { data: AtlasMapData }) {
  const { getNode, getViewport, setCenter, setViewport } = useReactFlow();
  const theme = useTheme();
  const reduced = usePrefersReducedMotion();
  const duration = reduced ? 0 : 300;
  const { nodes, edges } = useMemo(() => layout(data), [data]);
  const wrapper = useRef<HTMLDivElement>(null);
  const selected = data.themes.find((t) => t.selected) ?? null;
  const selectionKey = selected ? `${selected.id}:${selected.topics.length}:${selected.moreTopics}` : "";
  // The canvas size: hidden on small screens until the map view is chosen, so refit when it changes.
  const [size, setSize] = useState("0x0");
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize(`${Math.round(r.width / 20)}x${Math.round(r.height / 20)}`);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Bring the selection into view (or everything, without one), never below a readable zoom.
  // Computed from the layout itself, so it doesn't wait for React Flow to measure new nodes.
  useEffect(() => {
    const box = wrapper.current?.getBoundingClientRect();
    if (!box) return;
    const wanted = selected ? new Set([`theme:${selected.id}`, `more:${selected.id}`, ...selected.topics.map((p) => `topic:${p.id}`)]) : null;
    const target = wanted ? nodes.filter((n) => wanted.has(n.id)) : nodes;
    const v = viewportFor(target, box.width, box.height, wanted ? { minZoom: FIT_MIN_ZOOM, maxZoom: 1.1, padding: 0.06 } : { minZoom: FIT_ALL_MIN_ZOOM, maxZoom: 1.1, padding: 0.04 });
    if (v) void setViewport(v, { duration });
    // Only when the selection or the canvas size changes: not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, size]);

  // A link focused by keyboard that is outside the visible area is brought into view.
  const onFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
      const box = wrapper.current?.getBoundingClientRect();
      if (!el || !box) return;
      const r = el.getBoundingClientRect();
      if (r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom) return;
      const node = getNode(el.dataset.id ?? "");
      if (!node) return;
      void setCenter(node.position.x, node.position.y, { zoom: Math.max(getViewport().zoom, FIT_MIN_ZOOM), duration });
    },
    [getNode, getViewport, setCenter, duration],
  );

  return (
    <div ref={wrapper} className="h-full" onFocusCapture={onFocus}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodeOrigin={[0.5, 0.5]}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        disableKeyboardA11y
        minZoom={0.3}
        maxZoom={2}
        colorMode={theme ?? "system"}
        ariaLabelConfig={ARIA_LABELS}
        defaultEdgeOptions={{ style: { strokeWidth: 1.5 } }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function TopicMapView({ data, className = "" }: { data: AtlasMapData; className?: string }) {
  return (
    <section
      aria-label="Map of themes"
      aria-describedby="map-help"
      className={`overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700 ${className}`}
      data-testid="topic-map"
    >
      <p id="map-help" className="sr-only">
        Each theme and topic is a link. Tab moves between them; Enter selects one and lists its conversations next to the map.
      </p>
      <ReactFlowProvider>
        <Flow data={data} />
      </ReactFlowProvider>
    </section>
  );
}
