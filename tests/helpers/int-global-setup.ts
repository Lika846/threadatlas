import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { migrateTestDatabase } from "./migrate";

declare module "vitest" {
  export interface ProvidedContext {
    /** Migrated template database inside a private temp directory. */
    templateDb: string;
  }
}

/**
 * Integration tests (A41): migrate one template database in a fresh temp
 * directory (mode 0700), hand its path to the test files, and delete the
 * whole directory afterwards.
 */
export default function setup(project: TestProject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threadatlas-int-"));
  const templateDb = path.join(dir, "template.db");
  migrateTestDatabase(templateDb);
  project.provide("templateDb", templateDb);
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
