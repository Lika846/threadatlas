/**
 * Inference child process entry (M5.1b-2; started by `inference-process.ts`). Owns the
 * tokenizer and the ONNX Runtime session; never touches the database and never logs.
 * The approved model is verified (sizes and SHA-256) before it is loaded.
 *
 * Node loads this file directly (type stripping), outside any bundler, so this file and
 * everything it imports use erasable TypeScript syntax and relative `.ts` imports.
 * `init.testOptions` is ignored here: only test entries in `tests/helpers/` read it.
 */
import { serveOverIpc } from "./child-core.ts";
import { loadE5Pipeline } from "./pipeline.ts";

serveOverIpc((init) => ({
  load: () => loadE5Pipeline(init.modelDir, { verifyHashes: init.verifyHashes }),
}));
