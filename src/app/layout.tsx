import type { Metadata } from "next";
import Link from "next/link";
import { MainNav } from "@/components/main-nav";
import { ThemeSwitch } from "@/components/theme-switch";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ThreadAtlas", template: "%s · ThreadAtlas" },
  description: "Local-first browser for your exported ChatGPT conversations.",
  // Local tool: keep it out of search indexes if ever exposed by mistake.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script sets data-theme on <html> before React loads (see src/lib/theme.ts).
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      {/* Browser extensions (for example Grammarly) add attributes to <body> before React loads.
          This ignores attribute differences on <body> itself only, never on its children. */}
      <body
        suppressHydrationWarning
        className="flex min-h-screen flex-col bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100"
      >
        <a
          href="#main-content"
          className="sr-only rounded-md bg-blue-700 font-medium text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:outline-2 focus:outline-offset-2 focus:outline-blue-700"
        >
          Skip to content
        </a>

        <header className="border-b border-neutral-200 dark:border-neutral-800">
          {/* Small screens: the name and theme switch on one row, the navigation on one scrollable row below. */}
          <div className="page-width mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
            <Link
              href="/"
              className="rounded-md text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              ThreadAtlas
            </Link>
            <div className="order-last -mx-1 w-full min-w-0 overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0">
              <MainNav />
            </div>
            <ThemeSwitch />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="page-width mx-auto w-full max-w-4xl flex-1 px-4 py-6 focus:outline-none sm:py-10"
        >
          {children}
        </main>

        <footer className="border-t border-neutral-200 dark:border-neutral-800">
          <p className="page-width mx-auto max-w-4xl px-4 py-4 text-sm text-neutral-600 dark:text-neutral-400">
            Runs locally. Imported data stays on this machine.
          </p>
        </footer>
      </body>
    </html>
  );
}
