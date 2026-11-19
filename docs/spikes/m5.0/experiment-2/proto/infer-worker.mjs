// Inference worker thread: owns the tokenizer and the ONNX session; chunks and embeds the messages it is
// given and returns spans + vectors. No database access, no logging of text.
import { parentPort, workerData } from "node:worker_threads";
import { createDirectEmbedder } from "../bench/direct.mjs";
import { makeChunker } from "./chunker.mjs";

const e = await createDirectEmbedder({ rt: workerData.rt, modelDir: workerData.modelDir });
const chunk = makeChunker(e.tokenizer, 64);
parentPort.postMessage({ type: "ready", loadMs: e.loadMs });
parentPort.on("message", async (m) => {
  if (m.type === "index") {
    try {
      const spans = [];
      for (const msg of m.messages) chunk(msg.text).forEach((s, k) => spans.push({ sourceNodeId: msg.sourceNodeId, chunkIndex: k, start: s.start, end: s.end, text: msg.text.slice(s.start, s.end) }));
      const vecs = await e.embedBatched(spans.map((s) => "passage: " + s.text), 16);
      const flat = new Float32Array(vecs.length * 384);
      vecs.forEach((v, i) => flat.set(v, i * 384));
      parentPort.postMessage({ type: "indexed", id: m.id, spans: spans.map((s) => ({ sourceNodeId: s.sourceNodeId, chunkIndex: s.chunkIndex, start: s.start, end: s.end })), flat }, [flat.buffer]);
    } catch {
      parentPort.postMessage({ type: "error", id: m.id, code: "INFERENCE_FAILED" });
    }
  } else if (m.type === "query") {
    const [v] = await e.embedBatched(["query: " + m.text], 1);
    parentPort.postMessage({ type: "queryVector", id: m.id, v }, [v.buffer]);
  } else if (m.type === "shutdown") {
    await e.release();
    parentPort.postMessage({ type: "closed" });
  }
});
