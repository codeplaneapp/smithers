import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    DEVTOOLS_ERROR_CODES,
    NODE_DIFF_ERROR_CODES,
    NODE_OUTPUT_ERROR_CODES,
    JUMP_TO_FRAME_ERROR_CODES,
} from "@smithers-orchestrator/protocol/errors/index.js";
import {
    CLI_ERROR_MESSAGES,
    formatCliErrorForStderr,
    parseCliErrorFromStderr,
} from "../src/util/errorMessage.js";
import { EXIT_USER_ERROR, EXIT_SERVER_ERROR } from "../src/util/exitCodes.js";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const SRC_DIR = resolve(import.meta.dir, "..", "src");

/** Recursively concatenate every .js/.ts source under apps/cli/src. */
function readAllCliSource(dir = SRC_DIR, chunks = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            readAllCliSource(path, chunks);
        }
        else if (/\.(js|ts|tsx)$/.test(entry.name)) {
            chunks.push(readFileSync(path, "utf8"));
        }
    }
    return chunks.join("\n");
}

/**
 * Finding #10 regression guard.
 *
 * Every typed error code returned by the four devtools RPCs must have
 * a CLI-side mapping to a user-friendly message, a hint, and an exit
 * code. Importing the protocol's frozen code arrays and asserting each
 * one maps here means any code added to `@smithers-orchestrator/protocol/errors`
 * that the CLI forgets to handle will fail this test immediately.
 */
describe("CLI_ERROR_MESSAGES covers every protocol error code", () => {
    const allCodes = Array.from(
        new Set([
            ...DEVTOOLS_ERROR_CODES,
            ...NODE_DIFF_ERROR_CODES,
            ...NODE_OUTPUT_ERROR_CODES,
            ...JUMP_TO_FRAME_ERROR_CODES,
        ]),
    );

    test("every code is present with a non-empty message and hint", () => {
        for (const code of allCodes) {
            const mapping = CLI_ERROR_MESSAGES[code];
            expect(mapping).toBeDefined();
            expect(typeof mapping.message).toBe("string");
            expect(mapping.message.length).toBeGreaterThan(0);
            expect(typeof mapping.hint).toBe("string");
            expect(mapping.hint.length).toBeGreaterThan(0);
        }
    });

    test("exit code is either user-error (1) or server-error (2)", () => {
        for (const code of allCodes) {
            const mapping = CLI_ERROR_MESSAGES[code];
            expect([EXIT_USER_ERROR, EXIT_SERVER_ERROR]).toContain(mapping.exitCode);
        }
    });

    test("every `smithers <cmd>` referenced in a hint is a real CLI command (#8)", () => {
        const repo = createTempRepo();
        const help = runSmithers(["--help"], { cwd: repo.dir, format: null });
        expect(help.exitCode).toBe(0);
        const registered = new Set();
        for (const line of help.stdout.split("\n")) {
            const match = line.match(/^  ([a-z][a-z0-9-]*)\s{2,}/);
            if (match) registered.add(match[1]);
        }
        expect(registered.size).toBeGreaterThan(20);
        for (const [code, mapping] of Object.entries(CLI_ERROR_MESSAGES)) {
            for (const reference of mapping.hint.matchAll(/`smithers ([a-z][a-z0-9-]*)/g)) {
                expect(registered.has(reference[1]), `hint for ${code} references nonexistent command \`smithers ${reference[1]}\``).toBe(true);
            }
        }
    }, 60_000);

    test("hints never reference the removed `smithers login` and every SMITHERS_* env var they name is real (#8)", () => {
        const source = readAllCliSource();
        for (const [code, mapping] of Object.entries(CLI_ERROR_MESSAGES)) {
            const text = `${mapping.message}\n${mapping.hint}`;
            expect(text, `mapping for ${code} references nonexistent \`smithers login\``).not.toContain("smithers login");
            expect(text, `mapping for ${code} references SMITHERS_HOST, which nothing reads`).not.toContain("SMITHERS_HOST");
            for (const envRef of text.matchAll(/SMITHERS_[A-Z_]+/g)) {
                expect(source.includes(envRef[0]), `hint for ${code} names ${envRef[0]}, which apps/cli/src never reads`).toBe(true);
            }
        }
    });

    test("user-supplied Invalid* inputs map to exit 1", () => {
        // InvalidDelta is a server-side protocol error (delta the client
        // cannot apply); it maps to server-error. Every other Invalid*
        // code represents a user-supplied bad value and must exit 1.
        const USER_INPUT_INVALID = [
            "InvalidRunId",
            "InvalidNodeId",
            "InvalidIteration",
            "InvalidFrameNo",
        ];
        for (const code of USER_INPUT_INVALID) {
            const mapping = CLI_ERROR_MESSAGES[code];
            expect(mapping).toBeDefined();
            expect(mapping.exitCode).toBe(EXIT_USER_ERROR);
        }
    });
});

describe("parseCliErrorFromStderr round-trips formatCliErrorForStderr (#7)", () => {
    test("mapped code renders and parses back to {code, message, hint}", () => {
        const rendered = formatCliErrorForStderr("RunNotFound");
        const parsed = parseCliErrorFromStderr(rendered);
        expect(parsed).toEqual({
            code: "RunNotFound",
            message: CLI_ERROR_MESSAGES.RunNotFound.message,
            hint: CLI_ERROR_MESSAGES.RunNotFound.hint,
        });
    });

    test("every mapped code round-trips", () => {
        for (const [code, mapping] of Object.entries(CLI_ERROR_MESSAGES)) {
            const parsed = parseCliErrorFromStderr(formatCliErrorForStderr(code));
            expect(parsed?.code, `code ${code} did not round-trip`).toBe(code);
            expect(parsed?.message).toBe(mapping.message);
        }
    });

    test("code-less renderings and non-error text degrade gracefully", () => {
        const parsed = parseCliErrorFromStderr(formatCliErrorForStderr(undefined, "boom happened"));
        expect(parsed?.code).toBeUndefined();
        expect(parsed?.message).toBe("boom happened");
        expect(parseCliErrorFromStderr("No matching durability checkpoint\n")).toBeNull();
        // A thrown-error line ("error: tree failed: ...") must not misparse
        // "tree" as a code, because "tree failed" is not a bare code token.
        const thrown = parseCliErrorFromStderr("error: tree failed: Run not found: x\n");
        expect(thrown?.code).toBeUndefined();
        expect(thrown?.message).toBe("tree failed: Run not found: x");
    });
});
