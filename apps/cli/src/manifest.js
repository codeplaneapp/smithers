import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { decode, encode } from "@toon-format/toon";

const DEFAULT_MANIFEST = {
    version: "0.0.0",
    description: "",
    repository: "",
    smithers: "*",
    contents: { workflows: [], ui: [] },
    capabilities: { bins: [], env: [], writes: "none" },
};

/**
 * @typedef {{ name: string; version: string; description: string; repository: string; smithers: string; contents: { workflows: string[]; ui: string[] }; capabilities: { bins: string[]; env: string[]; writes: "repo" | "sandbox" | "none" } }} SmithersManifest
 */

function manifestError(message, cause) {
    const error = new Error(`Invalid smithers.toon: ${message}`);
    if (cause) error.cause = cause;
    return error;
}

/** @param {unknown} value @param {string} field */
function stringValue(value, field) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw manifestError(`${field} must be a string`);
    return value;
}

/** @param {unknown} value @param {string} field */
function stringArray(value, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw manifestError(`${field} must be an array of strings`);
    }
    return [...value];
}

/**
 * Parse and validate a smithers.toon document. Optional fields are filled with
 * stable defaults so old or minimal manifests remain publishable.
 *
 * @param {string} source
 * @returns {SmithersManifest}
 */
export function parseManifest(source) {
    let value;
    try {
        value = decode(source);
    }
    catch (error) {
        throw manifestError(`malformed TOON${error instanceof Error ? `: ${error.message}` : ""}`, error);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw manifestError("the document must contain an object");
    }
    const input = /** @type {Record<string, any>} */ (value);
    if (typeof input.name !== "string" || input.name.trim() === "") {
        throw manifestError("missing required name");
    }
    const contents = input.contents === undefined
        ? {}
        : input.contents && typeof input.contents === "object" && !Array.isArray(input.contents)
            ? input.contents
            : (() => {
                throw manifestError("contents must be an object");
            })();
    const capabilities = input.capabilities === undefined
        ? {}
        : input.capabilities && typeof input.capabilities === "object" && !Array.isArray(input.capabilities)
            ? input.capabilities
            : (() => {
                throw manifestError("capabilities must be an object");
            })();
    const writes = capabilities.writes ?? DEFAULT_MANIFEST.capabilities.writes;
    if (writes !== "repo" && writes !== "sandbox" && writes !== "none") {
        throw manifestError("capabilities.writes must be one of repo, sandbox, or none");
    }
    return {
        name: input.name.trim(),
        version: stringValue(input.version ?? DEFAULT_MANIFEST.version, "version"),
        description: stringValue(input.description, "description"),
        repository: stringValue(input.repository, "repository"),
        smithers: stringValue(input.smithers ?? DEFAULT_MANIFEST.smithers, "smithers"),
        contents: {
            workflows: stringArray(contents.workflows, "contents.workflows"),
            ui: stringArray(contents.ui, "contents.ui"),
        },
        capabilities: {
            bins: stringArray(capabilities.bins, "capabilities.bins"),
            env: stringArray(capabilities.env, "capabilities.env"),
            writes,
        },
    };
}

/** @param {string} manifestPath @returns {SmithersManifest} */
export function loadManifest(manifestPath) {
    let source;
    try {
        source = readFileSync(resolve(manifestPath), "utf8");
    }
    catch (error) {
        throw manifestError(`cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    return parseManifest(source);
}

/** @param {SmithersManifest} manifest */
export function renderManifest(manifest) {
    return `${encode(manifest)}\n`;
}

/**
 * @param {string} projectRoot
 * @param {Array<{ path: string }>} scaffoldFiles
 * @returns {SmithersManifest}
 */
export function buildDefaultManifest(projectRoot, scaffoldFiles) {
    const workflows = scaffoldFiles
        .map((file) => file.path.match(/^\.smithers\/workflows\/(.+)\.tsx$/)?.[1])
        .filter(Boolean)
        .sort();
    const ui = scaffoldFiles
        .map((file) => file.path.match(/^\.smithers\/ui\/(.+)\.tsx$/)?.[1])
        .filter(Boolean)
        .sort();
    return {
        ...DEFAULT_MANIFEST,
        name: basename(resolve(projectRoot)),
        contents: { workflows, ui },
    };
}
