import { afterEach, describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { QueryClient } from "@tanstack/react-query";
import { createSmithersPostgres } from "smithers-orchestrator";

import {
  createSmithersCollections,
  docsShapeWhere,
  ticketsShapeWhere,
} from "../../src/data/createSmithersCollections.ts";
import type { SmithersCollections } from "../../src/data/SmithersCollections.ts";
import { smithersLocalCollectionOptions } from "../../src/data/smithersLocalCollectionOptions.ts";

/**
 * Multiplayer docs/tickets collections compile their request filters into
 * Electric predicates over `_smithers_docs`. These tests prove PARITY with the
 * RPC contract (`listDocs` / `listTickets`) by evaluating the compiled
 * predicate against a REAL Postgres (pglite) `_smithers_docs` table seeded
 * through the real db adapter, and by asserting the predicates are wired into
 * the Electric shape config (tombstones hidden, omitted ticket kind NOT forced
 * to `ticket`, and `limit` falling back to the RPC-backed query collection).
 */

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

type PgConnection = { query: (query: { text: string; values?: unknown[] }) => Promise<{ rows: Record<string, unknown>[] }> };

/** Evaluate a compiled Electric predicate against the real `_smithers_docs` table. */
async function shapePaths(connection: PgConnection, where: string | undefined): Promise<string[]> {
  const text = where
    ? `SELECT path FROM _smithers_docs WHERE ${where}`
    : "SELECT path FROM _smithers_docs";
  const result = await connection.query({ text });
  return result.rows.map((row) => String(row.path)).sort();
}

function rpcPaths(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) => String(row.path)).sort();
}

describe("multiplayer docs/tickets predicate parity (real pglite)", () => {
  test("docsShapeWhere and ticketsShapeWhere select the same rows as the RPC reads", async () => {
    const api = await createSmithersPostgres({}, { provider: "pglite" });
    cleanups.push(() => api.close());
    const adapter = new SmithersDb(api.db);
    const connection = (api.db as unknown as { connection: PgConnection }).connection;
    const now = 1_718_000_000_000;

    const seed = [
      { path: "tickets/live-a.md", kind: "ticket", updatedAtMs: now + 10, deletedAtMs: null },
      { path: "tickets/live-b.md", kind: "ticket", updatedAtMs: now + 400, deletedAtMs: null },
      { path: "plans/live.md", kind: "plan", updatedAtMs: now + 20, deletedAtMs: null },
      { path: "specs/live.md", kind: "spec", updatedAtMs: now + 30, deletedAtMs: null },
      { path: "docs/live.md", kind: "doc", updatedAtMs: now + 5, deletedAtMs: null },
      { path: "docs/old.md", kind: "doc", updatedAtMs: now - 100, deletedAtMs: null },
      { path: "tickets/tombstone.md", kind: "ticket", updatedAtMs: now + 50, deletedAtMs: now + 50 },
      { path: "plans/tombstone.md", kind: "plan", updatedAtMs: now + 60, deletedAtMs: now + 60 },
    ];
    for (const row of seed) {
      await adapter.upsertDoc({
        path: row.path,
        kind: row.kind,
        content: `content of ${row.path}`,
        contentHash: `hash-${row.path}`,
        status: "open",
        updatedAtMs: row.updatedAtMs,
        deletedAtMs: row.deletedAtMs,
      });
    }

    // Docs parity: every documented `listDocs` filter combination selects the
    // SAME rows via the compiled Electric predicate as via the adapter read
    // that backs the RPC (kind, includeDeleted, updatedAfterMs, and defaults).
    const docFilters: Array<{ kind?: string; includeDeleted?: boolean; updatedAfterMs?: number }> = [
      {},
      { kind: "ticket" },
      { kind: "doc" },
      { includeDeleted: true },
      { includeDeleted: true, kind: "plan" },
      { updatedAfterMs: now },
      { kind: "ticket", updatedAfterMs: now + 15 },
      { includeDeleted: true, updatedAfterMs: now + 45 },
    ];
    for (const filter of docFilters) {
      expect(await shapePaths(connection, docsShapeWhere(filter)))
        .toEqual(rpcPaths(await adapter.listDocs(filter)));
    }

    // The default docs predicate hides tombstones even with no filter at all.
    const defaultDocs = await shapePaths(connection, docsShapeWhere({}));
    expect(defaultDocs).not.toContain("tickets/tombstone.md");
    expect(defaultDocs).not.toContain("plans/tombstone.md");

    // Tickets without kind include EVERY live document kind (previously the
    // shape forced an omitted kind to `ticket`).
    const allTickets = await shapePaths(connection, ticketsShapeWhere(undefined));
    expect(allTickets).toEqual(rpcPaths(await adapter.listDocs(null)));
    expect(allTickets).toContain("plans/live.md");
    expect(allTickets).toContain("specs/live.md");
    expect(allTickets).toContain("docs/live.md");
    expect(allTickets).not.toContain("tickets/tombstone.md");
    expect(allTickets).not.toContain("plans/tombstone.md");

    // An explicit kind restricts results to live rows of that kind.
    const ticketOnly = await shapePaths(connection, ticketsShapeWhere("ticket"));
    expect(ticketOnly).toEqual(rpcPaths(await adapter.listDocs("ticket")));
    expect(ticketOnly).toEqual(["tickets/live-a.md", "tickets/live-b.md"]);
    expect(await shapePaths(connection, ticketsShapeWhere("plan"))).toEqual(["plans/live.md"]);

    // Tombstone regression: soft-deleting a previously-live ticket drops it
    // from both the RPC read and the compiled shape predicate.
    await adapter.softDeleteDoc("tickets/live-b.md", now + 500);
    expect(rpcPaths(await adapter.listDocs("ticket"))).toEqual(["tickets/live-a.md"]);
    expect(await shapePaths(connection, ticketsShapeWhere("ticket"))).toEqual(["tickets/live-a.md"]);
    expect(await shapePaths(connection, ticketsShapeWhere(undefined))).not.toContain("tickets/live-b.md");
  }, 120_000);
});

describe("docsShapeWhere / ticketsShapeWhere compilation", () => {
  test("compiles the documented listDocs filters into validated predicates", () => {
    expect(docsShapeWhere()).toBe("deleted_at_ms IS NULL");
    expect(docsShapeWhere({})).toBe("deleted_at_ms IS NULL");
    expect(docsShapeWhere({ kind: "doc" })).toBe("deleted_at_ms IS NULL AND kind = 'doc'");
    expect(docsShapeWhere({ includeDeleted: true })).toBeUndefined();
    expect(docsShapeWhere({ includeDeleted: true, kind: "plan" })).toBe("kind = 'plan'");
    expect(docsShapeWhere({ updatedAfterMs: 100.9 })).toBe("deleted_at_ms IS NULL AND updated_at_ms > 100");
    expect(docsShapeWhere({ kind: "doc", updatedAfterMs: 5, includeDeleted: true })).toBe("kind = 'doc' AND updated_at_ms > 5");
    // Non-finite updatedAfterMs is ignored, matching the adapter's validation.
    expect(docsShapeWhere({ updatedAfterMs: Number.NaN })).toBe("deleted_at_ms IS NULL");
    expect(docsShapeWhere({ updatedAfterMs: Number.POSITIVE_INFINITY })).toBe("deleted_at_ms IS NULL");
    // Kind literals are SQL-escaped.
    expect(docsShapeWhere({ kind: "it's" })).toBe("deleted_at_ms IS NULL AND kind = 'it''s'");
  });

  test("tickets always enforce live rows; omitted kind stays unrestricted", () => {
    expect(ticketsShapeWhere(undefined)).toBe("deleted_at_ms IS NULL");
    expect(ticketsShapeWhere("ticket")).toBe("deleted_at_ms IS NULL AND kind = 'ticket'");
    expect(ticketsShapeWhere("plan")).toBe("deleted_at_ms IS NULL AND kind = 'plan'");
  });
});

describe("multiplayer docs/tickets Electric wiring", () => {
  const multiplayerMode = {
    kind: "multiplayer" as const,
    apiBaseUrl: "http://127.0.0.1:65535/",
    electricBaseUrl: "http://127.0.0.1:65534",
    workspaceId: "workspace-docs-parity",
    token: "mp-token",
  };

  test("compiled predicates reach the Electric shape config and limit falls back to the query collection", async () => {
    const queryClient = new QueryClient();
    const configs: Array<{ shape: string; where: string | undefined }> = [];
    // A stand-in electricCollectionOptions (same injectable seam the coverage
    // test uses) that records the shape + where each factory hands to Electric,
    // then returns a real query-backed config so createCollection accepts it.
    const fakeElectric = Object.assign(
      (config: Record<string, unknown>) => {
        configs.push({ shape: config.shape as string, where: config.where as string | undefined });
        return smithersLocalCollectionOptions({
          id: config.id as string,
          queryKey: [config.id as string],
          queryClient,
          queryFn: async () => [],
          getKey: config.getKey as never,
        });
      },
      { load: async () => {} },
    );

    const collections = await (createSmithersCollections as unknown as (
      mode: typeof multiplayerMode,
      qc: QueryClient,
      load: () => Promise<typeof fakeElectric>,
    ) => Promise<SmithersCollections>)(
      multiplayerMode,
      queryClient,
      async () => fakeElectric,
    );
    cleanups.push(() => {
      collections.close();
      queryClient.clear();
    });

    collections.docs();
    expect(configs.at(-1)).toEqual({ shape: "docs", where: "deleted_at_ms IS NULL" });

    collections.docs({ filter: { kind: "doc", updatedAfterMs: 100 } });
    expect(configs.at(-1)).toEqual({ shape: "docs", where: "deleted_at_ms IS NULL AND kind = 'doc' AND updated_at_ms > 100" });

    collections.docs({ filter: { includeDeleted: true } });
    expect(configs.at(-1)).toEqual({ shape: "docs", where: undefined });

    // Electric cannot express LIMIT: a limited request must NOT build an
    // Electric shape and instead falls back to the RPC-backed query collection.
    const before = configs.length;
    const limited = collections.docs({ filter: { limit: 5 } });
    expect(configs.length).toBe(before);
    expect(limited.id).toContain("docs");

    collections.tickets();
    expect(configs.at(-1)).toEqual({ shape: "docs", where: "deleted_at_ms IS NULL" });

    collections.tickets({ kind: "plan" });
    expect(configs.at(-1)).toEqual({ shape: "docs", where: "deleted_at_ms IS NULL AND kind = 'plan'" });
  });
});
