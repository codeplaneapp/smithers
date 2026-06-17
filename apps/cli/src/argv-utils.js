const BUILTIN_FLAGS_WITH_VALUES = new Set([
    "--format",
    "--filter-output",
    "--surface",
    "--allowed-tools",
    "--token-limit",
    "--token-offset",
]);

/**
 * @param {string | undefined} value
 * @returns {"semantic" | "raw" | "both"}
 */
function normalizeMcpSurface(value) {
    const surface = value?.trim().toLowerCase();
    if (surface === undefined || surface.length === 0) {
        throw new Error("Missing value for --surface. Expected semantic, raw, or both.");
    }
    if (surface === "semantic" || surface === "raw" || surface === "both") {
        return surface;
    }
    throw new Error(`Invalid --surface value: ${value}. Expected semantic, raw, or both.`);
}

/**
 * @param {string | undefined} value
 * @returns {readonly string[]}
 */
function normalizeMcpAllowedTools(value) {
    if (value === undefined) {
        throw new Error("Missing value for --allowed-tools. Expected a comma-separated semantic tool allowlist.");
    }
    return value
        .split(",")
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0);
}

/**
 * @param {string[]} argv
 */
export function parseMcpSurfaceArgv(argv) {
    let surface = "semantic";
    /** @type {readonly string[] | undefined} */
    let allowedTools;
    let readOnly = false;
    const filtered = [];
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--surface") {
            surface = normalizeMcpSurface(argv[index + 1]);
            index += 1;
            continue;
        }
        if (arg.startsWith("--surface=")) {
            surface = normalizeMcpSurface(arg.slice("--surface=".length));
            continue;
        }
        if (arg === "--allowed-tools") {
            allowedTools = normalizeMcpAllowedTools(argv[index + 1]);
            index += 1;
            continue;
        }
        if (arg.startsWith("--allowed-tools=")) {
            allowedTools = normalizeMcpAllowedTools(arg.slice("--allowed-tools=".length));
            continue;
        }
        if (arg === "--read-only") {
            readOnly = true;
            continue;
        }
        filtered.push(arg);
    }
    return { surface, argv: filtered, allowedTools, readOnly };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function findFirstPositionalIndex(argv, startIndex = 0) {
    for (let index = startIndex; index < argv.length; index++) {
        const arg = argv[index];
        if (!arg.startsWith("-")) {
            return index;
        }
        if (BUILTIN_FLAGS_WITH_VALUES.has(arg)) {
            index++;
        }
    }
    return -1;
}

/**
 * Incur treats union-typed options as value-bearing flags, so a bare
 * `--resume --run-id value` would consume `--run-id` as the resume value.
 *
 * @param {string[]} argv
 */
export function rewriteBareResumeFlagArgv(argv) {
    return argv.map((arg, index) => arg === "--resume" && (argv[index + 1] === undefined || argv[index + 1]?.startsWith("-"))
        ? "--resume=true"
        : arg);
}
