// ---------------------------------------------------------------------------
// Regression: a real file path whose CONTENT is unparseable must surface the
// genuine content-parse error, not the misleading path-as-text error produced
// by re-parsing the file path string when content parsing throws.
// ---------------------------------------------------------------------------
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadSpecSync } from "../src/loadSpecSync.js";
import { loadSpecEffect } from "../src/loadSpecEffect.js";

/**
 * Write content to a temp file and return its path.
 * @param {string} content
 * @returns {string}
 */
function writeTempSpec(content) {
    const dir = mkdtempSync(join(tmpdir(), "openapi-broken-"));
    const filePath = join(dir, "openapi.json");
    writeFileSync(filePath, content, "utf8");
    return filePath;
}

// Broken JSON that also fails YAML parsing — guarantees parseSpecText throws
// "Failed to parse OpenAPI spec as JSON or YAML".
const brokenContent = '{ "openapi": "3.0.0", "paths": { ';

describe("loadSpec surfaces content-parse errors for real file paths", () => {
    test("loadSpecSync reports the genuine parse error, not the path", () => {
        const filePath = writeTempSpec(brokenContent);
        // Before the fix, the readFileSync content threw inside the try, the
        // catch re-parsed the *file path string* as YAML (a valid scalar),
        // and surfaced the misleading "...does not appear to be a valid
        // OpenAPI spec" error. The corrected behavior surfaces the real
        // content-parse failure.
        expect(() => loadSpecSync(filePath)).toThrow(
            "Failed to parse OpenAPI spec as JSON or YAML",
        );
        expect(() => loadSpecSync(filePath)).not.toThrow(
            /does not appear to be a valid OpenAPI spec/,
        );
    });

    test("loadSpecEffect reports the genuine parse error, not the path", async () => {
        const filePath = writeTempSpec(brokenContent);
        await expect(
            Effect.runPromise(loadSpecEffect(filePath)),
        ).rejects.toThrow("Failed to parse OpenAPI spec as JSON or YAML");
    });
});
