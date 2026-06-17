import { hasGatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";
import type { GatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";
import {
  createSmithersElectricProxyMetrics,
  type SmithersElectricProxyMetrics,
} from "./createSmithersElectricProxyMetrics.ts";
import {
  smithersElectricCatalogWithOutputTables,
  type SmithersElectricShapeDefinition,
} from "./smithersElectricShapeCatalog.ts";
import {
  emitSmithersElectricEvent,
  type SmithersElectricProxyObserver,
} from "./createSmithersElectricProxyObserver.ts";

export type SmithersElectricAuthContext = {
  principalId?: string;
  userId?: string;
  tokenId?: string;
  scopes: readonly string[];
  grantedRunIds?: readonly string[];
  grantedWorkspaceIds?: readonly string[];
  /**
   * Single-user local-cloud installs (one tenant, no per-run partitioning) can
   * opt OUT of run/workspace scoping by setting this. Absent or false, the
   * proxy fails CLOSED: a run/workspace-scoped shape with no concrete grant
   * array is rejected rather than forwarded unscoped. Cloud auth must derive
   * concrete grants and leave this unset.
   */
  unscoped?: boolean;
};

export type SmithersElectricScopeDecision = {
  event: "smithers-electric.scope";
  allowed: boolean;
  reason: string;
  table: string;
  shape: string;
  requiredScope: GatewayScope;
  principalId: string;
};

export type SmithersElectricProxyOptions = {
  electricUrl: string;
  authenticate: (request: Request) => Promise<SmithersElectricAuthContext | null> | SmithersElectricAuthContext | null;
  fetchClient?: typeof fetch;
  now?: () => number;
  rateLimits?: {
    openPerMinute?: number;
    activeMax?: number;
  };
  maxFrameBytes?: number;
  catalog?: readonly SmithersElectricShapeDefinition[];
  /**
   * Explicit allowlist of workflow output-table names that may be opened as
   * run-scoped shapes. Empty (the default) exposes NO output tables. Derive
   * this from the real output-table registry — never a regex catch-all.
   */
  outputTables?: readonly string[];
  /**
   * Reclaim an active-shape slot whose stream never started draining after this
   * many ms. Without it, a client that opens shapes but never reads or cancels
   * the body holds active slots forever and self-DoSes with permanent 429s.
   */
  activeTtlMs?: number;
  metrics?: SmithersElectricProxyMetrics;
  observer?: SmithersElectricProxyObserver;
  log?: (decision: SmithersElectricScopeDecision) => void;
};

export type SmithersElectricProxy = {
  fetch(request: Request): Promise<Response>;
  metrics: SmithersElectricProxyMetrics;
};

type ParsedWhere = {
  values: Map<string, string[]>;
  isNull: Set<string>;
};

type OpenBucket = {
  windowStartMs: number;
  count: number;
};

const DEFAULT_OPEN_PER_MINUTE = 60;
const DEFAULT_ACTIVE_MAX = 50;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_ACTIVE_TTL_MS = 5 * 60_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(status: number, payload: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

function principalId(auth: SmithersElectricAuthContext): string {
  return auth.principalId ?? auth.userId ?? auth.tokenId ?? "anonymous";
}

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function listLiteral(values: readonly string[]): string {
  return values.map(q).join(",");
}

function parseCsvList(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function hasDuplicateSecurityParam(params: URLSearchParams): string | null {
  for (const name of ["table", "shape", "where", "key"]) {
    if (params.getAll(name).length > 1) return name;
  }
  return null;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.toLowerCase();
}

function tokenizeWhere(where: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < where.length) {
    const ch = where[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && where[i + 1] === "-") {
      throw new Error("comments are not allowed in shape where clauses");
    }
    if (ch === "/" && where[i + 1] === "*") {
      throw new Error("comments are not allowed in shape where clauses");
    }
    if ("(),=".includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === "'" || ch === `"`) {
      const quote = ch;
      i += 1;
      let value = "";
      while (i < where.length && where[i] !== quote) {
        if (where[i] === "\\") throw new Error("backslash escapes are not allowed in shape where clauses");
        value += where[i];
        i += 1;
      }
      if (where[i] !== quote) throw new Error("unterminated string literal in shape where clause");
      i += 1;
      tokens.push(JSON.stringify(value));
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < where.length && /[A-Za-z0-9_]/.test(where[i])) i += 1;
      tokens.push(normalizeIdentifier(where.slice(start, i)));
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < where.length && /[0-9]/.test(where[i])) i += 1;
      tokens.push(where.slice(start, i));
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in shape where clause`);
  }
  return tokens;
}

function tokenValue(token: string): string {
  if (token.startsWith("\"")) return JSON.parse(token) as string;
  return token;
}

function parseWhere(where: string): ParsedWhere {
  const tokens = tokenizeWhere(where);
  const values = new Map<string, string[]>();
  const isNull = new Set<string>();
  let i = 0;
  const peek = () => tokens[i];
  const take = (expected?: string): string => {
    const token = tokens[i];
    if (token === undefined) throw new Error(`expected ${expected ?? "token"}, got end of where clause`);
    if (expected !== undefined && token !== expected) throw new Error(`expected ${expected}, got ${token}`);
    i += 1;
    return token;
  };
  const takeValue = () => {
    const token = take();
    if (["and", "or", "union", "select", "not", "in", "is", "null", "=", "(", ")", ","].includes(token)) {
      throw new Error(`expected literal value, got ${token}`);
    }
    return tokenValue(token);
  };

  while (i < tokens.length) {
    if (["or", "union", "select", "not"].includes(peek())) {
      throw new Error(`${peek().toUpperCase()} is not allowed in shape where clauses`);
    }
    const column = take();
    if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`invalid where column ${column}`);
    const op = take();
    if (op === "=") {
      values.set(column, [takeValue()]);
    } else if (op === "in") {
      take("(");
      const list: string[] = [];
      for (;;) {
        list.push(takeValue());
        if (peek() === ",") {
          take(",");
          continue;
        }
        break;
      }
      take(")");
      values.set(column, list);
    } else if (op === "is") {
      take("null");
      isNull.add(column);
    } else {
      throw new Error(`unsupported where operator ${op}`);
    }
    if (i >= tokens.length) break;
    take("and");
  }

  return { values, isNull };
}

function shapeForTable(
  catalog: readonly SmithersElectricShapeDefinition[],
  table: string,
  shapeName?: string | null,
): SmithersElectricShapeDefinition | undefined {
  if (shapeName) {
    return catalog.find((shape) => shape.name === shapeName && (shape.table === table || shape.table === "*" || table === ""));
  }
  return catalog.find((shape) => shape.table === table) ??
    catalog.find((shape) => shape.tablePattern?.test(table));
}

function fillWhereTemplate(
  shape: SmithersElectricShapeDefinition,
  auth: SmithersElectricAuthContext,
): string | null {
  if (!shape.whereTemplate) return null;
  let where = shape.whereTemplate;
  if (where.includes("{run_ids}")) {
    const runIds = auth.grantedRunIds ?? [];
    if (runIds.length === 0) return null;
    where = where.replaceAll("{run_ids}", listLiteral(runIds));
  }
  if (where.includes("{workspace_ids}")) {
    const workspaceIds = auth.grantedWorkspaceIds ?? [];
    if (workspaceIds.length === 0) return null;
    where = where.replaceAll("{workspace_ids}", listLiteral(workspaceIds));
  }
  if (where.includes("{user_id}")) {
    if (!auth.userId) return null;
    where = where.replaceAll("{user_id}", q(auth.userId));
  }
  return where;
}

function ensureValuesAllowed(
  column: string,
  requested: readonly string[],
  granted: readonly string[] | undefined,
  unscoped: boolean,
): void {
  // A single-user local-cloud install (no per-run partitioning) may opt out of
  // scoping entirely. Otherwise this column is a scoping boundary and an
  // undefined grant array means "no access derived" — FAIL CLOSED rather than
  // forwarding an arbitrary client-supplied predicate.
  if (unscoped) return;
  if (!granted) throw new Error(`${column} scoping grants are required`);
  if (requested.length === 0) throw new Error(`${column} predicate is required`);
  const allowed = new Set(granted.map(String));
  for (const value of requested) {
    if (!allowed.has(String(value))) {
      throw new Error(`${column} predicate includes an unauthorized value`);
    }
  }
}

function validateWhere(
  shape: SmithersElectricShapeDefinition,
  where: string | null,
  auth: SmithersElectricAuthContext,
): string | null {
  const unscoped = auth.unscoped === true;
  const effectiveWhere = where && where.trim() ? where.trim() : fillWhereTemplate(shape, auth);
  if (!effectiveWhere) {
    // No client where and the template could not be filled. For a scoped shape
    // that is only acceptable when the principal is explicitly unscoped; a
    // scoped principal with no concrete grants gets nothing.
    if ((shape.runIdColumn || shape.workspaceIdColumn || shape.userPrivateColumn) && !unscoped) {
      throw new Error("where clause cannot be filled from the authenticated grants");
    }
    return null;
  }

  const parsed = parseWhere(effectiveWhere);
  if (shape.runIdColumn) {
    ensureValuesAllowed(shape.runIdColumn, parsed.values.get(shape.runIdColumn) ?? [], auth.grantedRunIds, unscoped);
  }
  if (shape.workspaceIdColumn) {
    ensureValuesAllowed(shape.workspaceIdColumn, parsed.values.get(shape.workspaceIdColumn) ?? [], auth.grantedWorkspaceIds, unscoped);
  }
  if (shape.userPrivateColumn) {
    const claimed = parsed.values.get(shape.userPrivateColumn) ?? [];
    if (claimed.length !== 1 || !auth.userId || claimed[0] !== auth.userId) {
      throw new Error(`${shape.userPrivateColumn} predicate must match the authenticated user`);
    }
  }
  return effectiveWhere;
}

type ActiveSlot = {
  key: string;
  acquiredAtMs: number;
  /** Set true once the stream actually starts draining (first pull / cancel). */
  draining: boolean;
  released: boolean;
};

function rateLimiter(now: () => number, openPerMinute: number, activeMax: number, activeTtlMs: number) {
  const buckets = new Map<string, OpenBucket>();
  const active = new Map<string, Set<ActiveSlot>>();
  const windowMs = 60_000;

  // Reclaim slots whose stream never started draining within the TTL window. A
  // client that opens a shape but never reads or cancels the body would
  // otherwise pin a slot forever and eventually self-DoS with permanent 429s.
  const sweepExpired = () => {
    const current = now();
    for (const [key, slots] of active) {
      for (const slot of slots) {
        if (!slot.released && !slot.draining && current - slot.acquiredAtMs >= activeTtlMs) {
          slot.released = true;
          slots.delete(slot);
        }
      }
      if (slots.size === 0) active.delete(key);
    }
  };
  const countFor = (key: string) => active.get(key)?.size ?? 0;
  const activeTotal = () => {
    let total = 0;
    for (const slots of active.values()) total += slots.size;
    return total;
  };
  return {
    consumeOpen(key: string): boolean {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current - bucket.windowStartMs >= windowMs) {
        buckets.set(key, { windowStartMs: current, count: 1 });
        return true;
      }
      if (bucket.count >= openPerMinute) return false;
      bucket.count += 1;
      return true;
    },
    acquireActive(key: string): ActiveSlot | null {
      sweepExpired();
      if (countFor(key) >= activeMax) return null;
      const slot: ActiveSlot = { key, acquiredAtMs: now(), draining: false, released: false };
      const slots = active.get(key) ?? new Set<ActiveSlot>();
      slots.add(slot);
      active.set(key, slots);
      return slot;
    },
    markDraining(slot: ActiveSlot): void {
      slot.draining = true;
    },
    releaseActive(slot: ActiveSlot): void {
      if (slot.released) return;
      slot.released = true;
      const slots = active.get(slot.key);
      if (!slots) return;
      slots.delete(slot);
      if (slots.size === 0) active.delete(slot.key);
    },
    activeTotal,
  };
}

function copyForwardHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "host" || lower === "content-length") continue;
    out.set(key, value);
  }
  if (!out.has("accept")) out.set("accept", "text/event-stream");
  return out;
}

function responseHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set("access-control-allow-origin", "*");
  out.set("access-control-expose-headers", "electric-handle, electric-offset");
  return out;
}

/**
 * Bounds the byte size of a single SSE frame (frames delimited by `\n`[\r]*`\n`)
 * without iterating every byte: newlines are located with `indexOf` and the
 * CR-only gap test runs only until the first data byte of each frame, so the
 * hot path is O(frames), not O(bytes). Byte accounting stays exact so the size
 * guard is faithful to the original per-byte loop.
 */
function createFrameBoundScanner(maxFrameBytes: number) {
  let frameBytes = 0;
  let seenNewline = false;
  let gapCrOnly = true;
  return {
    push(chunk: Uint8Array): "ok" | "exceeded" {
      let pos = 0;
      while (pos < chunk.length) {
        const nl = chunk.indexOf(10, pos);
        const segEnd = nl === -1 ? chunk.length : nl;
        const segLen = segEnd - pos;
        if (segLen > 0) {
          frameBytes += segLen;
          if (gapCrOnly) {
            for (let k = pos; k < segEnd; k += 1) {
              if (chunk[k] !== 13) {
                gapCrOnly = false;
                break;
              }
            }
          }
          if (frameBytes > maxFrameBytes) return "exceeded";
        }
        if (nl === -1) break;
        frameBytes += 1; // the '\n' itself counts toward the frame
        if (frameBytes > maxFrameBytes) return "exceeded";
        if (seenNewline && gapCrOnly) {
          frameBytes = 0;
          seenNewline = false;
        } else {
          seenNewline = true;
        }
        gapCrOnly = true;
        pos = nl + 1;
      }
      return "ok";
    },
  };
}

function wrapBody(
  body: ReadableStream<Uint8Array> | null,
  metrics: SmithersElectricProxyMetrics,
  maxFrameBytes: number,
  hooks: { onStart: () => void; release: () => void },
): ReadableStream<Uint8Array> | null {
  if (!body) {
    hooks.release();
    return null;
  }
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    hooks.release();
  };
  const reader = body.getReader();
  const scanner = createFrameBoundScanner(maxFrameBytes);
  let started = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done();
          controller.close();
          return;
        }
        const value = chunk.value;
        // The stream has genuinely started draining only once real bytes flow.
        // A shape that is opened but never produces a byte (abandoned/stuck) is
        // left reclaimable by the active-slot TTL; a live Electric shape always
        // sends its initial snapshot, so it is marked draining and held.
        if (!started) {
          started = true;
          hooks.onStart();
        }
        metrics.addForwardedBytes(value.byteLength);
        if (scanner.push(value) === "exceeded") {
          metrics.incLargeFrame();
          await reader.cancel("smithers electric frame exceeded proxy limit").catch(() => undefined);
          done();
          controller.error(new Error(`Electric frame exceeded ${maxFrameBytes} bytes`));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      done();
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-expose-headers": "electric-handle, electric-offset",
    },
  });
}

function sanitizeQuery(
  requestUrl: URL,
  table: string,
  where: string | null,
): URLSearchParams {
  const params = new URLSearchParams(requestUrl.searchParams);
  params.delete("key");
  params.set("table", table);
  if (where) params.set("where", where);
  else params.delete("where");
  params.delete("shape");
  return params;
}

export function createSmithersElectricProxy(options: SmithersElectricProxyOptions): SmithersElectricProxy {
  const fetchClient = options.fetchClient ?? fetch;
  const now = options.now ?? (() => Date.now());
  const metrics = options.metrics ?? createSmithersElectricProxyMetrics();
  const observer = options.observer;
  const catalog = options.catalog ?? smithersElectricCatalogWithOutputTables(options.outputTables ?? []);
  const limits = rateLimiter(
    now,
    options.rateLimits?.openPerMinute ?? DEFAULT_OPEN_PER_MINUTE,
    options.rateLimits?.activeMax ?? DEFAULT_ACTIVE_MAX,
    options.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS,
  );
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const reject = (
    decisionBase: Omit<SmithersElectricScopeDecision, "allowed" | "reason">,
    reason: string,
  ) => {
    options.log?.({ ...decisionBase, allowed: false, reason });
    metrics.incShapeOpenRejected();
    emitSmithersElectricEvent(observer, {
      type: "electric.shape.rejected",
      principalId: decisionBase.principalId,
      table: decisionBase.table,
      shape: decisionBase.shape,
      requiredScope: decisionBase.requiredScope,
      reason,
    });
  };

  async function handleShape(request: Request, requestUrl: URL): Promise<Response> {
    const duplicate = hasDuplicateSecurityParam(requestUrl.searchParams);
    if (duplicate) {
      metrics.incShapeOpenRejected();
      return json(400, { error: `duplicate ${duplicate} query parameter` });
    }

    const auth = await options.authenticate(request);
    if (!auth) {
      metrics.incShapeOpenRejected();
      return json(401, { error: "authentication required" });
    }

    const table = requestUrl.searchParams.get("table") ?? "";
    const shape = shapeForTable(catalog, table, requestUrl.searchParams.get("shape"));
    if (!shape || (!table && shape.table === "*")) {
      metrics.incShapeOpenRejected();
      return json(404, { error: "shape not found" });
    }
    const effectiveTable = table || shape.table;
    const principal = principalId(auth);
    const allowedByScope = hasGatewayScope(auth.scopes, shape.requiredScope, "listRuns");
    const decisionBase = {
      event: "smithers-electric.scope" as const,
      table: effectiveTable,
      shape: shape.name,
      requiredScope: shape.requiredScope,
      principalId: principal,
    };
    if (!allowedByScope) {
      reject(decisionBase, "missing required scope");
      return json(403, { error: "missing required gateway scope", requiredScope: shape.requiredScope });
    }

    let where: string | null;
    try {
      where = validateWhere(shape, requestUrl.searchParams.get("where"), auth);
    } catch (error) {
      reject(decisionBase, error instanceof Error ? error.message : String(error));
      return json(400, { error: error instanceof Error ? error.message : String(error) });
    }

    if (!limits.consumeOpen(principal)) {
      reject(decisionBase, "shape open rate limit exceeded");
      return json(429, { error: "shape open rate limit exceeded" }, { "retry-after": "60" });
    }
    const slot = limits.acquireActive(principal);
    if (!slot) {
      reject(decisionBase, "active shape limit exceeded");
      return json(429, { error: "too many active shape subscriptions" }, { "retry-after": "1" });
    }
    metrics.setActiveShapes(limits.activeTotal());

    const release = () => {
      limits.releaseActive(slot);
      metrics.setActiveShapes(limits.activeTotal());
    };

    options.log?.({ ...decisionBase, allowed: true, reason: "authorized" });
    metrics.incShapeOpen();
    const startedAtMs = now();
    emitSmithersElectricEvent(observer, {
      type: "electric.shape.open",
      principalId: principal,
      table: effectiveTable,
      shape: shape.name,
      requiredScope: shape.requiredScope,
    });

    const upstreamUrl = new URL(options.electricUrl);
    upstreamUrl.search = sanitizeQuery(requestUrl, effectiveTable, where).toString();
    const response = await fetchClient(upstreamUrl, {
      method: request.method,
      headers: copyForwardHeaders(request.headers),
      signal: request.signal,
    }).catch((error) => {
      release();
      throw error;
    });
    const lagHeader = response.headers.get("x-electric-lag-ms") ?? response.headers.get("electric-lag-ms");
    const lag = lagHeader ? Number(lagHeader) : Number.NaN;
    if (Number.isFinite(lag)) metrics.observeSyncLag(lag);
    if (response.status === 409 || response.status === 410) metrics.incReplayGap();

    return new Response(
      wrapBody(response.body, metrics, maxFrameBytes, {
        onStart: () => limits.markDraining(slot),
        release: () => {
          release();
          emitSmithersElectricEvent(observer, {
            type: "electric.shape.forwarded",
            principalId: principal,
            table: effectiveTable,
            shape: shape.name,
            status: response.status,
            durationMs: now() - startedAtMs,
            forwardedBytes: metrics.snapshot().forwardedBytes,
            lagMs: Number.isFinite(lag) ? lag : undefined,
          });
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers),
      },
    );
  }

  return {
    metrics,
    async fetch(request: Request): Promise<Response> {
      const requestUrl = new URL(request.url);
      if (request.method === "OPTIONS") return corsPreflight();
      if (requestUrl.pathname === "/healthz") return json(200, { status: "ok" });
      if (requestUrl.pathname === "/metrics") {
        return new Response(metrics.renderPrometheus(), {
          status: 200,
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (requestUrl.pathname !== "/v1/shape") return json(404, { error: "not found" });
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      try {
        return await handleShape(request, requestUrl);
      } catch (error) {
        metrics.incShapeOpenRejected();
        return json(502, { error: "upstream service unavailable", message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}
