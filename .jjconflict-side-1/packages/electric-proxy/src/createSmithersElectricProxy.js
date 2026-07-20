import { hasGatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";
import { createSmithersElectricProxyMetrics } from "./createSmithersElectricProxyMetrics.js";
import { emitSmithersElectricEvent } from "./createSmithersElectricProxyObserver.js";
import { smithersElectricCatalogWithOutputTables } from "./smithersElectricShapeCatalog.js";

/** @typedef {import("./SmithersElectricProxyOptions.ts").SmithersElectricAuthContext} SmithersElectricAuthContext */
/** @typedef {import("./SmithersElectricProxyOptions.ts").SmithersElectricProxy} SmithersElectricProxy */
/** @typedef {import("./SmithersElectricProxyOptions.ts").SmithersElectricProxyOptions} SmithersElectricProxyOptions */
/** @typedef {import("./SmithersElectricProxyOptions.ts").SmithersElectricScopeDecision} SmithersElectricScopeDecision */
/** @typedef {import("./SmithersElectricProxyMetrics.ts").SmithersElectricProxyMetrics} SmithersElectricProxyMetrics */
/** @typedef {import("./SmithersElectricShapeDefinition.ts").SmithersElectricShapeDefinition} SmithersElectricShapeDefinition */

/**
 * @typedef {{
 *   values: Map<string, string[]>;
 *   isNull: Set<string>;
 * }} ParsedWhere
 */

/**
 * @typedef {{
 *   windowStartMs: number;
 *   count: number;
 * }} OpenBucket
 */

// Per-principal abuse bounds (overridable via options): 60 shape opens/min,
// 50 concurrent streams, 4 MiB per SSE frame, 5 min idle-slot reclaim.
const DEFAULT_OPEN_PER_MINUTE = 60;
const DEFAULT_ACTIVE_MAX = 50;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_ACTIVE_TTL_MS = 5 * 60_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {HeadersInit} [headers]
 * @returns {Response}
 */
function json(status, payload, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function q(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * @param {readonly string[]} values
 * @returns {string}
 */
function listLiteral(values) {
  return values.map(q).join(",");
}

/**
 * @param {URLSearchParams} params
 * @returns {string | null}
 */
function hasDuplicateSecurityParam(params) {
  for (const name of ["table", "shape", "where", "key"]) {
    if (params.getAll(name).length > 1) return name;
  }
  return null;
}

/**
 * @param {string} where
 * @returns {string[]}
 */
function tokenizeWhere(where) {
  /** @type {string[]} */
  const tokens = [];
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
      // identifiers/keywords compare case-insensitively downstream
      tokens.push(where.slice(start, i).toLowerCase());
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

/**
 * @param {string} where
 * @returns {ParsedWhere}
 */
function parseWhere(where) {
  const tokens = tokenizeWhere(where);
  /** @type {Map<string, string[]>} */
  const values = new Map();
  /** @type {Set<string>} */
  const isNull = new Set();
  let i = 0;
  const peek = () => tokens[i];
  /**
   * @param {string} [expected]
   * @returns {string}
   */
  const take = (expected) => {
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
    // The tokenizer re-encodes string literals as JSON strings; everything
    // else is a bare token.
    return token.startsWith("\"") ? /** @type {string} */ (JSON.parse(token)) : token;
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
      /** @type {string[]} */
      const list = [];
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

/**
 * @param {readonly SmithersElectricShapeDefinition[]} catalog
 * @param {string} table
 * @param {string | null} [shapeName]
 * @returns {SmithersElectricShapeDefinition | undefined}
 */
function shapeForTable(catalog, table, shapeName) {
  if (shapeName) {
    return catalog.find((shape) => shape.name === shapeName && (shape.table === table || shape.table === "*" || table === ""));
  }
  return catalog.find((shape) => shape.table === table) ??
    catalog.find((shape) => shape.tablePattern?.test(table));
}

/**
 * @param {SmithersElectricShapeDefinition} shape
 * @param {SmithersElectricAuthContext} auth
 * @returns {string | null}
 */
function fillWhereTemplate(shape, auth) {
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

/**
 * @param {string} column
 * @param {readonly string[]} requested
 * @param {readonly string[] | undefined} granted
 * @param {boolean} unscoped
 * @returns {void}
 */
function ensureValuesAllowed(column, requested, granted, unscoped) {
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

/**
 * @param {SmithersElectricShapeDefinition} shape
 * @param {string | null} where
 * @param {SmithersElectricAuthContext} auth
 * @returns {string | null}
 */
function validateWhere(shape, where, auth) {
  const unscoped = auth.unscoped === true;
  // A shape with no row-level scoping mechanism at all (no run/workspace/user
  // column AND no whereTemplate) is a whole-table read. Forwarding it to a
  // scoped principal (e.g. a `run:read` token granted a single run) would
  // expose every row of the table regardless of which runs were granted — the
  // exact fail-open the rest of this module is designed to prevent. Reject it
  // before any client-supplied `where` is considered; only an explicitly
  // unscoped principal (a single-user local-cloud install) may read it.
  const hasRowScoping = Boolean(
    shape.runIdColumn || shape.workspaceIdColumn || shape.userPrivateColumn || shape.whereTemplate,
  );
  if (!hasRowScoping && !unscoped) {
    throw new Error(`shape "${shape.name}" has no row-level scoping and cannot be served to a scoped principal`);
  }
  // When the whereTemplate is the shape's ONLY scoping mechanism, there is no
  // scoping column for the value checks below to re-verify, so a client
  // `where` would replace the template with an arbitrary predicate after
  // nothing but syntactic parsing. The template is authoritative: reject the
  // client where outright for scoped principals.
  const templateOnly =
    Boolean(shape.whereTemplate) && !shape.runIdColumn && !shape.workspaceIdColumn && !shape.userPrivateColumn;
  if (templateOnly && !unscoped && where && where.trim()) {
    throw new Error(`shape "${shape.name}" is scoped only by its where template; a client where clause is not allowed`);
  }
  const effectiveWhere = where && where.trim() ? where.trim() : fillWhereTemplate(shape, auth);
  if (!effectiveWhere) {
    // No client where and the template could not be filled. For a scoped shape
    // (scoping column or template) that is only acceptable when the principal
    // is explicitly unscoped; a scoped principal with no concrete grants gets
    // nothing rather than the whole table.
    if (hasRowScoping && !unscoped) {
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

/**
 * @typedef {{
 *   key: string;
 *   acquiredAtMs: number;
 *   draining: boolean;
 *   released: boolean;
 *   cancelUpstream?: () => void;
 * }} ActiveSlot
 * `draining` is set true once the stream actually starts draining (first pull /
 * cancel). `cancelUpstream` tears down the upstream Electric stream bound to
 * this slot; reclaiming the local slot without it leaves the upstream
 * connection open, so activeMax would stop bounding real upstream connections.
 */

/**
 * @param {() => number} now
 * @param {number} openPerMinute
 * @param {number} activeMax
 * @param {number} activeTtlMs
 */
function rateLimiter(now, openPerMinute, activeMax, activeTtlMs) {
  /** @type {Map<string, OpenBucket>} */
  const buckets = new Map();
  /** @type {Map<string, Set<ActiveSlot>>} */
  const active = new Map();
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
          // Freeing the local slot count is not enough: cancel the upstream
          // Electric stream too, or activeMax stops bounding real upstream
          // connections (reclaimed-but-open streams would leak past the cap).
          slot.cancelUpstream?.();
        }
      }
      if (slots.size === 0) active.delete(key);
    }
  };
  /** @param {string} key */
  const countFor = (key) => active.get(key)?.size ?? 0;
  const activeTotal = () => {
    let total = 0;
    for (const slots of active.values()) total += slots.size;
    return total;
  };
  return {
    /**
     * @param {string} key
     * @returns {boolean}
     */
    consumeOpen(key) {
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
    /**
     * @param {string} key
     * @returns {ActiveSlot | null}
     */
    acquireActive(key) {
      sweepExpired();
      if (countFor(key) >= activeMax) return null;
      /** @type {ActiveSlot} */
      const slot = { key, acquiredAtMs: now(), draining: false, released: false };
      const slots = active.get(key) ?? new Set();
      slots.add(slot);
      active.set(key, slots);
      return slot;
    },
    /** @param {ActiveSlot} slot */
    markDraining(slot) {
      slot.draining = true;
    },
    /** @param {ActiveSlot} slot */
    releaseActive(slot) {
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

/**
 * @param {Headers} headers
 * @returns {Headers}
 */
function copyForwardHeaders(headers) {
  const out = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "host" || lower === "content-length") continue;
    out.set(key, value);
  }
  if (!out.has("accept")) out.set("accept", "text/event-stream");
  return out;
}

/**
 * @param {Headers} headers
 * @returns {Headers}
 */
function responseHeaders(headers) {
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
 *
 * @param {number} maxFrameBytes
 */
function createFrameBoundScanner(maxFrameBytes) {
  let frameBytes = 0;
  let seenNewline = false;
  let gapCrOnly = true;
  return {
    /**
     * @param {Uint8Array} chunk
     * @returns {"ok" | "exceeded"}
     */
    push(chunk) {
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

/**
 * `registerCancel` receives a callback that cancels the upstream reader and
 * releases the slot. It is wired to the active slot so a TTL reclaim can tear
 * down the real upstream Electric stream, not just the local slot count.
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {SmithersElectricProxyMetrics} metrics
 * @param {number} maxFrameBytes
 * @param {{
 *   onStart: () => void;
 *   release: (forwardedBytes?: number) => void;
 *   registerCancel?: (cancel: () => void) => void;
 * }} hooks
 * @returns {ReadableStream<Uint8Array> | null}
 */
function wrapBody(body, metrics, maxFrameBytes, hooks) {
  if (!body) {
    hooks.release();
    return null;
  }
  let released = false;
  let forwardedBytes = 0;
  const done = () => {
    if (released) return;
    released = true;
    hooks.release(forwardedBytes);
  };
  const reader = body.getReader();
  hooks.registerCancel?.(() => {
    reader.cancel("smithers electric active-slot TTL reclaimed").catch(() => undefined);
    done();
  });
  const scanner = createFrameBoundScanner(maxFrameBytes);
  let started = false;
  return new ReadableStream({
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
        forwardedBytes += value.byteLength;
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

/**
 * @returns {Response}
 */
function corsPreflight() {
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

/**
 * @param {URL} requestUrl
 * @param {string} table
 * @param {string | null} where
 * @returns {URLSearchParams}
 */
function sanitizeQuery(requestUrl, table, where) {
  const params = new URLSearchParams(requestUrl.searchParams);
  params.delete("key");
  params.set("table", table);
  if (where) params.set("where", where);
  else params.delete("where");
  params.delete("shape");
  return params;
}

/**
 * Build the auth, scope, rate-limit, and observability proxy that fronts an
 * ElectricSQL shape endpoint for Smithers clients.
 *
 * @param {SmithersElectricProxyOptions} options
 * @returns {SmithersElectricProxy}
 */
export function createSmithersElectricProxy(options) {
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
  /**
   * @param {Omit<SmithersElectricScopeDecision, "allowed" | "reason">} decisionBase
   * @param {string} reason
   */
  const reject = (decisionBase, reason) => {
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

  /**
   * @param {Request} request
   * @param {URL} requestUrl
   * @returns {Promise<Response>}
   */
  async function handleShape(request, requestUrl) {
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
    const principal = auth.principalId ?? auth.userId ?? auth.tokenId ?? "anonymous";
    const allowedByScope = hasGatewayScope(auth.scopes, shape.requiredScope, "listRuns");
    const decisionBase = {
      event: /** @type {const} */ ("smithers-electric.scope"),
      table: effectiveTable,
      shape: shape.name,
      requiredScope: shape.requiredScope,
      principalId: principal,
    };
    if (!allowedByScope) {
      reject(decisionBase, "missing required scope");
      return json(403, { error: "missing required gateway scope", requiredScope: shape.requiredScope });
    }

    /** @type {string | null} */
    let where;
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
      // An upstream outage is otherwise invisible past a counter bump. Emit a
      // structured event (with the failure reason) on the observability path so
      // the cloud exporter surfaces Electric outages, not just a 502 to the
      // client.
      const reason = error instanceof Error ? error.message : String(error);
      metrics.incUpstreamError();
      emitSmithersElectricEvent(observer, {
        type: "electric.upstream.error",
        principalId: principal,
        table: effectiveTable,
        shape: shape.name,
        requiredScope: shape.requiredScope,
        reason,
      });
      throw error;
    });
    const lagHeader = response.headers.get("x-electric-lag-ms") ?? response.headers.get("electric-lag-ms");
    const lag = lagHeader ? Number(lagHeader) : Number.NaN;
    if (Number.isFinite(lag)) metrics.observeSyncLag(lag);
    if (response.status === 409 || response.status === 410) metrics.incReplayGap();

    return new Response(
      wrapBody(response.body, metrics, maxFrameBytes, {
        onStart: () => limits.markDraining(slot),
        registerCancel: (cancel) => {
          slot.cancelUpstream = cancel;
        },
        release: (forwardedBytes = 0) => {
          release();
          emitSmithersElectricEvent(observer, {
            type: "electric.shape.forwarded",
            principalId: principal,
            table: effectiveTable,
            shape: shape.name,
            status: response.status,
            durationMs: now() - startedAtMs,
            forwardedBytes,
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
    /**
     * @param {Request} request
     * @returns {Promise<Response>}
     */
    async fetch(request) {
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
