/**
 * Process-local PostgreSQL pool registry. Each normalized URL owns at most one
 * bounded node-postgres pool; callers receive a reference-counted lease.
 */
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const DEFAULT_POSTGRES_POOL_MAX = 16;
/**
 * Bounded wait for a pooled connection. Without it node-postgres queues an
 * acquire forever, so a saturated pool hangs the caller instead of surfacing
 * the actionable `PG_POOL_SATURATED` error below.
 */
const DEFAULT_POSTGRES_ACQUIRE_TIMEOUT_MS = 10_000;
/** node-postgres' fixed message for "waited past connectionTimeoutMillis for a pooled client". */
const POOL_ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

/** @type {Map<string, { pool: any; max: number; maxSource: "option" | "env" | "default"; acquireTimeoutMs: number; owners: number; closing?: Promise<void> }>} */
const poolsByIdentity = new Map();

/**
 * Normalize a PostgreSQL URL into the process-local pool identity. URL query
 * parameter order does not affect PostgreSQL connection semantics, so sorting
 * it prevents equivalent registrations from creating separate pools.
 *
 * @param {string} connectionString PostgreSQL URL to normalize.
 * @returns {string} Canonical connection identity.
 * @throws {TypeError} When `connectionString` cannot parse as a PostgreSQL URL.
 */
export function normalizePostgresConnectionIdentity(connectionString) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new TypeError("PostgreSQL connectionString must use postgres: or postgresql:.");
    }
    url.protocol = "postgres:";
    url.hostname = url.hostname.toLowerCase();
    if (url.port === "5432") {
        url.port = "";
    }
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
}

/**
 * Strip the password out of a pool identity so it can appear in errors, logs,
 * and diagnostics. The identity is only ever built from a connection URL the
 * caller supplied, and the password is the one part of it that must never
 * reach an error message.
 *
 * @param {string} identity Normalized pool identity.
 * @returns {string} Identity with any password replaced by `***`.
 */
export function redactPostgresIdentity(identity) {
    try {
        const url = new URL(identity);
        if (url.password) {
            url.password = "***";
        }
        return url.toString();
    }
    catch {
        return "postgres://<unparseable-url>";
    }
}

/**
 * Resolve the bounded PostgreSQL pool capacity from an explicit option or
 * `SMITHERS_POSTGRES_POOL_MAX` and otherwise return the safe default of 16.
 *
 * @param {number | undefined} configuredMax Explicit pool capacity.
 * @param {string | undefined} environmentMax Environment configuration.
 * @returns {number} Positive integer pool capacity.
 * @throws {RangeError} When a configured capacity lacks a positive integer value.
 */
export function resolvePostgresPoolMax(configuredMax, environmentMax = process.env.SMITHERS_POSTGRES_POOL_MAX) {
    const value = configuredMax ?? (environmentMax === undefined ? DEFAULT_POSTGRES_POOL_MAX : Number(environmentMax));
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("PostgreSQL pool max must be a positive integer.");
    }
    return value;
}

/**
 * Report where a resolved pool bound came from, so a saturation error can say
 * whether the cap is the shipped default or something the deployment chose.
 *
 * @param {number | undefined} configuredMax Explicit pool capacity.
 * @param {string | undefined} environmentMax Environment configuration.
 * @returns {"option" | "env" | "default"} Origin of the effective bound.
 */
export function postgresPoolMaxSource(configuredMax, environmentMax = process.env.SMITHERS_POSTGRES_POOL_MAX) {
    if (configuredMax !== undefined)
        return "option";
    return environmentMax === undefined ? "default" : "env";
}

/**
 * Resolve how long an acquire may wait for a pooled connection before the pool
 * is declared saturated.
 *
 * @param {number | undefined} configuredMs Explicit bounded wait.
 * @param {string | undefined} environmentMs Environment configuration.
 * @returns {number} Positive integer milliseconds.
 * @throws {RangeError} When a configured wait lacks a positive integer value.
 */
export function resolvePostgresAcquireTimeoutMs(configuredMs, environmentMs = process.env.SMITHERS_POSTGRES_ACQUIRE_TIMEOUT_MS) {
    const value = configuredMs ?? (environmentMs === undefined ? DEFAULT_POSTGRES_ACQUIRE_TIMEOUT_MS : Number(environmentMs));
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError("PostgreSQL pool acquire timeout must be a positive integer number of milliseconds.");
    }
    return value;
}

/**
 * True when node-postgres rejected because the acquire waited past
 * `connectionTimeoutMillis` for a pooled client. node-postgres uses a distinct
 * message ("Connection terminated due to connection timeout") when a *new*
 * socket fails to connect in time, so this does not mislabel a network stall.
 *
 * @param {unknown} error Rejection from `pool.connect()` / `pool.query()`.
 * @returns {boolean} Whether the rejection means the bound was reached.
 */
function isPoolAcquireTimeout(error) {
    return error instanceof Error && error.message === POOL_ACQUIRE_TIMEOUT_MESSAGE;
}

/**
 * Turn node-postgres' bare acquire timeout into an error an operator can act
 * on: which pool, what the cap is and where it came from, what the pool was
 * doing, why that happens, and the exact knob that raises it.
 *
 * @param {unknown} error Rejection from `pool.connect()` / `pool.query()`.
 * @param {{ pool: any; max: number; maxSource: "option" | "env" | "default"; acquireTimeoutMs: number }} entry Registry entry for the saturated pool.
 * @param {string} identity Normalized pool identity.
 * @returns {unknown} A `PG_POOL_SATURATED` SmithersError, or the original error.
 */
function toPoolSaturationError(error, entry, identity) {
    if (!isPoolAcquireTimeout(error)) {
        return error;
    }
    const redacted = redactPostgresIdentity(identity);
    const suggested = entry.max * 2;
    const capOrigin = entry.maxSource === "default"
        ? `the default ${DEFAULT_POSTGRES_POOL_MAX}`
        : `explicitly configured, default ${DEFAULT_POSTGRES_POOL_MAX}`;
    const summary = [
        `PostgreSQL pool ${redacted} is saturated: all ${entry.max} connections (${capOrigin}) were busy`,
        `for the full ${entry.acquireTimeoutMs}ms acquire wait.`,
        `Pool now: ${entry.pool.totalCount ?? 0} open, ${entry.pool.idleCount ?? 0} idle, ${entry.pool.waitingCount ?? 0} waiting.`,
        "Likely causes: more concurrent workflows than pooled connections, or a leaked/stuck query still holding a client.",
        `Raise the cap with SMITHERS_POSTGRES_POOL_MAX (for example SMITHERS_POSTGRES_POOL_MAX=${suggested})`,
        `or pass postgresPoolMax: ${suggested} to openSmithersBackend()/createSmithersPostgres().`,
    ].join(" ");
    return new SmithersError("PG_POOL_SATURATED", summary, {
        identity: redacted,
        max: entry.max,
        maxSource: entry.maxSource,
        acquireTimeoutMs: entry.acquireTimeoutMs,
        totalCount: entry.pool.totalCount ?? 0,
        idleCount: entry.pool.idleCount ?? 0,
        waitingCount: entry.pool.waitingCount ?? 0,
        configKnob: "SMITHERS_POSTGRES_POOL_MAX",
    }, error);
}

/**
 * A logical PostgreSQL connection backed by a shared pool. It pins a pool
 * client from BEGIN through COMMIT/ROLLBACK, preserving transaction affinity
 * while non-transactional queries use the bounded shared pool.
 */
class TransactionalPoolConnection {
    /**
     * @param {{ pool: any; max: number; maxSource: "option" | "env" | "default"; acquireTimeoutMs: number }} entry Registry entry for the shared pool.
     * @param {string} identity Normalized pool identity.
     * @param {() => Promise<void>} releaseLease Releases this owner's pool reference.
     */
    constructor(entry, identity, releaseLease) {
        this.entry = entry;
        this.pool = entry.pool;
        this.identity = identity;
        this.releaseLease = releaseLease;
        this.transactionClient = null;
        this.closed = false;
    }

    /**
     * Send a query through the shared pool or its transaction-pinned client.
     * @param {{ text: string; values?: unknown[] }} query Query configuration.
     * @returns {Promise<any>} node-postgres query result.
     * @throws {Error} When called after close or a nested transaction begins.
     */
    async query(query) {
        if (this.closed) {
            throw new Error("PostgreSQL connection has closed.");
        }
        const command = query.text.trim().toUpperCase();
        if (command === "BEGIN") {
            if (this.transactionClient) {
                throw new Error("Nested PostgreSQL transactions are not supported.");
            }
            let client;
            try {
                client = await this.pool.connect();
            }
            catch (error) {
                throw toPoolSaturationError(error, this.entry, this.identity);
            }
            this.transactionClient = client;
            try {
                return await client.query(query);
            }
            catch (error) {
                this.releaseTransactionClient(error);
                throw error;
            }
        }
        const client = this.transactionClient;
        if (!client) {
            try {
                return await this.pool.query(query);
            }
            catch (error) {
                throw toPoolSaturationError(error, this.entry, this.identity);
            }
        }
        if (command === "COMMIT" || command === "ROLLBACK") {
            try {
                return await client.query(query);
            }
            catch (error) {
                this.releaseTransactionClient(error);
                throw error;
            }
            finally {
                this.releaseTransactionClient();
            }
        }
        return client.query(query);
    }

    /** Release the client pin after a terminal transaction command. */
    releaseTransactionClient(error) {
        const client = this.transactionClient;
        this.transactionClient = null;
        client?.release(error);
    }

    /**
     * Roll back an unfinished transaction, release its client, then release the
     * process-local pool reference. Repeated calls have no effect.
     * @returns {Promise<void>} Completion after all owned resources release.
     */
    async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const client = this.transactionClient;
        this.transactionClient = null;
        let rollbackError;
        try {
            await client?.query({ text: "ROLLBACK" });
        }
        catch (error) {
            // Releasing a failed client lets node-postgres discard it when needed.
            rollbackError = error;
        }
        finally {
            client?.release(rollbackError);
            await this.releaseLease();
        }
    }
}

/**
 * Acquire a logical connection over a process-local bounded PostgreSQL pool.
 * A normalized URL shares a pool; conflicting bounds reject rather than
 * silently creating an unbounded second pool.
 *
 * @param {{ pg: { Pool: new (options: object) => any; types: { getTypeParser: (oid: number, format?: string) => (value: string) => unknown } }; connectionString: string; max?: number; environmentMax?: string; acquireTimeoutMs?: number; environmentAcquireTimeoutMs?: string }} options Pool configuration.
 * @returns {Promise<{ connection: { query: (query: { text: string; values?: unknown[] }) => Promise<any>; close: () => Promise<void> }; close: () => Promise<void>; identity: string; max: number }>} Lease and logical connection.
 * @throws {RangeError | TypeError} When the connection identity or bound lacks validity.
 */
export async function acquireSharedPostgresPool(options) {
    const identity = normalizePostgresConnectionIdentity(options.connectionString);
    const max = resolvePostgresPoolMax(options.max, options.environmentMax);
    const maxSource = postgresPoolMaxSource(options.max, options.environmentMax);
    const acquireTimeoutMs = resolvePostgresAcquireTimeoutMs(options.acquireTimeoutMs, options.environmentAcquireTimeoutMs);
    let entry = poolsByIdentity.get(identity);
    if (entry?.closing) {
        await entry.closing;
        entry = poolsByIdentity.get(identity);
    }
    if (!entry) {
        const types = {
            getTypeParser: (oid, format) => oid === 20 && format !== "binary"
                ? (value) => (value === null ? null : Number(value))
                : options.pg.types.getTypeParser(oid, format),
        };
        const pool = new options.pg.Pool({
            connectionString: options.connectionString,
            max,
            types,
            connectionTimeoutMillis: acquireTimeoutMs,
        });
        // node-postgres re-emits idle-client errors (server restart, network
        // drop) on the pool, and an unhandled 'error' event takes down the whole
        // host process. The pool already discards the broken client; owners see
        // the failure on their next query.
        pool.on?.("error", () => {});
        entry = { pool, max, maxSource, acquireTimeoutMs, owners: 0 };
        poolsByIdentity.set(identity, entry);
    }
    else if (entry.max !== max) {
        throw new RangeError(`PostgreSQL pool ${redactPostgresIdentity(identity)} already has max ${entry.max}; requested ${max}.`);
    }
    entry.owners += 1;
    let released = false;
    const releaseLease = async () => {
        if (released) {
            return;
        }
        released = true;
        entry.owners -= 1;
        if (entry.owners > 0) {
            return;
        }
        entry.closing = entry.pool.end().finally(() => {
            if (poolsByIdentity.get(identity) === entry) {
                poolsByIdentity.delete(identity);
            }
        });
        await entry.closing;
    };
    const connection = new TransactionalPoolConnection(entry, identity, releaseLease);
    return { connection, close: () => connection.close(), identity, max };
}

/** @returns {number} Number of currently referenced shared pools. */
export function sharedPostgresPoolCount() {
    return poolsByIdentity.size;
}
