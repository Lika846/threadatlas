/**
 * Test-only inference child entry with the REAL model (M5.1b-2 real-model tests): the same
 * steps as `loadE5Pipeline` (verify sizes and SHA-256, tokenizer, ONNX Runtime), but the
 * backend is wrapped to log when each native batch starts and ends, so tests can check
 * what happens around real inference. Loaded by Node directly (type stripping).
 *
 * testOptions: { eventLog?: string (absolute temp path), abortAtBatch?: number (process.abort()
 * inside that native batch's callback, before it runs) }. Logs static event names only.
 */
import fs from "node:fs";
import { serveOverIpc } from "../../src/lib/semantic/child-core.ts";
import { createOrtBackend } from "../../src/lib/semantic/ort-backend.ts";
import { modelFilePath, verifyModelDir } from "../../src/lib/semantic/model-files.ts";
import { E5_SMALL_MANIFEST, E5_SMALL_SPEC } from "../../src/lib/semantic/model-manifest.ts";
import { createPipeline, tokenizerKeyOf } from "../../src/lib/semantic/pipeline.ts";
import { loadHfTokenizer } from "../../src/lib/semantic/tokenizer.ts";

type Options = { eventLog?: string; abortAtBatch?: number };

serveOverIpc((init) => {
  const o = (init.testOptions ?? {}) as Options;
  const log = (name: string) => {
    if (o.eventLog) fs.appendFileSync(o.eventLog, `${JSON.stringify({ t: Date.now(), name })}\n`);
  };
  log(`pid:${process.pid}`);
  process.on("exit", (code) => log(`exit:${code}`));
  return {
    onEvent: log,
    load: async () => {
      await verifyModelDir(init.modelDir, E5_SMALL_MANIFEST, { hash: init.verifyHashes });
      const tokenizer = await loadHfTokenizer(init.modelDir, E5_SMALL_SPEC);
      const inner = await createOrtBackend(modelFilePath(init.modelDir, E5_SMALL_SPEC.modelFile));
      let batches = 0;
      const backend = {
        async run(batch: Parameters<typeof inner.run>[0]) {
          const k = ++batches;
          log("batch-start");
          if (o.abortAtBatch === k) setImmediate(() => process.abort());
          const r = await inner.run(batch);
          log("batch-end");
          return r;
        },
        release: () => inner.release(),
      };
      return createPipeline({ tokenizer, backend, spec: E5_SMALL_SPEC, tokenizerKey: tokenizerKeyOf(E5_SMALL_MANIFEST) });
    },
  };
});
