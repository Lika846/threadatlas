/**
 * The test-entry override of the inference child (M5.1b-2, owner's condition 5): ignored
 * outside a test runner, whatever the environment says; under a test runner only the exact
 * fake child file is accepted. (Under a test runner the database clients also refuse every
 * database outside the system temp directory, so the fake child can never index real data:
 * covered by src/lib/db/path.test.ts.)
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { productionChildEntry } from "../inference-process";
import { inferenceTarget, TEST_INFERENCE_ENTRY } from "./service";

const ROOT = "/project";
const FAKE = "tests/helpers/fake-inference-child.mts";

describe("inferenceTarget", () => {
  it.each([
    ["no override", {}],
    ["an override in production", { NODE_ENV: "production", THREADATLAS_INFERENCE_ENTRY: FAKE }],
    ["an override without any test flag", { THREADATLAS_INFERENCE_ENTRY: FAKE, THREADATLAS_INFERENCE_TEST_OPTIONS: "{}" }],
    ["an override with a wrong test flag value", { THREADATLAS_TEST: "true", THREADATLAS_INFERENCE_ENTRY: FAKE }],
  ])("uses the production entry with %s", (_label, env) => {
    expect(inferenceTarget(env, ROOT)).toEqual({ entry: productionChildEntry(ROOT) });
  });

  it.each([
    ["another test helper", "tests/helpers/fake-index-worker.mts"],
    ["a file outside the project", "/tmp/evil.mts"],
    ["a path that escapes", "tests/helpers/../../src/lib/semantic/inference-child.ts"],
    ["the production entry itself", "src/lib/semantic/inference-child.ts"],
  ])("refuses %s under a test runner (RUNTIME_UNAVAILABLE)", (_label, entry) => {
    expect(() => inferenceTarget({ THREADATLAS_TEST: "1", THREADATLAS_INFERENCE_ENTRY: entry }, ROOT)).toThrow(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });

  it("accepts exactly the fake child under a test runner, with its options", () => {
    for (const env of [{ THREADATLAS_TEST: "1" }, { VITEST: "true" }, { NODE_ENV: "test" }]) {
      expect(inferenceTarget({ ...env, THREADATLAS_INFERENCE_ENTRY: FAKE, THREADATLAS_INFERENCE_TEST_OPTIONS: '{"batchDelayMs":5}' }, ROOT)).toEqual({
        entry: path.resolve(ROOT, TEST_INFERENCE_ENTRY),
        testOptions: { batchDelayMs: 5 },
      });
    }
  });

  it.each(["not json", "[1,2]", "null", "42"])("refuses malformed test options %j", (opts) => {
    expect(() => inferenceTarget({ THREADATLAS_TEST: "1", THREADATLAS_INFERENCE_ENTRY: FAKE, THREADATLAS_INFERENCE_TEST_OPTIONS: opts }, ROOT)).toThrow(
      expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }),
    );
  });
});
