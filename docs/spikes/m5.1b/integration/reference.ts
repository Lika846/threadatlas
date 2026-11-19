// Reference vectors for the spike's synthetic texts, computed by plain Node (no Next.js).
// Usage: node docs/spikes/m5.1b/integration/reference.ts > ref.json  (THREADATLAS_MODEL_DIR set)
import { Embedder } from "../../../../src/lib/semantic/embedder.ts";
import { resolveModelDir } from "../../../../src/lib/semantic/model-files.ts";

const SYNTHETIC = [
  "The community garden plan needs a budget for seeds and tools.",
  "Hagen trenger et budsjett for frø og verktøy til våren.",
  "Бюджет на семена и инструменты для сада нужно утвердить.",
  "A short note.",
];
const e = await Embedder.start({ modelDir: resolveModelDir({ env: process.env, root: process.cwd() }), verifyHashes: false });
const all = [...(await e.embedPassages(SYNTHETIC)), await e.embedQuery("garden budget")];
await e.close();
process.stdout.write(JSON.stringify({ vectors: Buffer.concat(all.map((x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength))).toString("base64") }));
