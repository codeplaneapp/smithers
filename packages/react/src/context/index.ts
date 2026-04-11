import React from "react";
import type { z } from "zod";
import type { OutputKey } from "../OutputKey";
import type { RunAuthContext } from "../RunAuthContext";
import type { SmithersCtx } from "../SmithersCtx";
import { SmithersError } from "../errors";

export type OutputSnapshot = {
  [tableName: string]: Array<any>;
};

export type SmithersRuntimeConfig = {
  cliAgentToolsDefault?: "all" | "explicit-only";
};

export const SmithersContext = React.createContext<SmithersCtx<any> | null>(null);
SmithersContext.displayName = "SmithersContext";

function normalizeInputRow(input: any) {
  if (!input || typeof input !== "object") return input;
  if (!("payload" in input)) return input;
  const keys = Object.keys(input);
  const payloadOnly = keys.every((key) => key === "runId" || key === "payload");
  if (!payloadOnly) return input;
  const payload = input.payload;
  if (payload == null) return {};
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

function buildCurrentScopes(iterations?: Record<string, number>): Set<string> {
  const scopes = new Set<string>();
  if (!iterations) return scopes;

  const unscopedIters: Record<string, number> = {};
  for (const [ralphId, iter] of Object.entries(iterations)) {
    if (!ralphId.includes("@@")) {
      unscopedIters[ralphId] = iter;
    }
  }

  for (const ralphId of Object.keys(iterations)) {
    const atIdx = ralphId.indexOf("@@");
    if (atIdx < 0) continue;
    const suffix = ralphId.slice(atIdx + 2);
    const rebuiltParts: string[] = [];
    for (const part of suffix.split(",")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) continue;
      const ancestorId = part.slice(0, eqIdx);
      const currentIter = unscopedIters[ancestorId];
      rebuiltParts.push(
        currentIter === undefined ? part : `${ancestorId}=${currentIter}`,
      );
    }
    if (rebuiltParts.length > 0) {
      scopes.add("@@" + rebuiltParts.join(","));
    }
  }

  return scopes;
}

function withLogicalIterationShortcuts(
  iterations?: Record<string, number>,
): Record<string, number> | undefined {
  if (!iterations) return iterations;
  const normalized: Record<string, number> = { ...iterations };
  const logicalIdsWithScope = new Set<string>();

  for (const id of Object.keys(iterations)) {
    const atIdx = id.indexOf("@@");
    if (atIdx >= 0) {
      logicalIdsWithScope.add(id.slice(0, atIdx));
    }
  }

  for (const logicalId of logicalIdsWithScope) {
    normalized[logicalId] = 0;
  }

  for (const [id, iter] of Object.entries(iterations)) {
    const atIdx = id.indexOf("@@");
    if (atIdx < 0) continue;
    const logicalId = id.slice(0, atIdx);
    const scopeSuffix = id.slice(atIdx + 2);
    let isCurrentScope = true;

    for (const part of scopeSuffix.split(",")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) {
        isCurrentScope = false;
        break;
      }
      const ancestorId = part.slice(0, eqIdx);
      const ancestorIter = Number(part.slice(eqIdx + 1));
      if (normalized[ancestorId] !== ancestorIter) {
        isCurrentScope = false;
        break;
      }
    }

    if (isCurrentScope) {
      normalized[logicalId] = iter;
    }
  }

  return normalized;
}

function filterRowsByNodeId(
  rows: any[],
  lookupNodeId: string,
  currentScopes: Set<string>,
): any[] {
  const exact = rows.filter((row) => row.nodeId === lookupNodeId);
  if (exact.length > 0 || lookupNodeId.includes("@@")) return exact;

  const sortedScopes = [...currentScopes].sort((a, b) => b.length - a.length);
  for (const scope of sortedScopes) {
    const scopedId = lookupNodeId + scope;
    const matched = rows.filter((row) => row.nodeId === scopedId);
    if (matched.length > 0) return matched;
  }

  return [];
}

function resolveDrizzleName(table: any): string | undefined {
  if (!table || typeof table !== "object") return undefined;
  const tableMeta = table._;
  if (tableMeta && typeof tableMeta === "object" && typeof tableMeta.name === "string") {
    return tableMeta.name;
  }
  if (typeof table.name === "string") return table.name;
  return undefined;
}

export function buildContext<Schema>(opts: {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: unknown;
  auth?: RunAuthContext | null;
  outputs: OutputSnapshot;
  zodToKeyName?: Map<any, string>;
  runtimeConfig?: SmithersRuntimeConfig;
}): SmithersCtx<Schema> {
  const {
    runId,
    iteration,
    iterations,
    input,
    auth,
    outputs,
    zodToKeyName,
    runtimeConfig,
  } = opts;
  const normalizedInput = normalizeInputRow(input);
  const normalizedIterations = withLogicalIterationShortcuts(iterations);
  const currentScopes = buildCurrentScopes(normalizedIterations);

  const outputsFn: any = (table: string) => outputs[table] ?? [];
  for (const [name, rows] of Object.entries(outputs)) {
    outputsFn[name] = rows;
  }

  function resolveTableName(table: any): string {
    if (typeof table === "string") return table;
    const zodKey = zodToKeyName?.get(table);
    if (zodKey) return zodKey;
    return resolveDrizzleName(table) ?? String(table);
  }

  function resolveRow(table: any, key: OutputKey): any | undefined {
    const tableName = resolveTableName(table);
    const rows = outputs[tableName] ?? [];
    const matching = filterRowsByNodeId(rows, key.nodeId, currentScopes);
    return matching.find((row) => {
      return (row.iteration ?? 0) === (key.iteration ?? iteration);
    });
  }

  return {
    runId,
    iteration,
    iterations: normalizedIterations,
    input: normalizedInput,
    auth: auth ?? null,
    __smithersRuntime: runtimeConfig ?? null,
    outputs: outputsFn,
    output(table: any, key: OutputKey): any {
      const row = resolveRow(table, key);
      if (!row) {
        throw new SmithersError(
          "MISSING_OUTPUT",
          `Missing output for nodeId=${key.nodeId} iteration=${key.iteration ?? 0}`,
          { nodeId: key.nodeId, iteration: key.iteration ?? 0 },
        );
      }
      return row;
    },
    outputMaybe(table: any, key: OutputKey): any {
      return resolveRow(table, key);
    },
    latest(table: any, nodeId: string): any {
      const tableName = resolveTableName(table);
      const rows = outputs[tableName] ?? [];
      const matching = filterRowsByNodeId(rows, nodeId, currentScopes);
      let best: any = undefined;
      let bestIteration = -Infinity;
      for (const row of matching) {
        const iter = Number.isFinite(Number(row.iteration))
          ? Number(row.iteration)
          : 0;
        if (!best || iter >= bestIteration) {
          best = row;
          bestIteration = iter;
        }
      }
      return best;
    },
    latestArray(value: unknown, schema: z.ZodType): unknown[] {
      if (value == null) return [];
      let arr: unknown[];
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          arr = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      } else {
        arr = Array.isArray(value) ? value : [value];
      }
      return arr.flatMap((item) => {
        const parsed = schema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
    },
    iterationCount(table: any, nodeId: string): number {
      const tableName = resolveTableName(table);
      const rows = outputs[tableName] ?? [];
      const matching = filterRowsByNodeId(rows, nodeId, currentScopes);
      const seen = new Set<number>();
      for (const row of matching) {
        const iter = Number.isFinite(Number(row.iteration))
          ? Number(row.iteration)
          : 0;
        seen.add(iter);
      }
      return seen.size;
    },
  };
}

export function createSmithersContext<Schema>() {
  const Context = React.createContext<SmithersCtx<Schema> | null>(null);
  Context.displayName = "SmithersContext";

  function useCtx(): SmithersCtx<Schema> {
    const ctx = React.useContext(Context);
    if (!ctx) {
      throw new SmithersError(
        "CONTEXT_OUTSIDE_WORKFLOW",
        "useCtx() must be called inside a Smithers workflow context.",
      );
    }
    return ctx;
  }

  return { SmithersContext: Context, useCtx };
}
