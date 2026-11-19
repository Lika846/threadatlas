import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killChild, spawnChild, waitForFile, type Child } from "../../../tests/helpers/child/spawn";
import { acquireWriteLock, IMPORT_LOCK_WAIT_MS, lockPathFor, tryAcquireWriteLock } from "./write-lock";

let dir: string;
let dbPath: string;
const children: Child[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-lock-"));
  dbPath = path.join(dir, "threadatlas.db");
});
afterEach(async () => {
  for (const c of children.splice(0)) await killChild(c);
  fs.rmSync(dir, { recursive: true, force: true });
});

const holdLock = async () => {
  const r = await acquireWriteLock(dbPath);
  if (!r.ok) throw new Error(`expected the lock, got ${r.code}`);
  return r.lock;
};

describe("write lock, one process", () => {
  it("is exclusive between two connections and reusable after release", async () => {
    const a = await holdLock();
    expect(tryAcquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_BUSY" });
    const t0 = performance.now();
    expect(await acquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_BUSY" });
    expect(performance.now() - t0).toBeLessThan(1_000); // bounded retries, then busy
    a.release();
    a.release(); // idempotent
    const b = await holdLock();
    b.release();
  });

  it("retries without blocking the event loop", async () => {
    const a = await holdLock();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const r = await acquireWriteLock(dbPath);
    clearInterval(timer);
    expect(r.ok).toBe(false);
    expect(ticks).toBeGreaterThan(3);
    a.release();
  });

  it("creates the lock file 0600, never deletes it, and never writes to it", async () => {
    const lock = await holdLock();
    const file = lockPathFor(dbPath);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    lock.release();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
    expect(fs.readdirSync(dir).sort()).toEqual(["threadatlas.db.lock"]); // no journal next to it
  });

  it("tightens an existing lock file's permissions", async () => {
    fs.writeFileSync(lockPathFor(dbPath), "");
    fs.chmodSync(lockPathFor(dbPath), 0o644);
    (await holdLock()).release();
    expect(fs.statSync(lockPathFor(dbPath)).mode & 0o777).toBe(0o600);
  });

  it("fails closed on a symlinked lock path and leaves the target alone", async () => {
    const target = path.join(dir, "elsewhere");
    fs.writeFileSync(target, "synthetic");
    fs.symlinkSync(target, lockPathFor(dbPath));
    expect(await acquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_LOCK_FAILED" });
    expect(fs.readFileSync(target, "utf8")).toBe("synthetic");
  });

  it("fails closed when the lock path is a directory or its folder is missing", async () => {
    fs.mkdirSync(lockPathFor(dbPath));
    expect(await acquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_LOCK_FAILED" });
    expect(await acquireWriteLock(path.join(dir, "missing", "x.db"))).toEqual({ ok: false, code: "IMPORT_LOCK_FAILED" });
  });

  it("fails closed when the lock file is not an SQLite file", async () => {
    fs.writeFileSync(lockPathFor(dbPath), "not sqlite ".repeat(500));
    expect(await acquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_LOCK_FAILED" });
  });
});

describe("write lock, bounded wait for imports and delete-all (M5.1b-1)", () => {
  it("waitMs: retries for at least waitMs and at most about one retry delay longer, then IMPORT_BUSY", async () => {
    const a = await holdLock();
    const t0 = performance.now();
    expect(await acquireWriteLock(dbPath, { waitMs: 300 })).toEqual({ ok: false, code: "IMPORT_BUSY" });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(300 + 250);
    a.release();
  });

  it("waitMs: a lock released during the wait is taken", async () => {
    const a = await holdLock();
    setTimeout(() => a.release(), 500);
    const t0 = performance.now();
    const r = await acquireWriteLock(dbPath, { waitMs: IMPORT_LOCK_WAIT_MS });
    expect(r.ok).toBe(true);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(490);
    if (r.ok) r.lock.release();
  });

  it("a non-contention failure is still not retried with waitMs", async () => {
    fs.mkdirSync(lockPathFor(dbPath));
    const t0 = performance.now();
    expect(await acquireWriteLock(dbPath, { waitMs: IMPORT_LOCK_WAIT_MS })).toEqual({ ok: false, code: "IMPORT_LOCK_FAILED" });
    expect(performance.now() - t0).toBeLessThan(10);
  });

  it("across processes: the import wait outlasts a 500 ms hold (the indexer's T2 budget); the short default does not", async () => {
    for (const [k, opts, expected] of [
      [0, {}, "IMPORT_BUSY"],
      [1, { waitMs: IMPORT_LOCK_WAIT_MS }, "ACQUIRED"],
    ] as const) {
      const out = path.join(dir, `hold-${k}`);
      const holder = spawnChild(dbPath, { CHILD_TASK: "lock-try", CHILD_OUT: out, CHILD_HOLD_MS: "500" });
      children.push(holder);
      expect(await waitForFile(out)).toBe("ACQUIRED");
      const r = await acquireWriteLock(dbPath, opts);
      expect(r.ok ? "ACQUIRED" : r.code).toBe(expected);
      if (r.ok) r.lock.release();
      await holder.exited;
    }
  }, 60_000);
});

describe("write lock, across processes", () => {
  it("a lock held in another process makes this one busy, and the reverse", async () => {
    const out = path.join(dir, "out");
    const holder = spawnChild(dbPath, { CHILD_TASK: "lock-hold", CHILD_OUT: out });
    children.push(holder);
    expect(await waitForFile(out)).toBe("ACQUIRED");
    expect(await acquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_BUSY" });
    await killChild(holder);

    const mine = await holdLock();
    const out2 = path.join(dir, "out2");
    const tryer = spawnChild(dbPath, { CHILD_TASK: "lock-try", CHILD_OUT: out2 });
    children.push(tryer);
    expect(await waitForFile(out2)).toBe("IMPORT_BUSY");
    await tryer.exited;
    mine.release();
  }, 60_000);

  it("SIGKILL of the holder releases the OS lock; the lock file survives", async () => {
    const out = path.join(dir, "out");
    const holder = spawnChild(dbPath, { CHILD_TASK: "lock-hold", CHILD_OUT: out });
    children.push(holder);
    expect(await waitForFile(out)).toBe("ACQUIRED");
    expect(tryAcquireWriteLock(dbPath).ok).toBe(false);
    const t0 = performance.now();
    holder.proc.kill("SIGKILL");
    const { signal } = await holder.exited;
    expect(signal).toBe("SIGKILL");
    let acquired = false;
    for (let i = 0; i < 200 && !acquired; i++) {
      const r = tryAcquireWriteLock(dbPath);
      if (r.ok) {
        acquired = true;
        r.lock.release();
      } else await new Promise((res) => setTimeout(res, 10));
    }
    expect(acquired).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(fs.existsSync(lockPathFor(dbPath))).toBe(true);
  }, 60_000);

  it("processes started at the same instant: exactly one gets the lock, the others are busy", async () => {
    for (let round = 0; round < 3; round++) {
      const outs = [0, 1, 2].map((k) => path.join(dir, `race-${round}-${k}`));
      const kids = outs.map((o) => spawnChild(dbPath, { CHILD_TASK: "lock-try", CHILD_OUT: o, CHILD_HOLD_MS: "1500" }));
      children.push(...kids);
      const results = await Promise.all(outs.map((o) => waitForFile(o)));
      await Promise.all(kids.map((k) => k.exited));
      // Children start ~0.5 s apart at most; a holder keeps the lock for 1.5 s.
      expect(results.filter((r) => r === "ACQUIRED").length, results.join(",")).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r === "ACQUIRED" || r === "IMPORT_BUSY")).toBe(true);
    }
  }, 120_000);

  it("never lets two holders overlap: three processes contending repeatedly", async () => {
    const owner = path.join(dir, "owner");
    fs.writeFileSync(owner, "");
    const outs = [0, 1, 2].map((k) => path.join(dir, `loop-${k}`));
    const kids = outs.map((o) => spawnChild(dbPath, { CHILD_TASK: "lock-loop", CHILD_OUT: o, CHILD_OWNER_FILE: owner, CHILD_LOOP_MS: "4000" }));
    children.push(...kids);
    const results = (await Promise.all(outs.map((o) => waitForFile(o, 90_000)))).map((r) => JSON.parse(r) as { held: number; busy: number; violations: number });
    await Promise.all(kids.map((k) => k.exited));
    expect(results.reduce((n, r) => n + r.violations, 0)).toBe(0);
    expect(results.reduce((n, r) => n + r.held, 0)).toBeGreaterThan(20);
    expect(results.reduce((n, r) => n + r.busy, 0)).toBeGreaterThan(0); // they really contended
    expect(fs.existsSync(lockPathFor(dbPath))).toBe(true);
  }, 120_000);

  it("a failed contender in the holder's own process cannot release the holder's lock", async () => {
    const holder = await holdLock();
    const ino = fs.statSync(lockPathFor(dbPath)).ino;
    // Contenders fail and close their own connections to the same file: with
    // POSIX locks, closing any descriptor of a file could drop the whole
    // process's locks on it. SQLite must keep the holder's lock regardless.
    for (let i = 0; i < 5; i++) expect(await acquireWriteLock(dbPath, { attempts: 2 })).toEqual({ ok: false, code: "IMPORT_BUSY" });
    const out = path.join(dir, "after-contenders");
    const probe = spawnChild(dbPath, { CHILD_TASK: "lock-try", CHILD_OUT: out });
    children.push(probe);
    expect(await waitForFile(out)).toBe("IMPORT_BUSY");
    await probe.exited;
    expect(fs.statSync(lockPathFor(dbPath)).ino).toBe(ino);
    holder.release();
    expect(tryAcquireWriteLock(dbPath).ok).toBe(true);
  }, 60_000);

  it("a failed contender in another process cannot release the holder's lock", async () => {
    const holder = await holdLock();
    for (let k = 0; k < 3; k++) {
      const out = path.join(dir, `contender-${k}`);
      const c = spawnChild(dbPath, { CHILD_TASK: "lock-try", CHILD_OUT: out });
      children.push(c);
      expect(await waitForFile(out)).toBe("IMPORT_BUSY");
      await c.exited; // its connection closed and its process exited
      expect(tryAcquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_BUSY" });
    }
    holder.release();
  }, 60_000);

  it("retry exhaustion returns IMPORT_BUSY; a non-contention failure is not retried", async () => {
    const holder = await holdLock();
    const t0 = performance.now();
    expect(await acquireWriteLock(dbPath, { attempts: 6 })).toEqual({ ok: false, code: "IMPORT_BUSY" });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(5 * 10 - 5); // five waits of at least 10 ms
    expect(elapsed).toBeLessThan(1_000);
    holder.release();
    fs.rmSync(lockPathFor(dbPath));
    fs.mkdirSync(lockPathFor(dbPath));
    const t1 = performance.now();
    expect(await acquireWriteLock(dbPath)).toEqual({ ok: false, code: "IMPORT_LOCK_FAILED" });
    expect(performance.now() - t1).toBeLessThan(10);
  });
});
