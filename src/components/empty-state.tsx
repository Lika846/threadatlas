import type { ReactNode } from "react";

/** Bordered placeholder for sections that have no content yet. */
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="empty-state-title"
      className="mt-8 rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700"
    >
      <h2 id="empty-state-title" className="text-lg font-medium">
        {title}
      </h2>
      <div className="mt-2 text-neutral-600 dark:text-neutral-400">
        {children}
      </div>
    </section>
  );
}
