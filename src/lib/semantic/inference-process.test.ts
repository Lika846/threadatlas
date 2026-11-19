/**
 * Pins how the inference child is started (M5.1b-2; plan §3.1 and §3.9): an empty
 * environment, no inherited Node flags, discarded stdio, advanced serialisation, nothing
 * in argv, and the start-up data as the first IPC message. `fork` is replaced by a fake,
 * so no process starts.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { modulePath: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
const sent: unknown[] = [];

vi.mock("node:child_process", () => ({
  fork: (modulePath: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ modulePath, args, options });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.pid = 4242;
    child.connected = true;
    child.exitCode = null;
    child.signalCode = null;
    child.send = (m: unknown, _h: unknown, _o: unknown, cb?: () => void) => {
      sent.push(m);
      cb?.();
      // Reply like a child whose model is missing, then exit.
      setImmediate(() => {
        child.emit("message", { type: "init-error", code: "MODEL_MISSING" });
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
      return true;
    };
    child.kill = () => true;
    return child;
  },
}));

const { InferenceProcess, productionChildEntry, CHILD_ENTRY } = await import("./inference-process");

beforeEach(() => {
  calls.length = 0;
  sent.length = 0;
});

describe("starting the inference child", () => {
  it("forks the entry with an empty environment, no Node flags, discarded stdio and nothing in argv", async () => {
    const entry = productionChildEntry(process.cwd());
    await expect(InferenceProcess.start({ entry, modelDir: "/models/e5", verifyHashes: true })).rejects.toMatchObject({ code: "MODEL_MISSING" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.modulePath).toBe(entry);
    expect(calls[0]!.args).toEqual([]);
    expect(calls[0]!.options).toEqual({
      serialization: "advanced",
      execArgv: [],
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    // The model directory travels only in the first IPC message.
    expect(sent[0]).toEqual({ type: "init", modelDir: "/models/e5", verifyHashes: true, testOptions: undefined });
  });

  it("uses the source entry inside the project", () => {
    expect(CHILD_ENTRY).toBe(path.join("src", "lib", "semantic", "inference-child.ts"));
    expect(productionChildEntry("/p")).toBe(path.resolve("/p", "src/lib/semantic/inference-child.ts"));
  });
});
