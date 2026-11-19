"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_ITEMS = [
  { href: "/conversations", label: "Conversations" },
  { href: "/search", label: "Search" },
  { href: "/map", label: "Map" },
  { href: "/import", label: "Import" },
  { href: "/settings", label: "Settings" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MainNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main">
      <ul className="flex gap-1 whitespace-nowrap sm:flex-wrap">
        {NAV_ITEMS.map(({ href, label }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  active
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
