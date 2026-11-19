# M5.1b integration spike: the inference worker inside Next.js

Date: 2026-11-10. Research only: nothing here is part of the app. Synthetic text only,
a temporary synthetic database (migrated, never read by the spike route), no persistent
index, no migration, no change to the real database, backup or manifest.

## Question

M5.1a tested the worker only when Node starts it directly. Before M5.1b builds on it:
- Does the worker start from `next dev` and `next start`?
- Should the worker be loaded from source or bundled by Next.js?
- Does native ONNX Runtime work in the Next.js server process?
- What happens on shutdown, on restart, and during `next dev` reloads?
- Are there unintended outbound connections?

## Method

- **Overlay** (`overlay/`, stored as `*.txt` so the project typecheck ignores it):
  `overlay.sh install` copies three files into `src/`, and `overlay.sh remove` deletes them
  again.
  - `src/app/api/spike-embed/route.ts`: a GET route with `op=status|start|embed|busy|close`.
  - `src/lib/semantic/spike-host.ts`: a `globalThis` singleton per mode, plus a deliberately
    module-scoped handle for comparison, and a drain-then-exit signal handler.
  - `src/instrumentation.ts`: registers the handler in `register()` (Node.js runtime only).
- **Two generated embedder copies:** from the committed `embedder.ts`, with only its
  `new Worker(...)` line changed:
  - **source:** `new Worker(/* turbopackIgnore: true */ opts.workerUrl!, …)`, with the URL
    `<cwd>/src/lib/semantic/worker.ts`, so Node loads the worker itself by type stripping,
    exactly as in the M5.1a tests;
  - **bundled:** `new Worker(new URL("./worker.ts", import.meta.url), …)`, so Turbopack
    bundles the worker.
- **Equivalence:** `reference.ts` computes vectors for the four synthetic texts and one
  query in plain Node. `compare.mjs` compares them with the route's vectors.
- **Shutdown in plain Node:** `kill-mid.mjs` ends the real worker by `process.exit()`,
  `worker.terminate()` or a cooperative drain, both during a batch and when idle.
- **Servers:** `server.sh` starts `npm run dev` or `npm run start` in their own process
  group on a temporary synthetic database (`THREADATLAS_TEST=1`).
- **Offline evidence:** an `lsof` sampler (every 0.1 s, all node processes) ran for the
  whole Next.js part. The plain-Node checks and one production server ran under
  `docs/spikes/m5.0/experiment-2/bench/nonet.sb`.
- **Model:** the read-only Experiment 1 copy in the session scratch directory, via
  `THREADATLAS_MODEL_DIR`. Nothing was downloaded.
- **Environment:** Next.js 16.4.4 (Turbopack), Node 24.22.2, Intel Mac.

## Results

### 1. Worker startup, native runtime and equivalence

| | Worker start | Vectors against plain Node |
| --- | --- | --- |
| `next dev`, source | 1.0–1.3 s | bit-identical (max diff 0) |
| `next dev`, bundled | 1.1 s | bit-identical |
| `next start`, source | 1.3 s | bit-identical |
| `next start`, bundled | 1.1 s | bit-identical |
| `next start` in the network-denied sandbox, both modes | 1.0–1.2 s | bit-identical |

ONNX Runtime 1.23.2 loads and runs in worker threads of the Next.js server process in
both modes. The main thread never loads it.

### 2. Source-loaded against bundled

| | Source-loaded | Bundled by Turbopack |
| --- | --- | --- |
| Works in dev and production | yes | yes |
| Same code path as the M5.1a tests | yes | no: a Turbopack worker chunk |
| ONNX Runtime | loaded by Node from `node_modules` | kept external automatically (Next's default `serverExternalPackages` list); the tokenizer is bundled |
| Build output | Next's file tracer lists every file in `src/lib/semantic/`, tests included (matters only for `output: "standalone"`, which we don't use) | a worker-thread chunk, plus an unused raw copy `assets/worker.<hash>.ts` from the `new URL()` asset reference |
| Needs | the source tree at runtime and the project root (`process.cwd()` under the npm scripts) | Turbopack's support for Node `worker_threads` (a newer feature; an upgrade risk) |

**The committed default breaks the build path:**
- `new Worker(opts.workerUrl ?? new URL("./worker.ts", import.meta.url))` can't be analysed.
  Turbopack treated the argument as a wildcard and made a worker entry for every JS, TS and
  JSON file in the project:
  - 928 chunks, from `src`, `docs`, `e2e`, `tests`, `scripts` and the config files;
  - none for anything under `data/`.
- The route then failed to compile, on the `eslint-config-next` native resolver.
- The line must change before any Next.js integration. An explicit URL with
  `/* turbopackIgnore: true */` fixes it.

### 3. Shutdown: the decisive finding

**Ending a worker thread while ONNX Runtime is inferring aborts the whole process.**

| How the worker ends (plain Node, offline) | During a batch | Idle (session loaded) |
| --- | --- | --- |
| `process.exit()` | **abort** (`libc++abi … Napi::Error`, exit 134): 8 of 8 | clean: 3 of 3 |
| `worker.terminate()` | **abort**: 8 of 8 | clean: 3 of 3 |
| Cancel flag, then `shutdown` message (M5.1a drain) | clean, 27–188 ms: 5 of 5 | — |

Next.js ends the process with `process.exit()` in each of these paths:
- **`next start` on SIGINT/SIGTERM:** after closing the HTTP server, which takes a few
  milliseconds with no open requests. This doesn't wait for anything registered by the
  app.
- **`next dev`:** the server child does the same. The `next dev` parent also SIGKILLs the
  child 100 ms after forwarding the signal (`NEXT_EXIT_TIMEOUT_MS`, default 100).
- **`next dev` restart after a `next.config.ts` change:** the child calls `process.exit()`
  directly.

Results with a batch in flight:

| Server and signal handling | Result |
| --- | --- |
| `next start`, Next's default handling, SIGTERM | **abort** 3 of 3 |
| `next start`, `NEXT_MANUAL_SIG_HANDLE=1` and the drain handler, SIGTERM or SIGINT, source or bundled | drained 44–117 ms, then `process.exit(143/130)`: 5 of 5, plus 1 of 1 in the sandbox |
| `next start`, SIGKILL | killed, no abort output (the operating system ends the process); the restart works |
| `next start`, idle workers, default handling | clean |
| `next dev`, default handling, Ctrl-C to the process group | **abort** 1 of 1 |
| `next dev`, `NEXT_EXIT_TIMEOUT_MS=15000` only | **abort** 1 of 1 |
| `next dev`, `NEXT_MANUAL_SIG_HANDLE=1` only | drained only when it finished inside 100 ms (2 of 3); otherwise SIGKILL |
| `next dev`, `NEXT_MANUAL_SIG_HANDLE=1` and `NEXT_EXIT_TIMEOUT_MS=15000` | drained 60–189 ms: 4 of 4 (Ctrl-C), plus 1 of 1 (SIGTERM to the `next` parent only) |
| `next dev`, `next.config.ts` touched during a batch | **abort**; the dev session ended and must be restarted by hand |

In every case, no data is at risk: the worker never touches the database, and chunks are
written only in the commit transaction. The aborts matter because they are crashes
(SIGABRT and a native error message), not because they lose data.

### 4. `next dev` reloads (HMR)

- **Separate module instances:** `instrumentation.ts` and the route import the same module
  as two instances (the evaluation counter was 2 at the first request). Only `globalThis`
  is shared.
- **Editing the host module** (three edits): it was re-evaluated each time.
  - The `globalThis` singleton was reused: no new worker. Its instance kept working after
    an edit to the embedder module, still bit-identical.
  - The module-scoped handle was lost after each edit, and the next request started a
    second worker. The orphan stayed live: **one leaked worker per edit**.
- **`register()`** did not run again on HMR. The SIGTERM listener count stayed at 2
  (Next's and ours).

### 5. Network

- **Sampled:** no non-loopback connection from any node process during the whole Next.js
  part.
- **Caveat:** the documented `next dev` registry check (seen in earlier e2e runs) did not
  occur in this window, so its absence here is not evidence that it's gone.
- **Sandbox:** the plain-Node checks and one production server ran in the network-denied
  sandbox, and worked normally.

## Conclusions for M5.1b

1. **Load the worker from source** (decision 6):
   - It is the tested path, with no dependence on Turbopack's worker bundling.
   - Change `embedder.ts` to take an explicit worker URL and construct
     `new Worker(/* turbopackIgnore: true */ url, …)`, with no `new URL(…, import.meta.url)`
     fallback in bundled code. The URL comes from one helper,
     `<projectRoot>/src/lib/semantic/worker.ts`, and the root is checked (the
     `src/lib/semantic/package.json` marker must exist).
   - Bundling stays a measured fallback.
2. **Own the shutdown signals:**
   - `"start": "NEXT_MANUAL_SIG_HANDLE=true … next start …"` and
     `"dev": "NEXT_MANUAL_SIG_HANDLE=true NEXT_EXIT_TIMEOUT_MS=15000 … next dev …"`.
   - The handler is registered in `instrumentation.ts` `register()` (Node.js runtime).
     With manual handling Next no longer exits by itself, so the handler is always
     installed and always ends the process after draining, even when the indexer never
     ran.
   - **Caveat:** Next documents `NEXT_MANUAL_SIG_HANDLE` for `next start` (Pages Router
     page) and says it is not available in `next dev`, yet it works in 16.4.4.
     `NEXT_EXIT_TIMEOUT_MS` is undocumented. Both are pinned by a test of the scripts and
     re-checked on every Next.js upgrade. Without them the result is a crash, never data
     loss.
3. **Singleton on `globalThis` only:** the indexer, its Embedder and its state. Never module
   scope.
4. **Accepted dev-only limitation:** a `next.config.ts` change during a batch crashes
   `next dev`. Documented; recovered by I5 at the next Start.
5. **Never terminate a worker mid-batch** (confirmed, now with evidence):
   - `terminate()` is allowed only after the worker has released its session, as M5.1a
     already does.
   - Missing the 10 s target never leads to termination.

## Reproduce

```sh
# Once: a migrated synthetic database in the system temp dir, the model directory,
# and an output folder for logs (all absolute paths).
export SPIKE_OUT=… SPIKE_DB=… THREADATLAS_MODEL_DIR=…
node docs/spikes/m5.1b/integration/reference.ts > "$SPIKE_OUT/ref.json"
docs/spikes/m5.1b/integration/overlay.sh install
docs/spikes/m5.1b/integration/server.sh d1 dev 3201 THREADATLAS_SPIKE_SIGNALS=1 NEXT_MANUAL_SIG_HANDLE=1 NEXT_EXIT_TIMEOUT_MS=15000
curl -s 'http://127.0.0.1:3201/api/spike-embed?op=embed&mode=source' > "$SPIKE_OUT/r.json"
node docs/spikes/m5.1b/integration/compare.mjs "$SPIKE_OUT/ref.json" "$SPIKE_OUT/r.json"
curl -s 'http://127.0.0.1:3201/api/spike-embed?op=busy&mode=source&n=6000'; kill -INT -"$(cat "$SPIKE_OUT/d1.pid")"
cat "$SPIKE_OUT/d1.events"      # signal → drained
docs/spikes/m5.1b/integration/overlay.sh remove   # then rebuild (.next holds the spike route)
```
