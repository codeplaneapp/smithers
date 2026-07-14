/**
 * Canonical JSON used by provenance proofs. Object keys are recursively
 * sorted, arrays retain order, and the result contains no insignificant
 * whitespace. Unsupported object properties follow JSON.stringify semantics
 * (they are omitted; unsupported array entries become null).
 *
 * This implementation is deliberately runtime-neutral: SmithersCtx is used by
 * both Node and browser drivers, so importing node:crypto here would make the
 * portable driver bundle invalid. `digestProofRow` below is the single hasher
 * used by both ctx.prove() and the Node engine's schedule-time verifier.
 *
 * @param {unknown} value
 * @param {Set<object>} [ancestors]
 * @returns {string | undefined}
 */
export function canonicalJson(value, ancestors = new Set()) {
    if (value && typeof value === "object" && typeof value.toJSON === "function") {
        return canonicalJson(value.toJSON(), ancestors);
    }
    if (value === null)
        return "null";
    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            return Number.isFinite(value) ? JSON.stringify(value) : "null";
        case "bigint":
            throw new TypeError("BigInt is not JSON serializable");
        case "undefined":
        case "function":
        case "symbol":
            return undefined;
        case "object": {
            const objectValue = /** @type {object} */ (value);
            if (ancestors.has(objectValue)) {
                throw new TypeError("Converting circular structure to JSON");
            }
            const nextAncestors = new Set(ancestors);
            nextAncestors.add(objectValue);
            if (Array.isArray(value)) {
                // Array.prototype.map skips sparse holes. Array.from visits
                // every index, which preserves JSON.stringify semantics:
                // holes and unsupported entries are encoded as null.
                return `[${Array.from(value, (entry) => canonicalJson(entry, nextAncestors) ?? "null").join(",")}]`;
            }
            const record = /** @type {Record<string, unknown>} */ (value);
            const entries = [];
            for (const key of Object.keys(record).sort()) {
                const encoded = canonicalJson(record[key], nextAncestors);
                if (encoded !== undefined) {
                    entries.push(`${JSON.stringify(key)}:${encoded}`);
                }
            }
            return `{${entries.join(",")}}`;
        }
        default:
            return undefined;
    }
}

/**
 * Small synchronous SHA-256 implementation over UTF-8 input. Keeping this
 * here makes provenance hashing identical in every runtime without adding a
 * Node-only import to the driver package.
 *
 * @param {string} input
 * @returns {string} lowercase hexadecimal digest
 */
export function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input);
    const bitLength = bytes.length * 8;
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const message = new Uint8Array(paddedLength);
    message.set(bytes);
    message[bytes.length] = 0x80;
    const view = new DataView(message.buffer);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);

    const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const words = new Uint32Array(64);
    const rotateRight = (value, amount) => (value >>> amount) | (value << (32 - amount));
    for (let offset = 0; offset < message.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 64; index += 1) {
            const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
            const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choose = (e & f) ^ (~e & g);
            const temp1 = (h + sum1 + choose + constants[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map((word) => word.toString(16).padStart(8, "0"))
        .join("");
}

/**
 * Hash the typed/user-visible portion of an output row. Reserved persistence
 * columns are identity metadata carried separately by ProofBinding and must
 * not make content-equivalent rows hash differently.
 *
 * @param {unknown} row
 * @returns {string}
 */
export function digestProofRow(row) {
    let content = row;
    if (row && typeof row === "object" && !Array.isArray(row)) {
        const { runId: _runId, nodeId: _nodeId, iteration: _iteration, ...rest } = /** @type {Record<string, unknown>} */ (row);
        content = rest;
    }
    const canonical = canonicalJson(content);
    if (canonical === undefined) {
        throw new TypeError("Proof rows must be JSON serializable");
    }
    return `sha256:${sha256Hex(canonical)}`;
}
