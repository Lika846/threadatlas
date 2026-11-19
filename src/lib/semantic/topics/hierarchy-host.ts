/**
 * Builds the atlas's tree off the server's main thread (phase 2). Server-only.
 *
 * The average linkage is O(n²): about 0.3 s at 1,000 conversations and 3 s at 3,000, measured
 * on the development Mac. Computed inline, it held every other request for that long. Here a
 * short-lived worker thread (`hierarchy-worker.ts`, Node's own `worker_threads`, as the
 * embedder already uses) computes it and exits. The vectors are copied into one buffer that is
 * transferred, not cloned, and the small result comes back.
 *
 * Falls back to computing inline when the worker can't start or fails, so the map works in any
 * case, only less smoothly. Same result either way: the worker runs the same pure code.
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import { buildHierarchy, type Hierarchy } from "./themes.ts";

/** The worker entry, resolved from the project root (as the inference child is). */
export function hierarchyWorkerEntry(root: string = process.cwd()): string {
  return path.resolve(root, "src", "lib", "semantic", "topics", "hierarchy-worker.ts");
}

/** How the last computation ran (tests and diagnostics; never shown to the user). */
export const lastRun: { mode: "worker" | "inline" | null } = { mode: null };

/** Themes → topics of centred vectors, computed in a worker thread. */
export async function computeHierarchy(centred: readonly Float64Array[], opts: { entry?: string } = {}): Promise<Hierarchy> {
  const n = centred.length;
  const dims = n > 0 ? centred[0]!.length : 0;
  if (n < 2) {
    lastRun.mode = "inline";
    return buildHierarchy(centred);
  }
  const vectors = new Float64Array(n * dims);
  centred.forEach((v, i) => vectors.set(v, i * dims));
  try {
    const result = await new Promise<Hierarchy>((resolve, reject) => {
      // Reflect.construct, not `new Worker(…)`: the bundler treats `new Worker(path)` as a worker to
      // bundle and, with a computed path, would pull in the whole source tree. Node loads the
      // entry itself at run time, as it does the inference child.
      const worker: Worker = Reflect.construct(Worker, [opts.entry ?? hierarchyWorkerEntry(), { workerData: { n, dims, vectors }, transferList: [vectors.buffer] }]);
      worker.once("message", (h: Hierarchy) => {
        resolve(h);
        void worker.terminate();
      });
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`hierarchy worker exited with code ${code}`)));
    });
    lastRun.mode = "worker";
    return result;
  } catch {
    lastRun.mode = "inline";
    return buildHierarchy(centred);
  }
}
