/**
 * `TextTokenizer` backed by `@huggingface/tokenizers` 0.2.0 (pure JavaScript), loaded
 * from the local `tokenizer.json` and `tokenizer_config.json`.
 */
import fs from "node:fs";
import path from "node:path";
import type { TextTokenizer } from "./backend.ts";
import { EmbeddingError } from "./errors.ts";

type HfTokenizer = {
  encode(text: string, options?: { add_special_tokens?: boolean }): { ids: number[] };
  token_to_id(token: string): number | undefined;
};

export async function loadHfTokenizer(
  modelDir: string,
  files: { tokenizerFile: string; tokenizerConfigFile: string },
): Promise<TextTokenizer> {
  let tok: HfTokenizer;
  try {
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const json: unknown = JSON.parse(await fs.promises.readFile(path.join(modelDir, files.tokenizerFile), "utf8"));
    const config: unknown = JSON.parse(
      await fs.promises.readFile(path.join(modelDir, files.tokenizerConfigFile), "utf8"),
    );
    tok = new Tokenizer(json as object, config as object) as unknown as HfTokenizer;
  } catch {
    throw new EmbeddingError("MODEL_LOAD_FAILED");
  }
  const padId = tok.token_to_id("<pad>");
  const eosId = tok.token_to_id("</s>");
  if (padId === undefined || eosId === undefined) throw new EmbeddingError("MODEL_LOAD_FAILED");
  return {
    padId,
    eosId,
    encodeWithSpecialTokens: (text) => tok.encode(text).ids,
    countTokens: (text) => tok.encode(text, { add_special_tokens: false }).ids.length,
  };
}
