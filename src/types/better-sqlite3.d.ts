/**
 * Minimal local typings for the parts of better-sqlite3 that ThreadAtlas uses
 * directly (the write lock; tests' direct database checks). better-sqlite3 is already a direct dependency
 * (via the Prisma adapter); `@types/better-sqlite3` is not installed, so this
 * declares only what is needed. `Options` is also what the Prisma adapter's
 * own typings import.
 */
declare module "better-sqlite3" {
  interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    /** Busy timeout in milliseconds (0 = fail immediately). */
    timeout?: number;
    nativeBinding?: string;
  }

  interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  }

  interface SqliteDatabase {
    exec(sql: string): this;
    prepare(sql: string): Statement;
    close(): this;
    /** Online backup with SQLite's backup API (the M5.1b migration rehearsal). */
    backup(destination: string): Promise<{ totalPages: number; remainingPages: number }>;
    readonly open: boolean;
    readonly inTransaction: boolean;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: Options): SqliteDatabase;
  }

  const Database: DatabaseConstructor;
  export default Database;
  export type { Options, SqliteDatabase, Statement };
}
