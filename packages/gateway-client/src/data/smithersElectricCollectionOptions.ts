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
  onInsert?: (params: {
    transaction: { mutations: Array<{ key: TKey; modified: TRow; original?: TRow }> };
  }) => Promise<unknown>;
  onUpdate?: (params: {
    transaction: { mutations: Array<{ key: TKey; modified: TRow; original: TRow; changes?: Partial<TRow> }> };
  }) => Promise<unknown>;
  onDelete?: (params: { transaction: { mutations: Array<{ key: TKey; original: TRow }> } }) => Promise<unknown>;
};

let cachedElectricCollectionOptions: ElectricCollectionOptionsLoader | undefined;
let cachedElectricCollectionOptionsPromise: Promise<ElectricCollectionOptionsLoader> | undefined;

async function resolveElectricCollectionOptions(
  importer: () => Promise<unknown>,
): Promise<ElectricCollectionOptionsLoader> {
  const mod = await importer();
  const options = (mod as { electricCollectionOptions?: unknown }).electricCollectionOptions;
  if (typeof options !== "function") {
    throw new Error("@tanstack/electric-db-collection did not export electricCollectionOptions.");
  }
  return options as ElectricCollectionOptionsLoader;
}

// `importer` is an injectable seam used only by tests to drive the "dependency
// did not export electricCollectionOptions" failure path deterministically; it
// bypasses the shared module cache so it can never poison the real loader.
async function loadElectricCollectionOptions(
  importer?: () => Promise<unknown>,
): Promise<ElectricCollectionOptionsLoader> {
  if (importer) return resolveElectricCollectionOptions(importer);
  if (cachedElectricCollectionOptions) return cachedElectricCollectionOptions;
  cachedElectricCollectionOptionsPromise ??= resolveElectricCollectionOptions(
    () => import("@tanstack/electric-db-collection"),
  ).then((options) => {
    cachedElectricCollectionOptions = options;
    return options;
  });
  return cachedElectricCollectionOptionsPromise;
}

function loadedElectricCollectionOptions(): ElectricCollectionOptionsLoader {
  if (!cachedElectricCollectionOptions) {
    throw new Error(
      "Smithers multiplayer collections must preload @tanstack/electric-db-collection before creating collections.",
    );
  }
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

function createSmithersElectricCollectionOptions<
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
  const options = loadedElectricCollectionOptions();
  return options<TRow>({
    id: config.id,
    getKey: config.getKey,
    shapeOptions: {
      url: electricUrl(config.mode.electricBaseUrl),
      params,
      headers: authHeaders(config.mode.token),
      liveSse: true,
      transformer: config.mapRow,
    },
    onInsert: config.onInsert,
    onUpdate: config.onUpdate,
    onDelete: config.onDelete,
  } as Record<string, unknown>) as unknown as CollectionConfig<TRow, TKey>;
}

export const smithersElectricCollectionOptions = Object.assign(createSmithersElectricCollectionOptions, {
  load: loadElectricCollectionOptions,
});
