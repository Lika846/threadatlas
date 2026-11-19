/**
 * Test-only parent process (M5.1b-2): starts an inference child through the real client,
 * writes the child's pid to `readyFile`, starts one long embedding request and waits to
 * be killed. Has no signal handlers, so SIGTERM and SIGINT end it at once, as Next.js's
 * default handling does. Writes nothing to stdout or stderr.
 *
 *   node inference-parent.mts '<json: { entry, modelDir, testOptions, texts, words, readyFile, verifyHashes }>'
 */
import fs from "node:fs";
import { InferenceProcess } from "../../src/lib/semantic/inference-process.ts";

type Args = {
  entry: string;
  modelDir: string;
  testOptions?: Record<string, unknown>;
  texts: number;
  words?: number;
  readyFile: string;
  verifyHashes?: boolean;
};

const args = JSON.parse(process.argv[2] ?? "{}") as Args;
const p = await InferenceProcess.start({ entry: args.entry, modelDir: args.modelDir, testOptions: args.testOptions, verifyHashes: args.verifyHashes });
const texts = Array.from({ length: args.texts }, (_, i) => Array.from({ length: args.words ?? 40 }, (_, w) => `w${(i * 7 + w) % 97}`).join(" "));
void p.embedPassages(texts).catch(() => {});
fs.writeFileSync(`${args.readyFile}.tmp`, JSON.stringify({ pid: p.pid }));
fs.renameSync(`${args.readyFile}.tmp`, args.readyFile);
setInterval(() => {}, 1_000);
