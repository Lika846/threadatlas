import Link from "next/link";
import { LINK } from "@/components/styles";

const PAGE_LINK = `rounded-md px-3 py-2 text-sm ${LINK}`;

/** Previous/next links with a page indicator. Server-rendered; no client JavaScript. */
export function PageNav({
  label,
  page,
  totalPages,
  href,
  previousText,
  nextText,
}: {
  label: string;
  page: number;
  totalPages: number;
  href: (page: number) => string;
  previousText: string;
  nextText: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label={label} className="mt-6 flex flex-wrap items-center gap-3">
      {page > 1 ? (
        <Link href={href(page - 1)} className={PAGE_LINK} rel="prev">
          {previousText}
        </Link>
      ) : (
        <span className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400" aria-hidden="true">
          {previousText}
        </span>
      )}
      <span className="text-sm" aria-current="page">
        Page {page} of {totalPages}
      </span>
      {page < totalPages ? (
        <Link href={href(page + 1)} className={PAGE_LINK} rel="next">
          {nextText}
        </Link>
      ) : (
        <span className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400" aria-hidden="true">
          {nextText}
        </span>
      )}
    </nav>
  );
}
