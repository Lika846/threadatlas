import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { expect } from "@playwright/test";

/**
 * Seeding and inspecting the run's temporary e2e database (never the real
 * one: playwright.config.ts creates it in the system temp directory).
 * Imports go through the real `POST /api/import` route.
 */

export const E2E_DB = path.join(process.env.THREADATLAS_E2E_DIR!, "e2e.db");

/** Imports export text through the route, as the import page does. */
export async function importViaRoute(baseURL: string, text: string): Promise<{ ok: boolean; batch?: { status: string; counts: Record<string, number> } }> {
  const u = new URL(baseURL);
  const body = Buffer.from(text);
  const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: "/api/import",
        method: "POST",
        agent: false,
        headers: { origin: u.origin, "x-threadatlas-import": "1", "content-type": "application/json", "content-length": String(body.length) },
      },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c: string) => (data += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  expect(res.status, res.body.slice(0, 200)).toBe(200);
  return JSON.parse(res.body) as { ok: boolean };
}

/** Internal Conversation.id for a source ID (read-only access to the e2e database). */
export function internalId(sourceId: string): string {
  const d = new Database(E2E_DB, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    const row = d.prepare('SELECT "id" FROM "Conversation" WHERE "sourceId" = ?').get(sourceId) as { id: string } | undefined;
    if (!row) throw new Error("conversation not found in the e2e database");
    return row.id;
  } finally {
    d.close();
  }
}

/** Row counts of the imported-data tables (read-only access to the e2e database). */
export function tableCounts(): { conversations: number; messages: number; imports: number } {
  const d = new Database(E2E_DB, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    const n = (table: string) => (d.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    return { conversations: n("Conversation"), messages: n("Message"), imports: n("ImportBatch") };
  } finally {
    d.close();
  }
}
