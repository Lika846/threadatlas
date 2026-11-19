/**
 * Worker-thread entry for the atlas's tree (phase 2, `hierarchy-host.ts`): builds themes →
 * topics (`themes.ts`) from centred vectors sent by the server, so the O(n²) average linkage
 * (about 3 s at 3,000 conversations) doesn't block the server's other requests.
 *
 * Node loads this file directly (type stripping), outside any bundler, as it does the
 * inference child: this file and everything it imports use erasable TypeScript syntax and
 * relative `.ts` imports. Pure computation: no database, no files, no network, no logging.
 */
import { parentPort, workerData } from "node:worker_threads";
import { buildHierarchy } from "./themes.ts";

type Input = { n: number; dims: number; vectors: Float64Array };

if (!parentPort) throw new Error("hierarchy-worker.ts must run in a worker thread");
const input = workerData as Input;
const centred = Array.from({ length: input.n }, (_, i) => input.vectors.subarray(i * input.dims, (i + 1) * input.dims));
parentPort.postMessage(buildHierarchy(centred));
