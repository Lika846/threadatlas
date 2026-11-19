# Privacy and local-first design

How ThreadAtlas keeps imported conversations on your computer, and every network request it or
its tooling makes. Design record: [ADR 0001](adr/0001-stack-and-privacy.md).

## Configuration

ThreadAtlas is designed so imported conversation data never leaves your machine.

- **Localhost only.** `dev` and `start` bind to `127.0.0.1`, so the app is not
  reachable from other devices on your network.
- **DNS-rebinding protection.** Every request must be addressed to `127.0.0.1` or
  `localhost` (any port), or it gets `403`. This stops a malicious website from
  pointing its own domain at your machine and reading the app's pages
  (`src/proxy.ts`).
- **No Next.js telemetry.** Every Next.js script sets `NEXT_TELEMETRY_DISABLED=1`.
- **No remote fonts or assets.** No `next/font/google` or CDN assets; Tailwind's
  system font stack is used.
- **Browser locked to this origin.** A Content-Security-Policy restricts scripts,
  styles, images, fonts and network requests to `'self'`, so rendered content
  cannot make the browser contact third-party hosts. Also sent:
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `nosniff`, and a
  restrictive `Permissions-Policy`. The `X-Powered-By` header is disabled.
- **Search terms stay out of URLs and logs.** See [guide.md](guide.md#searching).
- **Data never committed.** `.gitignore` excludes `data/`, `exports/`,
  `imports/`, SQLite files, `conversations.json`, `chat.html` and `.zip`
  exports. Only synthetic fixtures under `tests/fixtures/` may be committed.

## Known outbound requests (no user data)

- `npm ci` (or `npm install`) contacts the npm registry.
- `npx playwright install` downloads browsers from `cdn.playwright.dev` into
  the Playwright cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on
  Linux; outside the repo).
- `next dev` fetches `https://registry.npmjs.org/-/package/next/dist-tags` to
  show an "outdated version" hint. This is an anonymous GET carrying no app
  data; it fails silently offline.
- Next.js 16.4's automatic agent-upgrade check (`experimental.agentUpgrade`, default
  `"security"`) would make `next build` and `next dev` query `registry.npmjs.org` for
  release and advisory metadata. It is **turned off** in `next.config.ts`
  (`agentUpgrade: false`), and `tests/next-config.test.ts` fails if it is re-enabled.
  Upgrade Next.js deliberately instead.
- Installing Prisma downloads its schema-engine binary (used by migrations) from
  `binaries.prisma.sh`. Installing `better-sqlite3` downloads a prebuilt binary
  from GitHub releases (`github.com`, `release-assets.githubusercontent.com`).
- `npm run model:fetch` downloads the four pinned model files from `huggingface.co`
  (which redirects to its CDN) when, and only when, you run it. Plain GETs, no
  credentials or identifying headers.
- Installing `onnxruntime-node` runs a postinstall script. On macOS and Windows it
  downloads nothing. On **Linux x64** it fetches CUDA provider binaries from NuGet unless
  `ONNXRUNTIME_NODE_INSTALL=skip` is set (ThreadAtlas uses only the CPU provider).
- With the npm scripts, the Prisma CLI makes no network requests. Measured for
  `generate`, `validate`, `migrate diff` and `migrate deploy`; nothing was
  attempted. The Prisma Client and its SQLite adapter contain no network code.
