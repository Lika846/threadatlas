import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutInTempDir } from "../../../tests/helpers/test-db";
import {
  assertDatabaseIsolation,
  DatabaseConfigError,
  DatabaseIsolationError,
  databasePathFromUrl,
  isTestContext,
  realDatabasePath,
  resolveDatabasePath,
  toDatabaseUrl,
} from "./path";

const PROJECT = process.cwd();
const TEST_ENV = { THREADATLAS_TEST: "1" };

describe("database path resolution", () => {
  it("defaults to <root>/data/threadatlas.db", () => {
    expect(resolveDatabasePath({ env: {}, root: "/proj" })).toBe(path.resolve("/proj/data/threadatlas.db"));
    expect(resolveDatabasePath({ env: { DATABASE_URL: "  " }, root: "/proj" })).toBe(realDatabasePath("/proj"));
  });

  it("accepts an absolute file: URL", () => {
    expect(resolveDatabasePath({ env: { DATABASE_URL: "file:/tmp/x/a.db" }, root: "/proj" })).toBe("/tmp/x/a.db");
    expect(databasePathFromUrl("file:/a/b/../c.db")).toBe("/a/c.db");
  });

  it.each([
    ["a relative path", "file:./dev.db"],
    ["a bare relative path", "file:dev.db"],
    ["another scheme", "postgres://localhost/db"],
    ["no scheme", "/abs/path.db"],
    ["a query string", "file:/tmp/a.db?mode=ro"],
    ["a fragment", "file:/tmp/a.db#x"],
    ["a newline", "file:/tmp/a\n.db"],
  ])("rejects %s", (_label, url) => {
    expect(() => databasePathFromUrl(url)).toThrow(DatabaseConfigError);
  });

  it("builds file: URLs only from absolute paths", () => {
    expect(toDatabaseUrl("/tmp/a.db")).toBe("file:/tmp/a.db");
    expect(() => toDatabaseUrl("data/a.db")).toThrow(DatabaseConfigError);
  });
});

describe("test-context detection", () => {
  it.each([
    [{ THREADATLAS_TEST: "1" }, true],
    [{ VITEST: "true" }, true],
    [{ NODE_ENV: "test" }, true],
    [{ NODE_ENV: "production" }, false],
    [{}, false],
  ])("%j → %s", (env, expected) => {
    expect(isTestContext(env)).toBe(expected);
  });

  it("is on inside this Vitest run", () => {
    expect(isTestContext(process.env)).toBe(true);
  });
});

describe("assertDatabaseIsolation (fails closed in tests)", () => {
  let tmp: string;
  let fakeRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-guard-"));
    fakeRoot = path.join(tmp, "project");
    fs.mkdirSync(path.join(fakeRoot, "data"), { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const check = (dbPath: string, root = fakeRoot, env: Record<string, string> = TEST_ENV) => () =>
    assertDatabaseIsolation({ env, root, dbPath });

  it("allows a file inside the system temp directory", () => {
    expect(check(path.join(tmp, "test.db"))).not.toThrow();
    expect(check(path.join(tmp, "not", "yet", "created.db"))).not.toThrow();
  });

  it("refuses the real database of the actual project (default path)", () => {
    expect(check(realDatabasePath(PROJECT), PROJECT)).toThrow(/never use the real database/);
  });

  it("refuses the real database even when it lies inside the temp directory", () => {
    expect(check(realDatabasePath(fakeRoot))).toThrow(DatabaseIsolationError);
  });

  it.skipIf(checkoutInTempDir(PROJECT))("refuses a path outside the temp directory", () => {
    expect(check(path.join(PROJECT, "test-results", "x.db"), PROJECT)).toThrow(/inside the system temp directory/);
  });

  it("refuses the temp directory itself and paths escaping it with ..", () => {
    expect(check(os.tmpdir())).toThrow(DatabaseIsolationError);
    expect(check(path.join(tmp, "..", "..", "..", "escape.db"))).toThrow(DatabaseIsolationError);
  });

  it("refuses a symlink in the temp directory that points to the real database, without following it", () => {
    const real = realDatabasePath(fakeRoot);
    fs.writeFileSync(real, "");
    const link = path.join(tmp, "link.db");
    fs.symlinkSync(real, link);
    expect(check(link)).toThrow(/must not be symbolic links/);
    // Any symlink is refused, even a dangling one or one to an ordinary temp file.
    const other = path.join(tmp, "other.db");
    fs.writeFileSync(other, "");
    fs.symlinkSync(other, path.join(tmp, "link2.db"));
    expect(check(path.join(tmp, "link2.db"))).toThrow(/must not be symbolic links/);
    fs.symlinkSync(path.join(tmp, "missing.db"), path.join(tmp, "dangling.db"));
    expect(check(path.join(tmp, "dangling.db"))).toThrow(/must not be symbolic links/);
  });

  it("refuses a hard link to the real database (any file with more than one link)", () => {
    const real = realDatabasePath(fakeRoot);
    fs.writeFileSync(real, "");
    const hard = path.join(tmp, "hard.db");
    fs.linkSync(real, hard);
    expect(check(hard)).toThrow(/must not be hard links/);
  });

  it("refuses the real database reached through a symlinked directory", () => {
    const real = realDatabasePath(fakeRoot);
    fs.writeFileSync(real, "");
    const dirLink = path.join(tmp, "dir-link");
    fs.symlinkSync(path.dirname(real), dirLink);
    expect(check(path.join(dirLink, path.basename(real)))).toThrow(/never use the real database/);
  });

  it("never touches the real database, its sidecars, lock, backups or manifest (string comparison first)", () => {
    const real = realDatabasePath(PROJECT);
    const dataDir = path.dirname(real);
    const calls: string[] = [];
    const record = (name: "existsSync" | "lstatSync" | "statSync" | "realpathSync" | "openSync" | "accessSync" | "readFileSync") => {
      const original = fs[name] as (...a: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
        calls.push(String(a[0]));
        return original.apply(fs, a);
      }) as never);
    };
    for (const name of ["existsSync", "lstatSync", "statSync", "realpathSync", "openSync", "accessSync", "readFileSync"] as const) record(name);
    expect(check(real, PROJECT)).toThrow(/never use the real database/);
    expect(check(`${real}/../${path.basename(real)}`, PROJECT)).toThrow(/never use the real database/);
    expect(check(path.join(tmp, "ok.db"), PROJECT)).not.toThrow();
    if (!checkoutInTempDir(PROJECT)) expect(check(path.join(PROJECT, "test-results", "x.db"), PROJECT)).toThrow(/inside the system temp directory/);
    vi.restoreAllMocks();
    expect(calls.length).toBeGreaterThan(0); // the spies saw the candidate checks
    const touched = calls.filter((c) => c.startsWith(real) || c.startsWith(path.join(dataDir, "backups")) || /manifest/i.test(c));
    expect(touched).toEqual([]);
  });

  describe("case and Unicode variants (decoy project roots only)", () => {
    // macOS file systems ignore case and Unicode normalisation, so each of these names
    // the decoy's real database; realpath keeps the spelling it is given.
    const variants = (root: string): [string, string][] => {
      const parent = path.dirname(root);
      const name = path.basename(root);
      return [
        ["project directory upper case", path.join(parent, name.toUpperCase(), "data", "threadatlas.db")],
        ["data directory upper case", path.join(root, "DATA", "threadatlas.db")],
        ["file name upper case", path.join(root, "data", "THREADATLAS.DB")],
        ["file name mixed case", path.join(root, "data", "ThreadAtlas.db")],
        ["everything upper case", path.join(parent, name.toUpperCase(), "DATA", "THREADATLAS.DB")],
        ["long s (ſ) in the file name", path.join(root, "data", "threadatlaſ.db")],
        ["redundant segments", path.join(root, "Data", ".", "..", "data", "threadatlas.db")],
      ];
    };
    const spyFs = () => {
      const calls: string[] = [];
      for (const name of ["existsSync", "lstatSync", "statSync", "realpathSync", "openSync", "accessSync", "readFileSync", "readdirSync"] as const) {
        const original = fs[name] as (...a: unknown[]) => unknown;
        vi.spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
          calls.push(String(a[0]));
          return original.apply(fs, a);
        }) as never);
      }
      return calls;
    };

    it.each([true, false])("refuses every variant of the decoy's database before any filesystem call (file exists: %s)", (exists) => {
      if (exists) fs.writeFileSync(realDatabasePath(fakeRoot), "DECOY");
      for (const [label, p] of variants(fakeRoot)) {
        const calls = spyFs();
        expect(check(p), label).toThrow(/never use the real database/);
        vi.restoreAllMocks();
        expect(calls, label).toEqual([]);
      }
    });

    it("refuses Unicode normalisation variants of a decoy root with accented letters", () => {
      const nfc = path.join(tmp, "prøjéct");
      const nfd = path.join(tmp, "prøjéct");
      fs.mkdirSync(path.join(nfc, "data"), { recursive: true });
      for (const [root, p] of [
        [nfc, path.join(nfd, "data", "threadatlas.db")],
        [nfd, path.join(nfc, "data", "threadatlas.db")],
        [nfc, path.join(nfd.toUpperCase(), "DATA", "threadatlas.db")],
      ] as const) {
        const calls = spyFs();
        expect(check(p, root)).toThrow(/never use the real database/);
        vi.restoreAllMocks();
        expect(calls).toEqual([]);
      }
    });

    it("refuses the decoy's lock, sidecars, backups and manifest in any spelling, before any filesystem call", () => {
      const data = path.join(fakeRoot, "data");
      fs.mkdirSync(path.join(data, "backups"));
      for (const p of [
        `${realDatabasePath(fakeRoot)}.lock`,
        `${realDatabasePath(fakeRoot)}-journal`,
        path.join(path.dirname(fakeRoot), path.basename(fakeRoot).toUpperCase(), "DATA", "THREADATLAS.DB-WAL"),
        path.join(data, "backups", "copy.db"),
        path.join(fakeRoot, "Data", "Backups", "copy.db.manifest.json"),
        path.join(data, "models", "x.db"),
        data,
      ]) {
        const calls = spyFs();
        expect(check(p), p).toThrow(/never use the real data directory/);
        vi.restoreAllMocks();
        expect(calls, p).toEqual([]);
      }
    });

    it("refuses a case variant of the decoy's database reached through a symlinked directory", () => {
      fs.writeFileSync(realDatabasePath(fakeRoot), "DECOY");
      const dirLink = path.join(tmp, "dir-link");
      fs.symlinkSync(path.join(fakeRoot, "data"), dirLink);
      expect(check(path.join(dirLink, "THREADATLAS.DB"))).toThrow(/never use the real database/);
      expect(check(path.join(dirLink, "backups", "copy.db"))).toThrow(/never use the real data directory/);
    });

    it("still refuses symlinks and hard links whose names differ only in case", () => {
      fs.writeFileSync(realDatabasePath(fakeRoot), "DECOY");
      fs.symlinkSync(realDatabasePath(fakeRoot), path.join(tmp, "LINK.DB"));
      expect(check(path.join(tmp, "LINK.DB"))).toThrow(/must not be symbolic links/);
      fs.linkSync(realDatabasePath(fakeRoot), path.join(tmp, "HARD.DB"));
      expect(check(path.join(tmp, "HARD.DB"))).toThrow(/must not be hard links/);
    });

    it("still allows ordinary temp databases, whatever their case", () => {
      expect(check(path.join(tmp, "Test.DB"))).not.toThrow();
      expect(check(path.join(tmp, "DATA", "threadatlas.db"))).not.toThrow(); // not the decoy's data directory
    });
  });

  it("fails closed when the temp directory cannot be resolved", () => {
    vi.spyOn(os, "tmpdir").mockReturnValue(path.join(tmp, "does-not-exist"));
    expect(check(path.join(tmp, "test.db"))).toThrow(/Cannot verify/);
  });

  it("does nothing outside tests", () => {
    expect(check(realDatabasePath(PROJECT), PROJECT, {})).not.toThrow();
  });

  it("never creates the database or its directory", () => {
    const target = path.join(tmp, "new-dir", "new.db");
    check(target)();
    check(realDatabasePath(PROJECT), PROJECT, {})();
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });
});
