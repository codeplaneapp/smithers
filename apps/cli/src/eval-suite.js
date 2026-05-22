import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import crypto from "node:crypto";
import { SmithersError } from "@smithers-orchestrator/errors";

export const EVAL_CASE_STATUSES = [
    "finished",
    "continued",
    "failed",
    "cancelled",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
];

const RUN_ID_MAX_LENGTH = 64;
const EVAL_EXPECTED_KEYS = new Set(["status", "output", "outputContains", "errorContains"]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} value
 */
function stableHash(value) {
    return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/**
 * @param {string} value
 * @param {string} fallback
 * @param {number} maxLength
 */
export function slugifyEvalToken(value, fallback = "case", maxLength = 32) {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    const normalized = slug || fallback;
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(1, maxLength - 9)).replace(/-+$/g, "")}-${stableHash(normalized)}`;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertJsonObject(value, label) {
    if (!isPlainObject(value)) {
        throw new SmithersError("INVALID_INPUT", `${label} must be a JSON object.`, { label });
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, string | number | boolean>}
 */
function normalizeAnnotations(value, label) {
    if (value === undefined || value === null) {
        return {};
    }
    const object = assertJsonObject(value, label);
    /** @type {Record<string, string | number | boolean>} */
    const normalized = {};
    for (const [key, entry] of Object.entries(object)) {
        if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
            throw new SmithersError("INVALID_INPUT", `${label}.${key} must be a string, number, or boolean.`, { key });
        }
        normalized[key] = entry;
    }
    return normalized;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function normalizeExpected(value, label) {
    if (value === undefined || value === null) {
        return { status: "finished" };
    }
    const object = assertJsonObject(value, label);
    const unknownKeys = Object.keys(object).filter((key) => !EVAL_EXPECTED_KEYS.has(key));
    if (unknownKeys.length > 0) {
        throw new SmithersError("INVALID_INPUT", `${label} contains unsupported assertion keys: ${unknownKeys.join(", ")}.`, {
            keys: unknownKeys,
            supportedKeys: [...EVAL_EXPECTED_KEYS],
        });
    }
    const status = object.status ?? "finished";
    if (typeof status !== "string" || !EVAL_CASE_STATUSES.includes(status)) {
        throw new SmithersError("INVALID_INPUT", `${label}.status must be one of ${EVAL_CASE_STATUSES.join(", ")}.`, { status });
    }
    return { ...object, status };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(",")}]`;
    }
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 */
function jsonEquals(actual, expected) {
    return stableJson(actual) === stableJson(expected);
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 */
function jsonContains(actual, expected) {
    if (isPlainObject(expected)) {
        if (!isPlainObject(actual)) {
            return false;
        }
        for (const [key, value] of Object.entries(expected)) {
            if (!jsonContains(actual[key], value)) {
                return false;
            }
        }
        return true;
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length < expected.length) {
            return false;
        }
        return expected.every((entry, index) => jsonContains(actual[index], entry));
    }
    return jsonEquals(actual, expected);
}

/**
 * @param {unknown} error
 */
function formatEvalError(error) {
    if (error === undefined || error === null) {
        return "";
    }
    if (error instanceof Error) {
        return error.message;
    }
    if (isPlainObject(error)) {
        if (typeof error.message === "string") {
            return error.message;
        }
        return stableJson(error);
    }
    return String(error);
}

/**
 * @param {unknown} raw
 * @param {number} index
 */
export function normalizeEvalCase(raw, index) {
    const object = assertJsonObject(raw, `cases[${index}]`);
    const rawId = typeof object.id === "string"
        ? object.id
        : typeof object.name === "string"
            ? object.name
            : `case-${String(index + 1).padStart(3, "0")}`;
    const id = slugifyEvalToken(rawId, `case-${index + 1}`, 40);
    const input = object.input === undefined ? {} : assertJsonObject(object.input, `cases[${index}].input`);
    const annotations = normalizeAnnotations(object.annotations, `cases[${index}].annotations`);
    const expected = normalizeExpected(object.expected, `cases[${index}].expected`);
    const metadata = object.metadata === undefined || object.metadata === null
        ? {}
        : assertJsonObject(object.metadata, `cases[${index}].metadata`);
    return {
        id,
        name: rawId,
        input,
        annotations,
        expected,
        metadata,
    };
}

/**
 * @param {Array<ReturnType<typeof normalizeEvalCase>>} cases
 */
function assertUniqueEvalCaseIds(cases) {
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (let index = 0; index < cases.length; index += 1) {
        const testCase = cases[index];
        const firstIndex = seen.get(testCase.id);
        if (firstIndex !== undefined) {
            throw new SmithersError("INVALID_INPUT", `Duplicate eval case ID after normalization: ${testCase.id}`, {
                id: testCase.id,
                firstIndex,
                duplicateIndex: index,
            });
        }
        seen.set(testCase.id, index);
    }
}

/**
 * @param {string} text
 * @param {string} path
 */
function parseCasesText(text, path) {
    if (extname(path).toLowerCase() === ".jsonl") {
        return text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
                try {
                    return JSON.parse(line);
                }
                catch (err) {
                    throw new SmithersError("INVALID_JSON", `Invalid JSONL case at line ${index + 1}: ${err?.message ?? String(err)}`, { line: index + 1 });
                }
            });
    }
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (isPlainObject(parsed) && Array.isArray(parsed.cases)) {
            return parsed.cases;
        }
        throw new SmithersError("INVALID_INPUT", "Eval case file must be a JSON array, a { cases: [...] } object, or JSONL.", { path });
    }
    catch (err) {
        if (err instanceof SmithersError) {
            throw err;
        }
        throw new SmithersError("INVALID_JSON", `Invalid JSON case file: ${err?.message ?? String(err)}`, { path });
    }
}

/**
 * @param {string} root
 * @param {string} path
 * @param {{ maxCases?: number }} [options]
 */
export function loadEvalCases(root, path, options = {}) {
    const absolutePath = isAbsolute(path) ? path : resolve(root, path);
    if (!existsSync(absolutePath)) {
        throw new SmithersError("INVALID_INPUT", `Eval case file not found: ${path}`, { path });
    }
    const rawCases = parseCasesText(readFileSync(absolutePath, "utf8"), absolutePath);
    if (rawCases.length === 0) {
        throw new SmithersError("INVALID_INPUT", "Eval case file must contain at least one case.", { path });
    }
    const limit = options.maxCases ?? rawCases.length;
    const cases = rawCases.slice(0, limit).map(normalizeEvalCase);
    assertUniqueEvalCaseIds(cases);
    return {
        path: absolutePath,
        cases,
        totalCases: rawCases.length,
    };
}

/**
 * @param {string} suiteId
 * @param {string} caseId
 */
export function evalRunId(suiteId, caseId) {
    const suite = slugifyEvalToken(suiteId, "suite", 24);
    const testCase = slugifyEvalToken(caseId, "case", 24);
    const base = `eval-${suite}-${testCase}`;
    if (base.length <= RUN_ID_MAX_LENGTH) {
        return base;
    }
    return `${base.slice(0, RUN_ID_MAX_LENGTH - 9).replace(/-+$/g, "")}-${stableHash(base)}`;
}

/**
 * @param {{
 *   suiteId?: string;
 *   runLabel?: string;
 *   workflowPath: string;
 *   casesPath: string;
 *   loadedCases: ReturnType<typeof loadEvalCases>;
 * }} input
 */
export function buildEvalPlan(input) {
    const defaultSuite = basename(input.casesPath, extname(input.casesPath));
    const suiteId = slugifyEvalToken(input.suiteId ?? defaultSuite, "suite", 32);
    const runLabel = input.runLabel ? slugifyEvalToken(input.runLabel, "run", 24) : null;
    const runSuiteId = runLabel ? `${suiteId}-${runLabel}` : suiteId;
    const cases = input.loadedCases.cases.map((testCase) => ({
        ...testCase,
        runId: evalRunId(runSuiteId, testCase.id),
    }));
    assertUniqueEvalRunIds(cases);
    return {
        suiteId,
        runLabel,
        workflowPath: input.workflowPath,
        casesPath: input.loadedCases.path,
        totalCases: input.loadedCases.totalCases,
        plannedCases: input.loadedCases.cases.length,
        cases,
    };
}

/**
 * @param {Array<{ runId: string; id: string }>} cases
 */
function assertUniqueEvalRunIds(cases) {
    /** @type {Map<string, string>} */
    const seen = new Map();
    for (const testCase of cases) {
        const firstCaseId = seen.get(testCase.runId);
        if (firstCaseId !== undefined) {
            throw new SmithersError("INVALID_INPUT", `Duplicate eval run ID after normalization: ${testCase.runId}`, {
                runId: testCase.runId,
                firstCaseId,
                duplicateCaseId: testCase.id,
            });
        }
        seen.set(testCase.runId, testCase.id);
    }
}

/**
 * @param {{ getRun(runId: string): Promise<unknown> }} adapter
 * @param {Array<{ runId: string }>} cases
 */
export async function assertEvalRunIdsAvailable(adapter, cases) {
    const existing = [];
    for (const testCase of cases) {
        if (await adapter.getRun(testCase.runId)) {
            existing.push(testCase.runId);
        }
    }
    if (existing.length > 0) {
        throw new SmithersError("EVAL_RUN_ID_EXISTS", `Eval run ID${existing.length === 1 ? "" : "s"} already ${existing.length === 1 ? "exists" : "exist"}: ${existing.join(", ")}. Use a unique --run-label.`, {
            runIds: existing,
        });
    }
}

/**
 * @param {Array<{ passed: boolean; status?: string; durationMs?: number }>} results
 */
export function summarizeEvalResults(results) {
    const byStatus = {};
    for (const result of results) {
        const status = result.status ?? "error";
        byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const passed = results.filter((result) => result.passed).length;
    const failed = results.length - passed;
    return {
        total: results.length,
        passed,
        failed,
        byStatus,
        durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
    };
}

/**
 * @param {ReturnType<typeof normalizeEvalCase>} testCase
 * @param {{ status?: string; output?: unknown; error?: unknown }} result
 */
export function evaluateEvalCaseResult(testCase, result) {
    const assertions = [];
    const actualStatus = result.status ?? "error";
    assertions.push({
        name: "status",
        passed: actualStatus === testCase.expected.status,
        expected: testCase.expected.status,
        actual: actualStatus,
    });
    if (Object.prototype.hasOwnProperty.call(testCase.expected, "output")) {
        assertions.push({
            name: "output",
            passed: jsonEquals(result.output, testCase.expected.output),
            expected: testCase.expected.output,
            actual: result.output,
        });
    }
    if (Object.prototype.hasOwnProperty.call(testCase.expected, "outputContains")) {
        assertions.push({
            name: "outputContains",
            passed: jsonContains(result.output, testCase.expected.outputContains),
            expected: testCase.expected.outputContains,
            actual: result.output,
        });
    }
    if (Object.prototype.hasOwnProperty.call(testCase.expected, "errorContains")) {
        const actualError = formatEvalError(result.error);
        assertions.push({
            name: "errorContains",
            passed: actualError.includes(String(testCase.expected.errorContains)),
            expected: String(testCase.expected.errorContains),
            actual: actualError,
        });
    }
    return {
        passed: assertions.every((assertion) => assertion.passed),
        assertions,
    };
}

/**
 * @param {{
 *   plan: ReturnType<typeof buildEvalPlan>;
 *   results: Array<Record<string, unknown> & { passed: boolean; status?: string; durationMs?: number }>;
 *   startedAtMs: number;
 *   finishedAtMs: number;
 *   reportPath?: string | null;
 * }} input
 */
export function buildEvalReport(input) {
    return {
        suiteId: input.plan.suiteId,
        runLabel: input.plan.runLabel,
        workflowPath: input.plan.workflowPath,
        casesPath: input.plan.casesPath,
        startedAtMs: input.startedAtMs,
        finishedAtMs: input.finishedAtMs,
        durationMs: input.finishedAtMs - input.startedAtMs,
        reportPath: input.reportPath ?? null,
        summary: summarizeEvalResults(input.results),
        results: input.results,
    };
}

/**
 * @param {string} root
 * @param {string} suiteId
 */
export function defaultEvalReportPath(root, suiteId) {
    return join(root, ".smithers", "evals", `${suiteId}.json`);
}

/**
 * @param {string} root
 * @param {string | undefined} path
 */
function resolveOutputPath(root, path) {
    if (!path) {
        return null;
    }
    return isAbsolute(path) ? path : resolve(root, path);
}

/**
 * @param {string} root
 * @param {string} suiteId
 * @param {string | undefined} path
 */
export function resolveEvalReportPath(root, suiteId, path) {
    return resolveOutputPath(root, path) ?? defaultEvalReportPath(root, suiteId);
}

/**
 * @param {string} root
 * @param {string} suiteId
 * @param {{ path?: string; force?: boolean }} [options]
 */
export function assertEvalReportWritable(root, suiteId, options = {}) {
    const target = resolveEvalReportPath(root, suiteId, options.path);
    if (existsSync(target) && !options.force) {
        throw new SmithersError("INVALID_INPUT", `Eval report already exists: ${target}. Pass --force to overwrite.`, { path: target });
    }
    return target;
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} report
 * @param {{ path?: string; force?: boolean }} [options]
 */
export function writeEvalReport(root, report, options = {}) {
    const suiteId = typeof report.suiteId === "string" ? report.suiteId : "suite";
    const target = assertEvalReportWritable(root, suiteId, options);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ ...report, reportPath: target }, null, 2)}\n`, "utf8");
    return target;
}

/**
 * @param {ReturnType<typeof buildEvalPlan>} plan
 */
export function renderEvalPlan(plan) {
    const lines = [
        `Eval suite: ${plan.suiteId}`,
        ...(plan.runLabel ? [`Run label: ${plan.runLabel}`] : []),
        `Workflow: ${plan.workflowPath}`,
        `Cases: ${plan.plannedCases}${plan.totalCases !== plan.plannedCases ? ` of ${plan.totalCases}` : ""}`,
        "",
        "Planned runs:",
    ];
    for (const testCase of plan.cases) {
        lines.push(`- ${testCase.id} -> ${testCase.runId} (expect ${testCase.expected.status})`);
    }
    lines.push("");
    lines.push("Dry run only. Re-run without --dry-run to execute the suite.");
    return lines.join("\n");
}

/**
 * @param {ReturnType<typeof buildEvalReport>} report
 */
export function renderEvalReport(report) {
    const lines = [
        `Eval suite: ${report.suiteId}`,
        ...(report.runLabel ? [`Run label: ${report.runLabel}`] : []),
        `Workflow: ${report.workflowPath}`,
        `Result: ${report.summary.passed}/${report.summary.total} passed`,
        `Duration: ${report.durationMs}ms`,
    ];
    if (report.reportPath) {
        lines.push(`Report: ${report.reportPath}`);
    }
    lines.push("");
    lines.push("Cases:");
    for (const result of report.results) {
        const mark = result.passed ? "PASS" : "FAIL";
        lines.push(`- ${mark} ${result.caseId} -> ${result.runId} (${result.status ?? "error"}, ${result.durationMs ?? 0}ms)`);
        if (result.error) {
            lines.push(`  ${result.error}`);
        }
    }
    return lines.join("\n");
}
