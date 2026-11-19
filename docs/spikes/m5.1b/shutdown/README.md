# M5.1b shutdown comparison: worker thread against child process

Date: 2026-11-11. A bounded comparison of the two ways to host native inference. It is
not a general redesign: both run the same unchanged M5.1a worker loop (`serveWorker`),
pipeline and model. Synthetic text only, a temporary database, no persistent index.

## The two candidates

**A. Worker thread with the Next.js workaround** (M5.1b integration spike):
- the M5.1a `Embedder` (`worker_threads`);
- `NEXT_MANUAL_SIG_HANDLE=true` (and `NEXT_EXIT_TIMEOUT_MS=15000` in dev);
- a drain-then-exit handler in `instrumentation.ts`.

**B. Child process:**
- `child-entry.ts` runs `serveWorker` over the IPC channel. It drains on a `shutdown`
  message, on SIGINT/SIGTERM, and when the parent disappears (IPC `disconnect`).
- `process-embedder.ts` is the same client surface as `Embedder`, using
  `fork(/* turbopackIgnore: true */ entry, …)` with `serialization: "advanced"`, an
  empty environment and `execArgv: []`.
- Cancellation is a message: a SharedArrayBuffer cannot cross processes, so the child
  sets its own flag.
- Next.js's own signal handling is left at its defaults.

## Results

### Plain Node (`bench.ts`)

| | A. Worker thread | B. Child process |
| --- | --- | --- |
| Start (ready), 5 runs × 2 | 0.88–1.15 s | 1.15–1.23 s (**+0.25 s**) |
| Vectors against the reference | bit-identical | bit-identical |
| 2,000 passages | 4.8–4.9 s | 5.0 s (+3%) |
| Memory while loaded (fresh process, after 2,000 passages) | 764–781 MB, all in the server | server 76–83 MB + child 729–870 MB = 812–948 MB |
| **Server memory after close** | **755–756 MB** (ONNX Runtime's native memory is not returned) | **77–83 MB** (all freed with the child) |
| Cancel → rejection | 0.20–0.23 s | 0.34–0.41 s (next batch boundary in both) |
| Close during a batch (drain) | 0.25–0.32 s | 0.10–0.33 s; one run took 1.1 s (once, in a run without the event log; not seen again in 5 later runs) |
| Native abort during inference | **ends the whole server process** (spike: 8 of 8) | **only the child ends**; the pending call rejects `WORKER_FAILED`; restart 1.2–1.8 s, then bit-identical results |
| Parent calls `process.exit()` mid-batch | — (this *is* the abort case) | child drains on `disconnect`, 52–55 ms, exit 0; 4 of 4 |
| Parent SIGKILLed mid-batch | the operating system ends everything (no abort, no drain) | child drains on `disconnect`, 40–57 ms, exit 0; no orphan; 4 of 4 |

### Inside Next.js 16.4.4

B was measured with Next's **default** signal handling (no `NEXT_MANUAL_SIG_HANDLE`, no
`NEXT_EXIT_TIMEOUT_MS`, no handler). A's results are from the integration spike, with
the workaround in place.

| Scenario | A. Worker thread + workaround | B. Child process, Next defaults |
| --- | --- | --- |
| `next start`, SIGTERM or SIGINT mid-batch | drained 44–117 ms (6 of 6). **Without the workaround: abort, 3 of 3** (and 4 of 4 again today, when a test route bug ran the thread mode) | server exits at once; child drains on `disconnect` 44–72 ms, exit 0; no abort, no orphan: **8 of 8** (incl. 1 in the network-denied sandbox) |
| `next start`, SIGKILL mid-batch | killed; no abort | child drains on `disconnect` 59–60 ms; no orphan: 2 of 2 |
| `next dev`, Ctrl-C (whole process group) mid-batch | drained 60–189 ms with both variables (5 of 5) | child drains (SIGINT or `disconnect`) 61–133 ms, exit 0; no orphan: **8 of 8** after one fix (below) |
| `next dev`, `next.config.ts` changed mid-batch | **abort; the dev session ends** | the server restarts normally; the old child drains (60 ms, exit 0); the new server embeds bit-identically |
| Inference crashes (SIGABRT) mid-batch | the server dies | the server stays up; keyword search answers (200); the next request restarts inference (1.3 s) |
| HMR edit of the host module | `globalThis` singleton reused | the same; the same child reused |
| Worker start inside Next | 1.0–1.3 s | 1.14–1.21 s |
| Build | no warnings | no warnings; the ignored `fork()` adds only the child entry to the trace |
| Outbound connections (sampled) | none | none |

**One defect found and fixed in B.**
- **What happened:** in 1 of the first 3 dev Ctrl-C runs the child exited with code 1
  and aborted.
- **Cause:** the child received SIGINT while its parent was dying. A
  `process.send()` on the closing channel raised an unhandled `error` event, which
  ended the child mid-inference.
- **Fix:** sends now take an error callback, and channel errors and uncaught exceptions
  start the drain instead of exiting.
- **After the fix:** 8 of 8 dev, 4 of 4 production and 2 of 2 plain-Node runs clean.
- **Lesson:** B needs exactly this kind of care. Any path that ends the child while it
  is inferring aborts it, just as in A, but only the child.

## Comparison

| Criterion | A. Worker thread + workaround | B. Child process |
| --- | --- | --- |
| **Reliability: shutdown** | Depends on `NEXT_MANUAL_SIG_HANDLE` (documented for `next start` only) and `NEXT_EXIT_TIMEOUT_MS` (undocumented). If a Next.js upgrade changes either, shutdown during a batch aborts the server | Independent of Next's signal handling: the child drains whenever its parent goes, however it goes. Works with Next's defaults |
| **Reliability: crash isolation** | None: any native fault in inference ends the web server | A native fault ends only the child; the server and keyword search keep running |
| **Reliability: dev** | A config change during a batch kills `next dev` | Restarts normally |
| **Reliability: new failure modes** | — | A child that hangs inside native code would outlive the server (not observed: no orphan in any of the 31 parent-death, shutdown and crash runs). IPC errors must never end the child (the defect above) |
| **Complexity** | Simplest client (exists); plus the signal handler, two env variables in both scripts, and an upgrade check | About 90 lines of child entry and 150 lines of client (replacing the `Worker` use); cancellation by message; a small IPC adapter around the unchanged worker loop; no signal handler and no env variables |
| **Startup** | 0.9–1.3 s | +0.25 s (a second Node runtime) |
| **Throughput** | baseline | −3% (copies over IPC, about 1.5 KB per vector) |
| **Memory while indexing** | ≈ 0.77 GB | ≈ 0.81–0.95 GB (+40–170 MB for the second runtime) |
| **Cleanup** | The server keeps ≈ 0.75 GB after the model is closed, until it restarts | Everything is returned when the child exits; the server stays ≈ 80 MB |
| **Testing** | Signal behaviour needs a built server and the env variables pinned | Shutdown and crash behaviour are testable in plain Node (kill the parent, kill the child) |

## Recommendation: B, the child process

- **No reliance on Next.js internals.** It removes the dependence on one
  documented-for-production and one undocumented setting, which you did not approve as
  the final architecture.
- **Crash isolation.** It is the only option that keeps ThreadAtlas, and keyword
  search, running when the native runtime fails.
- **Memory is returned.** The server's memory comes back after indexing.
- **The dev limitation goes away.**
- **The costs are small and bounded:** about a quarter of a second at start, 3%
  throughput, and about 0.1 GB extra while indexing, all for a manual, occasional
  operation.

**Conditions:**
- The child's environment is empty, its stdio is ignored in production (no native
  messages reach the logs), and it is started only on explicit Start.
- **IPC errors and uncaught exceptions always start the drain.** A test kills the
  parent at random points during a batch and requires exit code 0 and no orphan.
- The `close()` rule from M5.1a stays: SIGKILL only after the child reported that its
  session is released.
- M5.1b-2 moves the host into `src/lib/semantic/`: `inference-process.ts` (the child
  entry) and the client.
  - The M5.1a `worker.ts` and `Embedder` stay for the existing tests, or are retired
    in M5.1b-2.
  - The Turbopack wildcard in `embedder.ts` (integration spike) must be fixed or the
    class retired before anything imports it from Next.js.
- If B is approved, `NEXT_MANUAL_SIG_HANDLE`, `NEXT_EXIT_TIMEOUT_MS` and the
  `instrumentation.ts` signal handler are **not** used.
  - A Next.js shutdown then simply exits.
  - The indexer's claimed row stays `running` and is reset at the next Start (I5): the
    *interrupted* state.
  - The child finishes its batch and exits on its own.

## Reproduce

```sh
export THREADATLAS_MODEL_DIR=…            # verified model directory (absolute)
node docs/spikes/m5.1b/shutdown/bench.ts compare <ref.json>     # ref from integration/reference.ts
node docs/spikes/m5.1b/shutdown/bench.ts memory thread|process
node docs/spikes/m5.1b/shutdown/bench.ts parent-dies exit|sigkill <events file>
# Inside Next.js: docs/spikes/m5.1b/integration (overlay.sh install; mode=process).
```
