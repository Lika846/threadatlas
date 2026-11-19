// Direct embedder: onnxruntime-node 1.23.2 + @huggingface/tokenizers 0.2.0, no Transformers.js.
// Reproduces the Transformers.js feature-extraction pipeline for multilingual-e5-small:
// tokenizer.json + tokenizer_config.json, special tokens <s> … </s>, truncation to 512,
// right padding with pad id, attention mask, token_type_ids = 0, mean pooling over the
// attention mask, L2 normalisation. `truncation: "tfjs"` cuts the id list at 512 (as
// Transformers.js 3.8.1 does, which drops the final </s>); `"reference"` keeps </s> as the
// Python tokenizers library does.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function createDirectEmbedder({ rt, modelDir, truncation = "tfjs", maxLength = 512, sessionOptions = {} }) {
  const t0 = performance.now();
  const ort = (await import(pathToFileURL(path.join(rt, "onnxruntime-node/dist/index.js")).href)).default;
  const { Tokenizer } = await import(pathToFileURL(path.join(rt, "@huggingface/tokenizers/dist/tokenizers.mjs")).href);
  const importMs = performance.now() - t0;
  const t1 = performance.now();
  const tokJson = JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf8"));
  const tokCfg = JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer_config.json"), "utf8"));
  const tokenizer = new Tokenizer(tokJson, tokCfg);
  const session = await ort.InferenceSession.create(path.join(modelDir, "onnx/model_quantized.onnx"), { executionProviders: ["cpu"], ...sessionOptions });
  const loadMs = performance.now() - t1;
  const padId = tokenizer.token_to_id("<pad>");
  const eosId = tokenizer.token_to_id("</s>");

  function encode(text) {
    let ids = tokenizer.encode(text).ids; // with <s> … </s>
    if (ids.length > maxLength) {
      ids = truncation === "reference" ? [...ids.slice(0, maxLength - 1), eosId] : ids.slice(0, maxLength);
    }
    return ids;
  }

  async function embed(texts) {
    const enc = texts.map(encode);
    const len = Math.max(...enc.map((e) => e.length));
    const n = enc.length;
    const ids = new BigInt64Array(n * len);
    const mask = new BigInt64Array(n * len);
    enc.forEach((e, i) => {
      for (let j = 0; j < len; j++) {
        ids[i * len + j] = BigInt(j < e.length ? e[j] : padId);
        mask[i * len + j] = j < e.length ? 1n : 0n;
      }
    });
    const feeds = {
      input_ids: new ort.Tensor("int64", ids, [n, len]),
      attention_mask: new ort.Tensor("int64", mask, [n, len]),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(n * len), [n, len]),
    };
    const out = await session.run(feeds);
    const h = out.last_hidden_state;
    const [, , d] = h.dims;
    const data = h.data;
    const vecs = [];
    for (let i = 0; i < n; i++) {
      const v = new Float32Array(d);
      let count = 0;
      for (let j = 0; j < len; j++) {
        if (mask[i * len + j] === 0n) continue;
        count++;
        const o = (i * len + j) * d;
        for (let k = 0; k < d; k++) v[k] += data[o + k];
      }
      let norm = 0;
      for (let k = 0; k < d; k++) { v[k] /= count; norm += v[k] * v[k]; }
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < d; k++) v[k] /= norm;
      vecs.push(v);
    }
    h.dispose?.();
    return vecs;
  }

  return {
    importMs, loadMs, tokenizer, encode,
    tokenCount: (t) => tokenizer.encode(t).ids.length,
    async embedBatched(texts, batch = 16) {
      const out = [];
      for (let i = 0; i < texts.length; i += batch) out.push(...(await embed(texts.slice(i, i + batch))));
      return out;
    },
    release: () => session.release(),
  };
}
