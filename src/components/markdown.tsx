import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown/parse";
import { LINK } from "@/components/styles";

/**
 * Renders an assistant message's Markdown (phase 3) from the safe tree of
 * `src/lib/markdown/parse.ts`, as React elements only: never `dangerouslySetInnerHTML`, never raw
 * HTML, so imported text can't inject markup or scripts (React escapes all text). Links point
 * only to absolute http(s)/mailto URLs, open in a new tab and send no referrer; images are shown
 * as a placeholder and never loaded. Headings inside a message start at level 4, below the
 * message's own heading. Too long or too deeply nested: the plain text view instead.
 */

const CODE_INLINE = "rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-neutral-800";

function inlines(nodes: readonly Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.type) {
      case "text":
        return n.text;
      case "br":
        return <br key={k} />;
      case "code":
        return (
          <code key={k} className={CODE_INLINE}>
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={k}>{inlines(n.children, `${k}.`)}</strong>;
      case "em":
        return <em key={k}>{inlines(n.children, `${k}.`)}</em>;
      case "del":
        return <del key={k}>{inlines(n.children, `${k}.`)}</del>;
      case "image":
        return (
          <span key={k} className="text-neutral-600 italic dark:text-neutral-400">
            [Image{n.alt ? `: ${n.alt}` : ""}]
          </span>
        );
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className={`${LINK} break-words`}>
            {inlines(n.children, `${k}.`)}
          </a>
        );
    }
  });
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

function blocks(nodes: readonly Block[], key = ""): ReactNode[] {
  return nodes.map((b, i) => {
    const k = `${key}${i}`;
    switch (b.type) {
      case "paragraph":
        return <p key={k}>{inlines(b.children)}</p>;
      case "heading": {
        const level = Math.min(6, b.level + 3);
        const H = `h${level}` as "h4" | "h5" | "h6";
        return (
          <H key={k} className={level === 4 ? "text-lg font-semibold" : "font-semibold"}>
            {inlines(b.children)}
          </H>
        );
      }
      case "code":
        return (
          <figure key={k}>
            {b.lang && <figcaption className="text-xs text-neutral-600 dark:text-neutral-400">{b.lang}</figcaption>}
            <pre className="mt-1 overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-sm leading-relaxed dark:bg-neutral-900">
              <code>{b.text}</code>
            </pre>
          </figure>
        );
      case "list": {
        const items = b.items.map((it, j) => <li key={j}>{blocks(it, `${k}.${j}.`)}</li>);
        return b.ordered ? (
          <ol key={k} start={b.start === 1 ? undefined : b.start} className="list-decimal space-y-1 pl-6">
            {items}
          </ol>
        ) : (
          <ul key={k} className="list-disc space-y-1 pl-6">
            {items}
          </ul>
        );
      }
      case "blockquote":
        return (
          <blockquote key={k} className="space-y-3 border-l-2 border-neutral-300 pl-4 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
            {blocks(b.children, `${k}.`)}
          </blockquote>
        );
      case "hr":
        return <hr key={k} className="border-neutral-200 dark:border-neutral-800" />;
      case "table":
        return (
          <div key={k} className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {b.header.map((h, j) => (
                    <th key={j} scope="col" className={`border-b border-neutral-300 px-2 py-1 font-semibold dark:border-neutral-700 ${ALIGN[b.align[j] ?? "left"]}`}>
                      {inlines(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, m) => (
                      <td key={m} className={`border-b border-neutral-200 px-2 py-1 align-top dark:border-neutral-800 ${ALIGN[b.align[m] ?? "left"]}`}>
                        {inlines(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** An assistant message's text as Markdown; falls back to plain text when it can't be parsed safely. */
export function Markdown({ text }: { text: string }) {
  const tree = parseMarkdown(text);
  if (tree === null) return <div className="break-words whitespace-pre-wrap">{text}</div>;
  return <div className="space-y-3 break-words">{blocks(tree)}</div>;
}
