import { Markdown } from "@/components/markdown";
import { formatEpochSeconds, isCodeContent, isoFromEpochSeconds, roleLabel } from "@/lib/conversations/display";
import type { DisplayedMessage } from "@/lib/conversations/queries";

/**
 * One message of the visible path (M1.6; reading layout, phase 3).
 *
 * - **Your turns** (user) sit in a tinted block and show their text exactly as typed: plain
 *   text, line breaks kept, as ChatGPT shows them.
 * - **Assistant turns** are open reading text in the system serif face, with their Markdown
 *   rendered safely (`markdown.tsx`: React elements only, no HTML, only http(s)/mailto links,
 *   no images loaded).
 * - **Other roles** (system, tool) are plain text, like your turns but without the tint.
 * - **Code and tool output** keep their exact text in a <pre>, as before.
 */

const BADGE = "rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";

export function MessageView({ message }: { message: DisplayedMessage }) {
  const time = formatEpochSeconds(message.createdAtSec);
  const iso = isoFromEpochSeconds(message.createdAtSec);
  const code = isCodeContent(message.contentType);
  const user = message.role === "user";
  const assistant = message.role === "assistant";
  const frame = message.isHidden
    ? "rounded-lg border border-dashed border-neutral-400 p-4 dark:border-neutral-600"
    : user
      ? "rounded-lg border-l-4 border-blue-700 bg-neutral-100 p-4 dark:border-blue-400 dark:bg-neutral-900"
      : assistant
        ? "px-1 py-2"
        : "rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
  return (
    <article aria-labelledby={`m-${message.number}`} data-role={message.role ?? "unknown"} className={frame}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`m-${message.number}`} className="font-semibold">
          {roleLabel(message.role)}
          {message.authorName !== null && <span className="font-normal"> ({message.authorName})</span>}
        </h3>
        {time !== null && (
          <time dateTime={iso} className="text-sm text-neutral-600 dark:text-neutral-400">
            {time}
          </time>
        )}
        <span className="text-xs text-neutral-600 dark:text-neutral-400">Message {message.number}</span>
      </header>
      {(message.versions > 1 || message.isHidden || message.isMalformed || message.hasUnsupportedParts) && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Notes">
          {message.versions > 1 && <li className={BADGE}>{message.versions} versions exist; only the one on the stored path is shown</li>}
          {message.isHidden && <li className={BADGE}>Hidden by default</li>}
          {message.isMalformed && <li className={BADGE}>Malformed in the export; recoverable text shown</li>}
          {message.hasUnsupportedParts && <li className={BADGE}>Contains unsupported content; the original is kept</li>}
        </ul>
      )}
      {code ? (
        <figure className="mt-3">
          <figcaption className="text-xs text-neutral-600 dark:text-neutral-400">
            {message.contentType === "execution_output" ? "Output" : "Code"}
            {message.codeLanguage !== null && ` (${message.codeLanguage})`}
          </figcaption>
          <pre className="mt-1 overflow-x-auto rounded-md bg-neutral-100 p-3 font-mono text-sm dark:bg-neutral-900" data-testid="message-body">
            <code>{message.contentText}</code>
          </pre>
        </figure>
      ) : message.contentText === "" ? (
        <p className="mt-3 text-sm text-neutral-600 italic dark:text-neutral-400">No text.</p>
      ) : assistant && !message.isMalformed ? (
        <div className="mt-2 font-serif text-[1.0625rem] leading-relaxed" data-testid="message-body">
          <Markdown text={message.contentText} />
        </div>
      ) : (
        <div className="mt-3 break-words whitespace-pre-wrap" data-testid="message-body">
          {message.contentText}
        </div>
      )}
    </article>
  );
}
