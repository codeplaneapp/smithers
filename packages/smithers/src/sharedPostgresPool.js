/**
 * Process-local PostgreSQL pool registry. Each normalized URL owns at most one
 * bounded node-postgres pool; callers receive a reference-counted lease.
 */
const DEFAULT_POSTGRES_POOL_MAX = 10;

/** @type {Map<string, { pool: any; max: number; owners: number; closing?: Promise<void> }>} */
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
 * Resolve the bounded PostgreSQL pool capacity from an explicit option or
 * `SMITHERS_POSTGRES_POOL_MAX` and otherwise return the safe default of ten.
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
 * A logical PostgreSQL connection backed by a shared pool. It pins a pool
 * client from BEGIN through COMMIT/ROLLBACK, preserving transaction affinity
 * while non-transactional queries use the bounded shared pool.
 */
class TransactionalPoolConnection {
    /**
     * @param {any} pool node-postgres Pool.
     * @param {() => Promise<void>} releaseLease Releases this owner's pool reference.
     */
    constructor(pool, releaseLease) {
        this.pool = pool;
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
            const client = await this.pool.connect();
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
            return this.pool.query(query);
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
 * @param {{ pg: { Pool: new (options: object) => any; types: { getTypeParser: (oid: number, format?: string) => (value: string) => unknown } }; connectionString: string; max?: number; environmentMax?: string }} options Pool configuration.
 * @returns {Promise<{ connection: { query: (query: { text: string; values?: unknown[] }) => Promise<any>; close: () => Promise<void> }; close: () => Promise<void>; identity: string; max: number }>} Lease and logical connection.
 * @throws {RangeError | TypeError} When the connection identity or bound lacks validity.
 */
export async function acquireSharedPostgresPool(options) {
    const identity = normalizePostgresConnectionIdentity(options.connectionString);
    const max = resolvePostgresPoolMax(options.max, options.environmentMax);
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
        entry = {
            pool: new options.pg.Pool({ connectionString: options.connectionString, max, types }),
            max,
            owners: 0,
        };
        poolsByIdentity.set(identity, entry);
    }
    else if (entry.max !== max) {
        throw new RangeError(`PostgreSQL pool ${identity} already has max ${entry.max}; requested ${max}.`);
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
    const connection = new TransactionalPoolConnection(entry.pool, releaseLease);
    return { connection, close: () => connection.close(), identity, max };
}

/** @returns {number} Number of currently referenced shared pools. */
export function sharedPostgresPoolCount() {
    return poolsByIdentity.size;
}
