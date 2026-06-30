import { existsSync } from "node:fs";
import { resolve } from "node:path";

const LATEST_DOCS_BASE_URL = "https://smithers.sh";
const SEMVER_TAG_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} version
 * @returns {string}
 */
export function normalizeDocsVersion(version) {
    const normalized = version.trim().replace(/^v/, "");
    if (!SEMVER_TAG_RE.test(normalized)) {
        throw new Error(`Invalid Smithers docs version "${version}". Expected a semver tag like 0.22.0 or v0.22.0.`);
    }
    return normalized;
}

/**
 * @param {string} file
 * @param {string} version
 */
export function versionedDocsUrl(file, version) {
    const normalizedVersion = normalizeDocsVersion(version);
    const stem = file.replace(/\.txt$/, "");
    return `${LATEST_DOCS_BASE_URL}/${stem}-v${normalizedVersion}.txt`;
}

/**
 * @param {{
 *   file: string;
 *   latest?: boolean;
 *   version?: string;
 *   packageVersion: string;
 *   localDocsRoots?: string[];
 * }} input
 * @returns {{ kind: "local"; path: string; url: string } | { kind: "remote"; url: string }}
 */
export function resolveSmithersDocsSource(input) {
    if (input.latest && input.version) {
        throw new Error("Use either --latest or --docs-version, not both.");
    }
    if (input.latest) {
        return { kind: "remote", url: `${LATEST_DOCS_BASE_URL}/${input.file}` };
    }

    // An explicit --docs-version must be a valid semver tag; surface the error.
    // When the version comes only from the package (e.g. the literal "unknown"
    // from an unreadable package.json), fall back to packaged local docs before
    // erroring so a confusing version message never hides on-disk docs.
    if (input.version) {
        const version = normalizeDocsVersion(input.version);
        return { kind: "remote", url: versionedDocsUrl(input.file, version) };
    }

    let url;
    try {
        url = versionedDocsUrl(input.file, input.packageVersion);
    }
    catch {
        url = `${LATEST_DOCS_BASE_URL}/${input.file}`;
    }
    for (const localDocsRoot of input.localDocsRoots ?? []) {
        const localPath = resolve(localDocsRoot, input.file);
        if (existsSync(localPath)) {
            return { kind: "local", path: localPath, url };
        }
    }

    return { kind: "remote", url };
}
