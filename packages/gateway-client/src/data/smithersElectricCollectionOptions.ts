import {
  smithersElectricShapeCatalog,
  type SmithersElectricShapeDefinition,
} from "@smithers-orchestrator/electric-proxy/smithersElectricShapeCatalog";
import type { CollectionConfig } from "@tanstack/db";
import type { WorkspaceMode } from "./WorkspaceMode.ts";

type ElectricCollectionOptionsLoader = <TRow extends Record<string, unknown>>(
  config: Record<string, unknown>,
) => CollectionConfig<TRow, string | number>;

type ElectricMutationHandlers<TRow extends object, TKey extends string | number> = {
  onInsert?: (params: { transaction: { mutations: Array<{ key: TKey; modified: TRow; original?: TRow }> } }) => Promise<unknown>;
  onUpdate?: (params: { transaction: { mutations: Array<{ key: TKey; modified: TRow; original: TRow; changes?: Partial<TRow> }> } }) => Promise<unknown>;
  onDelete?: (params: { transaction: { mutations: Array<{ key: TKey; original: TRow }> } }) => Promise<unknown>;
};

let cachedElectricCollectionOptions: ElectricCollectionOptionsLoader | undefined;

function runtimeRequire(): ((id: string) => unknown) | undefined {
  const importMetaRequire = (import.meta as ImportMeta & { require?: (id: string) => unknown }).require;
  if (typeof importMetaRequire === "function") return importMetaRequire;
  const globalRequire = (globalThis as typeof globalThis & { require?: (id: string) => unknown }).require;
  if (typeof globalRequire === "function") return globalRequire;
  try {
    const evaluated = (0, eval)("typeof require === 'function' ? require : undefined") as unknown;
    return typeof evaluated === "function" ? evaluated as (id: string) => unknown : undefined;
  } catch {
    return undefined;
  }
}

function loadElectricCollectionOptions(): ElectricCollectionOptionsLoader {
  if (cachedElectricCollectionOptions) return cachedElectricCollectionOptions;
  const maybeRequire = runtimeRequire();
  if (typeof maybeRequire !== "function") {
    throw new Error("Smithers multiplayer collections require a bundler/runtime that can load @tanstack/electric-db-collection.");
  }
  const mod = maybeRequire("@tanstack/electric-db-collection") as {
    electricCollectionOptions?: ElectricCollectionOptionsLoader;
  };
  if (typeof mod.electricCollectionOptions !== "function") {
    throw new Error("@tanstack/electric-db-collection did not export electricCollectionOptions.");
  }
  cachedElectricCollectionOptions = mod.electricCollectionOptions;
  return cachedElectricCollectionOptions;
}

function shapeByName(name: string): SmithersElectricShapeDefinition {
  const shape = smithersElectricShapeCatalog.find((entry) => entry.name === name);
  if (!shape) throw new Error(`Smithers Electric shape not found: ${name}`);
  return shape;
}

function electricUrl(baseUrl: string): string {
  return new URL("/v1/shape", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function authHeaders(token: string | undefined): Record<string, string> | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

export function smithersElectricCollectionOptions<
  TRow extends Record<string, unknown>,
  TKey extends string | number = string | number,
>(
  config: {
    id: string;
    mode: Extract<WorkspaceMode, { kind: "multiplayer" }>;
    shape: string;
    getKey: (row: TRow) => TKey;
    mapRow: (row: Record<string, unknown>) => TRow;
    where?: string;
  } & ElectricMutationHandlers<TRow, TKey>,
): CollectionConfig<TRow, TKey> {
  const shape = shapeByName(config.shape);
  const params: Record<string, string> = {
    table: shape.table,
    shape: shape.name,
  };
  if (config.where) params.where = config.where;
  const options = loadElectricCollectionOptions();
  return options<TRow>({
    id: config.id,
    getKey: config.getKey,
    shapeOptions: {
      url: electricUrl(config.mode.electricBaseUrl),
      params,
      headers: authHeaders(config.mode.token),
      liveSse: true,
      transformer: (row: Record<string, unknown>) => config.mapRow(row),
    },
    onInsert: config.onInsert,
    onUpdate: config.onUpdate,
    onDelete: config.onDelete,
  } as Record<string, unknown>) as unknown as CollectionConfig<TRow, TKey>;
}
